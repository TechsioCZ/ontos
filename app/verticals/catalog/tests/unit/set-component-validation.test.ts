import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { CatalogResourceRefSchema } from '../../shared/domain/catalog-revision-reference.ts';
import { SetCompositionRevisionSchema } from '../../shared/domain/set-composition.ts';
import type { SetComponentCurrentProof } from '../../shared/domain/set-component-validation.ts';
import { validateSetComponents } from '../../shared/domain/set-component-validation.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const ref = (resourceType: string, resourceId: string) =>
  Schema.decodeUnknownSync(CatalogResourceRefSchema)({
    moduleId: 'commerce.catalog',
    resourceId,
    resourceType,
    tenantId,
  });
const productRef = ref('commerce.catalog.product', '22222222-2222-4222-8222-222222222222');
const shelfProduct = ref('commerce.catalog.product', '33333333-3333-4333-8333-333333333333');
const bracketProduct = ref('commerce.catalog.product', '44444444-4444-4444-8444-444444444444');
const unitRef = ref('commerce.catalog.product-unit', '55555555-5555-4555-8555-555555555555');
const revision = Schema.decodeUnknownSync(SetCompositionRevisionSchema)({
  components: [
    {
      componentId: '88888888-8888-4888-8888-888888888888',
      quantity: { amount: '1', unitRef },
      selection: {
        productRef: shelfProduct,
        variantRef: ref('commerce.catalog.variant', '99999999-9999-4999-8999-999999999999'),
      },
    },
    {
      componentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      quantity: { amount: '2', unitRef },
      selection: {
        productRef: bracketProduct,
        variantRef: ref('commerce.catalog.variant', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
      },
    },
  ],
  productRef,
  provenance: { changeKind: 'INITIAL', evidenceRefs: [], reason: 'Fixed shelf set' },
  reference: {
    resourceRef: ref('commerce.catalog.set-composition', '66666666-6666-4666-8666-666666666666'),
    revision: 1,
  },
  variantRef: ref('commerce.catalog.variant', '77777777-7777-4777-8777-777777777777'),
});
const proof = (index: number): SetComponentCurrentProof => {
  const component = revision.components[index];
  if (component === undefined) {
    throw new Error('Test component missing');
  }
  return {
    assessedAt: '2026-09-17T10:00:00.000Z',
    attestationId: `catalog-current-${index}`,
    componentId: component.componentId,
    divisible: false,
    productKind: 'ATOMIC',
    productLifecycle: 'ACTIVE',
    quantityStep: '1',
    quantityUnitRef: unitRef,
    selection: component.selection,
    source: 'CATALOG_OWNER_CURRENT_READ',
    status: 'VALID',
    variantLifecycle: 'ACTIVE',
    variantProductRef: component.selection.productRef,
  };
};

describe('Set component Current validation', () => {
  it('accepts two exact active non-set components with owner Current proof', () => {
    expect(validateSetComponents(revision, [proof(0), proof(1)])).toMatchObject({
      componentIds: revision.components.map((item) => item.componentId),
      status: 'VALID',
    });
  });

  it('fails closed without Current proof and distinguishes known retirement', () => {
    expect(validateSetComponents(revision, [proof(0)])).toMatchObject({
      code: 'CURRENT_COMPONENT_PROOF_MISSING',
      status: 'INDETERMINATE',
    });
    expect(validateSetComponents(revision, [proof(0), { ...proof(1), variantLifecycle: 'RETIRED' }])).toMatchObject({
      code: 'COMPONENT_RETIRED_OR_INACTIVE',
      status: 'INVALID',
    });
  });

  it('rejects nested Set evidence and quantity off the exact unit step', () => {
    expect(validateSetComponents(revision, [proof(0), { ...proof(1), productKind: 'SET' }])).toMatchObject({
      code: 'NESTED_SET',
      status: 'INVALID',
    });
    expect(validateSetComponents(revision, [proof(0), { ...proof(1), quantityStep: '3' }])).toMatchObject({
      code: 'COMPONENT_QUANTITY_RULE_VIOLATION',
      status: 'INVALID',
    });
  });
});
