import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { packageDefinitions, packageOptionRoleRevisions, products } from '../../src/database/schema.ts';
import {
  VariantUseChangeBasisUnavailable,
  variantReactivationBasisForScope,
} from '../../src/persistence/variant-use-change-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '33333333-3333-4333-8333-333333333333';
const packageDefinitionId = '44444444-4444-4444-8444-444444444444';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:variant-reactivation-basis:run:1',
    authMethod: 'system',
    principalId: '55555555-5555-4555-8555-555555555555',
    tenantId,
  }),
  correlationId: 'variant-reactivation-basis-test',
};
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: variantId,
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
type Table = typeof products | typeof packageDefinitions | typeof packageOptionRoleRevisions;
interface ProductRow {
  readonly lifecycleState: string;
  readonly productId: string;
}
interface DefinitionRow {
  readonly currentOptionRevision: number;
  readonly lifecycleState: string;
  readonly optionState: string;
  readonly packageDefinitionId: string;
}
interface RoleRow {
  readonly independentlyRequested: boolean;
  readonly looseUnitsSubstitutable: boolean;
  readonly state: string;
}

const definition = (overrides: Partial<typeof packageDefinitions.$inferSelect> = {}) => ({
  currentOptionRevision: 1,
  lifecycleState: 'ACTIVE',
  optionState: 'ACTIVE',
  packageDefinitionId,
  ...overrides,
});
const role = (overrides: Partial<typeof packageOptionRoleRevisions.$inferSelect> = {}) => ({
  independentlyRequested: true,
  looseUnitsSubstitutable: false,
  state: 'ACTIVE',
  ...overrides,
});
const productsQuery = (product: ProductRow | undefined) => ({
  where: () => ({ limit: () => Effect.succeed(product === undefined ? [] : [product]) }),
});
const definitionsQuery = (definitions: readonly DefinitionRow[]) => ({
  where: () => ({ pipe: () => Effect.succeed(definitions) }),
});
const roleQuery = (optionRole: RoleRow | undefined) => ({
  where: () => ({ limit: () => Effect.succeed(optionRole === undefined ? [] : [optionRole]) }),
});
const mockTransaction = (rows: {
  readonly definitions?: readonly DefinitionRow[];
  readonly product?: ProductRow;
  readonly role?: RoleRow;
}) => ({
  select: () => ({
    from: (table: Table) => {
      if (table === products) {
        return productsQuery(rows.product);
      }
      if (table === packageDefinitions) {
        return definitionsQuery(rows.definitions ?? []);
      }
      if (table === packageOptionRoleRevisions) {
        return roleQuery(rows.role);
      }
      throw new Error('Unexpected table');
    },
  }),
});
const basisFor = (rows: Parameters<typeof mockTransaction>[0]) =>
  // @ts-expect-error Only the exercised Drizzle query chains are mocked.
  variantReactivationBasisForScope(mockTransaction(rows), scope);

describe('Variant reactivation basis (#441 rule 10)', () => {
  it.effect('reports an active parent and a selectable required Package Option', () =>
    Effect.gen(function* activeBasis() {
      const basis = basisFor({
        definitions: [definition()],
        product: { lifecycleState: 'ACTIVE', productId },
        role: role(),
      });
      expect(yield* basis.read({ productRef, variantRef })).toEqual({
        parentProductLifecycle: 'ACTIVE',
        requiredPackageOptions: [{ lifecycle: 'ACTIVE' }],
      });
    }),
  );

  it.effect('reports a retired/inactive required Package Option as RETIRED', () =>
    Effect.gen(function* retiredOption() {
      const basis = basisFor({
        definitions: [definition({ optionState: 'RETIRED' })],
        product: { lifecycleState: 'ACTIVE', productId },
        role: role({ state: 'RETIRED' }),
      });
      expect(yield* basis.read({ productRef, variantRef })).toEqual({
        parentProductLifecycle: 'ACTIVE',
        requiredPackageOptions: [{ lifecycle: 'RETIRED' }],
      });
    }),
  );

  it.effect('ignores a quantity-only Package Option that loose Variant quantity already satisfies', () =>
    Effect.gen(function* quantityOnly() {
      const basis = basisFor({
        definitions: [definition()],
        product: { lifecycleState: 'ACTIVE', productId },
        role: role({ looseUnitsSubstitutable: true }),
      });
      expect(yield* basis.read({ productRef, variantRef })).toEqual({
        parentProductLifecycle: 'ACTIVE',
        requiredPackageOptions: [],
      });
    }),
  );

  it.effect('fails closed when a Current Package Option role cannot be verified', () =>
    Effect.gen(function* missingRole() {
      const failure = yield* basisFor({
        definitions: [definition()],
        product: { lifecycleState: 'ACTIVE', productId },
      })
        .read({ productRef, variantRef })
        .pipe(Effect.flip);
      expect(Schema.is(VariantUseChangeBasisUnavailable)(failure)).toBe(true);
    }),
  );

  it.effect('rejects a foreign tenant before querying private data', () =>
    Effect.gen(function* foreignTenant() {
      const transaction = {
        select: () => {
          throw new Error('foreign tenant must not query Catalog');
        },
      };
      const failure = yield* variantReactivationBasisForScope(
        // @ts-expect-error Only the guarded query path is mocked.
        transaction,
        scope,
      )
        .read({ productRef: { ...productRef, tenantId: '99999999-9999-4999-8999-999999999999' }, variantRef })
        .pipe(Effect.flip);
      expect(Schema.is(VariantUseChangeBasisUnavailable)(failure)).toBe(true);
    }),
  );
});
