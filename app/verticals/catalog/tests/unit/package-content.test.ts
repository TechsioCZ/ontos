import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { CatalogResourceRefSchema } from '../../shared/domain/catalog-revision-reference.ts';
import { CatalogSelectionRevisionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import { resolvePackageContent } from '../../shared/domain/package-content.ts';
import { assessPackageOption } from '../../shared/domain/package-option.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';
import { VariantRefSchema } from '../../shared/resources/variant.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const ref = (type: string, id: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId: id,
  resourceType: `commerce.catalog.${type}`,
  tenantId,
});
const productRef = Schema.decodeUnknownSync(ProductRefSchema)(ref('product', '22222222-2222-4222-8222-222222222222'));
const variantRef = Schema.decodeUnknownSync(VariantRefSchema)(ref('variant', '33333333-3333-4333-8333-333333333333'));
const form = { productRef, variantRef };
const unitRef = Schema.decodeUnknownSync(CatalogResourceRefSchema)(ref('unit', '44444444-4444-4444-8444-444444444444'));
const boxRef = Schema.decodeUnknownSync(CatalogResourceRefSchema)(
  ref('package-definition', '55555555-5555-4555-8555-555555555555'),
);
const caseRef = Schema.decodeUnknownSync(CatalogResourceRefSchema)(
  ref('package-definition', '66666666-6666-4666-8666-666666666666'),
);
const ten = Schema.decodeUnknownSync(CatalogSelectionRevisionSchema)({ resourceRef: boxRef, revision: 1 });
const eight = Schema.decodeUnknownSync(CatalogSelectionRevisionSchema)({ resourceRef: boxRef, revision: 2 });
const caseRevision = Schema.decodeUnknownSync(CatalogSelectionRevisionSchema)({ resourceRef: caseRef, revision: 1 });
const box10 = { amount: '10', form, reference: ten, unitRef };
const box8 = { amount: '8', form, reference: eight, unitRef };

describe('Package content and Option', () => {
  it('converts pinned two-by-ten exactly even after a successor eight revision exists', () => {
    expect(resolvePackageContent(ten, [box10, box8], '2')).toMatchObject({
      amount: '20',
      path: [ten],
      status: 'VALID',
    });
    expect(resolvePackageContent(eight, [box10, box8], '2')).toMatchObject({ amount: '16', status: 'VALID' });
  });

  it('keeps a higher level pinned to the old lower revision', () => {
    const higher = { amount: '20', form, lower: { count: '2', revision: ten }, reference: caseRevision, unitRef };
    expect(resolvePackageContent(caseRevision, [higher, box10, box8], '1')).toMatchObject({
      amount: '20',
      path: [caseRevision, ten],
      status: 'VALID',
    });
    expect(resolvePackageContent(caseRevision, [higher, box8], '1').status).toBe('UNVERIFIABLE');
  });

  it('rejects zero, unknown, cyclic, mixed, and disagreeing contents', () => {
    expect(resolvePackageContent(ten, [{ ...box10, amount: '0' }], '1').status).toBe('INVALID');
    expect(resolvePackageContent(ten, [], '1').status).toBe('UNVERIFIABLE');
    expect(resolvePackageContent(ten, [{ ...box10, lower: { count: '1', revision: ten } }], '1').status).toBe(
      'INVALID',
    );
    const higher = { amount: '20', form, lower: { count: '2', revision: ten }, reference: caseRevision, unitRef };
    expect(resolvePackageContent(caseRevision, [higher, { ...box10, amount: '8' }], '1').status).toBe('INVALID');
    expect(
      resolvePackageContent(
        caseRevision,
        [
          higher,
          {
            ...box10,
            form: {
              ...form,
              variantRef: Schema.decodeUnknownSync(VariantRefSchema)(
                ref('variant', '77777777-7777-4777-8777-777777777777'),
              ),
            },
          },
        ],
        '1',
      ).status,
    ).toBe('INVALID');
  });

  it('creates no Option merely from a multiplier; retirement does not substitute loose pieces', () => {
    const role = {
      currentContent: ten,
      definitionRef: boxRef,
      form,
      independentlyRequested: false,
      lifecycle: 'ACTIVE',
      substitutionWithLooseQuantitySatisfiesRequest: true,
    } as const;
    expect(assessPackageOption(role, 'ACTIVE', 'ACTIVE').status).toBe('QUANTITY_ONLY');
    expect(assessPackageOption({ ...role, lifecycle: 'RETIRED' }, 'ACTIVE', 'ACTIVE').status).toBe('UNVERIFIABLE');
    expect(assessPackageOption(role, 'RETIRED', 'ACTIVE').status).toBe('UNVERIFIABLE');
    expect(assessPackageOption(role, 'ACTIVE', 'RETIRED').status).toBe('UNVERIFIABLE');
    expect(
      assessPackageOption(
        { ...role, independentlyRequested: true, substitutionWithLooseQuantitySatisfiesRequest: false },
        'ACTIVE',
        'ACTIVE',
      ).status,
    ).toBe('SELECTABLE');
    expect(
      assessPackageOption(
        {
          ...role,
          independentlyRequested: true,
          lifecycle: 'RETIRED',
          substitutionWithLooseQuantitySatisfiesRequest: false,
        },
        'ACTIVE',
        'ACTIVE',
      ).status,
    ).toBe('UNVERIFIABLE');
    expect(
      assessPackageOption(
        {
          ...role,
          currentContent: { ...ten, resourceRef: { ...boxRef, resourceType: 'commerce.catalog.variant' } },
          independentlyRequested: true,
          substitutionWithLooseQuantitySatisfiesRequest: false,
        },
        'ACTIVE',
        'ACTIVE',
      ).status,
    ).toBe('INVALID');
  });
});
