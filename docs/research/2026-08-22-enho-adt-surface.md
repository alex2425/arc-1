# ENHO on ADT — the collection is release-dependent and the coding lives elsewhere

**Date**: 2026-08-22
**System**: customer NW 7.50 (on-prem, via ARC-1 on BTP CF → Cloud Connector)
**Note**: customer object names, user ids and ABAP payloads are anonymized throughout; SAP-standard names (SAPFP51T, RPTMOZ00, CL_HCMFAB_*, CATS_SAVE_CATSDB, …) are kept so the evidence stays reproducible.
**Trigger**: `SAPRead(type="ENHO", name="ZENH_HOOK_DEMO")` returned HTTP 404 for every enhancement
implementation on that system.

## Findings

### 1. `enhoxhb` does not exist on 7.50 — `enhoxh` does

| Request | 7.50 (live) | NPL 7.50 SP02 (recorded probe fixture) |
|---|---|---|
| `GET /sap/bc/adt/enhancements/enhoxhb/{name}` | 404 | collection 404 |
| `GET /sap/bc/adt/enhancements/enhoxh/{name}` | 406 with `Accept: text/plain` (i.e. **the resource exists**) | advertised in discovery |

The system's own discovery document advertises exactly one representation for the collection:

```xml
<app:collection href="/sap/bc/adt/enhancements/enhoxh">
  <atom:title>Enhancement Implementation</atom:title>
  <app:accept>application/vnd.sap.adt.enh.enho.v1+xml</app:accept>
</app:collection>
```

`SAPSearch(searchType="tadir_lookup")` already returned the right address
(`uri = /sap/bc/adt/enhancements/enhoxh/zenh_hook_demo`, `objectType = ENHO/XH`) — the read path was
the only place using the hard-coded `enhoxhb`. This matches the gap recorded in
[docs/adr/0001](../adr/0001-discovery-driven-endpoint-routing.md) ("NPL has `enhoxh` but not
`enhoxhb`") and closes it: the read now tries both collections, discovery-first, and treats
404/406/415 as "try the next one".

Recorded discovery across the four probe fixtures in this repo — the enhancement workspace is a
per-release set, not a constant:

| System | Advertised enhancement collections |
|---|---|
| NPL 7.50 SP02 (dev edition) | `enhoxh`, `enhsxs` |
| ECC EhP8 / NW 7.50 SP31 (production) | `enhoxh`, `enhsxs` |
| S/4HANA 2023 (7.58) | `enhoxh`, `enhoxhb`, `enhoxhh`, `enhsxs`, `enhsxsb` |
| ABAP Platform 2025 (8.16) | `enhoxh`, `enhoxhb`, `enhoxhh`, `enhsxs`, `enhsxsb` |

`enhoxhh` (hook implementations) exists only from 7.58 — a customer's source plug-in on S/4 is
likely served there rather than by `enhoxh`, so it belongs in the candidate list even though no
7.50 system can exercise it.

### 2. The ENHO resource has no source — the ENHANCED object serves it

`GET /sap/bc/adt/enhancements/enhoxh/{name}/source/main` → **404**. The coding of a source-code
plug-in is served by the object it enhances:

```
GET {objectUri}/source/main/enhancements?context={mainProgramUri}
```

Live example (`ZENH_HOOK_DEMO`, an `ENHO/XH` hook on include `RPTMOZ00` of main program `SAPFP51T`):

```
GET /sap/bc/adt/programs/includes/rptmoz00/source/main/enhancements
    ?context=%2Fsap%2Fbc%2Fadt%2Fprograms%2Fprograms%2Fsapfp51t
```

```xml
<enh:enhancements>
  <enh:enhancementImplementations adtcore:name="ZENH_HOOK_DEMO" adtcore:type="ENHO/XH" adtcore:version="active">
    <enh:elements>
      <enh:sourceCodePlugin enh:uri="…/elements/sourcecodeplugins/%5cPR%3aSAPFP51T…"
                            enh:id="1 " enh:fullname="\PR:SAPFP51T\IC:RPTMOZ00\SE:END\EI"
                            enh:mode="static" enh:replacing="false">
        <enh:source>RU5IQU5DRU1FTlQgMSB6ZW5oX2hvb2tfZGVtby4K…</enh:source>   <!-- base64 ABAP -->
        <enh:option><enh:sourceCodePluginOption enh:fullname="…">
          <enh:position adtcore:uri="…/rptmoz00/source/main?context=…#start=1310,0"/>
        </enh:sourceCodePluginOption></enh:option>
      </enh:sourceCodePlugin>
    </enh:elements>
    <enh:enhancedObject adtcore:uri="/sap/bc/adt/programs/programs/sapfp51t" adtcore:type="PROG/P" adtcore:name="SAPFP51T"/>
  </enh:enhancementImplementations>
</enh:enhancements>
```

Behaviour worth remembering, all live-verified:

- **`context` must be the MAIN PROGRAM.** No `context`, or `context` = the include itself, returns
  the empty root `<enh:enhancements/>` — a silent empty answer, not an error.
- Reading the *main program's* own `…/enhancements` is also empty here: the enhancement is bound to
  the include (`FULL_NAME = \PR:SAPFP51T\IC:RPTMOZ00\SE:END\EI`, from `ENHINCINX`).
- `Accept` is loose on this sub-resource: ADT served the enhancement XML even for `text/plain`.
  The object resource itself is strict (406 on `text/plain`).
- `…/source/main/enhancements/elements` (the S/4 path in abap-adt-api) → 404 on 7.50.
- The generated include (`ENHINCINX~ENHINCLUDE`, e.g. `ZENH_HOOK_DEMO================E`) stays
  unreadable through ADT (500), and `?withEnhancements=true` on the enhanced program returns
  byte-identical source. Neither is a workaround.

### 3. The object representation itself DUMPS on 7.50 (found after deploying the fix)

With the URL corrected, `GET /sap/bc/adt/enhancements/enhoxh/{name}` returns **500** for both test
objects (`ZENH_HOOK_DEMO`, `ZENH_CLASS_DEMO`) — uppercase and lowercase alike, while the same URL
still answers 406 for `Accept: text/plain`. That fits the release history: ADT could not edit
source-code enhancements before 7.53, so 7.50 registers the collection but has no working
representation handler. There is nothing to negotiate — the endpoint is a dead end on this release.

Two things still work, and together they replace it:

| Need | Endpoint | Result on 7.50 |
|---|---|---|
| Metadata | `GET /sap/bc/adt/vit/wb/object_type/enhoxh/object_name/{NAME}` | 200 — `<adtcore:mainObject>` with package, author, master language, created/changed |
| Hook locations | `ENHINCINX` (SQL) — `PROGRAMNAME` + `FULL_NAME` | one row per anchor |
| Coding | the enhanced object's enhancement feed (finding 2) | full base64 ABAP |

### 4. Class enhancements are not served at all on 7.50

`ZENH_CLASS_DEMO` hooks into `CL_HCMFAB_EMPLOYEE_API` (9 anchors: `\TY:CL_…\SE:PUBLIC\SE:END\EI`,
`\TY:CL_…\ME:GET_EMPLOYEENUMBER_FROM_USER\SE:%_BEGIN\EI`, plus a `\PR:CL_…CP\IC:CL_…CCIMP` row).
Every feed URL tried returns the empty root — the class main source, the class pool addressed as a
program, `/oo/classes/{c}/includes/implementations/enhancements` with and without context — and
`/oo/classes/{c}/includes/main/enhancements` 500s. So ARC-1 does not fire feed requests for class
anchors; it reports the anchors themselves and says the coding needs SE80/SE24 on this release.

### 5. ENHS has its own envelope — and it is served fine on 7.50

Spots do NOT share the implementation envelope: the root is `<enhs:objectData>` (namespace
`http://www.sap.com/adt/enhancements/enhs`) and the BAdI definitions sit under
`contentSpecific > badiTechnology > badiDefinitions`, each with its interface and filter list.
Verified live on `ZENH_SPOT_DEMO` (`ENHS/XS`, 200 from `enhsxs`) and captured as
`tests/fixtures/xml/enhancement-spot.xml` — so spots are returned structured, not raw.

Not every TADIR `ENHS` row is addressable: two of the four custom spots on the test system exist in
TADIR but ADT answers `Enhancement spot … does not exist` on both spot collections, and
`tadir_lookup` finds no ADT URI for them either.

### 6. The feed is per SUB-OBJECT — one URL shape per anchor form

Measured over all 45 enhancement implementations on the system (129 anchors), the first
implementation returned coding for 6: it asked the feed of whatever `\PR:`/`\IC:` named, which is
right only for a plain program include. The feed is served by the **sub-object that holds the
code**, and the anchor form says which one that is. All verified live 2026-08-23:

| `FULL_NAME` | Feed object | `context` |
|---|---|---|
| `\PR:<prog>\IC:<incl>` | `/programs/includes/{incl}/source/main` | `/programs/programs/{prog}` |
| `\IC:<incl>\EX:<point>` | same as above | same |
| `\FU:<fm>` | `/functions/groups/{grp}/fmodules/{fm}/source/main` | `/functions/groups/{grp}` |
| `\PR:<prog>\FO:<form>` | the include holding the FORM | the container |
| `\TY:<class>…`, `\PR:<cls>CP\IC:<cls>CCIMP` | — not served on 7.50 — | — |

The FORM case has no shortcut: `ENHINCINX` names only the main program, and the main program's own
feed is empty. The include comes from the container's object structure
(`/sap/bc/adt/repository/objectstructure?objectname=…&objecttype=PROG/P|FUGR/F`), whose subroutine
nodes carry `description="<FORM>"` and an `objecturi` that already includes `?context=` — e.g.
`CHECK_EXPORT_3X` → `/programs/includes/rpcipe03_old/source/main?context=…zdemo_report`. One structure
request per container, memoized.

Two dead ends, both tried and rejected:

- The per-plug-in resource from the feed's own `enh:uri`
  (`/sap/bc/adt/enhancements/implementations/{enh}/elements/sourcecodeplugins/{escaped fullName}`)
  is **not GET-able** on 7.50 — 404 with lower- and upper-case escapes, with and without
  `/source/main`, and the `…/elements` collection 404s too. It is an identifier the enhancement
  editor resolves internally, not a reader.
- Class anchors: eight URL shapes tried (class main source with four different contexts, the class
  pool as a program, `/oo/classes/{c}/includes/implementations[/source/main]/enhancements`,
  `/oo/classes/{c}/enhancements`, `…/enhancements/elements`, the generated `…============E`
  include). Every one is an empty root, a 404, or a 500.

### 7. One `<enh:elements>` container PER PLUG-IN, not one holding them all

The feed for `LOM_GEN_OVERVIEWF01` (ENHO `ZENH_FORM_DEMO`, one FORM, two hooks) returns:

```xml
<enh:enhancementImplementations adtcore:name="ZENH_FORM_DEMO" …>
  <enh:elements><enh:sourceCodePlugin enh:id="2 " …BEGIN…/></enh:elements>
  <enh:elements><enh:sourceCodePlugin enh:id="1 " …END…/></enh:elements>
  <enh:enhancedObject …/>
</enh:enhancementImplementations>
```

Two SIBLING containers. The parser read `impl.elements` as a single node and fell back to
`findDeepNodes`, which returns the first match only — so every second-and-later hook of an
implementation was dropped. It looked like "dynamic hooks in FORM routines return nothing" because
in both affected objects the dynamic hook happened to be the second element; the same feed serves
static and dynamic alike, and dynamic hooks in function modules and includes were never affected.
Fixed by flattening `toRecordArray(impl.elements).flatMap(…)`.

Two mode fields, deliberately kept apart: `ENHINCINX~ENHMODE` (`S`/`D`) is authoritative and is
surfaced as `anchors[].mode`; the feed's own `enh:mode` is reported verbatim on the plug-in and says
`any` for hooks that ENHINCINX marks `D`.

### 8. The per-plug-in resource is not an API on 7.50 — for ANY anchor

`/sap/bc/adt/enhancements/implementations/{enh}/elements/sourcecodeplugins/{escaped fullName}` 404s
for a class anchor (`ZENH_CLASS_DEMO` / `\TY:…\ME:GET_EMPLOYEENUMBER_FROM_USER\SE:%_BEGIN\EI`) —
and equally for program anchors whose coding ARC-1 *does* retrieve through the sub-object feed. So
it is not a class-specific gap: the URI in `enh:uri` is an identifier the enhancement editor
resolves internally, not a readable resource. Class-enhancement coding has no ADT reader here; the
generated `{ENHANCEMENT}======EIMP` include exists in `REPOSRC` (2.5–39 KB) but ADT 500s on it and
`REPOSRC~DATA` is compressed.

### 9. Method exits (pre / post / overwrite) are not derivable on 7.50

SE24 shows the exit type per method (tab *Methoden*, column *Overwrite-Exit*). The type lives in the
GENERATED method name inside the enhancement include — `IPR_<enh>~<method>` pre, `IPO_` post,
`IOW_` overwrite. Everything that could expose it was tried and fails:

| Route | Result |
|---|---|
| `/programs/includes/{ENH}=====E/source/main` (name padded to 30 chars + `E`), with and without the class pool as `context` | 500 `Resource PROGRAM … could not be successfully read` |
| the same include, `/versions` | 404 |
| `/programs/programs/{CLASSPOOL}/source/main` | 500 |
| `/repository/objectstructure?objectname={CLASSPOOL}&objecttype=PROG/P` | 500 `Object type OU is not defined` |
| `/oo/classes/{class}/objectstructure` | class members only — no `IPR_`/`IPO_`/`IOW_` |
| `ENHCROSS` — columns `METHTYPE`, `METHOD_NAME`, `INT_NAME`, `ENHHOOKTYPE`, exactly the right shape | **empty system-wide** |
| `ENHA_TMDIR`, `SEOCOMPO`, `TMDIR`, `ENHINCINX~OVERWRITE` | empty / not applicable |

The include name is the enhancement padded to **30** characters with `=`, then `E` (declarations)
or `EIMP` (implementations) — take it from `REPOSRC`, which lists it verbatim, and never from the
HTTP status: the reader answers 500 for the correct name and for a deliberately mis-padded one
alike. An earlier note in this file claimed a mis-padded name gives 404; that was a comparison of
two different objects on two different request paths and is wrong.

`ENHINCINX~METHOD = 'X'` is the only field that varies between method anchors — 15 of ~29k rows on
the reference system, always on anchors carrying a `\ME:` part, on class-own AND interface methods
alike. On the one anchor with SE24 ground truth (an overwrite exit) it is EMPTY, while a pre/post
exit on the same class has it set. That is consistent with *"the enhancement sits inside an existing
method body"* versus *"the enhancement IS the method"* — but it is a single sample, and SAP's
switch-check classes contribute thousands of `METHOD = ''` method anchors that are not overwrites.
ARC-1 reports the flag verbatim as `anchors[].inMethodBody` and derives NO exit type from it: a
wrong overwrite label is worse for a migration assessment than an absent one.

Surfaced for class anchors instead: `class`, `method`, `interface`, `section`.

## What ARC-1 does with this

- `src/adt/enhancements.ts` owns the domain: discovery-ordered collection candidates for ENHO/ENHS,
  the workbench-wrapper fallback, the feed URL builder, the anchor derivation, and the parsers.
- `SAPRead(type="ENHO")` resolves in this order:
  1. metadata from `enhoxhb` → `enhoxh` (discovery-first; 404/406/415 falls through),
  2. on 500, metadata from the VIT workbench wrapper,
  3. the enhanced object from the payload if it names one, else from `ENHINCINX` — gated on free
     SQL, exactly like the TRAN program lookup,
  4. the coding from each distinct enhanced object's feed, keeping only entries whose
     `adtcore:name` is this ENHO.
  Every step after 1 is best effort; an empty result carries a `sourceHint` saying which of the
  three reasons applies (class anchors / unresolved object / feed had nothing).
- `SAPRead(type="ENHS")` reads spots (`enhsxsb` → `enhsxs`, discovery-first) and structures their
  BAdI definitions (interface, single-use, filters); raw XML only for an unrecognized envelope.
- Unrecognized payloads return the raw XML in `raw` instead of an empty structure.

## Follow-ups

- The `enhoxh` v1 metadata shape is still uncaptured — 7.50 dumps before emitting it. On a 7.53+
  system it should be recorded as a fixture and the parser tightened if the envelope differs from
  `<enho:objectData>`.
- Class-enhancement coding: re-test on 7.58+/S4 before concluding ADT never serves it.
- The forward direction ("which enhancements sit in this PROG/INCL?") is one client call away
  (`getObjectEnhancements`) but is not exposed as a tool surface yet — see
  `docs/compare/abap-adt-api/evaluations/enho-splicing-include-expansion.md`.
- `src/probe/catalog.ts` still probes `enhoxhb`; pointing it at `enhoxh` needs re-recorded A4H + NPL
  fixtures (the replay asserts zero unavailable types).
