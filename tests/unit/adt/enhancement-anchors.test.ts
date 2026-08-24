/**
 * Anchor resolution: turning ENHINCINX rows into the enhancement-feed requests that actually
 * carry coding. Every row and URI below is verbatim from the live NW 7.50 system
 * (2026-08-23) — see docs/research/2026-08-22-enho-adt-surface.md.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  anchorFeedTargets,
  enhancementIncludeName,
  feedTargetFromSourceUri,
  parseEnhancementAnchors,
  parseEnhancementMethodExits,
  parseSubroutineNodes,
  resolveAnchorFeedTargets,
} from '../../../src/adt/enhancements.js';

const row = (fullName: string, programName: string) => ({
  ENHNAME: 'ZE',
  PROGRAMNAME: programName,
  FULL_NAME: fullName,
});

/** Two `<projectexplorer:node>` entries in the shape the repository objectstructure returns. */
const objectStructureXml = (nodes: Array<{ description: string; type: string; uri: string }>) =>
  `<projectexplorer:objectstructure xmlns:projectexplorer="http://www.sap.com/adt/projectexplorer">${nodes
    .map(
      (n) =>
        `<projectexplorer:node isfolder="false" description="${n.description}" objecttype="${n.type}" objecturi="${n.uri}"/>`,
    )
    .join(
      '',
    )}<projectexplorer:node isfolder="true" description="Subroutines" objecttype="PROG/PU"/></projectexplorer:objectstructure>`;

describe('enhancement anchor classification', () => {
  it('classifies each FULL_NAME shape seen on the live system', () => {
    const anchors = parseEnhancementAnchors([
      row('\\PR:SAPFP51T\\IC:RPTMOZ00\\SE:END\\EI', 'SAPFP51T'),
      row('\\IC:H99CWTR0_FORMS\\EX:CHANGE_DRIVER_CODE\\EI', 'H99CWTR0'),
      row('\\PR:ZDEMO_REPORT\\FO:CHECK_EXPORT_3X\\SE:BEGIN\\EI', 'ZDEMO_REPORT'),
      row('\\FU:CATS_SAVE_CATSDB\\SE:BEGIN\\EI', 'SAPLCATSTOOLS'),
      row(
        '\\TY:CL_HCMFAB_EMPLOYEE_API\\ME:GET_EMPLOYEENUMBER_FROM_USER\\SE:%_BEGIN\\EI',
        'CL_HCMFAB_EMPLOYEE_API========CP',
      ),
      row('\\TY:CL_X\\SE:PUBLIC\\SE:END\\EI', 'CL_X=========================CP'),
    ]);
    expect(anchors.map((a) => a.kind)).toEqual(['include', 'include', 'form', 'functionModule', 'class', 'class']);
    expect(anchors[2]?.member).toBe('CHECK_EXPORT_3X');
    expect(anchors[3]?.member).toBe('CATS_SAVE_CATSDB');
  });

  it('carries the ENHINCINX mode, which the feed does not report faithfully', () => {
    // The feed says enh:mode="any" for hooks that ENHINCINX marks D, so both values are kept:
    // anchors[].mode is authoritative, sourceCodePlugins[].mode is SAP's feed value verbatim.
    const anchors = parseEnhancementAnchors([
      {
        ENHNAME: 'ZE',
        PROGRAMNAME: 'SAPLOM_GEN_OVERVIEW',
        ENHMODE: 'D',
        FULL_NAME: '\\PR:SAPLOM_GEN_OVERVIEW\\FO:GET_FCODES_PER_OTYPE\\SE:END\\EI',
      },
      {
        ENHNAME: 'ZE',
        PROGRAMNAME: 'SAPLOM_GEN_OVERVIEW',
        ENHMODE: 'S',
        FULL_NAME: '\\PR:SAPLOM_GEN_OVERVIEW\\FO:GET_FCODES_PER_OTYPE\\SE:BEGIN\\EI',
      },
      { ENHNAME: 'ZE', PROGRAMNAME: 'ZP', ENHMODE: '', FULL_NAME: '\\PR:ZP\\IC:ZI\\SE:END\\EI' },
    ]);
    expect(anchors.map((a) => a.mode)).toEqual(['dynamic', 'static', undefined]);
    // Both hooks of the same routine are FORM anchors — the pair that exposed the parser bug.
    expect(anchors.map((a) => a.kind)).toEqual(['form', 'form', 'include']);
  });

  it('names the class, method and interface a class anchor touches', () => {
    // Rows verbatim from the reference system: a declaration section, a class-own method with
    // ENHINCINX~METHOD set, and an interface method (the one SE24 shows as an overwrite exit).
    const anchors = parseEnhancementAnchors([
      {
        ENHNAME: 'ZE',
        PROGRAMNAME: 'CL_DEMO_DPC_EXTCP',
        ENHMODE: 'S',
        METHOD: '',
        FULL_NAME: '\\TY:CL_DEMO_DPC_EXT\\SE:PUBLIC\\SE:END\\EI',
      },
      {
        ENHNAME: 'ZE',
        PROGRAMNAME: 'CL_DEMO_DPC_EXTCP',
        ENHMODE: 'D',
        METHOD: 'X',
        FULL_NAME: '\\TY:CL_DEMO_DPC_EXT\\ME:ENRICH_REQUEST\\SE:%_BEGIN\\EI',
      },
      {
        ENHNAME: 'ZE',
        PROGRAMNAME: 'CL_DEMO_DPC_EXTCP',
        ENHMODE: 'D',
        METHOD: '',
        FULL_NAME: '\\TY:CL_DEMO_DPC_EXT\\IN:IF_DEMO_RUNTIME\\ME:CHANGESET_PROCESS\\SE:%_BEGIN\\EI',
      },
    ]);

    expect(anchors.map((a) => a.kind)).toEqual(['class', 'class', 'class']);
    expect(anchors[0]).toMatchObject({ class: 'CL_DEMO_DPC_EXT', section: 'PUBLIC' });
    expect(anchors[0]?.method).toBeUndefined();
    expect(anchors[1]).toMatchObject({ method: 'ENRICH_REQUEST', inMethodBody: true });
    expect(anchors[1]?.interface).toBeUndefined();
    expect(anchors[2]).toMatchObject({ method: 'CHANGESET_PROCESS', interface: 'IF_DEMO_RUNTIME' });
    // The flag is absent on this one — which is what makes it an overwrite; see the exitType test.
    expect(anchors[2]?.inMethodBody).toBeUndefined();
  });

  it('separates overwrite exits from the pre/post pair via ENHINCINX~METHOD', () => {
    // Verified against SE24 in both directions: an empty flag on a method anchor is an OVERWRITE
    // (customer redefinition and SAP switch-check method both confirmed), 'X' is a pre/post exit.
    // The flag cannot split pre from post — only the generated method name does that.
    const anchors = parseEnhancementAnchors([
      {
        ENHNAME: 'ZE',
        PROGRAMNAME: 'CL_DEMO_DPC_EXTCP',
        ENHMODE: 'D',
        METHOD: '',
        FULL_NAME: '\\TY:CL_DEMO_DPC_EXT\\IN:IF_DEMO_RUNTIME\\ME:CHANGESET_PROCESS\\SE:%_BEGIN\\EI',
      },
      {
        ENHNAME: 'ZE',
        PROGRAMNAME: 'CL_DEMO_DPC_EXTCP',
        ENHMODE: 'D',
        METHOD: 'X',
        FULL_NAME: '\\TY:CL_DEMO_DPC_EXT\\ME:ENRICH_REQUEST\\SE:%_BEGIN\\EI',
      },
      {
        ENHNAME: 'ZE',
        PROGRAMNAME: 'CL_DEMO_DPC_EXTCP',
        ENHMODE: 'S',
        METHOD: '',
        FULL_NAME: '\\TY:CL_DEMO_DPC_EXT\\SE:PUBLIC\\SE:END\\EI',
      },
    ]);

    expect(anchors.map((a) => a.exitType)).toEqual(['overwrite', 'pre-or-post', undefined]);
    // A declaration-section anchor enhances no method at all and must stay untyped.
    expect(anchors[2]?.method).toBeUndefined();
  });
  it('treats an UNPADDED class pool as a class', () => {
    // CL_HCMFAB_TIMESHEET_CR_DPC_EXT already fills 30 characters, so the pool carries no `=`
    // padding. With a padding-required pattern this anchor was mis-typed as a plain include and
    // ARC-1 then asked a program URI that does not exist.
    const anchors = parseEnhancementAnchors([
      row(
        '\\PR:CL_HCMFAB_TIMESHEET_CR_DPC_EXTCP\\IC:CL_HCMFAB_TIMESHEET_CR_DPC_EXTCCIMP\\SE:END\\EI',
        'CL_HCMFAB_TIMESHEET_CR_DPC_EXTCP',
      ),
    ]);
    expect(anchors[0]?.kind).toBe('class');
    expect(anchorFeedTargets(anchors)).toEqual([]);
  });
});

describe('feedTargetFromSourceUri', () => {
  it('keeps the context the object structure already encoded and drops the fragment', () => {
    expect(
      feedTargetFromSourceUri(
        '/sap/bc/adt/programs/includes/rpcipe03_old/source/main?context=%2fsap%2fbc%2fadt%2fprograms%2fprograms%2fzdemo_report#start=21,5',
        '/fallback',
      ),
    ).toEqual({
      objectUri: '/sap/bc/adt/programs/includes/rpcipe03_old/source/main',
      context: '/sap/bc/adt/programs/programs/zdemo_report',
    });
  });

  it('falls back to the container context when the URI carries none', () => {
    expect(
      feedTargetFromSourceUri(
        '/sap/bc/adt/functions/groups/hrbas00search_internal/includes/lhrbas00search_internalf50/source/main#start=11,5',
        '/sap/bc/adt/functions/groups/hrbas00search_internal',
      ),
    ).toEqual({
      objectUri: '/sap/bc/adt/functions/groups/hrbas00search_internal/includes/lhrbas00search_internalf50/source/main',
      context: '/sap/bc/adt/functions/groups/hrbas00search_internal',
    });
  });
});

describe('parseSubroutineNodes', () => {
  it('maps FORM names to their include URI and ignores folders and non-subroutines', () => {
    const forms = parseSubroutineNodes(
      objectStructureXml([
        {
          description: 'CHECK_EXPORT_3X',
          type: 'PROG/PU',
          uri: '/sap/bc/adt/programs/includes/rpcipe03_old/source/main',
        },
        { description: 'NATIVE_SQL', type: 'FUGR/PD', uri: '/sap/bc/adt/programs/includes/other/source/main' },
      ]),
    );
    expect(forms.get('CHECK_EXPORT_3X')).toBe('/sap/bc/adt/programs/includes/rpcipe03_old/source/main');
    expect(forms.has('NATIVE_SQL')).toBe(false);
  });
});

describe('resolveAnchorFeedTargets', () => {
  it('resolves a function-module anchor through its group', async () => {
    const deps = {
      getObjectStructure: vi.fn(),
      resolveFunctionGroup: vi.fn().mockResolvedValue('CATSTOOLS'),
    };
    const anchors = parseEnhancementAnchors([row('\\FU:CATS_SAVE_CATSDB\\SE:BEGIN\\EI', 'SAPLCATSTOOLS')]);

    expect(await resolveAnchorFeedTargets(deps, anchors)).toEqual([
      {
        objectUri: '/sap/bc/adt/functions/groups/catstools/fmodules/cats_save_catsdb/source/main',
        context: '/sap/bc/adt/functions/groups/catstools',
      },
    ]);
    expect(deps.getObjectStructure).not.toHaveBeenCalled();
  });

  it('finds the include holding a FORM instead of asking the main program', async () => {
    const deps = {
      getObjectStructure: vi.fn().mockResolvedValue(
        objectStructureXml([
          {
            description: 'CHECK_EXPORT_3X',
            type: 'PROG/PU',
            uri: '/sap/bc/adt/programs/includes/rpcipe03_old/source/main?context=%2fsap%2fbc%2fadt%2fprograms%2fprograms%2fzdemo_report#start=21,5',
          },
        ]),
      ),
      resolveFunctionGroup: vi.fn(),
    };
    const anchors = parseEnhancementAnchors([
      row('\\PR:ZDEMO_REPORT\\FO:CHECK_EXPORT_3X\\SE:BEGIN\\EI', 'ZDEMO_REPORT'),
    ]);

    expect(await resolveAnchorFeedTargets(deps, anchors)).toEqual([
      {
        objectUri: '/sap/bc/adt/programs/includes/rpcipe03_old/source/main',
        context: '/sap/bc/adt/programs/programs/zdemo_report',
      },
    ]);
    expect(deps.getObjectStructure).toHaveBeenCalledWith('PROG/P', 'ZDEMO_REPORT');
  });

  it('reads a FORM inside a function group as FUGR/F, once per container', async () => {
    const deps = {
      getObjectStructure: vi.fn().mockResolvedValue(
        objectStructureXml([
          {
            description: 'F4_CALLBACK_SHLP',
            type: 'FUGR/PU',
            uri: '/sap/bc/adt/functions/groups/hrbas00search_internal/includes/lhrbas00search_internalf50/source/main#start=11,5',
          },
          {
            description: 'OTHER_FORM',
            type: 'FUGR/PU',
            uri: '/sap/bc/adt/functions/groups/hrbas00search_internal/includes/lhrbas00search_internalf60/source/main',
          },
        ]),
      ),
      resolveFunctionGroup: vi.fn(),
    };
    const anchors = parseEnhancementAnchors([
      row('\\PR:SAPLHRBAS00SEARCH_INTERNAL\\FO:F4_CALLBACK_SHLP\\SE:END\\EI', 'SAPLHRBAS00SEARCH_INTERNAL'),
      row('\\PR:SAPLHRBAS00SEARCH_INTERNAL\\FO:OTHER_FORM\\SE:END\\EI', 'SAPLHRBAS00SEARCH_INTERNAL'),
    ]);

    const targets = await resolveAnchorFeedTargets(deps, anchors);
    expect(deps.getObjectStructure).toHaveBeenCalledTimes(1);
    expect(deps.getObjectStructure).toHaveBeenCalledWith('FUGR/F', 'HRBAS00SEARCH_INTERNAL');
    expect(targets).toHaveLength(2);
    expect(targets[0]).toEqual({
      objectUri: '/sap/bc/adt/functions/groups/hrbas00search_internal/includes/lhrbas00search_internalf50/source/main',
      context: '/sap/bc/adt/functions/groups/hrbas00search_internal',
    });
  });

  it('drops an anchor whose lookup fails instead of failing the whole read', async () => {
    const deps = {
      getObjectStructure: vi.fn().mockRejectedValue(new Error('boom')),
      resolveFunctionGroup: vi.fn().mockResolvedValue(null),
    };
    const anchors = parseEnhancementAnchors([
      row('\\PR:ZDEMO_REPORT\\FO:CHECK_EXPORT_3X\\SE:BEGIN\\EI', 'ZDEMO_REPORT'),
      row('\\FU:CATS_SAVE_CATSDB\\SE:BEGIN\\EI', 'SAPLCATSTOOLS'),
      row('\\PR:SAPFP51T\\IC:RPTMOZ00\\SE:END\\EI', 'SAPFP51T'),
    ]);

    // The direct include anchor still produces its target.
    expect(await resolveAnchorFeedTargets(deps, anchors)).toEqual([
      {
        objectUri: '/sap/bc/adt/programs/includes/rptmoz00',
        context: '/sap/bc/adt/programs/programs/sapfp51t',
      },
    ]);
  });
});

describe('enhancementIncludeName', () => {
  it('pads the enhancement name to 30 characters, then E / EIMP', () => {
    // The 30-character padding is confirmed against REPOSRC, which lists exactly these names.
    // ADT's include reader answers 500 for the correct name AND for a mis-padded one, so the
    // status cannot be used to check the name — only REPOSRC can.
    expect(enhancementIncludeName('ZENH_CLASS_DEMO')).toBe('ZENH_CLASS_DEMO===============E');
    expect(enhancementIncludeName('ZENH_CLASS_DEMO', 1)).toBe('ZENH_CLASS_DEMO===============EIMP');
    expect(enhancementIncludeName('zenh_class_demo')).toHaveLength(31);
  });
});

describe('parseEnhancementMethodExits', () => {
  it('reads the exit type out of the generated method name', () => {
    // SAP encodes pre/post/overwrite ONLY in the name; the declaration include holds the headers.
    const source = [
      'CLASS zenh_class_demo DEFINITION.',
      '  METHODS ipr_zenh_class_demo~enrich_request.',
      '  METHODS ipo_zenh_class_demo~build_response.',
      '  METHODS iow_zenh_class_demo~changeset_process.',
      'ENDCLASS.',
    ].join(String.fromCharCode(10));

    expect(parseEnhancementMethodExits(source)).toEqual([
      { method: 'ENRICH_REQUEST', enhancement: 'ZENH_CLASS_DEMO', exitType: 'pre' },
      { method: 'BUILD_RESPONSE', enhancement: 'ZENH_CLASS_DEMO', exitType: 'post' },
      { method: 'CHANGESET_PROCESS', enhancement: 'ZENH_CLASS_DEMO', exitType: 'overwrite' },
    ]);
  });

  it('also reads implementation bodies and de-duplicates', () => {
    const source = [
      'METHOD iow_zenh_class_demo~changeset_process.',
      '  " the interface prefix is dropped in the generated name',
      'ENDMETHOD.',
      'METHOD iow_zenh_class_demo~changeset_process.',
      'ENDMETHOD.',
    ].join(String.fromCharCode(10));
    expect(parseEnhancementMethodExits(source)).toEqual([
      { method: 'CHANGESET_PROCESS', enhancement: 'ZENH_CLASS_DEMO', exitType: 'overwrite' },
    ]);
  });

  it('ignores source without generated exit methods', () => {
    expect(parseEnhancementMethodExits('METHOD changeset_process. ENDMETHOD.')).toEqual([]);
  });
});
