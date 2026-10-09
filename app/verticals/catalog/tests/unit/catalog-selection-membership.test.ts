import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { productVariants, products } from '../../src/database/schema.ts';
import { catalogSelectionMembershipForScope } from '../../src/persistence/catalog-selection-membership.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '33333333-3333-4333-8333-333333333333';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:membership-test:run:1',
    authMethod: 'system',
    principalId: '44444444-4444-4444-8444-444444444444',
    tenantId,
  }),
  correlationId: 'membership-test',
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
const selectedRows = (rows: readonly object[]) => {
  const effect = Effect.succeed(rows);
  return { where: () => ({ for: () => ({ limit: () => effect }) }) };
};

describe('Catalog Selection membership', () => {
  it.effect('does not query across tenant scope', () =>
    Effect.gen(function* rejectForeignTenant() {
      const transaction = {
        select: () => {
          throw new Error('forbidden query');
        },
      };
      // @ts-expect-error Deliberately mocks only the forbidden query path.
      const result = yield* catalogSelectionMembershipForScope(transaction, scope).issue(
        { ...productRef, tenantId: '55555555-5555-4555-8555-555555555555' },
        variantRef,
      );
      expect(result).toEqual({ reason: 'WRONG_SCOPE', status: 'INVALID' });
    }),
  );

  it.effect('issues only for the locked Product and Variant Current rows', () =>
    Effect.gen(function* issueMembership() {
      const locked: object[] = [];
      const transaction = {
        select: () => ({
          from: (table: typeof products | typeof productVariants) => {
            locked.push(table);
            return selectedRows(
              table === products ? [{ currentRevision: 4, productId }] : [{ currentRevision: 7, productId, variantId }],
            );
          },
        }),
      };
      // @ts-expect-error Only the exercised Drizzle chains are mocked.
      const result = yield* catalogSelectionMembershipForScope(transaction, scope).issue(productRef, variantRef);
      expect(locked).toEqual([products, productVariants]);
      expect(result.status).toBe('ISSUED');
      if (result.status === 'ISSUED') {
        expect(result.membership.variant.revision).toBe(7);
        expect(result.membership.productRef).toEqual(productRef);
        expect(result.membership.source).toBe('CATALOG_OWNER_CURRENT_READ');
      }
    }),
  );

  it.effect('rejects a Variant belonging to another Product', () =>
    Effect.gen(function* rejectWrongProduct() {
      const transaction = {
        select: () => ({
          from: (table: typeof products | typeof productVariants) =>
            selectedRows(
              table === products
                ? [{ currentRevision: 4, productId }]
                : [{ currentRevision: 7, productId: '66666666-6666-4666-8666-666666666666', variantId }],
            ),
        }),
      };
      // @ts-expect-error Only the exercised Drizzle chains are mocked.
      expect(yield* catalogSelectionMembershipForScope(transaction, scope).issue(productRef, variantRef)).toEqual({
        reason: 'WRONG_PRODUCT',
        status: 'INVALID',
      });
    }),
  );
});
