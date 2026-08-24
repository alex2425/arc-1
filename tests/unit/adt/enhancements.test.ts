/**
 * Enhancement framework (ENHO / ENHS) parser tests.
 *
 * Payload shapes are captured from real systems — see the fixture headers and
 * docs/research/2026-08-22-enho-adt-surface.md.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  anchorFeedTargets,
  parseEnhancementAnchors,
  parseEnhancementImplementation,
  parseEnhancementSpot,
  parseObjectEnhancements,
  parseWorkbenchEnhancementMetadata,
} from '../../../src/adt/enhancements.js';

const fixturesDir = join(import.meta.dirname, '../../fixtures/xml');
const loadFixture = (name: string) => readFileSync(join(fixturesDir, name), 'utf-8');

describe('enhancement parsers', () => {
  // ─── parseEnhancementImplementation ──────────────────────────────

  describe('parseEnhancementImplementation', () => {
    it('parses enhancement implementation metadata from real SAP fixture', () => {
      const xml = loadFixture('enhancement-implementation.xml');
      const enho = parseEnhancementImplementation(xml);
      expect(enho.name).toBe('SFW_BCF_TCD');
      expect(enho.description).toBe('TCD Lookup, Assignment...');
      expect(enho.package).toBe('SFWTOOLS');
      expect(enho.technology).toBe('BADI_IMPL');
      expect(enho.switchSupported).toBe(true);
      expect(enho.badiImplementations).toHaveLength(2);
      expect(enho.badiImplementations[0]).toEqual({
        name: 'SFW_TCD',
        shortText: 'Implementierung: BCF: BADI für TCD Remote Service',
        implementingClass: 'CL_SFW_TCD',
        badiDefinition: 'BCF_TCD_REMOTE_BADI',
        enhancementSpot: 'BCF_REMOTE_TCD',
        active: true,
        default: false,
      });
      expect(enho.badiImplementations[1]?.default).toBe(true);
      expect(enho.badiImplementations[1]?.active).toBe(false);
    });

    it('extracts the enhanced object and its main program from contentCommon usages', () => {
      const xml = loadFixture('enhancement-implementation.xml');
      const enho = parseEnhancementImplementation(xml);
      // The BAdI fixture points at its enhancement spot; a source plug-in points at the
      // enhanced include, with mainObjectReference naming the main program.
      expect(enho.enhancedObject).toEqual({
        name: 'BCF_REMOTE_TCD',
        type: 'ENHS/XSB',
        uri: '/sap/bc/adt/enhancements/enhsxsb/bcf_remote_tcd',
      });
      expect(enho.mainObject?.name).toBe('BCF_REMOTE_TCD');
    });

    it('returns the raw XML when the payload is not an objectData envelope', () => {
      // A release whose representation we have not mapped must not lose the response.
      const xml = '<enho:somethingElse xmlns:enho="http://www.sap.com/adt/enhancements/enho" name="Z"/>';
      const enho = parseEnhancementImplementation(xml);
      expect(enho.raw).toBe(xml);
      expect(enho.badiImplementations).toEqual([]);
    });

    it('handles minimal enhancement implementation XML', () => {
      const xml =
        '<enho:objectData xmlns:enho="http://www.sap.com/adt/enhancements/enho" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZENHO" adtcore:description="Test"/>';
      const enho = parseEnhancementImplementation(xml);
      expect(enho.name).toBe('ZENHO');
      expect(enho.description).toBe('Test');
      expect(enho.package).toBe('');
      expect(enho.technology).toBe('');
      expect(enho.badiImplementations).toEqual([]);
    });
  });

  // ─── parseObjectEnhancements ──────────────────────────────────────

  describe('parseObjectEnhancements', () => {
    it('decodes the base64 coding of a source-code plug-in (live 7.50 shape)', () => {
      const impls = parseObjectEnhancements(loadFixture('object-enhancements.xml'));
      expect(impls).toHaveLength(1);
      expect(impls[0]).toMatchObject({
        name: 'ZENH_HOOK_DEMO',
        type: 'ENHO/XH',
        version: 'active',
        enhancedObject: {
          name: 'SAPFP51T',
          type: 'PROG/P',
          uri: '/sap/bc/adt/programs/programs/sapfp51t',
        },
      });

      const plugin = impls[0]?.elements[0];
      expect(plugin?.fullName).toBe('\\PR:SAPFP51T\\IC:RPTMOZ00\\SE:END\\EI');
      expect(plugin?.id).toBe('1');
      expect(plugin?.mode).toBe('static');
      expect(plugin?.replacing).toBe(false);
      expect(plugin?.source).toContain('ENHANCEMENT 1 zenh_hook_demo.');
      expect(plugin?.source?.trimEnd().endsWith('ENDENHANCEMENT.')).toBe(true);
      // The insertion point of the plug-in inside the enhanced source.
      expect(plugin?.position).toMatchObject({ line: 1310, column: 0 });
    });

    it('collects plug-ins from EVERY sibling elements container', () => {
      // SAP wraps each plug-in in its own <enh:elements>. Reading only the first dropped the
      // second hook of a routine — the bug behind 'dynamic FORM anchors return nothing'.
      const impls = parseObjectEnhancements(loadFixture('object-enhancements-two-hooks.xml'));
      expect(impls).toHaveLength(1);
      expect(impls[0]?.elements).toHaveLength(2);
      expect(impls[0]?.elements.map((e) => e.id)).toEqual(['2', '1']);
      expect(impls[0]?.elements[0]?.source).toContain('data ls_fcodes_per_otype');
      expect(impls[0]?.elements[1]?.source).toContain('LOOP AT p_fcodes_per_otype');
      expect(impls[0]?.elements[1]?.position?.line).toBe(549);
    });
    it('returns an empty list for an object with no enhancements', () => {
      expect(parseObjectEnhancements(loadFixture('object-enhancements-empty.xml'))).toEqual([]);
    });

    it('accepts the newer full_name attribute spelling', () => {
      const xml =
        '<enh:enhancements xmlns:enh="http://www.sap.com/adt/abapsource/enhancements" ' +
        'xmlns:adtcore="http://www.sap.com/adt/core">' +
        '<enh:enhancementImplementations adtcore:name="ZE" adtcore:type="ENHO/XH">' +
        '<enh:elements><enh:sourceCodePlugin enh:full_name="\\PR:Z\\SE:END\\EI" enh:mode="static"/>' +
        '</enh:elements></enh:enhancementImplementations></enh:enhancements>';
      expect(parseObjectEnhancements(xml)[0]?.elements[0]?.fullName).toBe('\\PR:Z\\SE:END\\EI');
    });
  });

  // ─── parseEnhancementSpot ─────────────────────────────────────────

  describe('parseEnhancementSpot', () => {
    it('structures the BAdI definitions of a real spot payload', () => {
      const spot = parseEnhancementSpot(loadFixture('enhancement-spot.xml'));
      expect(spot).toMatchObject({
        name: 'ZENH_SPOT_DEMO',
        package: 'ZENH_DEMO',
        technology: 'BADI_DEF',
      });
      // XML entities are decoded for the human-readable fields.
      expect(spot.description).toBe('Data export & ' + String.fromCharCode(252) + 'bersicht');
      expect(spot.badiDefinitions).toHaveLength(1);
      expect(spot.badiDefinitions?.[0]).toMatchObject({
        name: 'ZENH_BADI_DEMO',
        interface: 'ZENH_BADI_IF_DEMO',
        singleUse: true,
        useFallbackClass: false,
        filters: [{ name: 'FIELDNAME', type: 'S', shortText: 'Name of the export field' }],
      });
      // A recognized envelope is returned structured only — no duplicate raw copy.
      expect(spot.raw).toBeUndefined();
    });

    it('returns the raw XML when the spot envelope is unrecognized', () => {
      const xml = '<enhs:somethingElse xmlns:enhs="http://www.sap.com/adt/enhancements/enhs" name="Z"/>';
      const spot = parseEnhancementSpot(xml);
      expect(spot.raw).toBe(xml);
      expect(spot.badiDefinitions).toBeUndefined();
    });
  });

  // ─── parseEnhancementAnchors (ENHINCINX rows) ─────────────────────
  //
  // Rows below are verbatim from the live 7.50 system (2026-08-22).

  describe('parseEnhancementAnchors', () => {
    it('maps an include hook to the include URI with its main program as context', () => {
      const anchors = parseEnhancementAnchors([
        { ENHNAME: 'ZENH_HOOK_DEMO', PROGRAMNAME: 'SAPFP51T', FULL_NAME: '\\PR:SAPFP51T\\IC:RPTMOZ00\\SE:END\\EI' },
      ]);
      expect(anchors).toEqual([
        {
          fullName: '\\PR:SAPFP51T\\IC:RPTMOZ00\\SE:END\\EI',
          mainProgram: 'SAPFP51T',
          kind: 'include',
          enhancedObjectUri: '/sap/bc/adt/programs/includes/rptmoz00',
          contextUri: '/sap/bc/adt/programs/programs/sapfp51t',
        },
      ]);
    });

    it('maps a program-level hook to the program itself', () => {
      const anchors = parseEnhancementAnchors([
        { ENHNAME: 'ZE', PROGRAMNAME: 'ZREPORT', FULL_NAME: '\\PR:ZREPORT\\SE:END\\EI' },
      ]);
      expect(anchors[0]).toMatchObject({
        kind: 'program',
        enhancedObjectUri: '/sap/bc/adt/programs/programs/zreport',
        contextUri: '/sap/bc/adt/programs/programs/zreport',
      });
    });

    it('classifies class hooks as class and gives them no feed target', () => {
      // ADT serves no coding for these on 7.50 — firing feed requests would be pure latency.
      const anchors = parseEnhancementAnchors([
        {
          ENHNAME: 'ZENH_CLASS_DEMO',
          PROGRAMNAME: 'CL_HCMFAB_EMPLOYEE_API========CP',
          FULL_NAME: '\\TY:CL_HCMFAB_EMPLOYEE_API\\ME:GET_EMPLOYEENUMBER_FROM_USER\\SE:%_BEGIN\\EI',
        },
        {
          ENHNAME: 'ZENH_CLASS_DEMO',
          PROGRAMNAME: 'CL_HCMFAB_EMPLOYEE_API========CP',
          FULL_NAME: '\\PR:CL_HCMFAB_EMPLOYEE_API========CP\\IC:CL_HCMFAB_EMPLOYEE_API========CCIMP\\SE:END\\EI',
        },
      ]);
      expect(anchors.map((a) => a.kind)).toEqual(['class', 'class']);
      expect(anchors.every((a) => a.enhancedObjectUri === undefined)).toBe(true);
      expect(anchorFeedTargets(anchors)).toEqual([]);
    });

    it('collapses repeated hooks into one feed request per object', () => {
      const anchors = parseEnhancementAnchors([
        { ENHNAME: 'ZE', PROGRAMNAME: 'SAPFP51T', FULL_NAME: '\\PR:SAPFP51T\\IC:RPTMOZ00\\SE:END\\EI' },
        { ENHNAME: 'ZE', PROGRAMNAME: 'SAPFP51T', FULL_NAME: '\\PR:SAPFP51T\\IC:RPTMOZ00\\SE:BEGIN\\EI' },
        { ENHNAME: 'ZE', PROGRAMNAME: 'SAPFP51T', FULL_NAME: '\\PR:SAPFP51T\\IC:RPTMOZ01\\SE:END\\EI' },
      ]);
      expect(anchorFeedTargets(anchors)).toEqual([
        { objectUri: '/sap/bc/adt/programs/includes/rptmoz00', context: '/sap/bc/adt/programs/programs/sapfp51t' },
        { objectUri: '/sap/bc/adt/programs/includes/rptmoz01', context: '/sap/bc/adt/programs/programs/sapfp51t' },
      ]);
    });

    it('ignores empty rows', () => {
      expect(parseEnhancementAnchors([{ ENHNAME: 'ZE', PROGRAMNAME: '', FULL_NAME: '' }])).toEqual([]);
    });
  });

  // ─── parseWorkbenchEnhancementMetadata ────────────────────────────

  describe('parseWorkbenchEnhancementMetadata', () => {
    it('maps the VIT workbench envelope served when the enhancement endpoint dumps', () => {
      // Verbatim shape from live 7.50: /sap/bc/adt/vit/wb/object_type/enhoxh/object_name/{NAME}
      const xml =
        '<adtcore:mainObject xmlns:adtcore="http://www.sap.com/adt/core" adtcore:responsible="TESTUSER" ' +
        'adtcore:name="ZENH_HOOK_DEMO" adtcore:type="ENHO/XH" adtcore:version="active">' +
        '<adtcore:packageRef adtcore:type="DEVC/K" adtcore:name="ZENH_DEMO"/></adtcore:mainObject>';
      const info = parseWorkbenchEnhancementMetadata(xml);
      expect(info).toMatchObject({
        name: 'ZENH_HOOK_DEMO',
        package: 'ZENH_DEMO',
        technology: 'ENHO/XH',
        switchSupported: false,
        badiImplementations: [],
      });
      expect(info.raw).toBe(xml);
    });
  });
});
