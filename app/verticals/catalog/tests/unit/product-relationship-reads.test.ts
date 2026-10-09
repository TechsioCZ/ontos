import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { productRelationshipRevisions } from '../../src/database/schema.ts';
import { productRelationships } from '../../src/database/schema.ts';
import { productRelationshipReadsForScope } from '../../src/persistence/product-relationship-reads.ts';
import { readProductRelationshipCurrent } from '../../src/api/product-relationship-current.read.ts';
import { readProductRelationshipHistory } from '../../src/api/product-relationship-history.read.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const sourceId = '00000000-0000-4000-8000-000000000002';
const targetId = '00000000-0000-4000-8000-000000000003';
const relationshipId = '00000000-0000-4000-8000-000000000004';
const principalId = '00000000-0000-4000-8000-000000000005';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:relationship-reads-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'relationship-reads-test',
};
const source = {
  moduleId: 'commerce.catalog',
  resourceId: sourceId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const target = {
  moduleId: 'commerce.catalog',
  resourceId: targetId,
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const head = {
  createdAt: new Date('2026-09-17T00:00:00.000Z'),
  currentRevision: 1,
  effectiveFrom: null,
  effectiveTo: new Date('2026-09-20T00:00:00.000Z'),
  relationshipId,
  relationshipType: 'ACCESSORY_FOR',
  sourceProductId: sourceId,
  sourceVariantId: null,
  targetProductId: null,
  targetVariantId: targetId,
  tenantId,
  updatedAt: new Date('2026-09-17T00:00:00.000Z'),
};
const revision = {
  ...head,
  actingPrincipalId: principalId,
  actionInvocationId: relationshipId,
  changeKind: 'CREATED',
  evidenceRefs: ['document:1'],
  reason: 'Confirmed only for this variant',
  recordedAt: new Date('2026-09-17T00:00:00.000Z'),
  revision: 1,
};

const serviceWith = (
  heads: readonly (typeof productRelationships.$inferSelect)[],
  revisions: readonly (typeof productRelationshipRevisions.$inferSelect)[],
) => {
  const queried: unknown[] = [];
  const transaction = {
    select: () => ({
      from: (table: typeof productRelationships | typeof productRelationshipRevisions) => {
        queried.push(table);
        return { where: () => Effect.succeed(table === productRelationships ? heads : revisions) };
      },
    }),
  };
  // @ts-expect-error Mock exposes only the exercised Drizzle chains.
  return { queried, service: productRelationshipReadsForScope(transaction, scope) };
};

describe('Product relationship read persistence', () => {
  it.effect('Current BFF preserves direction and excludes ended relationships', () =>
    Effect.gen(function* currentApi() {
      const { service } = serviceWith([head], [revision]);
      const forward = yield* readProductRelationshipCurrent(
        { direction: 'forward', endpoint: source },
        tenantId,
        service,
        '2026-09-19T00:00:00.000Z',
      );
      const reverse = yield* readProductRelationshipCurrent(
        { direction: 'reverse', endpoint: target },
        tenantId,
        service,
        '2026-09-19T00:00:00.000Z',
      );
      const ended = yield* readProductRelationshipCurrent(
        { direction: 'reverse', endpoint: target },
        tenantId,
        service,
        '2026-09-20T00:00:00.000Z',
      );
      expect(forward.relationships).toHaveLength(1);
      expect(reverse.relationships[0]?.relationship.source).toEqual(source);
      expect(reverse.relationships[0]?.relationship.target).toEqual(target);
      expect(ended.relationships).toEqual([]);
    }),
  );

  it.effect('history BFF returns retained revisions separately from Current', () =>
    Effect.gen(function* historyApi() {
      const { service } = serviceWith([head], [revision]);
      const result = yield* readProductRelationshipHistory({ relationshipId }, service);
      expect(result.revisions).toHaveLength(1);
      expect(result.revisions[0]).toMatchObject({
        changeKind: 'CREATED',
        relationship: { source, target },
        revision: 1,
      });
    }),
  );
  it.effect('preserves direction, exact Variant scope, evidence, and the exclusive effective end', () =>
    Effect.gen(function* directedRead() {
      const { service } = serviceWith([head], [revision]);
      const before = yield* service.forward(source, '2026-09-19T23:59:59.999Z');
      const after = yield* service.reverse(target, '2026-09-20T00:00:00.000Z');
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({
        actingPrincipalId: principalId,
        actionInvocationId: relationshipId,
        current: true,
        evidenceRefs: ['document:1'],
        relationship: { effectivePeriod: { effectiveTo: '2026-09-20T00:00:00.000Z' }, source, target },
        relationshipId,
        revision: 1,
      });
      expect(after[0]?.current).toBe(false);
      expect(after[0]?.relationship.source).toEqual(source);
      expect(after[0]?.relationship.target).toEqual(target);
      expect(after[0]?.relationship.effectivePeriod.effectiveFrom).toBeUndefined();
    }),
  );

  it.effect('returns an exact, ordered revision history and rejects missing history', () =>
    Effect.gen(function* historyRead() {
      const revisedHead = { ...head, currentRevision: 2, effectiveTo: null };
      const revised = {
        ...revision,
        changeKind: 'CORRECTED',
        effectiveTo: null,
        evidenceRefs: ['document:2'],
        reason: 'Correction supported by document:2',
        revision: 2,
      };
      const history = yield* serviceWith([revisedHead], [revised, revision]).service.history(relationshipId);
      expect(history.map((item) => item.revision)).toEqual([1, 2]);
      expect(history[1]?.reason).toBe('Correction supported by document:2');
      const corrupt = yield* serviceWith([revisedHead], [revised])
        .service.history(relationshipId)
        .pipe(Effect.catchTag('CatalogPersistenceUnavailable', () => Effect.succeed('unavailable' as const)));
      expect(corrupt).toBe('unavailable');
    }),
  );

  it.effect('fails closed on head/revision mismatch and foreign-Tenant query without touching storage', () =>
    Effect.gen(function* corruptRead() {
      const mismatch = yield* serviceWith([head], [{ ...revision, targetVariantId: sourceId }])
        .service.get(relationshipId, '2026-09-17T00:00:00.000Z')
        .pipe(Effect.catchTag('CatalogPersistenceUnavailable', () => Effect.succeed('unavailable' as const)));
      expect(mismatch).toBe('unavailable');
      const { queried, service } = serviceWith([head], [revision]);
      const foreign = yield* service
        .reverse({ ...target, tenantId: principalId }, '2026-09-17T00:00:00.000Z')
        .pipe(Effect.catchTag('CatalogPersistenceUnavailable', () => Effect.succeed('unavailable' as const)));
      expect(foreign).toBe('unavailable');
      expect(queried).toEqual([]);
    }),
  );
});
