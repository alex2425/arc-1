/**
 * ABAP Enhancement Framework — enhancement implementations (ENHO) and spots (ENHS).
 *
 * Two ADT facts drive this module, both live-verified on NW 7.50 (2026-08-22) and
 * recorded in docs/research/2026-08-22-enho-adt-surface.md:
 *
 * 1. The collection is release-dependent. 7.50 advertises only `enhoxh`/`enhsxs`; 7.58 and 8.16 add
 *    `enhoxhb` (BAdI), `enhoxhh` (hook) and `enhsxsb` — see the recorded probe discovery for NPL
 *    750, ECC EhP8 750, S/4HANA 2023 and ABAP Platform 2025. Addressing the wrong one returns 404,
 *    and forcing the wrong representation returns 406 — hence discovery-driven candidates
 *    (ADR-0001): on a system that advertises one collection we send exactly one request.
 * 2. The ENHO resource has NO `/source/main`. A source plug-in's coding is served by the
 *    ENHANCED object: `{objectUri}/source/main/enhancements?context={mainProgramUri}`, with the
 *    ABAP itself base64-encoded in `<enh:source>`.
 */

import { AdtApiError } from './errors.js';
import type { AdtHttpClient } from './http.js';
import type {
  EnhancementImplementationInfo,
  EnhancementObjectRef,
  EnhancementSourcePlugin,
  EnhancementSpotInfo,
  ObjectEnhancementImplementation,
  ObjectEnhancementsResult,
} from './types.js';
import { decodeXmlEntities, findDeepNodes, parseXml, toRecordArray } from './xml-parser.js';

/**
 * Collections that serve enhancement IMPLEMENTATIONS, BAdI-specific representation first.
 * `accept` is the fallback used when ADT discovery is not loaded.
 */
export const ENHO_COLLECTIONS: ReadonlyArray<{ collection: string; accept?: string }> = [
  { collection: '/sap/bc/adt/enhancements/enhoxhb', accept: 'application/vnd.sap.adt.enh.enhoxhb.v4+xml' },
  // Hook implementations get their own collection from 7.58 on. No hard-coded accept: the systems
  // that have it also advertise its media type, and we have not seen that type on the wire.
  // Recorded discovery: S/4HANA 2023 + ABAP Platform 2025 list it, both 7.50 systems do not.
  { collection: '/sap/bc/adt/enhancements/enhoxhh' },
  { collection: '/sap/bc/adt/enhancements/enhoxh', accept: 'application/vnd.sap.adt.enh.enho.v1+xml' },
];

/** Workbench-wrapper object type for enhancement implementations (`/vit/wb/object_type/…`). */
const ENHO_WORKBENCH_TYPE = 'enhoxh';

/**
 * Collections that serve enhancement SPOTS (the definition side).
 *
 * No `accept` fallback is hard-coded: discovery advertises the media type on every release that
 * has the collection, and inventing a vendor MIME type we have not seen on the wire would only
 * turn a working wildcard request into a 406.
 */
export const ENHS_COLLECTIONS: ReadonlyArray<{ collection: string; accept?: string }> = [
  { collection: '/sap/bc/adt/enhancements/enhsxsb' },
  { collection: '/sap/bc/adt/enhancements/enhsxs' },
];

/**
 * Read one enhancement object through the first collection that serves it.
 *
 * Candidates are filtered by ADT discovery when it is loaded, and a 404/406/415 falls through
 * to the next one, so no release gate is needed. Any other status is a real failure and is
 * re-thrown immediately rather than masked by a second request.
 */
export async function fetchEnhancementObject(
  http: AdtHttpClient,
  name: string,
  candidates: ReadonlyArray<{ collection: string; accept?: string }>,
): Promise<{ body: string; uri: string }> {
  const advertised = http.hasDiscoveryData()
    ? candidates.filter((c) => http.discoveryAcceptFor(c.collection) !== undefined)
    : [];
  const ordered = advertised.length > 0 ? advertised : candidates;

  let lastError: unknown;
  for (const candidate of ordered) {
    const uri = `${candidate.collection}/${encodeURIComponent(name)}`;
    const accept = http.discoveryAcceptFor(candidate.collection) ?? candidate.accept;
    try {
      const resp = await http.get(uri, accept ? { Accept: accept } : undefined);
      return { body: resp.body, uri };
    } catch (err) {
      if (err instanceof AdtApiError && (err.statusCode === 404 || err.statusCode === 406 || err.statusCode === 415)) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new AdtApiError(`Enhancement object "${name}" not found`, 404, ordered[0]?.collection ?? '');
}

/** Build the enhancement-feed URL of an object: `{objectUri}/source/main/enhancements[?context=]`. */
export function enhancementFeedUrl(objectUri: string, context?: string): string {
  const base = objectUri.replace(/\/+$/, '');
  const sourceMain = base.endsWith('/source/main') ? base : `${base}/source/main`;
  return `${sourceMain}/enhancements${context ? `?context=${encodeURIComponent(context)}` : ''}`;
}

/**
 * Read the enhancement feed of one object and decode the plug-in coding it carries.
 *
 * No explicit Accept: the sub-resource sits too deep for discovery negotiation, and ADT serves
 * its enhancement representation for a wildcard request (live-verified 7.50).
 */
export async function readObjectEnhancements(
  http: AdtHttpClient,
  objectUri: string,
  opts: { context?: string } = {},
): Promise<ObjectEnhancementsResult> {
  const url = enhancementFeedUrl(objectUri, opts.context);
  const resp = await http.get(url);
  return {
    objectUri: url.split('/enhancements')[0] ?? objectUri,
    ...(opts.context ? { context: opts.context } : {}),
    implementations: parseObjectEnhancements(resp.body),
  };
}

/** Read an ADT object reference (`adtcore:uri/type/name`) off a node, or undefined when empty. */
export function toEnhancementObjectRef(node: unknown): EnhancementObjectRef | undefined {
  // `objectReference` is an ARRAY_TAG, so the same helper must accept both shapes.
  const first = Array.isArray(node) ? node[0] : node;
  if (!first || typeof first !== 'object') return undefined;
  const rec = first as Record<string, unknown>;
  const name = String(rec['@_name'] ?? '');
  const uri = String(rec['@_uri'] ?? '');
  if (!name && !uri) return undefined;
  return { name, type: String(rec['@_type'] ?? ''), uri };
}

/**
 * Parse enhancement implementation metadata from
 * /sap/bc/adt/enhancements/{enhoxh|enhoxhb}/{name}.
 *
 * Expected root: <enho:objectData> with contentCommon/contentSpecific. BAdI implementations
 * (enhoxhb) live under contentSpecific; the enhanced object of a source plug-in comes from
 * contentCommon > usages > referencedObject.
 *
 * Unrecognized payloads are NOT an error: the caller gets the raw XML back (see `raw`), which
 * beats losing the response entirely on a release whose representation we haven't mapped yet.
 */
export function parseEnhancementImplementation(xml: string): EnhancementImplementationInfo {
  const parsed = parseXml(xml);
  const objectDataNode = parsed.objectData ?? findDeepNodes(parsed, 'objectData')[0];
  const objectData = (objectDataNode ?? {}) as Record<string, unknown>;
  const pkgRef = (objectData.packageRef ?? {}) as Record<string, unknown>;
  const contentCommon = (objectData.contentCommon ?? {}) as Record<string, unknown>;
  const contentSpecific = (objectData.contentSpecific ?? {}) as Record<string, unknown>;

  // Real responses wrap impls: contentSpecific > badiTechnology > badiImplementations > badiImplementation[]
  // badiTechnology may be an empty element (text value) on implementations with no BAdIs.
  const badiTech = contentSpecific.badiTechnology;
  const badiTechRec =
    badiTech && typeof badiTech === 'object' ? (badiTech as Record<string, unknown>) : ({} as Record<string, unknown>);
  const badiImplContainer = (badiTechRec.badiImplementations ?? contentSpecific.badiImplementations ?? {}) as Record<
    string,
    unknown
  >;
  const badiImplNodes = toRecordArray(badiImplContainer.badiImplementation);

  const technology = String(
    contentCommon['@_toolType'] ?? (typeof badiTech === 'string' || typeof badiTech === 'number' ? badiTech : ''),
  );

  // contentCommon > usages > referencedObject carries what the implementation is bound to.
  // For a source plug-in (ENHO/XH) that is the enhanced include, with mainObjectReference
  // naming its main program — exactly the (uri, context) pair the enhancement feed needs.
  const referencedObject = findDeepNodes(contentCommon, 'referencedObject')[0] ?? {};
  const enhancedObject = toEnhancementObjectRef(referencedObject.objectReference);
  const mainObject = toEnhancementObjectRef(referencedObject.mainObjectReference);

  return {
    name: String(objectData['@_name'] ?? ''),
    description: decodeXmlEntities(String(objectData['@_description'] ?? '')),
    package: String(pkgRef['@_name'] ?? ''),
    technology,
    switchSupported: String(contentCommon['@_switchSupported'] ?? '') === 'true',
    ...(enhancedObject ? { enhancedObject } : {}),
    ...(mainObject ? { mainObject } : {}),
    ...(objectDataNode ? {} : { raw: xml }),
    badiImplementations: badiImplNodes.map((node) => {
      const implementingClass = (node.implementingClass ?? {}) as Record<string, unknown>;
      const badiDefinition = (node.badiDefinition ?? {}) as Record<string, unknown>;
      const enhancementSpot = (node.enhancementSpot ?? {}) as Record<string, unknown>;
      return {
        name: String(node['@_name'] ?? ''),
        shortText: String(node['@_shortText'] ?? ''),
        implementingClass: String(implementingClass['@_name'] ?? ''),
        badiDefinition: String(badiDefinition['@_name'] ?? ''),
        enhancementSpot: String(enhancementSpot['@_name'] ?? ''),
        active: String(node['@_active'] ?? '') === 'true',
        default: String(node['@_default'] ?? '') === 'true',
      };
    }),
  };
}

/**
 * Parse enhancement spot metadata from /sap/bc/adt/enhancements/{enhsxs|enhsxsb}/{name}.
 *
 * Spots use their own `<enhs:objectData>` envelope (namespace …/enhancements/enhs) with the BAdI
 * definitions under contentSpecific > badiTechnology > badiDefinitions — each naming its interface
 * and its filters. Live payload verified on 7.50 (ZENH_SPOT_DEMO, 2026-08-23).
 *
 * The raw XML is returned ONLY when the envelope is unrecognized: shipping both a structured and a
 * raw copy of every spot would double the tokens for no gain.
 */
export function parseEnhancementSpot(xml: string): EnhancementSpotInfo {
  const parsed = parseXml(xml);
  const objectDataNode = parsed.objectData ?? findDeepNodes(parsed, 'objectData')[0];
  const objectData = (objectDataNode ?? {}) as Record<string, unknown>;
  const pkgRef = (objectData.packageRef ?? {}) as Record<string, unknown>;
  const contentCommon = (objectData.contentCommon ?? {}) as Record<string, unknown>;

  const definitions = findDeepNodes(objectData, 'badiDefinition').map((node) => {
    const iface = (node.interface ?? {}) as Record<string, unknown>;
    return {
      name: String(node['@_name'] ?? ''),
      shortText: decodeXmlEntities(String(node['@_shorttext'] ?? node['@_shortText'] ?? '')),
      interface: String((Array.isArray(iface) ? iface[0] : iface)?.['@_name'] ?? ''),
      singleUse: String(node['@_singleUse'] ?? '') === 'true',
      useFallbackClass: String(node['@_useFallbackClass'] ?? '') === 'true',
      filters: findDeepNodes(node, 'filter').map((f) => ({
        name: String(f['@_filterName'] ?? ''),
        type: String(f['@_filterType'] ?? ''),
        shortText: decodeXmlEntities(String(f['@_shorttext'] ?? '')),
      })),
    };
  });

  return {
    name: String(objectData['@_name'] ?? ''),
    description: decodeXmlEntities(String(objectData['@_description'] ?? '')),
    package: String(pkgRef['@_name'] ?? ''),
    technology: String(contentCommon['@_toolType'] ?? ''),
    ...(definitions.length > 0 ? { badiDefinitions: definitions } : {}),
    ...(objectDataNode ? {} : { raw: xml }),
  };
}

/** Decode a base64 <enh:source> payload (wire format is line-wrapped base64, UTF-8 text). */
function decodeEnhancementSource(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const encoded = String(value).replace(/\s+/g, '');
  if (!encoded) return undefined;
  return Buffer.from(encoded, 'base64').toString('utf8');
}

/** Split an ADT `#start=line,column` fragment off a URI. */
function splitPositionFragment(uri: string): { uri: string; line?: number; column?: number } {
  const match = /#start=(\d+),(\d+)/.exec(uri);
  if (!match) return { uri };
  return { uri, line: Number(match[1]), column: Number(match[2]) };
}

/**
 * Parse the enhancement feed of one object: `{objectUri}/source/main/enhancements`.
 *
 * Expected root: <enh:enhancements> with one <enh:enhancementImplementations> per bound ENHO,
 * each carrying <enh:elements><enh:sourceCodePlugin> entries whose <enh:source> is base64 ABAP.
 * An object with no enhancements returns the empty root — a valid, non-error answer.
 *
 * SAP emits ONE `<enh:elements>` container PER PLUG-IN, not one holding them all: an ENHO with a
 * BEGIN and an END hook in the same routine arrives as two sibling containers. Flatten across all
 * of them — reading only the first silently dropped every second-and-later hook.
 */
export function parseObjectEnhancements(xml: string): ObjectEnhancementImplementation[] {
  const parsed = parseXml(xml);
  const root = (parsed.enhancements ?? {}) as Record<string, unknown>;
  const implNodes = Array.isArray(root.enhancementImplementations)
    ? (root.enhancementImplementations as Array<Record<string, unknown>>)
    : findDeepNodes(parsed, 'enhancementImplementations');

  return implNodes.map((impl) => {
    const pluginNodes = toRecordArray(impl.elements).flatMap((container) => toRecordArray(container.sourceCodePlugin));

    const elements: EnhancementSourcePlugin[] = pluginNodes.map((plugin) => {
      // SAP spells the attribute `fullname` on 7.50 and `full_name` on newer releases.
      const fullName = String(plugin['@_fullname'] ?? plugin['@_full_name'] ?? '');
      const positionNode = findDeepNodes(plugin, 'position')[0];
      const positionUri = positionNode ? String(positionNode['@_uri'] ?? '') : '';
      const source = decodeEnhancementSource(plugin.source);
      return {
        fullName,
        id: String(plugin['@_id'] ?? '').trim(),
        mode: String(plugin['@_mode'] ?? ''),
        replacing: String(plugin['@_replacing'] ?? '') === 'true',
        uri: String(plugin['@_uri'] ?? ''),
        ...(positionUri ? { position: splitPositionFragment(positionUri) } : {}),
        ...(source ? { source } : {}),
      };
    });

    const enhancedObject = toEnhancementObjectRef(impl.enhancedObject);
    return {
      name: String(impl['@_name'] ?? ''),
      type: String(impl['@_type'] ?? ''),
      version: String(impl['@_version'] ?? ''),
      ...(enhancedObject ? { enhancedObject } : {}),
      elements,
    };
  });
}

// ─── Fallback metadata: the VIT workbench wrapper ────────────────────────────────────

/**
 * Read enhancement metadata through the generic workbench wrapper.
 *
 * NW 7.50 serves the enhancement collection but **dumps (500) on the object representation**
 * itself — ADT could not edit source-code enhancements before 7.53. The VIT wrapper answers for
 * the same object with the common workbench envelope (author, master language, package), which is
 * strictly better than surfacing the dump. Live-verified 7.50, 2026-08-22.
 */
export async function fetchEnhancementMetadataViaWorkbench(
  http: AdtHttpClient,
  name: string,
  objectType: string,
): Promise<{ body: string; uri: string }> {
  const uri = `/sap/bc/adt/vit/wb/object_type/${objectType}/object_name/${encodeURIComponent(name.toUpperCase())}`;
  const resp = await http.get(uri);
  return { body: resp.body, uri };
}

/** Parse the `<adtcore:mainObject>` envelope the VIT wrapper returns. */
export function parseWorkbenchEnhancementMetadata(xml: string): EnhancementImplementationInfo {
  const parsed = parseXml(xml);
  const main = (parsed.mainObject ?? findDeepNodes(parsed, 'mainObject')[0] ?? {}) as Record<string, unknown>;
  const pkgRef = (main.packageRef ?? {}) as Record<string, unknown>;
  return {
    name: String(main['@_name'] ?? ''),
    description: String(main['@_description'] ?? ''),
    package: String(pkgRef['@_name'] ?? ''),
    technology: String(main['@_type'] ?? ''),
    switchSupported: false,
    badiImplementations: [],
    raw: xml,
  };
}

// ─── Anchors: where an enhancement hooks into the enhanced object ────────────────────

/**
 * One place an enhancement implementation hooks into, derived from `ENHINCINX`.
 *
 * The feed that carries the coding is per SUB-OBJECT, never per container: an include, a function
 * module or the include that holds a FORM. Anchors therefore split by the shape of `FULL_NAME`,
 * and only `include`/`program` resolve without a second lookup — `form` needs the container's
 * object structure to find its include, `functionModule` needs the function group.
 *
 * `class` anchors get no target at all: on 7.50 every enhancement-feed URL for a class returns the
 * empty root (eight shapes tried, see docs/research/2026-08-22-enho-adt-surface.md), so they are
 * reported as locations only instead of costing a request per anchor.
 */
export interface EnhancementAnchor {
  fullName: string;
  mainProgram: string;
  kind: 'include' | 'program' | 'form' | 'functionModule' | 'class';
  /**
   * Enhancement mode from `ENHINCINX~ENHMODE` — the authoritative value. The feed's own
   * `enh:mode` is reported verbatim on the plug-in and says `any` for some of the same hooks,
   * so the two fields are deliberately kept apart rather than reconciled.
   */
  mode?: 'static' | 'dynamic';
  /** FORM or function-module name this anchor sits in (`form` / `functionModule`). */
  member?: string;
  /** Enhanced class (`class` anchors). */
  class?: string;
  /** Enhanced method, when the anchor names one. */
  method?: string;
  /**
   * pre / post / overwrite, read from the generated method name in the enhancement include.
   * Only present where that include is servable — see resolveClassMethodExits.
   */
  exitType?: EnhancementExitType;
  /** Interface the method belongs to, for interface-method anchors. */
  interface?: string;
  /** Declaration section (PUBLIC/PROTECTED/PRIVATE/…) for anchors that name no method. */
  section?: string;
  /**
   * `ENHINCINX~METHOD = 'X'`, reported verbatim because its meaning is NOT established.
   *
   * On the reference system it is set on 15 of ~29k anchors, always together with a `\ME:` part,
   * on class-own AND interface methods alike. The one anchor with SE24 ground truth — an
   * OVERWRITE exit — has it EMPTY, and a pre/post exit on the same class has it set, which is
   * consistent with "the enhancement sits inside an existing method body" versus "the enhancement
   * IS the method". That is one sample: do not derive pre/post/overwrite from it. ARC-1 does not.
   */
  inMethodBody?: boolean;
  enhancedObjectUri?: string;
  contextUri?: string;
}

/**
 * A class pool program name — `CL_FOO========CP`, `IF_FOO========IP`, or, when the name already
 * fills all 30 characters, unpadded (`CL_HCMFAB_TIMESHEET_CR_DPC_EXTCP`). The padding must be
 * OPTIONAL: with `=+` the unpadded form fell through and was mis-typed as a plain include.
 */
const CLASS_POOL = /^(?<name>[A-Z0-9_/]+?)=*(?:CP|IP)$/;

/** Function-group main program — `SAPL<group>`. */
const GROUP_MAIN = /^SAPL(?<group>.+)$/;

const programUri = (name: string) => `/sap/bc/adt/programs/programs/${encodeURIComponent(name.toLowerCase())}`;
const includeUri = (name: string) => `/sap/bc/adt/programs/includes/${encodeURIComponent(name.toLowerCase())}`;
const groupUri = (name: string) => `/sap/bc/adt/functions/groups/${encodeURIComponent(name.toLowerCase())}`;

/**
 * Derive hook locations from `ENHINCINX` rows (`ENHNAME`, `PROGRAMNAME`, `FULL_NAME`).
 *
 * `FULL_NAME` is the enhancement framework's own path. The five shapes seen live:
 * `\PR:<prog>\IC:<incl>` (include), `\IC:<incl>\EX:<point>` (explicit point), `\PR:<prog>\FO:<form>`
 * (FORM routine), `\FU:<fm>` (function module) and `\TY:<class>\…` (class). Pure function — the SQL
 * that feeds it lives in the handler, behind the same free-SQL gate as the TRAN program lookup.
 */
export function parseEnhancementAnchors(rows: Array<Record<string, unknown>>): EnhancementAnchor[] {
  const anchors: EnhancementAnchor[] = [];
  for (const row of rows) {
    const fullName = String(row.FULL_NAME ?? '').trim();
    const mainProgram = String(row.PROGRAMNAME ?? '').trim();
    if (!fullName && !mainProgram) continue;
    const enhMode = String(row.ENHMODE ?? '')
      .trim()
      .toUpperCase();
    const mode =
      enhMode === 'S' ? ({ mode: 'static' } as const) : enhMode === 'D' ? ({ mode: 'dynamic' } as const) : {};

    const include = /\\IC:([^\\]+)/.exec(fullName)?.[1]?.trim();
    const program = /\\PR:([^\\]+)/.exec(fullName)?.[1]?.trim() ?? mainProgram;
    const classType = /\\TY:([^\\]+)/.exec(fullName)?.[1]?.trim();
    const form = /\\FO:([^\\]+)/.exec(fullName)?.[1]?.trim();
    const functionModule = /\\FU:([^\\]+)/.exec(fullName)?.[1]?.trim();
    const base = { fullName, mainProgram, ...mode };

    // A class pool as PROGRAMNAME means the anchor is inside a class, whatever its FULL_NAME says.
    if (classType || CLASS_POOL.test(program ?? '') || CLASS_POOL.test(mainProgram)) {
      // Name what the anchor touches — an assessment needs the method, not just the section.
      const method = /\\ME:([^\\]+)/.exec(fullName)?.[1]?.trim();
      const iface = /\\IN:([^\\]+)/.exec(fullName)?.[1]?.trim();
      const section = /\\SE:([^\\]+)/.exec(fullName)?.[1]?.trim();
      anchors.push({
        ...base,
        kind: 'class',
        class: classType ?? CLASS_POOL.exec(program || mainProgram)?.groups?.name,
        ...(method ? { method } : {}),
        ...(iface ? { interface: iface } : {}),
        ...(section && !method ? { section } : {}),
        // ENHINCINX~METHOD: set on 15 of 129 anchors on the reference system, and only ever on
        // anchors that name a method. Reported as-is — see EnhancementAnchor.inMethodBody.
        ...(String(row.METHOD ?? '')
          .trim()
          .toUpperCase() === 'X'
          ? { inMethodBody: true }
          : {}),
      });
      continue;
    }
    if (functionModule) {
      anchors.push({ ...base, kind: 'functionModule', member: functionModule });
      continue;
    }
    if (form) {
      anchors.push({ ...base, kind: 'form', member: form });
      continue;
    }
    const container = program || mainProgram;
    if (!include && !container) continue;
    anchors.push({
      ...base,
      kind: include ? 'include' : 'program',
      enhancedObjectUri: include ? includeUri(include) : programUri(container),
      contextUri: programUri(container),
    });
  }
  return anchors;
}

/** One enhancement-feed request: the sub-object that serves the coding, plus its context. */
export interface EnhancementFeedTarget {
  objectUri: string;
  context?: string;
}

/** Distinct `(objectUri, context)` pairs to query — one feed request per pair, not per anchor. */
export function anchorFeedTargets(anchors: EnhancementAnchor[]): EnhancementFeedTarget[] {
  const seen = new Map<string, EnhancementFeedTarget>();
  for (const a of anchors) {
    if (!a.enhancedObjectUri) continue;
    const key = `${a.enhancedObjectUri}|${a.contextUri ?? ''}`;
    if (!seen.has(key)) seen.set(key, { objectUri: a.enhancedObjectUri, context: a.contextUri });
  }
  return [...seen.values()];
}

/**
 * Split an ADT source URI that may already carry `?context=` and a `#start=` fragment into the
 * pair the feed needs. The object structure hands out exactly such URIs, context included.
 */
export function feedTargetFromSourceUri(sourceUri: string, fallbackContext?: string): EnhancementFeedTarget {
  const [withoutFragment] = sourceUri.split('#');
  const [path, query = ''] = (withoutFragment ?? '').split('?');
  const context = new URLSearchParams(query).get('context') ?? undefined;
  return { objectUri: path ?? sourceUri, context: context ?? fallbackContext };
}

/**
 * Pull `<projectexplorer:node>` subroutine entries out of a repository object structure.
 *
 * Nodes look like `description="CHECK_EXPORT_3X" objecttype="PROG/PU" objecturi=".../source/main
 * ?context=…#start=21,5"` — the URI is exactly what the enhancement feed needs, so the FORM name
 * maps straight to a feed target. `PROG/PU` is used for reports and `FUGR/PU` inside a group.
 */
export function parseSubroutineNodes(xml: string): Map<string, string> {
  const parsed = parseXml(xml);
  const root = toRecordArray(parsed.objectstructure)[0] ?? {};
  const forms = new Map<string, string>();
  for (const node of toRecordArray(root.node)) {
    if (String(node['@_isfolder'] ?? '') === 'true') continue;
    if (!String(node['@_objecttype'] ?? '').endsWith('/PU')) continue;
    const form = String(node['@_description'] ?? '')
      .trim()
      .toUpperCase();
    const uri = String(node['@_objecturi'] ?? '');
    if (form && uri && !forms.has(form)) forms.set(form, uri);
  }
  return forms;
}

/** What anchor resolution needs from the client layer, kept narrow so this module stays testable. */
export interface AnchorResolutionDeps {
  /** Read a repository object structure ( is the ADT slash type, e.g. PROG/P). */
  getObjectStructure(objectType: string, objectName: string): Promise<string>;
  /** Resolve a function module's group (ADT-based; no SQL). */
  resolveFunctionGroup(functionModule: string): Promise<string | null>;
}

/**
 * Turn anchors into feed targets, looking up what `ENHINCINX` does not spell out.
 *
 * - `functionModule`: the group, then `/functions/groups/{grp}/fmodules/{fm}/source/main`.
 * - `form`: the container's object structure, which names the include holding the FORM — the main
 *   program's own feed stays empty, so guessing the container is exactly the bug this fixes.
 *
 * One structure request per container, memoized; a failed lookup drops that anchor rather than the
 * whole read. All shapes live-verified on NW 7.50 (2026-08-23).
 */
export async function resolveAnchorFeedTargets(
  deps: AnchorResolutionDeps,
  anchors: EnhancementAnchor[],
): Promise<EnhancementFeedTarget[]> {
  const targets = anchorFeedTargets(anchors);
  const seen = new Set(targets.map((t) => `${t.objectUri}|${t.context ?? ''}`));
  const push = (target: EnhancementFeedTarget) => {
    const key = `${target.objectUri}|${target.context ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };
  const structures = new Map<string, Promise<Map<string, string>>>();

  for (const anchor of anchors) {
    if (anchor.kind === 'functionModule' && anchor.member) {
      const group = await deps.resolveFunctionGroup(anchor.member).catch(() => null);
      if (!group) continue;
      push({
        objectUri: `${groupUri(group)}/fmodules/${encodeURIComponent(anchor.member.toLowerCase())}/source/main`,
        context: groupUri(group),
      });
      continue;
    }
    if (anchor.kind !== 'form' || !anchor.member) continue;

    const container = anchor.mainProgram || '';
    if (!container) continue;
    const group = GROUP_MAIN.exec(container)?.groups?.group;
    const objectType = group ? 'FUGR/F' : 'PROG/P';
    const objectName = group ?? container;
    const fallbackContext = group ? groupUri(group) : programUri(container);

    let structure = structures.get(objectName);
    if (!structure) {
      // A container is looked up once even when it holds a dozen FORM anchors.
      structure = deps
        .getObjectStructure(objectType, objectName)
        .then(parseSubroutineNodes)
        .catch(() => new Map<string, string>());
      structures.set(objectName, structure);
    }
    const formUri = (await structure).get(anchor.member.toUpperCase());
    if (formUri) push(feedTargetFromSourceUri(formUri, fallbackContext));
  }
  return targets;
}

/**
 * Read an enhancement implementation: collection candidates first, workbench wrapper as the
 * last resort. Kept here rather than in the client facade so the whole release-quirk story for
 * enhancements lives in one file.
 */
export async function readEnhancementImplementation(
  http: AdtHttpClient,
  name: string,
): Promise<EnhancementImplementationInfo> {
  try {
    const { body, uri } = await fetchEnhancementObject(http, name, ENHO_COLLECTIONS);
    return { ...parseEnhancementImplementation(body), uri };
  } catch (err) {
    // NW 7.50 dumps on the object representation (ADT could not edit enhancements before 7.53).
    // The workbench wrapper still answers, so a 500 downgrades to reduced metadata instead of no
    // answer at all. Any other failure — auth, network — stays a failure.
    if (!(err instanceof AdtApiError) || err.statusCode !== 500) throw err;
    try {
      const { body, uri } = await fetchEnhancementMetadataViaWorkbench(http, name, ENHO_WORKBENCH_TYPE);
      return { ...parseWorkbenchEnhancementMetadata(body), uri };
    } catch {
      // The wrapper is a consolation prize, not the request the caller made. If it fails too,
      // report the original dump — a 404 on a URL nobody asked for would only mislead.
      throw err;
    }
  }
}

/** Read an enhancement spot through the first collection that serves it. */
export async function readEnhancementSpot(http: AdtHttpClient, name: string): Promise<EnhancementSpotInfo> {
  const { body, uri } = await fetchEnhancementObject(http, name, ENHS_COLLECTIONS);
  return { ...parseEnhancementSpot(body), uri };
}

// ─── Class-enhancement method exits ─────────────────────────────────────────────────

/**
 * Name of the generated include that holds an enhancement declarations.
 *
 * The enhancement name padded to 30 characters with = , then E (declarations) or EIMP
 * (implementations) — confirmed against REPOSRC, which lists exactly these names.
 *
 * The ADT include reader refuses them with 500 "could not be successfully read" on NW 7.50, and
 * refuses a deliberately mis-padded name with 500 as well: the status does NOT distinguish a
 * wrong name from a refused one, so never read it as "URL correct". REPOSRC is the authority.
 */
export function enhancementIncludeName(enhancement: string, part: 0 | 1 = 0): string {
  const padded = enhancement.toUpperCase().padEnd(30, String.fromCharCode(61));
  return part === 0 ? padded + String.fromCharCode(69) : padded + String.fromCharCode(69, 73, 77, 80);
}

/** How a class-enhancement method relates to the method it enhances. */
export type EnhancementExitType = 'pre' | 'post' | 'overwrite';

/** One generated exit method of a class enhancement. */
export interface EnhancementMethodExit {
  /** Enhanced method, without any interface prefix (SAP drops it in the generated name). */
  method: string;
  enhancement: string;
  exitType: EnhancementExitType;
}

const EXIT_PREFIX: Record<string, EnhancementExitType> = { IPR: 'pre', IPO: 'post', IOW: 'overwrite' };

/**
 * Read the exit type of class-enhancement methods out of the generated include.
 *
 * SAP encodes it in the method NAME and nowhere else — not in SEOCOMPO, TMDIR, ENHA_TMDIR,
 * ENHCROSS or ENHINCINX (all verified empty for these methods):
 *
 *   METHOD ipr_<enhancement>~<method>.   pre-exit
 *   METHOD ipo_<enhancement>~<method>.   post-exit
 *   METHOD iow_<enhancement>~<method>.   overwrite-exit  (replaces the SAP implementation)
 *
 * Scans tokens rather than statements so the same parser serves the declaration include (method
 * headers) and the implementation include (METHOD … ENDMETHOD bodies).
 */
export function parseEnhancementMethodExits(source: string): EnhancementMethodExit[] {
  const seen = new Map<string, EnhancementMethodExit>();
  // Word boundary: a method that merely CONTAINS the prefix must not be read as an exit.
  for (const match of source.matchAll(/\b(IPR|IPO|IOW)_([A-Z0-9_/]+)~([A-Z0-9_/]+)/gi)) {
    const exitType = EXIT_PREFIX[(match[1] ?? '').toUpperCase()];
    const enhancement = (match[2] ?? '').toUpperCase();
    const method = (match[3] ?? '').toUpperCase();
    if (!exitType || !method) continue;
    const key = method + '|' + exitType;
    if (!seen.has(key)) seen.set(key, { method, enhancement, exitType });
  }
  return [...seen.values()];
}
