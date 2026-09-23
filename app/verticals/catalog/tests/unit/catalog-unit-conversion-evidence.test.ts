import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  CatalogUnitConversionEvidenceSchema,
  catalogUnitConversionProves,
} from '../../shared/domain/catalog-unit-conversion-evidence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const centimetre = ref('commerce.catalog.unit', '44444444-4444-4444-8444-444444444444');
const millimetre = ref('commerce.catalog.unit', '66666666-6666-4666-8666-666666666666');
const foreignUnit = ref('commerce.catalog.unit', '77777777-7777-4777-8777-777777777777');
const metres = ref('commerce.catalog.unit', '88888888-8888-4888-8888-888888888888');
const foreignTenantUnit = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '99999999-9999-4999-8999-999999999999',
  resourceType: 'commerce.catalog.unit',
  tenantId: '99999999-9999-4999-8999-999999999999',
};
const instant = '2026-09-18T12:00:00.000Z';

const decode = Schema.decodeUnknownSync(CatalogUnitConversionEvidenceSchema, { onExcessProperty: 'error' });
interface UnitRefLike {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}
type ConversionOverrides = Partial<{
  readonly denominator: string;
  readonly evidenceId: string;
  readonly from: { readonly resourceRef: UnitRefLike; readonly revision: number };
  readonly numerator: string;
  readonly ownerModuleId: 'commerce.catalog';
  readonly source: 'CATALOG_OWNER_CURRENT_READ';
  readonly to: { readonly resourceRef: UnitRefLike; readonly revision: number };
}>;
const evidence = (overrides: ConversionOverrides = {}) =>
  decode({
    denominator: '1',
    evidenceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    from: { resourceRef: centimetre, revision: 1 },
    numerator: '10',
    observedAt: instant,
    ownerModuleId: 'commerce.catalog',
    source: 'CATALOG_OWNER_CURRENT_READ',
    to: { resourceRef: millimetre, revision: 1 },
    ...overrides,
  });

describe('Catalog unit-conversion evidence', () => {
  it('requires exact Unit revisions, one Tenant, distinct Units, and a positive ratio', () => {
    expect(evidence()).toMatchObject({
      denominator: '1',
      numerator: '10',
      ownerModuleId: 'commerce.catalog',
      source: 'CATALOG_OWNER_CURRENT_READ',
    });
    expect(() => evidence({ to: { resourceRef: centimetre, revision: 1 } })).toThrow();
    expect(() => evidence({ to: { resourceRef: foreignTenantUnit, revision: 1 } })).toThrow();
    expect(() =>
      evidence({
        to: {
          resourceRef: { ...millimetre, resourceType: 'commerce.catalog.product-unit' },
          revision: 1,
        },
      }),
    ).toThrow();
    expect(() => evidence({ numerator: '-10' })).toThrow();
    expect(() => evidence({ denominator: '0' })).toThrow();
    expect(() => evidence({ evidenceId: 'not-a-uuid' })).toThrow();
  });

  it('proves only an exact, owner-qualified conversion in the stated direction', () => {
    const conversion = evidence();
    expect(
      catalogUnitConversionProves(
        conversion,
        { resourceRef: centimetre, revision: 1 },
        { resourceRef: millimetre, revision: 1 },
        '83',
        '830',
      ),
    ).toBe(true);
    expect(
      catalogUnitConversionProves(
        conversion,
        { resourceRef: centimetre, revision: 1 },
        { resourceRef: millimetre, revision: 1 },
        '83',
        '831',
      ),
    ).toBe(false);
    expect(
      catalogUnitConversionProves(
        conversion,
        { resourceRef: centimetre, revision: 2 },
        { resourceRef: millimetre, revision: 1 },
        '83',
        '830',
      ),
    ).toBe(false);
    expect(
      catalogUnitConversionProves(
        conversion,
        { resourceRef: millimetre, revision: 1 },
        { resourceRef: centimetre, revision: 1 },
        '830',
        '83',
      ),
    ).toBe(false);
    expect(
      catalogUnitConversionProves(
        conversion,
        { resourceRef: centimetre, revision: 1 },
        { resourceRef: foreignUnit, revision: 1 },
        '83',
        '830',
      ),
    ).toBe(false);
  });

  it('handles exact decimal ratios without rounding', () => {
    const conversion = evidence({
      from: { resourceRef: metres, revision: 1 },
      numerator: '100',
      to: { resourceRef: centimetre, revision: 1 },
    });
    expect(
      catalogUnitConversionProves(
        conversion,
        { resourceRef: metres, revision: 1 },
        { resourceRef: centimetre, revision: 1 },
        '1.5',
        '150',
      ),
    ).toBe(true);
    expect(
      catalogUnitConversionProves(
        conversion,
        { resourceRef: metres, revision: 1 },
        { resourceRef: centimetre, revision: 1 },
        '1.5',
        '150.1',
      ),
    ).toBe(false);
  });
});
