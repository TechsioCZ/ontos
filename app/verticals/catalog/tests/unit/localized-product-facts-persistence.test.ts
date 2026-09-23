import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

/* oxlint-disable anti-slop/no-unknown-parameters -- Query-table mocks intentionally accept opaque Drizzle table identities and assert exact instances. expires: 2027-03-31. */

import { productLocalizedFactRevisions, productLocalizedFacts, products } from '../../src/database/schema.ts';
import { localizedProductFactsPersistenceForScope } from '../../src/persistence/localized-product-facts-persistence.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const productId = '00000000-0000-4000-8000-000000000002';
const principalId = '00000000-0000-4000-8000-000000000003';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:localized-facts-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'localized-facts-test',
};
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const base = {
  actionInvocationId: '00000000-0000-4000-8000-000000000004',
  evidenceRefs: ['catalog-record:1'],
  expectedRevision: 0,
  locale: 'cs-CZ',
  principalId,
  productRef,
  reason: 'Verified factual copy',
};
const selected = (rows: readonly object[]) => ({
  where: () => ({ for: () => ({ limit: () => Effect.succeed(rows) }), limit: () => Effect.succeed(rows) }),
});

describe('localized Product facts persistence', () => {
  it.effect('rejects cross-tenant writes before touching the transaction', () =>
    Effect.gen(function* rejectCrossTenant() {
      const transaction = new Proxy(
        {},
        {
          get: () => {
            throw new Error('transaction touched');
          },
        },
      );
      // @ts-expect-error The transaction must not be used for invalid ownership.
      const service = localizedProductFactsPersistenceForScope(transaction, scope);
      const result = yield* service.changeProduct({
        ...base,
        productRef: { ...productRef, tenantId: '00000000-0000-4000-8000-000000000099' },
        value: { facts: { name: 'Police' }, kind: 'SET' },
      });
      expect(result).toEqual({ kind: 'INVALID' });
    }),
  );

  it.effect('creates a locale independently of legacy scalar name and appends evidence', () =>
    Effect.gen(function* createLocale() {
      const writes: unknown[] = [];
      const transaction = {
        insert: (table: unknown) => ({
          values: (row: unknown) => {
            writes.push([table, row]);
            return Effect.succeed([]);
          },
        }),
        select: () => ({ from: (table: unknown) => selected(table === products ? [{ productId }] : []) }),
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = localizedProductFactsPersistenceForScope(transaction, scope);
      const result = yield* service.changeProduct({ ...base, value: { facts: { name: 'Police' }, kind: 'SET' } });
      expect(result).toEqual({ kind: 'CHANGED', revision: 1 });
      expect(writes).toEqual([
        [
          productLocalizedFacts,
          expect.objectContaining({ currentRevision: 1, locale: 'cs-CZ', name: 'Police', productId, state: 'SET' }),
        ],
        [
          productLocalizedFactRevisions,
          expect.objectContaining({
            actionInvocationId: base.actionInvocationId,
            evidenceRefs: base.evidenceRefs,
            revision: 1,
            state: 'SET',
          }),
        ],
      ]);
    }),
  );

  it.effect('reports a missing requested translation without relabeling another locale', () =>
    Effect.gen(function* readMissingLocale() {
      const transaction = {
        select: () => ({ from: (table: unknown) => selected(table === products ? [{ productId }] : []) }),
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = localizedProductFactsPersistenceForScope(transaction, scope);
      expect(yield* service.readProduct(productRef, 'de-DE')).toEqual({
        kind: 'MISSING_TRANSLATION',
        locale: 'de-DE',
        revision: 0,
      });
    }),
  );

  it.effect('does not remove the last usable name of an ACTIVE Product', () =>
    Effect.gen(function* preserveLastName() {
      let localizedReads = 0;
      const transaction = {
        insert: () => {
          throw new Error('last-name removal wrote a revision');
        },
        select: () => ({
          from: (table: unknown) => {
            if (table === products) {
              return selected([{ lifecycleState: 'ACTIVE', productId }]);
            }
            if (table === productLocalizedFactRevisions) {
              return selected([]);
            }
            localizedReads += 1;
            if (localizedReads === 1) {
              return selected([{ currentRevision: 1, locale: 'cs-CZ', name: 'Police', state: 'SET' }]);
            }
            return { where: () => Effect.succeed([{ locale: 'cs-CZ', name: 'Police', state: 'SET' }]) };
          },
        }),
        update: () => {
          throw new Error('last-name removal changed Current');
        },
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = localizedProductFactsPersistenceForScope(transaction, scope);
      const result = yield* service.changeProduct({ ...base, expectedRevision: 1, value: { kind: 'REMOVE' } });
      expect(result).toEqual({ kind: 'TEXT_MINIMUM_CONFLICT' });
    }),
  );

  it.effect('replays only the exact recorded invocation without another write', () =>
    Effect.gen(function* replayExactInvocation() {
      const transaction = {
        insert: () => {
          throw new Error('replay inserted another revision');
        },
        select: () => ({
          from: (table: unknown) =>
            selected(
              table === products
                ? [{ lifecycleState: 'DRAFT', productId }]
                : [
                    {
                      actingPrincipalId: principalId,
                      description: null,
                      evidenceRefs: base.evidenceRefs,
                      locale: 'cs-CZ',
                      name: 'Police',
                      productId,
                      reason: base.reason,
                      revision: 1,
                      state: 'SET',
                    },
                  ],
            ),
        }),
        update: () => {
          throw new Error('replay changed Current');
        },
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = localizedProductFactsPersistenceForScope(transaction, scope);
      expect(yield* service.changeProduct({ ...base, value: { facts: { name: 'Police' }, kind: 'SET' } })).toEqual({
        kind: 'REPLAYED',
        revision: 1,
      });
      expect(yield* service.changeProduct({ ...base, value: { facts: { name: 'Other' }, kind: 'SET' } })).toEqual({
        kind: 'INVALID',
      });
    }),
  );
});
