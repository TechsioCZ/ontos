import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import {
  attributeDefinitions,
  attributeValueSets,
  productAttributeApplicability,
  productAttributeApplicabilityRevisions,
  productTypeAssignments,
  productTypeRevisionAttributes,
  productTypes,
  productVariantAxes,
  products,
} from '../../src/database/schema.ts';
import {
  AttributeApplicabilityConflict,
  attributeApplicabilityPersistenceForScope,
  mapAttributeApplicabilityWriteError,
} from '../../src/persistence/attribute-applicability-persistence.ts';
import { AttributeApplicabilityImpactConfirmationSchema } from '../../shared/actions/govern-product-attribute-applicability.ts';
import type { CartOpenSelectionPopulationPort } from '../../shared/domain/catalog-open-selection-population.ts';
import { CartOpenSelectionReferenceSchema } from '../../shared/domain/catalog-open-selection-population.ts';
import {
  CatalogSelectionEvidenceSchema,
  CatalogSelectionSchema,
} from '../../shared/domain/catalog-selection-evidence.ts';
import { CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const productRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product' as const,
  tenantId,
};
const attributeDefinitionRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.attribute-definition' as const,
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '88888888-8888-4888-8888-888888888888',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({ productRef, variantRef });
const assessedAt = '2026-09-18T12:00:00.000Z';
const basis = [
  { role: 'PRODUCT', source: { resourceRef: productRef, revision: 1 } },
  { role: 'VARIANT', source: { resourceRef: variantRef, revision: 1 } },
  {
    provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
    role: 'PRODUCT_TYPE_UNTYPED_DECISION',
    source: { resourceRef: productRef, revision: 1 },
  },
];
const validSelectionEvidence = Schema.decodeUnknownSync(CatalogSelectionEvidenceSchema)({
  assessedAt,
  basis,
  membership: {
    attestationId: 'catalog-membership-attribute-applicability-1',
    observedAt: assessedAt,
    productRef,
    source: 'CATALOG_OWNER_CURRENT_READ',
    variant: { resourceRef: variantRef, revision: 1 },
  },
  purpose: 'CART_VALIDATION',
  selection,
  status: 'VALID',
});
const invalidSelectionEvidence = Schema.decodeUnknownSync(CatalogSelectionEvidenceSchema)({
  assessedAt,
  basis,
  purpose: 'CART_VALIDATION',
  reason: 'Selection is no longer valid',
  selection,
  status: 'INVALID',
});
const openSelection = Schema.decodeUnknownSync(CartOpenSelectionReferenceSchema)({
  selection,
  selectionId: 'cart-selection-1',
});
const impactConfirmation = Schema.decodeUnknownSync(AttributeApplicabilityImpactConfirmationSchema)({
  affectedOpenSelectionIds: ['cart-selection-1'],
  expectedPopulationRevisionToken: 'cart-population-1',
  remediationEvidenceRefs: ['applicability-remediation-1'],
});
const ownerPopulation = (
  revisionToken = 'cart-population-1',
  selections = [openSelection],
): CartOpenSelectionPopulationPort => ({
  read: () =>
    Effect.succeed({
      complete: true,
      observedAt: assessedAt,
      revisionToken,
      selections,
      tenantId,
    }),
});
const assessValid = () => Effect.succeed({ evidence: validSelectionEvidence });
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:attribute-applicability:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'attribute-applicability-test',
};
const base = {
  actionInvocationId: '55555555-5555-4555-8555-555555555555',
  attributeDefinitionRef,
  expectedRevision: null,
  principalId,
  productLevel: true,
  productRef,
  reason: 'Deliberate Product-local use',
  variantLevel: false,
};

type ApplicabilityTable =
  | typeof products
  | typeof attributeDefinitions
  | typeof productTypeAssignments
  | typeof productTypes
  | typeof productTypeRevisionAttributes
  | typeof productAttributeApplicability
  | typeof productAttributeApplicabilityRevisions
  | typeof attributeValueSets
  | typeof productVariantAxes;
type TestValue =
  | Partial<typeof productAttributeApplicability.$inferInsert>
  | Partial<typeof productAttributeApplicabilityRevisions.$inferInsert>;
interface TestWrite {
  readonly table: ApplicabilityTable;
  readonly value: TestValue;
}

const transactionWith = (overrides = new Map<ApplicabilityTable, readonly object[]>(), writes: TestWrite[] = []) => {
  const rows = new Map<ApplicabilityTable, readonly object[]>([
    [products, [{ lifecycleState: 'DRAFT' }]],
    [attributeDefinitions, [{ applicableLevels: ['PRODUCT', 'VARIANT'] }]],
    [productTypeAssignments, [{ productTypeId: '77777777-7777-4777-8777-777777777777' }]],
    [productTypes, [{ currentRevision: 1 }]],
    [
      productTypeRevisionAttributes,
      [
        { level: 'PRODUCT', requirement: 'OPTIONAL' },
        { level: 'VARIANT', requirement: 'OPTIONAL' },
      ],
    ],
  ]);
  for (const [table, value] of overrides) {
    rows.set(table, value);
  }
  const selected = (table: ApplicabilityTable) => {
    const result = Effect.succeed(rows.get(table) ?? []);
    // oxlint-disable-next-line sonarjs/no-nested-functions -- Minimal Drizzle chain for the focused transaction test double.
    return { where: () => ({ for: () => ({ limit: () => result }), limit: () => result, pipe: () => result }) };
  };
  return {
    insert: (table: ApplicabilityTable) => ({
      values: (value: TestValue) => {
        writes.push({ table, value });
        return Effect.void;
      },
    }),
    select: () => ({ from: selected }),
    update: (table: ApplicabilityTable) => ({
      set: (value: TestValue) => ({
        where: () => {
          writes.push({ table, value });
          return Effect.void;
        },
      }),
    }),
  };
};

describe('Product-local Attribute applicability', () => {
  it('maps only its own invocation uniqueness failure', () => {
    expect(
      mapAttributeApplicabilityWriteError({
        code: '23505',
        constraint: 'catalog_product_attribute_applicability_revisions_invocation_uk',
      }),
    ).toMatchObject({ conflict: 'ACTION_INVOCATION_ID' });
    for (const cause of [
      { code: '23505', constraint: 'catalog_product_attribute_applicability_pk' },
      new Error('storage unavailable'),
    ]) {
      const mapped = mapAttributeApplicabilityWriteError(cause);
      expect(Schema.is(AttributeApplicabilityConflict)(mapped)).toBe(false);
      expect(Schema.is(CatalogPersistenceUnavailable)(mapped)).toBe(true);
      expect(mapped.cause).toBe(cause);
    }
  });

  it.effect('rejects malformed, cross-Tenant, and empty initial declarations before any query', () =>
    Effect.gen(function* rejectBeforeIO() {
      // @ts-expect-error No query is legal for these rejected inputs.
      const persistence = yield* attributeApplicabilityPersistenceForScope({}, scope);
      for (const input of [
        { ...base, productLevel: false },
        { ...base, reason: ' padded ' },
        { ...base, productRef: { ...productRef, tenantId: '66666666-6666-4666-8666-666666666666' } },
      ]) {
        const result = yield* Effect.flip(persistence.change(input));
        expect(result).toMatchObject({ conflict: 'INVALID_INPUT' });
      }
    }),
  );

  it.effect('appends revision 2 for a clean DRAFT move and retains a removal tombstone', () =>
    Effect.gen(function* reviseCleanDraft() {
      for (const [levels, expected] of [
        [{ productLevel: false, variantLevel: true }, 2],
        [{ productLevel: false, variantLevel: false }, 2],
      ] as const) {
        const writes: TestWrite[] = [];
        const transaction = transactionWith(
          new Map([[productAttributeApplicability, [{ currentRevision: 1, productLevel: true, variantLevel: false }]]]),
          writes,
        );
        // @ts-expect-error Focused transaction double models the query chain.
        const persistence = yield* attributeApplicabilityPersistenceForScope(transaction, scope);
        const result = yield* persistence.change({ ...base, ...levels, expectedRevision: 1 });
        expect(result).toMatchObject({ ...levels, revision: expected });
        expect(writes).toHaveLength(2);
        expect(writes[0]).toMatchObject({
          table: productAttributeApplicability,
          value: { currentRevision: 2, ...levels },
        });
        expect(writes[1]).toMatchObject({
          table: productAttributeApplicabilityRevisions,
          value: { revision: 2, ...levels },
        });
      }
    }),
  );

  it.effect('requires affected live values and axes to be repaired before removing their level', () =>
    Effect.gen(function* repairLocalImpact() {
      const current = [{ currentRevision: 1, productLevel: true, variantLevel: true }];
      for (const [table, row, input, conflictKind] of [
        [
          attributeValueSets,
          { attributeDefinitionId: attributeDefinitionRef.resourceId, currentState: 'SET', variantId: null },
          { expectedRevision: 1, productLevel: false, variantLevel: true },
          'VALUE_IMPACT',
        ],
        [
          productVariantAxes,
          { attributeDefinitionId: attributeDefinitionRef.resourceId },
          { expectedRevision: 1, productLevel: true, variantLevel: false },
          'IDENTITY_IMPACT',
        ],
      ] as const) {
        const writes: TestWrite[] = [];
        const transaction = transactionWith(
          new Map<ApplicabilityTable, readonly object[]>([
            [productAttributeApplicability, current],
            [table, [row]],
          ]),
          writes,
        );
        // @ts-expect-error Focused transaction double models the query chain.
        const persistence = yield* attributeApplicabilityPersistenceForScope(transaction, scope);
        const error = yield* Effect.flip(persistence.change({ ...base, ...input }));
        expect(error).toMatchObject({ conflict: conflictKind });
        expect(writes).toHaveLength(0);
      }
    }),
  );

  it.effect('ignores values for another Attribute Definition on a clean DRAFT declaration', () =>
    Effect.gen(function* ignoreUnrelatedValues() {
      const writes: TestWrite[] = [];
      const transaction = transactionWith(
        new Map([
          [attributeValueSets, [{ attributeDefinitionId: 'another-definition', currentState: 'SET', variantId: null }]],
        ]),
        writes,
      );
      // @ts-expect-error Focused transaction double models the query chain.
      const persistence = yield* attributeApplicabilityPersistenceForScope(transaction, scope);
      expect(yield* persistence.change(base)).toMatchObject({ revision: 1 });
      expect(writes).toHaveLength(2);
    }),
  );

  it.effect('rejects a level the Attribute Definition does not permit', () =>
    Effect.gen(function* rejectDefinitionLevel() {
      const writes: TestWrite[] = [];
      const transaction = transactionWith(
        new Map([[attributeDefinitions, [{ applicableLevels: ['PRODUCT'] }]]]),
        writes,
      );
      // @ts-expect-error Focused transaction double models the query chain.
      const persistence = yield* attributeApplicabilityPersistenceForScope(transaction, scope);
      const error = yield* Effect.flip(persistence.change({ ...base, productLevel: false, variantLevel: true }));
      expect(error).toMatchObject({ conflict: 'INAPPLICABLE' });
      expect(writes).toHaveLength(0);
    }),
  );

  it.effect('rejects a level the Current Product Type does not allow', () =>
    Effect.gen(function* rejectTypeLevel() {
      const writes: TestWrite[] = [];
      const transaction = transactionWith(
        new Map([[productTypeRevisionAttributes, [{ level: 'VARIANT', requirement: 'OPTIONAL' }]]]),
        writes,
      );
      // @ts-expect-error Focused transaction double models the query chain.
      const persistence = yield* attributeApplicabilityPersistenceForScope(transaction, scope);
      const error = yield* Effect.flip(persistence.change(base));
      expect(error).toMatchObject({ conflict: 'INAPPLICABLE' });
      expect(writes).toHaveLength(0);
    }),
  );

  it.effect('requires an authoritative Current Product Type assignment', () =>
    Effect.gen(function* requireTypeAssignment() {
      const writes: TestWrite[] = [];
      const transaction = transactionWith(new Map([[productTypeAssignments, []]]), writes);
      // @ts-expect-error Focused transaction double models the query chain.
      const persistence = yield* attributeApplicabilityPersistenceForScope(transaction, scope);
      const error = yield* Effect.flip(persistence.change(base));
      expect(error).toMatchObject({ conflict: 'INAPPLICABLE' });
      expect(writes).toHaveLength(0);
    }),
  );

  it.effect('cannot remove a level the Current Product Type requires', () =>
    Effect.gen(function* preserveRequiredMinimum() {
      const writes: TestWrite[] = [];
      const transaction = transactionWith(
        new Map([
          [
            productTypeRevisionAttributes,
            [
              { level: 'PRODUCT', requirement: 'REQUIRED' },
              { level: 'VARIANT', requirement: 'OPTIONAL' },
            ],
          ],
        ]),
        writes,
      );
      // @ts-expect-error Focused transaction double models the query chain.
      const persistence = yield* attributeApplicabilityPersistenceForScope(transaction, scope);
      const error = yield* Effect.flip(persistence.change({ ...base, productLevel: false, variantLevel: true }));
      expect(error).toMatchObject({ conflict: 'REQUIRED' });
      expect(writes).toHaveLength(0);
    }),
  );

  it.effect('moves a clean DRAFT declaration to Variant without manufacturing values or axes', () =>
    Effect.gen(function* moveToVariant() {
      const writes: TestWrite[] = [];
      const transaction = transactionWith(
        new Map([[productAttributeApplicability, [{ currentRevision: 1, productLevel: true, variantLevel: false }]]]),
        writes,
      );
      // @ts-expect-error Focused transaction double models the query chain.
      const persistence = yield* attributeApplicabilityPersistenceForScope(transaction, scope);
      const result = yield* persistence.change({
        ...base,
        evidenceRefs: ['type-rule-review-2'],
        expectedRevision: 1,
        productLevel: false,
        variantLevel: true,
      });
      expect(result).toMatchObject({ productLevel: false, revision: 2, variantLevel: true });
      expect(writes.map(({ table }) => table)).toEqual([
        productAttributeApplicability,
        productAttributeApplicabilityRevisions,
      ]);
      expect(writes[1]).toMatchObject({
        value: { evidenceRefs: ['type-rule-review-2'], productLevel: false, revision: 2, variantLevel: true },
      });
      expect(writes.every(({ table }) => table !== attributeValueSets && table !== productVariantAxes)).toBe(true);
    }),
  );

  it.effect('refuses to merge Variant-only values into a Product declaration', () =>
    Effect.gen(function* refuseMerge() {
      const writes: TestWrite[] = [];
      const transaction = transactionWith(
        new Map<ApplicabilityTable, readonly object[]>([
          [productAttributeApplicability, [{ currentRevision: 1, productLevel: false, variantLevel: true }]],
          [
            attributeValueSets,
            [
              {
                attributeDefinitionId: attributeDefinitionRef.resourceId,
                currentState: 'SET',
                variantId: variantRef.resourceId,
              },
            ],
          ],
        ]),
        writes,
      );
      // @ts-expect-error Focused transaction double models the query chain.
      const persistence = yield* attributeApplicabilityPersistenceForScope(transaction, scope);
      const error = yield* Effect.flip(
        persistence.change({ ...base, expectedRevision: 1, productLevel: true, variantLevel: false }),
      );
      expect(error).toMatchObject({ conflict: 'VALUE_IMPACT' });
      expect(writes).toHaveLength(0);
    }),
  );

  it.effect('fails closed on non-DRAFT Products until a governed selection-impact basis exists', () =>
    Effect.gen(function* requireImpactBasis() {
      const writes: TestWrite[] = [];
      const transaction = transactionWith(new Map([[products, [{ lifecycleState: 'ACTIVE' }]]]), writes);
      // @ts-expect-error Focused transaction double models the query chain.
      const persistence = yield* attributeApplicabilityPersistenceForScope(transaction, scope);
      const error = yield* Effect.flip(persistence.change(base));
      expect(error).toMatchObject({ conflict: 'SELECTION_IMPACT' });
      expect(writes).toHaveLength(0);
    }),
  );

  it.effect('accepts a used applicability change with complete owner impact and remediation evidence', () =>
    Effect.gen(function* acceptUsedChange() {
      const writes: TestWrite[] = [];
      const transaction = transactionWith(
        new Map<ApplicabilityTable, readonly object[]>([
          [products, [{ lifecycleState: 'ACTIVE' }]],
          [productAttributeApplicability, [{ currentRevision: 1, productLevel: true, variantLevel: false }]],
        ]),
        writes,
      );
      const persistence = yield* attributeApplicabilityPersistenceForScope(
        // @ts-expect-error Focused transaction double models the query chain.
        transaction,
        scope,
        {
          assess: assessValid,
          openSelections: ownerPopulation(),
        },
      );
      expect(
        yield* persistence.change({
          ...base,
          expectedRevision: 1,
          impactConfirmation,
          productLevel: false,
          variantLevel: true,
        }),
      ).toMatchObject({ productLevel: false, revision: 2, variantLevel: true });
      expect(writes).toHaveLength(2);
      expect(writes[1]).toMatchObject({
        table: productAttributeApplicabilityRevisions,
        value: { evidenceRefs: ['applicability-remediation-1'], revision: 2 },
      });
    }),
  );

  it.effect('fails closed when the complete Cart owner population is unavailable or malformed', () =>
    Effect.gen(function* unavailablePopulation() {
      const transaction = transactionWith(
        new Map<ApplicabilityTable, readonly object[]>([
          [products, [{ lifecycleState: 'ACTIVE' }]],
          [productAttributeApplicability, [{ currentRevision: 1, productLevel: true, variantLevel: false }]],
        ]),
      );
      const populations: readonly (CartOpenSelectionPopulationPort | undefined)[] = [
        undefined,
        { read: () => Effect.succeed({ complete: false, selections: [], tenantId }) },
      ];
      for (const openSelections of populations) {
        const persistence = yield* attributeApplicabilityPersistenceForScope(
          // @ts-expect-error Focused transaction double models the query chain and malformed owner response.
          transaction,
          scope,
          openSelections === undefined ? {} : { assess: assessValid, openSelections },
        );
        const failure = yield* Effect.flip(
          persistence.change({
            ...base,
            expectedRevision: 1,
            impactConfirmation,
            productLevel: false,
            variantLevel: true,
          }),
        );
        expect(Schema.is(CatalogPersistenceUnavailable)(failure)).toBe(true);
      }
    }),
  );

  it.effect('rejects stale impact identity and a population change during the write attempt', () =>
    Effect.gen(function* rejectStaleImpact() {
      const transaction = transactionWith(
        new Map<ApplicabilityTable, readonly object[]>([
          [products, [{ lifecycleState: 'ACTIVE' }]],
          [productAttributeApplicability, [{ currentRevision: 1, productLevel: true, variantLevel: false }]],
        ]),
      );
      const stale = yield* attributeApplicabilityPersistenceForScope(
        // @ts-expect-error Focused transaction double models the query chain.
        transaction,
        scope,
        {
          assess: assessValid,
          openSelections: ownerPopulation('newer-population'),
        },
      );
      expect(
        yield* Effect.flip(
          stale.change({
            ...base,
            expectedRevision: 1,
            impactConfirmation,
            productLevel: false,
            variantLevel: true,
          }),
        ),
      ).toMatchObject({ conflict: 'SELECTION_IMPACT' });

      let reads = 0;
      const changesDuringWrite: CartOpenSelectionPopulationPort = {
        read: () => {
          reads += 1;
          return ownerPopulation(reads === 1 ? 'cart-population-1' : 'cart-population-2').read({ tenantId });
        },
      };
      const changing = yield* attributeApplicabilityPersistenceForScope(
        // @ts-expect-error Focused transaction double models the query chain.
        transaction,
        scope,
        {
          assess: assessValid,
          openSelections: changesDuringWrite,
        },
      );
      expect(
        yield* Effect.flip(
          changing.change({
            ...base,
            expectedRevision: 1,
            impactConfirmation,
            productLevel: false,
            variantLevel: true,
          }),
        ),
      ).toMatchObject({ conflict: 'SELECTION_IMPACT' });
    }),
  );

  it.effect('rejects impact evidence when an affected selection is not Current-VALID', () =>
    Effect.gen(function* rejectInvalidSelection() {
      const transaction = transactionWith(
        new Map<ApplicabilityTable, readonly object[]>([
          [products, [{ lifecycleState: 'ACTIVE' }]],
          [productAttributeApplicability, [{ currentRevision: 1, productLevel: true, variantLevel: false }]],
        ]),
      );
      const persistence = yield* attributeApplicabilityPersistenceForScope(
        // @ts-expect-error Focused transaction double models the query chain.
        transaction,
        scope,
        {
          assess: () => Effect.succeed({ evidence: invalidSelectionEvidence }),
          openSelections: ownerPopulation(),
        },
      );
      expect(
        yield* Effect.flip(
          persistence.change({
            ...base,
            expectedRevision: 1,
            impactConfirmation,
            productLevel: false,
            variantLevel: true,
          }),
        ),
      ).toMatchObject({ conflict: 'SELECTION_IMPACT' });
    }),
  );
});
