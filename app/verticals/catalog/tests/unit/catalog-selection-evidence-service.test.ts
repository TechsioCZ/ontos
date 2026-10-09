import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { CatalogSelectionCurrentFacts } from '../../shared/domain/catalog-selection-assessment.ts';
import {
  CatalogSelectionBasisSchema,
  CatalogSelectionMembershipSchema,
  CatalogSelectionSchema,
} from '../../shared/domain/catalog-selection-evidence.ts';
import type { CatalogSelection } from '../../shared/domain/catalog-selection-evidence.ts';
import { CatalogSelectionInjectedOwnerEvidenceSchema } from '../../shared/domain/catalog-selection-owner-contract.ts';
import {
  assembleCatalogSelectionEvidence,
  catalogSelectionEvidenceFromCurrentReader,
  catalogSelectionEvidenceForScope,
} from '../../src/persistence/catalog-selection-evidence-service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '99999999-9999-4999-8999-999999999999';
const ref = (resourceType: string, resourceId: string, tenant = tenantId) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId: tenant,
});
const productRef = ref('commerce.catalog.product', '22222222-2222-4222-8222-222222222222');
const variantRef = ref('commerce.catalog.variant', '33333333-3333-4333-8333-333333333333');
const typeRef = ref('commerce.catalog.product-type', '44444444-4444-4444-8444-444444444444');
const attrDefRef = ref('commerce.catalog.attribute-definition', '55555555-5555-4555-8555-555555555555');
const valueSetRef = ref('commerce.catalog.attribute-value-set', '66666666-6666-4666-8666-666666666666');
const configDefRef = ref('commerce.catalog.configuration-definition', '77777777-7777-4777-8777-777777777777');
const unitRef = ref('commerce.catalog.unit', '88888888-8888-4888-8888-888888888888');
const unitRuleRef = ref('commerce.catalog.product-unit', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const categoryRef = ref('commerce.catalog.product-category', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const assessedAt = '2026-09-18T12:00:00.000Z';

const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:selection-evidence-service:run:1',
    authMethod: 'system',
    principalId: '44444444-4444-4444-8444-444444444444',
    tenantId,
  }),
  correlationId: 'selection-evidence-service',
};

const decodeSelection = Schema.decodeUnknownSync(CatalogSelectionSchema, { onExcessProperty: 'error' });
const decodeBasis = Schema.decodeUnknownSync(CatalogSelectionBasisSchema, { onExcessProperty: 'error' });
const decodeMembership = Schema.decodeUnknownSync(CatalogSelectionMembershipSchema, { onExcessProperty: 'error' });
const decodeInjected = Schema.decodeUnknownSync(CatalogSelectionInjectedOwnerEvidenceSchema, {
  onExcessProperty: 'error',
});
const fact = (role: string, resourceRef: ReturnType<typeof ref>, revision: number) =>
  decodeBasis({ role, source: { resourceRef, revision } });

const selection = decodeSelection({ productRef, variantRef });
const purchaseBasis = [
  fact('PRODUCT', productRef, 4),
  fact('VARIANT', variantRef, 2),
  fact('PRODUCT_TYPE', typeRef, 1),
  fact('VARIANT_AXIS', productRef, 3),
  fact('INHERITED_VALUE', valueSetRef, 5),
  fact('UNIT_RULE', unitRuleRef, 6),
  fact('UNIT_TARGET_DIVISIBILITY', variantRef, 2),
];

const observedFacts = (input: {
  readonly basis: CatalogSelectionCurrentFacts['basis'];
  readonly productLifecycle?: 'ACTIVE' | 'RETIRED';
  readonly purpose?: string;
  readonly selection?: CatalogSelection;
  readonly variantLifecycle?: 'ACTIVE' | 'RETIRED';
}): CatalogSelectionCurrentFacts => ({
  assessedAt,
  basis: input.basis,
  dependentFactsComplete: true,
  membership: decodeMembership({
    attestationId: 'catalog-membership-service-1',
    observedAt: assessedAt,
    productRef: selection.productRef,
    source: 'CATALOG_OWNER_CURRENT_READ',
    variant: { resourceRef: selection.variantRef, revision: 2 },
  }),
  productLifecycle: input.productLifecycle ?? 'ACTIVE',
  purpose: input.purpose ?? 'PURCHASE_ACCEPTANCE',
  selection: input.selection ?? selection,
  source: 'CATALOG_OWNER_CURRENT_READ',
  status: 'OBSERVED',
  variantLifecycle: input.variantLifecycle ?? 'ACTIVE',
});

const failingLimit = () => Effect.fail(new Error('database offline'));
const failingWhere = () => ({ limit: failingLimit });
const failingFrom = () => ({ where: failingWhere });
const unavailableOwnerTransaction = { select: () => ({ from: failingFrom }) };
const untouchedTransaction = {
  insert: () => {
    throw new Error('must not write');
  },
  select: () => {
    throw new Error('must not query');
  },
};

describe('Catalog Selection evidence assembly service', () => {
  it('issues the smallest complete PURCHASE_ACCEPTANCE basis with deciding value facts', () => {
    const result = assembleCatalogSelectionEvidence({
      current: observedFacts({
        basis: [
          ...purchaseBasis,
          fact('ATTRIBUTE_DEFINITION', attrDefRef, 8),
          fact('OTHER_CATALOG_FACT', valueSetRef, 9),
        ],
      }),
      purpose: 'PURCHASE_ACCEPTANCE',
      selection,
    });
    expect(result.evidence).toMatchObject({ status: 'VALID' });
    expect(result.missingRoles).toEqual([]);
    expect(result.validity).toBeUndefined();
    if (result.evidence.status !== 'VALID') {
      return;
    }
    expect(result.evidence.basis.map(({ role }) => role)).toEqual([
      'PRODUCT',
      'VARIANT',
      'PRODUCT_TYPE',
      'VARIANT_AXIS',
      'INHERITED_VALUE',
      'UNIT_RULE',
      'UNIT_TARGET_DIVISIBILITY',
      'ATTRIBUTE_DEFINITION',
      'OTHER_CATALOG_FACT',
    ]);
  });

  it('accepts a complete purchase basis without inherited values', () => {
    const result = assembleCatalogSelectionEvidence({
      current: observedFacts({ basis: purchaseBasis.filter(({ role }) => role !== 'INHERITED_VALUE') }),
      purpose: 'PURCHASE_ACCEPTANCE',
      selection,
    });
    expect(result.evidence).toMatchObject({ status: 'VALID' });
    expect(result.missingRoles).toEqual([]);
  });

  it('downgrades an incomplete VALID decision to INDETERMINATE naming the missing deciding roles', () => {
    const result = assembleCatalogSelectionEvidence({
      current: observedFacts({
        basis: purchaseBasis.filter(({ role }) => role !== 'UNIT_RULE' && role !== 'UNIT_TARGET_DIVISIBILITY'),
      }),
      purpose: 'PURCHASE_ACCEPTANCE',
      selection,
    });
    expect(result.evidence).toMatchObject({
      reason: expect.stringContaining('UNIT_RULE, UNIT_TARGET_DIVISIBILITY'),
      status: 'INDETERMINATE',
    });
    expect(result.missingRoles).toEqual(['UNIT_RULE', 'UNIT_TARGET_DIVISIBILITY']);
    expect(result.validity).toBeUndefined();
  });

  it('requires the Category basis for Pricing and names it when absent', () => {
    const pricingBasis = [
      fact('PRODUCT', productRef, 4),
      fact('VARIANT', variantRef, 2),
      fact('PRODUCT_TYPE', typeRef, 1),
    ];
    const missing = assembleCatalogSelectionEvidence({
      current: observedFacts({ basis: pricingBasis, purpose: 'PRICING' }),
      purpose: 'PRICING',
      selection,
    });
    expect(missing.evidence).toMatchObject({
      reason: expect.stringContaining('CATEGORY'),
      status: 'INDETERMINATE',
    });
    expect(missing.missingRoles).toEqual(['CATEGORY']);
    const complete = assembleCatalogSelectionEvidence({
      current: observedFacts({ basis: [...pricingBasis, fact('CATEGORY', categoryRef, 8)], purpose: 'PRICING' }),
      purpose: 'PRICING',
      selection,
    });
    expect(complete.evidence).toMatchObject({ status: 'VALID' });
    if (complete.evidence.status === 'VALID') {
      expect(complete.evidence.basis.map(({ role }) => role)).toEqual([
        'PRODUCT',
        'VARIANT',
        'PRODUCT_TYPE',
        'CATEGORY',
      ]);
    }
  });

  it('never masks a materially proven INVALID behind an incomplete basis', () => {
    const result = assembleCatalogSelectionEvidence({
      current: observedFacts({
        basis: purchaseBasis.filter(({ role }) => role !== 'UNIT_RULE'),
        productLifecycle: 'RETIRED',
      }),
      purpose: 'PURCHASE_ACCEPTANCE',
      selection,
    });
    expect(result.evidence).toMatchObject({ status: 'INVALID' });
    expect(result.missingRoles).toEqual(['UNIT_RULE']);
    expect(result.validity).toBeUndefined();
  });

  it('carries a complete Configuration as a value without inventing a registry resource', () => {
    const configured = decodeSelection({
      configuration: {
        choices: [
          { attributeDefinition: { resourceRef: attrDefRef, revision: 5 }, choiceKey: 'mount', value: 'A' },
          { choiceKey: 'length', unit: { resourceRef: unitRef, revision: 7 }, value: '83' },
        ],
        definition: { resourceRef: configDefRef, revision: 3 },
        productRef,
        variantRef,
      },
      productRef,
      variantRef,
    });
    const result = assembleCatalogSelectionEvidence({
      current: observedFacts({
        basis: [
          ...purchaseBasis,
          fact('CONFIGURATION_DEFINITION', configDefRef, 3),
          fact('ATTRIBUTE_DEFINITION', attrDefRef, 5),
          fact('UNIT', unitRef, 7),
        ],
        selection: configured,
      }),
      purpose: 'PURCHASE_ACCEPTANCE',
      selection: configured,
    });
    expect(result.evidence).toMatchObject({ status: 'VALID' });
    expect(result.missingRoles).toEqual([]);
    if (result.evidence.status === 'VALID') {
      expect(result.evidence.basis.map(({ role }) => role)).toEqual([
        'PRODUCT',
        'VARIANT',
        'PRODUCT_TYPE',
        'VARIANT_AXIS',
        'INHERITED_VALUE',
        'UNIT_RULE',
        'UNIT_TARGET_DIVISIBILITY',
        'CONFIGURATION_DEFINITION',
        'ATTRIBUTE_DEFINITION',
        'UNIT',
      ]);
    }
    expect(JSON.stringify(result.evidence)).not.toContain('configurationRef');
    expect(JSON.stringify(result.evidence)).not.toContain('sku');
  });

  it('mints a time-bounded guarantee at t0 that no longer covers t1 and never reuses stale evidence', () => {
    const facts = observedFacts({ basis: purchaseBasis });
    const atT0 = assembleCatalogSelectionEvidence({
      current: facts,
      purpose: 'PURCHASE_ACCEPTANCE',
      requestedAt: assessedAt,
      selection,
      validUntil: '2026-09-18T13:00:00.000Z',
    });
    expect(atT0.evidence).toMatchObject({ assessedAt, status: 'VALID' });
    expect(atT0.validity).toBeDefined();
    const atT1 = assembleCatalogSelectionEvidence({
      current: facts,
      purpose: 'PURCHASE_ACCEPTANCE',
      requestedAt: '2026-09-18T14:00:00.000Z',
      selection,
      validUntil: '2026-09-18T13:00:00.000Z',
    });
    expect(atT1.validity).toBeUndefined();
    expect(atT1.evidence).toMatchObject({ assessedAt, status: 'VALID' });
  });

  it.effect('revalidates the exact source token before releasing a bounded attestation', () =>
    Effect.gen(function* stableSourceToken() {
      const reads = yield* Ref.make(0);
      const facts = observedFacts({ basis: purchaseBasis });
      const currentBasis = {
        read: () => Ref.updateAndGet(reads, (count) => count + 1).pipe(Effect.as(facts)),
      };
      const result = yield* catalogSelectionEvidenceFromCurrentReader(currentBasis).assess({
        purpose: 'PURCHASE_ACCEPTANCE',
        selection,
        validUntil: '2026-09-18T13:00:00.000Z',
      });
      expect(result.evidence).toMatchObject({ status: 'VALID' });
      if (!('basis' in result.evidence)) {
        return;
      }
      expect(result.validity).toMatchObject({ basis: result.evidence.basis });
      expect(yield* Ref.get(reads)).toBe(2);
    }),
  );

  it.effect('fails closed when a deciding source changes between preparation and revalidation', () =>
    Effect.gen(function* changedSourceToken() {
      const reads = yield* Ref.make(0);
      const first = observedFacts({
        basis: [...purchaseBasis, fact('OTHER_CATALOG_FACT', valueSetRef, 9)],
      });
      const changed = observedFacts({
        basis: [...purchaseBasis, fact('OTHER_CATALOG_FACT', valueSetRef, 10)],
      });
      const currentBasis = {
        read: () =>
          Ref.getAndUpdate(reads, (count) => count + 1).pipe(Effect.map((count) => (count === 0 ? first : changed))),
      };
      const result = yield* catalogSelectionEvidenceFromCurrentReader(currentBasis).assess({
        purpose: 'PURCHASE_ACCEPTANCE',
        selection,
        validUntil: '2026-09-18T13:00:00.000Z',
      });
      expect(result.evidence).toMatchObject({
        reason: expect.stringContaining('source changed during evidence preparation'),
        status: 'INDETERMINATE',
      });
      expect(result.validity).toBeUndefined();
      expect(yield* Ref.get(reads)).toBe(2);
    }),
  );

  it('fails closed to INDETERMINATE, with no validity, when the deciding basis is unavailable', () => {
    const unavailableFacts: CatalogSelectionCurrentFacts = {
      assessedAt,
      basis: [],
      purpose: 'PURCHASE_ACCEPTANCE',
      reason: 'Current Product Type assignment and rules are not owner-attested',
      selection,
      source: 'CATALOG_OWNER_CURRENT_READ',
      status: 'INDETERMINATE',
    };
    const result = assembleCatalogSelectionEvidence({
      current: unavailableFacts,
      purpose: 'PURCHASE_ACCEPTANCE',
      selection,
    });
    expect(result.evidence).toMatchObject({ status: 'INDETERMINATE' });
    expect(result.validity).toBeUndefined();
  });

  it('preserves matching injected owner evidence and types a mismatch as UNVERIFIABLE', () => {
    const injected = decodeInjected({
      evidenceId: 'pricing-evidence-1',
      observedAt: assessedAt,
      owner: 'PRICING',
      ownerRevision: {
        moduleId: 'commerce.pricing',
        resourceId: 'price-resource-1',
        resourceType: 'commerce.pricing.price',
        revision: 1,
        tenantId,
      },
      purpose: 'PRICING',
      selection,
    });
    const pricingBasis = [
      fact('PRODUCT', productRef, 4),
      fact('VARIANT', variantRef, 2),
      fact('PRODUCT_TYPE', typeRef, 1),
    ];
    const matching = assembleCatalogSelectionEvidence({
      current: observedFacts({ basis: pricingBasis, purpose: 'PRICING' }),
      injectedOwnerEvidence: injected,
      purpose: 'PRICING',
      selection,
    });
    expect(matching.ownerEvidence).toBe(injected);
    const otherSelection = decodeSelection({
      productRef,
      variantRef: ref('commerce.catalog.variant', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
    });
    const mismatched = assembleCatalogSelectionEvidence({
      current: observedFacts({ basis: pricingBasis, purpose: 'PRICING' }),
      injectedOwnerEvidence: injected,
      purpose: 'PRICING',
      selection: otherSelection,
    });
    expect(mismatched.ownerEvidence).toMatchObject({
      kind: 'UNVERIFIABLE_OWNER_EVIDENCE',
      owner: 'PRICING',
    });
  });

  it.effect('returns typed UNAVAILABLE instead of reusing a stale VALID when the owner read fails', () =>
    Effect.gen(function* unavailableOwnerRead() {
      // @ts-expect-error The mock implements only the failing owner read chain.
      const service = catalogSelectionEvidenceForScope(unavailableOwnerTransaction, scope);
      const result = yield* service.assess({ purpose: 'PURCHASE_ACCEPTANCE', selection });
      expect(result.evidence).toMatchObject({ kind: 'UNAVAILABLE' });
      expect(result.validity).toBeUndefined();
    }),
  );

  it.effect('fails a foreign Tenant selection closed before any read or write', () =>
    Effect.gen(function* foreignTenant() {
      const foreignSelection = decodeSelection({
        productRef: { ...productRef, tenantId: foreignTenantId },
        variantRef: { ...variantRef, tenantId: foreignTenantId },
      });
      // @ts-expect-error The mock must never be touched for a foreign Tenant selection.
      const service = catalogSelectionEvidenceForScope(untouchedTransaction, scope);
      const result = yield* service.assess({ purpose: 'PURCHASE_ACCEPTANCE', selection: foreignSelection });
      expect(result.evidence).toMatchObject({ status: 'INDETERMINATE' });
    }),
  );
});
