import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  productLocalizedFacts,
  productRevisions,
  productVariantRevisions,
  productVariants,
  products,
} from '../../src/database/schema.ts';
import { catalogPersistenceForScope } from '../../src/persistence/catalog-persistence.ts';

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, sonarjs/no-nested-functions -- The Drizzle transaction mock records heterogeneous table inserts and only implements Product creation's exercised query chains. expires: 2027-03-31. */

const tenantId = '00000000-0000-4000-8000-000000000001';
const principalId = '00000000-0000-4000-8000-000000000002';
const variantId = '00000000-0000-4000-8000-000000000003';
const actionInvocationId = '00000000-0000-4000-8000-000000000004';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:product-create-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'product-create-test',
};

describe('Product create initial Variant history', () => {
  it.effect('appends exactly one matching WIP Variant revision in the scoped transaction', () =>
    Effect.gen(function* createInitialVariantRevisionCase() {
      const writes: [unknown, Record<string, unknown>][] = [];
      const now = new Date('2026-09-17T10:00:00.000Z');
      const transaction = {
        insert: (table: unknown) => ({
          values: (value: Record<string, unknown>) => {
            writes.push([table, value]);
            return Effect.succeed([]);
          },
        }),
        select: () => ({
          from: (table: unknown) => ({
            where: () =>
              table === productLocalizedFacts
                ? Effect.succeed([])
                : {
                    limit: () => {
                      expect(table).toBe(products);
                      return Effect.succeed([
                        { ...writes[0]?.[1], createdAt: now, currentRevision: 1, updatedAt: now },
                      ]);
                    },
                    orderBy: () => {
                      expect(table).toBe(productVariants);
                      return Effect.succeed([{ ...writes[1]?.[1], createdAt: now }]);
                    },
                  },
          }),
        }),
      };
      // @ts-expect-error Only the Product create query chains are exercised.
      const persistence = yield* catalogPersistenceForScope(transaction, scope);
      const outcome = yield* persistence.create({
        actionInvocationId,
        // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Create input explicitly models the absent optional description.
        description: undefined,
        name: 'New product',
        principalId,
        reason: 'Initial catalog record',
        tenantId,
        variantId,
      });
      expect(outcome).toHaveProperty('variantId', variantId);
      expect(writes.map(([table]) => table)).toEqual([
        products,
        productVariants,
        productVariantRevisions,
        productRevisions,
      ]);
      expect(writes[2]?.[1]).toMatchObject({
        actingPrincipalId: principalId,
        actionInvocationId,
        changeKind: 'CREATED',
        combinationAxisRevision: null,
        combinationKey: null,
        evidenceRefs: [],
        lifecycleState: 'WORK_IN_PROGRESS',
        productId: writes[0]?.[1].productId,
        reason: 'Initial catalog record',
        revision: 1,
        tenantId,
        variantId,
      });
    }),
  );
});
