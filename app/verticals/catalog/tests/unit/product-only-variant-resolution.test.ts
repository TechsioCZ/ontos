import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ProductRefSchema } from '../../shared/resources/product.ts';
import { productVariants, products } from '../../src/database/schema.ts';
import { productOnlyVariantResolutionForScope } from '../../src/persistence/product-only-variant-resolution.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '33333333-3333-4333-8333-333333333333';
const productRef = Schema.decodeUnknownSync(ProductRefSchema)({
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
});
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:product-only-variant-resolution-test:run:1',
    authMethod: 'system',
    principalId: '66666666-6666-4666-8666-666666666666',
    tenantId,
  }),
  correlationId: 'product-only-variant-resolution-test',
};

const readResult = (table: typeof products | typeof productVariants, rows: readonly object[], ownerExists: boolean) => {
  if (table === products) {
    return ownerExists ? [{ productId, tenantId }] : [];
  }
  return rows;
};
const readChain = (result: readonly object[]) => ({
  where: () => ({
    for: () => ({ limit: () => Effect.succeed(result) }),
    limit: () => Effect.succeed(result),
  }),
});
const makeService = (rows: readonly object[], ownerExists = true) => {
  const reads: unknown[] = [];
  const transaction = {
    select: () => ({
      from: (table: typeof products | typeof productVariants) => {
        reads.push(table);
        return readChain(readResult(table, rows, ownerExists));
      },
    }),
  };
  // @ts-expect-error Mock implements only the exercised Drizzle read chains.
  return { reads, service: productOnlyVariantResolutionForScope(transaction, scope) };
};

describe('Product-only Variant owner resolution', () => {
  it.effect('returns the exact sole Active identity without a Current claim', () =>
    Effect.gen(function* soleActive() {
      const { reads, service } = makeService([{ tenantId, variantId }]);
      expect(yield* service.resolve(productRef)).toEqual({
        exactForm: {
          productRef,
          variantRef: {
            moduleId: 'commerce.catalog',
            resourceId: variantId,
            resourceType: 'commerce.catalog.variant',
            tenantId,
          },
        },
        status: 'RESOLVED',
      });
      expect(reads).toEqual([products, productVariants]);
    }),
  );

  it.effect('returns ambiguity rather than selecting by row order', () =>
    Effect.gen(function* ambiguous() {
      const { service } = makeService([
        { tenantId, variantId },
        { tenantId, variantId: '44444444-4444-4444-8444-444444444444' },
      ]);
      expect(yield* service.resolve(productRef)).toEqual({ status: 'AMBIGUOUS' });
    }),
  );

  it.effect('fails closed for absent owner, absent Active Variant, and wrong Tenant', () =>
    Effect.gen(function* failClosed() {
      const missing = makeService([], false);
      expect(yield* missing.service.resolve(productRef)).toEqual({ status: 'PRODUCT_NOT_FOUND' });
      expect(missing.reads).toEqual([products]);
      expect(yield* makeService([]).service.resolve(productRef)).toEqual({ status: 'NO_ELIGIBLE_VARIANT' });
      const wrongTenant = makeService([]);
      expect(
        yield* wrongTenant.service.resolve({ ...productRef, tenantId: '99999999-9999-4999-8999-999999999999' }),
      ).toEqual({ status: 'INVALID_SCOPE' });
      expect(wrongTenant.reads).toEqual([]);
    }),
  );
});
