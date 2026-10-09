import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { products } from '../../src/database/schema.ts';
import type { productVariants } from '../../src/database/schema.ts';
import { axisFreeCombinationKey, variantCurrentBasisForScope } from '../../src/persistence/variant-current-basis.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:variant-basis-test:run:1',
    authMethod: 'system',
    principalId: '22222222-2222-4222-8222-222222222222',
    tenantId,
  }),
  correlationId: 'variant-basis-test',
};
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const selectedRows = (rows: readonly object[]) => {
  const effect = Effect.succeed(rows);
  return { where: () => ({ for: () => Object.assign(effect, { limit: () => effect }) }) };
};

describe('Variant Current basis', () => {
  it('has a stable 64-character candidate key for the empty axis vector', () => {
    expect(axisFreeCombinationKey()).toBe('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
  });

  it.effect('rejects a foreign tenant before querying private data', () =>
    Effect.gen(function* rejectForeignTenant() {
      const transaction = {
        select: () => {
          throw new Error('foreign tenant must not query Catalog');
        },
      };
      // @ts-expect-error This test deliberately mocks only the forbidden query path.
      const basis = variantCurrentBasisForScope(transaction, scope);
      expect(
        yield* basis.inspect({ ...productRef, tenantId: '55555555-5555-4555-8555-555555555555' }, variantRef),
      ).toEqual({ reason: 'WRONG_SCOPE', status: 'INVALID' });
    }),
  );

  it.effect('does not infer a Variant from possible values or another Product', () =>
    Effect.gen(function* rejectAbsentVariant() {
      const transaction = {
        select: () => ({
          from: (table: typeof products | typeof productVariants) =>
            selectedRows(table === products ? [{ productId: productRef.resourceId }] : []),
        }),
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const basis = variantCurrentBasisForScope(transaction, scope);
      expect(yield* basis.inspect(productRef, variantRef)).toEqual({ reason: 'WRONG_PRODUCT', status: 'INVALID' });
    }),
  );

  it.effect('keeps recorded draft and retired forms separate from Current selection', () =>
    Effect.gen(function* rejectNonCurrentForms() {
      for (const lifecycleState of ['WORK_IN_PROGRESS', 'RETIRED']) {
        const transaction = {
          select: () => ({
            from: (table: typeof products | typeof productVariants) =>
              selectedRows(
                table === products
                  ? [{ productId: productRef.resourceId }]
                  : [{ lifecycleState, productId: productRef.resourceId, variantId: variantRef.resourceId }],
              ),
          }),
        };
        // @ts-expect-error Only the exercised Drizzle query chains are mocked.
        const basis = variantCurrentBasisForScope(transaction, scope);
        expect(yield* basis.inspect(productRef, variantRef)).toEqual({ reason: 'NOT_CURRENT', status: 'INVALID' });
      }
    }),
  );
});
