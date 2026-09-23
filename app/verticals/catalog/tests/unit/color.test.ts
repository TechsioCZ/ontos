import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  ColorHistoricalReferenceSchema,
  ColorRevisionDecisionSchema,
  ColorSchema,
  lookupColorLocalizedName,
  sameColorIdentity,
} from '../../shared/domain/color.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const colorRef = (resourceId: string, scopedTenantId = tenantId) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType: 'commerce.catalog.controlled-attribute-value',
  tenantId: scopedTenantId,
});
const firstRef = colorRef('22222222-2222-4222-8222-222222222222');
const secondRef = colorRef('33333333-3333-4333-8333-333333333333');
const evidence = {
  description: 'Matte anthracite sample A',
  kind: 'OTHER' as const,
  source: 'Approved physical sample',
  sourceScope: 'Manufacturer A, 2026 finish range',
};
const first = {
  displayName: 'Anthracite',
  distinctionEvidence: evidence,
  groupName: 'Grey',
  preview: { hex: '#333333', kind: 'HEX' as const },
  ref: firstRef,
};

describe('Catalog Color meaning', () => {
  it('does not infer identity from names, groups, or identical previews', () => {
    const a = Schema.decodeUnknownSync(ColorSchema)(first);
    const b = Schema.decodeUnknownSync(ColorSchema)({ ...first, ref: secondRef });
    expect(sameColorIdentity(a, b)).toBe(false);
    expect(a.preview).toEqual(b.preview);
    expect(
      sameColorIdentity(a, { ...a, ref: colorRef(firstRef.resourceId, '99999999-9999-4999-8999-999999999999') }),
    ).toBe(false);
  });

  it('supports a scoped swatch or independently evidenced Color, but rejects incomplete provenance', () => {
    expect(Schema.is(ColorSchema)(first)).toBe(true);
    const swatch = {
      ...first,
      distinctionEvidence: {
        designation: '7016',
        kind: 'SWATCH',
        source: 'Supplier chart',
        sourceScope: 'Manufacturer A powder coat',
        system: 'RAL',
      },
    };
    expect(Schema.is(ColorSchema)(swatch)).toBe(true);
    expect(
      Schema.is(ColorSchema)({ ...swatch, distinctionEvidence: { ...swatch.distinctionEvidence, sourceScope: ' ' } }),
    ).toBe(false);
    expect(Schema.is(ColorSchema)({ ...first, preview: { hex: '#xyzxyz', kind: 'HEX' } })).toBe(false);
  });

  it('keeps locale-specific names separate from identity and does not invent translations', () => {
    const color = Schema.decodeUnknownSync(ColorSchema)({
      ...first,
      localizedNames: [
        { locale: 'en', name: 'Anthracite' },
        { locale: 'cs', name: 'Antracit' },
      ],
    });
    expect(lookupColorLocalizedName(color, 'cs')?.name).toBe('Antracit');
    expect(lookupColorLocalizedName(color, 'de')).toBeUndefined();
    expect(sameColorIdentity(color, { ...color, displayName: 'Dark grey', localizedNames: [] })).toBe(true);
    expect(
      Schema.is(ColorSchema)({
        ...color,
        localizedNames: [
          { locale: 'en', name: 'Anthracite' },
          { locale: 'cs', name: 'Antracit' },
          { locale: 'cs', name: 'Šedá' },
        ],
      }),
    ).toBe(false);
  });

  it('allows an evidenced same-meaning rename while requiring a new identity for changed meaning', () => {
    const rename = {
      after: { ...first, displayName: 'Snow anthracite' },
      before: first,
      reviewEvidence: 'Reviewed same finish specification',
      samePhysicalMeaningConfirmed: true,
    };
    expect(Schema.is(ColorRevisionDecisionSchema)(rename)).toBe(true);
    expect(Schema.is(ColorRevisionDecisionSchema)({ ...rename, after: { ...rename.after, ref: secondRef } })).toBe(
      false,
    );
    expect(Schema.is(ColorRevisionDecisionSchema)({ ...rename, samePhysicalMeaningConfirmed: false })).toBe(false);
    expect(
      Schema.is(ColorRevisionDecisionSchema)({
        ...rename,
        after: { ...rename.after, ref: secondRef },
        samePhysicalMeaningConfirmed: false,
      }),
    ).toBe(true);
    expect(Schema.is(ColorRevisionDecisionSchema)({ ...rename, reviewEvidence: '' })).toBe(false);
  });

  it('retains accepted display and evidence without following later current metadata', () => {
    const historical = Schema.decodeUnknownSync(ColorHistoricalReferenceSchema)({
      acceptedDisplayName: first.displayName,
      acceptedDistinctionEvidence: first.distinctionEvidence,
      colorRef: firstRef,
    });
    expect(historical.colorRef).toEqual(firstRef);
    expect(historical.acceptedDisplayName).toBe('Anthracite');
    expect(
      Schema.is(ColorHistoricalReferenceSchema)({
        ...historical,
        colorRef: { ...firstRef, resourceType: 'commerce.catalog.product' },
      }),
    ).toBe(false);
  });
});
