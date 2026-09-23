import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SizeEquivalenceAssertionSchema, SizeUsageListSchema } from '../../shared/domain/attribute-vocabulary.ts';
import { productSizeUsageItems, productSizeUsageSets } from '../../src/database/schema.ts';
import type { productSizeUsageRevisions } from '../../src/database/schema.ts';
import { SizePersistenceConflict, sizeUsagePersistenceForScope } from '../../src/persistence/size-usage-persistence.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const principalId = '00000000-0000-4000-8000-000000000002';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:size-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'size-test',
};
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '00000000-0000-4000-8000-000000000003',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const sizeRef = {
  moduleId: 'commerce.catalog',
  resourceId: '00000000-0000-4000-8000-000000000004',
  resourceType: 'commerce.catalog.controlled-attribute-value',
  tenantId,
} as const;
const list = Schema.decodeUnknownSync(SizeUsageListSchema)({ orderedSizeRefs: [sizeRef], productRef });
const assertion = Schema.decodeUnknownSync(SizeEquivalenceAssertionSchema)({
  evidence: 'document:A',
  leftSizeRef: sizeRef,
  rightSizeRef: { ...sizeRef, resourceId: '00000000-0000-4000-8000-000000000005' },
  scope: 'Manufacturing line A',
});
const forbiddenTransaction = new Proxy(
  {},
  {
    get: () => {
      throw new Error('transaction touched');
    },
  },
);

const readTransaction = (
  revisionRecorded: boolean,
  positions: readonly number[],
  sizeIds: readonly string[] = [sizeRef.resourceId, '00000000-0000-4000-8000-000000000005'],
) => ({
  select: () => {
    let table: typeof productSizeUsageSets | typeof productSizeUsageRevisions | typeof productSizeUsageItems;
    const query = {
      from(value: typeof productSizeUsageSets | typeof productSizeUsageRevisions | typeof productSizeUsageItems) {
        table = value;
        return query;
      },
      limit: () => Effect.succeed(table === productSizeUsageSets || revisionRecorded ? [{ revision: 1 }] : []),
      orderBy: () =>
        Effect.succeed(
          table === productSizeUsageItems
            ? positions.map((position, index) => ({
                id: sizeIds[index],
                position,
              }))
            : [],
        ),
      where: () => query,
    };
    return query;
  },
});

describe('Size usage persistence preflight', () => {
  it.effect('rejects a cross-tenant product before touching storage', () =>
    Effect.gen(function* test() {
      // @ts-expect-error Only the validation path is exercised.
      const service = sizeUsagePersistenceForScope(forbiddenTransaction, scope);
      const result = yield* Effect.flip(
        service.replace({
          actionInvocationId: '00000000-0000-4000-8000-000000000006',
          evidenceRefs: [],
          expectedRevision: 0,
          list: { ...list, productRef: { ...productRef, tenantId: '00000000-0000-4000-8000-000000000099' } },
          principalId,
          reason: 'Verified order',
        }),
      );
      expect(Schema.is(SizePersistenceConflict)(result)).toBe(true);
      if (Schema.is(SizePersistenceConflict)(result)) {
        expect(result.conflict).toBe('INVALID_INPUT');
      }
    }),
  );

  it.effect('rejects an invalid evidence period without touching storage', () =>
    Effect.gen(function* test() {
      // @ts-expect-error Only the validation path is exercised.
      const service = sizeUsagePersistenceForScope(forbiddenTransaction, scope);
      const result = yield* Effect.flip(
        service.assertEquivalence({
          actionInvocationId: '00000000-0000-4000-8000-000000000007',
          assertion: {
            ...assertion,
            validFrom: DateTime.makeUnsafe('2026-09-18T00:00:00.000Z'),
            validUntil: DateTime.makeUnsafe('2026-09-17T00:00:00.000Z'),
          },
          principalId,
        }),
      );
      expect(Schema.is(SizePersistenceConflict)(result)).toBe(true);
      if (Schema.is(SizePersistenceConflict)(result)) {
        expect(result.conflict).toBe('INVALID_INPUT');
      }
    }),
  );

  it.effect('rejects a cross-tenant Size before touching storage', () =>
    Effect.gen(function* test() {
      // @ts-expect-error Only the validation path is exercised.
      const service = sizeUsagePersistenceForScope(forbiddenTransaction, scope);
      const result = yield* Effect.flip(
        service.replace({
          actionInvocationId: '00000000-0000-4000-8000-000000000006',
          evidenceRefs: [],
          expectedRevision: 0,
          list: { ...list, orderedSizeRefs: [{ ...sizeRef, tenantId: '00000000-0000-4000-8000-000000000099' }] },
          principalId,
          reason: 'Verified order',
        }),
      );
      expect(result).toMatchObject({ conflict: 'INVALID_INPUT' });
    }),
  );

  it.effect('rejects a revision that cannot fit the persisted integer column', () =>
    Effect.gen(function* test() {
      // @ts-expect-error Only the validation path is exercised.
      const service = sizeUsagePersistenceForScope(forbiddenTransaction, scope);
      const result = yield* Effect.flip(
        service.replace({
          actionInvocationId: '00000000-0000-4000-8000-000000000006',
          evidenceRefs: [],
          expectedRevision: 2_147_483_647,
          list,
          principalId,
          reason: 'Verified order',
        }),
      );
      expect(result).toMatchObject({ conflict: 'INVALID_INPUT' });
    }),
  );

  it.effect('fails closed when a current list has no matching revision record', () =>
    Effect.gen(function* test() {
      const transaction = readTransaction(false, [0]);
      // @ts-expect-error The focused test supplies only the read query shape.
      const service = sizeUsagePersistenceForScope(transaction, scope);
      const failure = yield* Effect.flip(service.read(productRef.resourceId));
      expect(failure.code).toBe('catalog_persistence_unavailable');
    }),
  );

  it.effect('fails closed on a gapped order and preserves an intact explicit order', () =>
    Effect.gen(function* test() {
      // @ts-expect-error The focused test supplies only the read query shape.
      const inconsistent = sizeUsagePersistenceForScope(readTransaction(true, [0, 2]), scope);
      const failure = yield* Effect.flip(inconsistent.read(productRef.resourceId));
      expect(failure.code).toBe('catalog_persistence_unavailable');

      // @ts-expect-error The focused test supplies only the read query shape.
      const intact = sizeUsagePersistenceForScope(readTransaction(true, [0, 1]), scope);
      const result = yield* intact.read(productRef.resourceId);
      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value).toEqual({
          orderedSizeIds: [sizeRef.resourceId, '00000000-0000-4000-8000-000000000005'],
          revision: 1,
        });
      }
    }),
  );

  it.effect('reads the same Size identity in two independently ordered Product lists', () =>
    Effect.gen(function* test() {
      const sizeL = '00000000-0000-4000-8000-000000000005';
      const sizeXs = '00000000-0000-4000-8000-000000000008';
      const firstProduct = sizeUsagePersistenceForScope(
        // @ts-expect-error The focused test supplies only the read query shape.
        readTransaction(true, [0, 1], [sizeRef.resourceId, sizeL]),
        scope,
      );
      const secondProduct = sizeUsagePersistenceForScope(
        // @ts-expect-error The focused test supplies only the read query shape.
        readTransaction(true, [0, 1, 2], [sizeXs, sizeRef.resourceId, sizeL]),
        scope,
      );
      const first = yield* firstProduct.read(productRef.resourceId);
      const second = yield* secondProduct.read('00000000-0000-4000-8000-000000000009');
      expect(Option.getOrThrow(first).orderedSizeIds).toEqual([sizeRef.resourceId, sizeL]);
      expect(Option.getOrThrow(second).orderedSizeIds).toEqual([sizeXs, sizeRef.resourceId, sizeL]);
    }),
  );
});
