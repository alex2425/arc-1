# ENHO — Enhancement Implementation

## TL;DR
Canonical TADIR R3TR `ENHO` (Enhancement Implementation — BAdI implementations,
explicit/implicit enhancement source plug-ins, enhanced classes). Spelling is correct.
URL `/sap/bc/adt/enhancements/enhoxhb/<name>` + Accept
`application/vnd.sap.adt.enh.enhoxhb.v4+xml` is the **BAdI-specific** form and exists only from
7.58. NW 7.50 advertises `/sap/bc/adt/enhancements/enhoxh/<name>` with
`application/vnd.sap.adt.enh.enho.v1+xml` and 404s on `enhoxhb`, so the read must try both
(discovery-first). On-prem only in ARC-1.

## TADIR ground truth
- **R3TR type**: `ENHO`.
- **LIMU sub-objects**: ENHO has internal sub-elements (BAdI implementations, source plug-ins)
  but TADIR doesn't carry them as separate LIMU rows in the way FUGR carries FUNC.
- **abap-file-formats support**: ✅ released — `file-formats/enho/`.

## ADT slash subtypes
| Slash code | Meaning | URL prefix | Verified on |
|---|---|---|---|
| `ENHO/XH` | Enhancement Implementation (source-code plug-in / class enh.) | `/sap/bc/adt/enhancements/enhoxh/<name>` | live 7.50 2026-08-22 (tadir_lookup + ADT read) |
| `ENHO/XHB` | BAdI implementation | `/sap/bc/adt/enhancements/enhoxhb/<name>` | 7.58 fixture (`tests/fixtures/xml/enhancement-implementation.xml`) |

## SAP docs & notes
- "Enhancement Framework" (SAP Help — ABAP Workbench Tools).
- BAdI / Implicit / Explicit enhancement spots.

## Other MCP servers / cross-reference
- abap-file-formats: serializes `enho` (✅ verified in this audit's gh api dump).
- mcp-abap-abap-adt-api: `ENHO`.

## Live verification
### a4h (S/4HANA 2023)
- Probe `knownObjects: []` per `src/probe/catalog.ts:190` — no SAP-shipped ENHO universally
  guaranteed; customer-defined.

### 7.50 (NW 7.50)
- `enhoxh` available, `enhoxhb` **absent** (404) — live 7.50 2026-08-22 and the recorded NPL
  probe fixture (`tests/fixtures/probe/npl-750-sp02-dev-edition/responses/GET__sap_bc_adt_enhancements_enhoxhb.json`).
- The ENHO resource has no `/source/main`; the plug-in coding comes from the enhanced object's
  `…/source/main/enhancements?context=<main program>` feed (base64 in `<enh:source>`).

## ARC-1 current surface
| Location | Form used | Correct? |
|---|---|---|
| `handleSAPRead` (`src/handlers/read.ts`) | `case 'ENHO'` → `getEnhancementImplementation` + `withEnhancementSource` | ✅ |
| `client.getEnhancementImplementation` | `fetchEnhancementObject(http, name, ENHO_COLLECTIONS)` — `enhoxhb` then `enhoxh`, discovery-ordered | ✅ |
| `src/adt/enhancements.ts` | collections, feed URL, parsers | ✅ |
| `src/probe/catalog.ts` | still probes `enhoxhb` only — accurate for what the fixtures recorded, but reports ENHO "unavailable" on 7.50; needs re-recorded fixtures to change | ⚠️ known |
| `objectBasePath` | n/a (read-only path; no URL builder entry) | acceptable — read uses dedicated client method |

## Verdict
- **Status**: fixed 2026-08-22 (was: wrong URL on every release below 7.58)
- **Evidence**: live-verified — see [docs/research/2026-08-22-enho-adt-surface.md](../../2026-08-22-enho-adt-surface.md)
- **Issue**: the single hard-coded `enhoxhb` URL made ENHO unreadable on 7.50 (404), and the
  implementation coding was not returned at all.

## Recommendation
- Read through `src/adt/enhancements.ts` (discovery-ordered candidates), never a hard-coded URL.
- **Breaking change**: no — the response gains fields (`uri`, `enhancedObject`, `sourceCodePlugins`).
- **Test gap to close**: capture a real `enhoxh` v1 metadata payload as a fixture.
