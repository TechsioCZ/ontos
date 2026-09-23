import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';

import { PackageDefinitionContentInputSchema } from '../../shared/actions/package-definition-contract.ts';
import { packageContentBasisForTransaction } from '../../src/actions/package-definition-action-support.ts';
import {
  packageDefinitions,
  productUnitRuleRevisions,
  productUnits,
  productVariants,
  products,
  setCompositionRevisions,
  setCompositions,
} from '../../src/database/schema.ts';
import type { packageContentRevisions } from '../../src/database/schema.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:package-basis-test:run:1',
    authMethod: 'system',
    principalId: '22222222-2222-4222-8222-222222222222',
    tenantId,
  }),
  correlationId: 'package-basis-test',
};
const productId = '33333333-3333-4333-8333-333333333333';
const variantId = '44444444-4444-4444-8444-444444444444';
const packageId = '55555555-5555-4555-8555-555555555555';
const lowerId = '77777777-7777-4777-8777-777777777777';
const unitId = '66666666-6666-4666-8666-666666666666';
const compositionId = '88888888-8888-4888-8888-888888888888';
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType: `commerce.catalog.${resourceType}`,
  tenantId,
});
const content = Schema.decodeUnknownSync(PackageDefinitionContentInputSchema)({
  amount: '20',
  effectiveAt: '2026-09-17T10:00:00.000Z',
  form: { productRef: ref('product', productId), variantRef: ref('variant', variantId) },
  lower: { count: '2', revision: { resourceRef: ref('package-definition', lowerId), revision: 1 } },
  unitRef: ref('product-unit', unitId),
});
const lowerRow = {
  amount: '10',
  configurationKey: null,
  effectiveAt: new Date('1900-01-01T00:00:00.000Z'),
  lowerCount: null,
  lowerPackageDefinitionId: null,
  lowerRevision: null,
  productId,
  revision: 1,
  setCompositionResourceId: null,
  setCompositionRevision: null,
  unitResourceId: unitId,
  unitResourceType: 'commerce.catalog.product-unit',
  variantId,
};
interface Overrides {
  readonly composition?: { readonly currentRevision: number } | null;
  readonly compositionRevision?: {
    readonly effectiveFrom: Date;
    readonly effectiveTo: Date | null;
    readonly lifecycleState: string;
  } | null;
  readonly lower?: Omit<typeof lowerRow, 'setCompositionResourceId' | 'setCompositionRevision'> & {
    readonly setCompositionResourceId: string | null;
    readonly setCompositionRevision: number | null;
  };
  readonly lowerRevisions?: readonly (typeof lowerRow)[];
  readonly unit?: { readonly lifecycleState: string } | null;
}
type Table =
  | typeof products
  | typeof productVariants
  | typeof productUnits
  | typeof productUnitRuleRevisions
  | typeof packageDefinitions
  | typeof setCompositions
  | typeof setCompositionRevisions
  | typeof packageContentRevisions;
const rowsForTable = (table: Table, overrides: Overrides) => {
  if (table === products || table === productVariants) {
    return [{ lifecycleState: 'ACTIVE' }];
  }
  if (table === productUnits) {
    return overrides.unit === null ? [] : [overrides.unit ?? { currentRuleRevision: 1, lifecycleState: 'ACTIVE' }];
  }
  if (table === productUnitRuleRevisions) {
    return [{ lifecycleState: 'ACTIVE' }];
  }
  if (table === packageDefinitions) {
    return [{ productId, variantId }];
  }
  if (table === setCompositions) {
    return overrides.composition === undefined || overrides.composition === null ? [] : [overrides.composition];
  }
  if (table === setCompositionRevisions) {
    return overrides.compositionRevision === null
      ? []
      : [
          overrides.compositionRevision ?? {
            effectiveFrom: new Date('1900-01-01'),
            effectiveTo: null,
            lifecycleState: 'ACTIVE',
          },
        ];
  }
  return overrides.lowerRevisions ?? [overrides.lower ?? lowerRow];
};
const query = (table: Table, overrides: Overrides) => ({
  where: () => ({
    for: () => ({
      limit: () => Effect.succeed(rowsForTable(table, overrides)),
      pipe: () => Effect.succeed(rowsForTable(table, overrides)),
    }),
    limit: () => Effect.succeed(rowsForTable(table, overrides)),
    pipe: () => Effect.succeed(rowsForTable(table, overrides)),
  }),
});
const transaction = (overrides: Overrides = {}) => ({
  select: () => ({ from: (table: Table) => query(table, overrides) }),
});

describe('Package Content Current basis', () => {
  const setContent = Schema.decodeUnknownSync(PackageDefinitionContentInputSchema)({
    ...content,
    setComposition: { resourceRef: ref('set-composition', compositionId), revision: 1 },
  });
  it.effect('accepts owned Unit and exact lower revision with matching conversion', () =>
    Effect.gen(function* acceptsExactLower() {
      // @ts-expect-error Mock implements only the exercised Drizzle read chain.
      const basis = packageContentBasisForTransaction(transaction(), scope);
      expect(yield* basis.verify({ content, definitionId: packageId, tenantId })).toBe(true);
    }),
  );

  it.effect('uses the pinned owner-effective lower revision without leaking a pending successor', () =>
    Effect.gen(function* resolvesEffectiveLower() {
      const pending = { ...lowerRow, amount: '8', effectiveAt: new Date('2100-01-01T00:00:00.000Z'), revision: 2 };
      const basis = packageContentBasisForTransaction(
        // @ts-expect-error Mock implements only the exercised Drizzle read chain.
        transaction({ lowerRevisions: [lowerRow, pending] }),
        scope,
      );
      expect(yield* basis.verify({ content, definitionId: packageId, tenantId })).toBe(true);
      const futurePinned = Schema.decodeUnknownSync(PackageDefinitionContentInputSchema)({
        ...content,
        lower: { count: '2', revision: { resourceRef: ref('package-definition', lowerId), revision: 2 } },
      });
      expect(yield* basis.verify({ content: futurePinned, definitionId: packageId, tenantId })).toBe(false);
      const futureUpper = Schema.decodeUnknownSync(PackageDefinitionContentInputSchema)({
        ...content,
        amount: '16',
        effectiveAt: '2100-01-02T00:00:00.000Z',
        lower: { count: '2', revision: { resourceRef: ref('package-definition', lowerId), revision: 2 } },
      });
      expect(yield* basis.verify({ content: futureUpper, definitionId: packageId, tenantId })).toBe(true);
    }),
  );

  it.effect('rejects gaps and non-monotonic effective times in the lower owner chain', () =>
    Effect.gen(function* rejectsInvalidLowerChain() {
      const invalidChains = [
        [lowerRow, { ...lowerRow, effectiveAt: new Date('2100-01-01T00:00:00.000Z'), revision: 3 }],
        [lowerRow, { ...lowerRow, effectiveAt: new Date('1800-01-01T00:00:00.000Z'), revision: 2 }],
      ];
      for (const lowerRevisions of invalidChains) {
        const basis = packageContentBasisForTransaction(
          // @ts-expect-error Mock implements only the exercised Drizzle read chain.
          transaction({ lowerRevisions }),
          scope,
        );
        expect(yield* basis.verify({ content, definitionId: packageId, tenantId })).toBe(false);
      }
    }),
  );

  it.effect('rejects absent or retired Unit, mismatched conversion, and unverified Set', () =>
    Effect.gen(function* rejectsInvalidBasis() {
      const cases: readonly Overrides[] = [
        { unit: null },
        { unit: { lifecycleState: 'RETIRED' } },
        { lower: { ...lowerRow, amount: '8' } },
      ];
      for (const overrides of cases) {
        // @ts-expect-error Mock implements only the exercised Drizzle read chain.
        const basis = packageContentBasisForTransaction(transaction(overrides), scope);
        expect(yield* basis.verify({ content, definitionId: packageId, tenantId })).toBe(false);
      }
      // @ts-expect-error Mock implements only the exercised Drizzle read chain.
      const basis = packageContentBasisForTransaction(transaction({ composition: null }), scope);
      expect(yield* basis.verify({ content: setContent, definitionId: packageId, tenantId })).toBe(false);
    }),
  );

  it.effect('requires an exact Set revision when the target has a Set composition', () =>
    Effect.gen(function* requiresSetRevision() {
      const basis = packageContentBasisForTransaction(
        // @ts-expect-error Mock implements only the exercised Drizzle read chain.
        transaction({ composition: { currentRevision: 1 } }),
        scope,
      );
      expect(yield* basis.verify({ content, definitionId: packageId, tenantId })).toBe(false);
    }),
  );

  it.effect('rejects stale, inactive, future, or missing Set composition before component proof', () =>
    Effect.gen(function* rejectsUnverifiableSet() {
      const matchingLower = { ...lowerRow, setCompositionResourceId: compositionId, setCompositionRevision: 1 };
      const cases: readonly Overrides[] = [
        { composition: null },
        { composition: { currentRevision: 0 } },
        { composition: { currentRevision: 1 }, compositionRevision: null },
        {
          composition: { currentRevision: 1 },
          compositionRevision: { effectiveFrom: new Date('2020-01-01'), effectiveTo: null, lifecycleState: 'RETIRED' },
        },
        {
          composition: { currentRevision: 1 },
          compositionRevision: { effectiveFrom: new Date('2100-01-01'), effectiveTo: null, lifecycleState: 'ACTIVE' },
        },
      ];
      for (const overrides of cases) {
        const basis = packageContentBasisForTransaction(
          // @ts-expect-error Mock implements only the exercised Drizzle read chain.
          transaction({ ...overrides, lower: matchingLower }),
          scope,
        );
        expect(yield* basis.verify({ content: setContent, definitionId: packageId, tenantId })).toBe(false);
      }
    }),
  );
});
