import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  packageDefinitions,
  packageContentRevisions,
  packageUnitDivisibility,
  productUnitRuleRevisions,
  productUnits,
  productVariants,
  products,
  variantUnitDivisibility,
} from '../../src/database/schema.ts';
import { catalogQuantityPreparationForScope } from '../../src/persistence/catalog-quantity-preparation.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '33333333-3333-4333-8333-333333333333';
const unitId = '44444444-4444-4444-8444-444444444444';
const packageId = '55555555-5555-4555-8555-555555555555';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:catalog-quantity-test:run:1',
    authMethod: 'system',
    principalId: '66666666-6666-4666-8666-666666666666',
    tenantId,
  }),
  correlationId: 'catalog-quantity-test',
};
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: productId,
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: variantId,
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});

const rows = new Map<unknown, unknown>([
  [products, { currentRevision: 2, lifecycleState: 'ACTIVE', productId }],
  [productVariants, { currentRevision: 3, lifecycleState: 'ACTIVE', productId, variantId }],
  [
    packageDefinitions,
    {
      currentRevision: 4,
      lifecycleState: 'ACTIVE',
      optionState: 'ACTIVE',
      packageDefinitionId: packageId,
      productId,
      variantId,
    },
  ],
  [variantUnitDivisibility, { currentRevision: 5, divisible: true, unitId, variantId }],
  [packageUnitDivisibility, { currentRevision: 6, divisible: false, packageDefinitionId: packageId, unitId }],
  [productUnits, { currentRuleRevision: 7, lifecycleState: 'ACTIVE', unitId }],
  [productUnitRuleRevisions, { revision: 7, rounding: 'UP', step: '0.01', unitId }],
  [
    packageContentRevisions,
    [1, 2, 3, 4].map((revision) => ({ effectiveAt: new Date(`196${revision}-01-01T00:00:00Z`), revision })),
  ],
]);
type ReadTable =
  | typeof products
  | typeof productVariants
  | typeof packageDefinitions
  | typeof variantUnitDivisibility
  | typeof packageUnitDivisibility
  | typeof productUnits
  | typeof productUnitRuleRevisions
  | typeof packageContentRevisions;
const queryResult = (table: ReadTable, overrides: Map<unknown, unknown>) => {
  const row = overrides.has(table) ? overrides.get(table) : rows.get(table);
  if (row === null) {
    return Effect.succeed([]);
  }
  return Effect.succeed(Array.isArray(row) ? row : [row]);
};
const makeLimit = (table: ReadTable, overrides: Map<unknown, unknown>) => () => queryResult(table, overrides);
const makeWhere = (table: ReadTable, overrides: Map<unknown, unknown>) => () =>
  table === packageContentRevisions ? queryResult(table, overrides) : { limit: makeLimit(table, overrides) };
const makeFrom = (overrides: Map<unknown, unknown>) => (table: ReadTable) => ({
  where: makeWhere(table, overrides),
});
const transactionFor = (overrides = new Map<unknown, unknown>()) => ({
  select: () => ({ from: makeFrom(overrides) }),
});

describe('Catalog quantity preparation', () => {
  it.effect('normalizes exactly and retains current source revisions', () =>
    Effect.gen(function* normalizesExactly() {
      // @ts-expect-error The mock provides only the read chains exercised here.
      const result = yield* catalogQuantityPreparationForScope(transactionFor(), scope).prepare({
        amount: '2.537',
        phase: 'PREPARE',
        selection,
      });
      expect(result.status).toBe('PREPARED');
      if (result.status === 'PREPARED') {
        expect(result.quantity).toMatchObject({
          changed: true,
          notice: 'ROUNDED',
          requested: '2.537',
          resulting: '2.54',
          unitRuleRevision: 7,
        });
        expect(result.sources).toMatchObject({
          product: { revision: 2 },
          targetDivisibilityRevision: 5,
          variant: { revision: 3 },
        });
      }
    }),
  );

  it.effect('rejects a fractional package count before rounding', () =>
    Effect.gen(function* rejectsFractionalPackage() {
      const packageSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
        ...selection,
        packageOption: {
          contentRevision: {
            resourceRef: {
              moduleId: 'commerce.catalog',
              resourceId: packageId,
              resourceType: 'commerce.catalog.package-definition',
              tenantId,
            },
            revision: 4,
          },
          optionRef: {
            moduleId: 'commerce.catalog',
            resourceId: packageId,
            resourceType: 'commerce.catalog.package-definition',
            tenantId,
          },
        },
      });
      // @ts-expect-error The mock provides only the read chains exercised here.
      const result = yield* catalogQuantityPreparationForScope(transactionFor(), scope).prepare({
        amount: '0.5',
        phase: 'PREPARE',
        selection: packageSelection,
      });
      expect(result.status).toBe('INVALID');
    }),
  );

  it.effect('does not prepare a scheduled future Package Content revision', () =>
    Effect.gen(function* rejectsFuturePackageContent() {
      const packageSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
        ...selection,
        packageOption: {
          contentRevision: {
            resourceRef: {
              moduleId: 'commerce.catalog',
              resourceId: packageId,
              resourceType: 'commerce.catalog.package-definition',
              tenantId,
            },
            revision: 4,
          },
          optionRef: {
            moduleId: 'commerce.catalog',
            resourceId: packageId,
            resourceType: 'commerce.catalog.package-definition',
            tenantId,
          },
        },
      });
      const overrides = new Map<unknown, unknown>([
        [
          packageContentRevisions,
          [1, 2, 3, 4].map((revision) => ({
            effectiveAt: new Date(revision === 4 ? '2099-01-01T00:00:00Z' : `196${revision}-01-01T00:00:00Z`),
            revision,
          })),
        ],
      ]);
      // @ts-expect-error The mock provides only the read chains exercised here.
      const result = yield* catalogQuantityPreparationForScope(transactionFor(overrides), scope).prepare({
        amount: '2',
        phase: 'PREPARE',
        selection: packageSelection,
      });
      expect(result.status).toBe('STALE');
    }),
  );

  it.effect('returns stale when a candidate pins an older Unit rule', () =>
    Effect.gen(function* detectsStaleRule() {
      // @ts-expect-error The mock provides only the read chains exercised here.
      const prepared = yield* catalogQuantityPreparationForScope(transactionFor(), scope).prepare({
        amount: '2.53',
        phase: 'PREPARE',
        selection,
      });
      expect(prepared.status).toBe('PREPARED');
      if (prepared.status !== 'PREPARED') {
        return;
      }
      // @ts-expect-error The mock provides only the read chains exercised here.
      const result = yield* catalogQuantityPreparationForScope(transactionFor(), scope).prepare({
        amount: '2.53',
        expected: {
          productRevision: 2,
          quantity: prepared.quantity,
          selection: prepared.selection,
          targetDivisibilityRevision: 5,
          unitRuleRevision: 6,
          variantRevision: 3,
        },
        phase: 'APPROVED',
        selection,
      });
      expect(result.status).toBe('STALE');
    }),
  );

  it.effect('pins requested and resulting Quantity through approval and commitment', () =>
    Effect.gen(function* pinsCandidateAmount() {
      // @ts-expect-error The mock provides only the read chains exercised here.
      const prepared = yield* catalogQuantityPreparationForScope(transactionFor(), scope).prepare({
        amount: '2.537',
        phase: 'PREPARE',
        selection,
      });
      expect(prepared.status).toBe('PREPARED');
      if (prepared.status !== 'PREPARED') {
        return;
      }
      const expected = {
        productRevision: prepared.sources.product.revision,
        quantity: prepared.quantity,
        selection: prepared.selection,
        targetDivisibilityRevision: prepared.sources.targetDivisibilityRevision,
        unitRuleRevision: prepared.sources.unitRuleRevision,
        variantRevision: prepared.sources.variant.revision,
      };
      for (const phase of ['APPROVED', 'COMMITTING'] as const) {
        // @ts-expect-error The mock provides only the read chains exercised here.
        const unchanged = yield* catalogQuantityPreparationForScope(transactionFor(), scope).prepare({
          amount: '2.537',
          expected,
          phase,
          selection,
        });
        expect(unchanged.status).toBe('PREPARED');
        // @ts-expect-error The mock provides only the read chains exercised here.
        const sameResultWithChangedRequest = yield* catalogQuantityPreparationForScope(transactionFor(), scope).prepare(
          {
            amount: '2.54',
            expected,
            phase,
            selection,
          },
        );
        expect(sameResultWithChangedRequest.status).toBe('STALE');
        // @ts-expect-error The mock provides only the read chains exercised here.
        const changed = yield* catalogQuantityPreparationForScope(transactionFor(), scope).prepare({
          amount: '2.55',
          expected,
          phase,
          selection,
        });
        expect(changed.status).toBe('STALE');
      }
    }),
  );

  it.effect('rejects a changed selection even when the quantity sources still match', () =>
    Effect.gen(function* pinsCandidateSelection() {
      // @ts-expect-error The mock provides only the read chains exercised here.
      const prepared = yield* catalogQuantityPreparationForScope(transactionFor(), scope).prepare({
        amount: '2',
        phase: 'PREPARE',
        selection,
      });
      expect(prepared.status).toBe('PREPARED');
      if (prepared.status !== 'PREPARED') {
        return;
      }
      const changedSelection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
        ...selection,
        setComposition: {
          resourceRef: {
            moduleId: 'commerce.catalog',
            resourceId: '77777777-7777-4777-8777-777777777777',
            resourceType: 'commerce.catalog.set-composition',
            tenantId,
          },
          revision: 1,
        },
      });
      // @ts-expect-error The mock provides only the read chains exercised here.
      const result = yield* catalogQuantityPreparationForScope(transactionFor(), scope).prepare({
        amount: '2',
        expected: {
          productRevision: prepared.sources.product.revision,
          quantity: prepared.quantity,
          selection: prepared.selection,
          targetDivisibilityRevision: prepared.sources.targetDivisibilityRevision,
          unitRuleRevision: prepared.sources.unitRuleRevision,
          variantRevision: prepared.sources.variant.revision,
        },
        phase: 'APPROVED',
        selection: changedSelection,
      });
      expect(result.status).toBe('STALE');
    }),
  );
});
