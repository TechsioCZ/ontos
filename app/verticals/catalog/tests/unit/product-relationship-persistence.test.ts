import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { productRelationshipRevisions, productRelationships, products } from '../../src/database/schema.ts';
import { productRelationshipPersistenceForScope } from '../../src/persistence/product-relationship-persistence.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const sourceId = '00000000-0000-4000-8000-000000000002';
const targetId = '00000000-0000-4000-8000-000000000003';
const relationshipId = '00000000-0000-4000-8000-000000000004';
const principalId = '00000000-0000-4000-8000-000000000005';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:relationship-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'relationship-test',
};
const ref = (resourceId: string) =>
  ({ moduleId: 'commerce.catalog', resourceId, resourceType: 'commerce.catalog.product', tenantId }) as const;
const relationship = {
  effectivePeriod: {},
  evidenceRefs: ['catalog-record:1'],
  reason: 'Verified fit',
  source: ref(sourceId),
  target: ref(targetId),
  type: 'ACCESSORY_FOR',
} as const;
const evidence = { actionInvocationId: '00000000-0000-4000-8000-000000000006', principalId };
const row = {
  currentRevision: 1,
  effectiveFrom: null,
  effectiveTo: null,
  relationshipId,
  relationshipType: 'ACCESSORY_FOR',
  sourceProductId: sourceId,
  sourceVariantId: null,
  targetProductId: targetId,
  targetVariantId: null,
  tenantId,
};
const locked = <T>(value: T) => ({ where: () => ({ for: () => ({ limit: () => Effect.succeed([value]) }) }) });
const selected = <T>(value: T) => ({ where: () => ({ limit: () => Effect.succeed([value]) }) });
const updated = <T>(value: T) => ({ where: () => ({ returning: () => Effect.succeed([value]) }) });

describe('Product relationship persistence', () => {
  it.effect(
    'creates one directed assertion and an immutable initial revision without inventing an effective start',
    () =>
      Effect.gen(function* create() {
        const writes: unknown[] = [];
        const transaction = {
          insert: (table: typeof productRelationships | typeof productRelationshipRevisions) => ({
            values: (
              value: typeof productRelationships.$inferInsert | typeof productRelationshipRevisions.$inferInsert,
            ) => {
              writes.push([table, value]);
              return table === productRelationships ? { returning: () => Effect.succeed([row]) } : Effect.succeed([]);
            },
          }),
          select: () => ({
            from: (table: typeof products) => {
              expect(table).toBe(products);
              return selected({ id: sourceId });
            },
          }),
        };
        // @ts-expect-error Mock exposes only the exercised Drizzle chains.
        const service = productRelationshipPersistenceForScope(transaction, scope);
        const result = yield* service.create({ ...evidence, relationship, relationshipId });
        expect(
          Match.value(result).pipe(
            Match.tag('created', () => true),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        expect(writes).toEqual([
          [
            productRelationships,
            expect.objectContaining({
              currentRevision: 1,
              effectiveFrom: null,
              sourceProductId: sourceId,
              targetProductId: targetId,
            }),
          ],
          [
            productRelationshipRevisions,
            expect.objectContaining({ changeKind: 'CREATED', evidenceRefs: ['catalog-record:1'], revision: 1 }),
          ],
        ]);
      }),
  );

  it.effect('rejects cross-tenant endpoints before touching the transaction', () =>
    Effect.gen(function* rejectTenant() {
      const transaction = new Proxy(
        {},
        {
          get: () => {
            throw new Error('transaction touched');
          },
        },
      );
      // @ts-expect-error No database operation is allowed in this path.
      const service = productRelationshipPersistenceForScope(transaction, scope);
      const result = yield* service.create({
        ...evidence,
        relationship: {
          ...relationship,
          target: { ...relationship.target, tenantId: '00000000-0000-4000-8000-000000000099' },
        },
        relationshipId,
      });
      expect(
        Match.value(result).pipe(
          Match.tag('invalid_change', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );

  it.effect('rejects a material change without rewriting a previously true assertion', () =>
    Effect.gen(function* rejectMaterial() {
      const transaction = {
        select: () => ({ from: () => locked(row) }),
        update: () => {
          throw new Error('material change must not overwrite');
        },
      };
      // @ts-expect-error Mock exposes only the exercised Drizzle chains.
      const service = productRelationshipPersistenceForScope(transaction, scope);
      const result = yield* service.change({
        ...evidence,
        classification: 'MATERIAL_CHANGE',
        expectedRevision: 1,
        relationship,
        relationshipId,
      });
      expect(
        Match.value(result).pipe(
          Match.tag('invalid_change', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );

  it.effect('preserves a stale editor conflict before any update', () =>
    Effect.gen(function* rejectStale() {
      const transaction = {
        select: () => ({ from: () => locked({ ...row, currentRevision: 2 }) }),
        update: () => {
          throw new Error('stale update');
        },
      };
      // @ts-expect-error Mock exposes only the exercised Drizzle chains.
      const service = productRelationshipPersistenceForScope(transaction, scope);
      const result = yield* service.change({
        ...evidence,
        classification: 'EVIDENCED_CORRECTION',
        expectedRevision: 1,
        relationship,
        relationshipId,
      });
      expect(
        Match.value(result).pipe(
          Match.tag('revision_conflict', ({ actualRevision }) => actualRevision),
          Match.orElse(() => 0),
        ),
      ).toBe(2);
    }),
  );

  it.effect('corrects an assertion while retaining identity and appending its prior truth', () =>
    Effect.gen(function* correct() {
      const writes: unknown[] = [];
      const corrected = { ...relationship, reason: 'Corrected explanation' };
      const transaction = {
        insert: (table: typeof productRelationshipRevisions) => ({
          values: (value: typeof productRelationshipRevisions.$inferInsert) => {
            writes.push([table, value]);
            return Effect.succeed([]);
          },
        }),
        select: () => ({
          from: (table: typeof productRelationships | typeof products) =>
            table === productRelationships ? locked(row) : selected({ id: sourceId }),
        }),
        update: (table: typeof productRelationships) => {
          expect(table).toBe(productRelationships);
          return { set: (value: Partial<typeof row>) => updated({ ...row, ...value }) };
        },
      };
      // @ts-expect-error Mock exposes only the exercised Drizzle chains.
      const service = productRelationshipPersistenceForScope(transaction, scope);
      const result = yield* service.change({
        ...evidence,
        classification: 'EVIDENCED_CORRECTION',
        expectedRevision: 1,
        relationship: corrected,
        relationshipId,
      });
      expect(
        Match.value(result).pipe(
          Match.tag('changed', ({ revision }) => revision),
          Match.orElse(() => 0),
        ),
      ).toBe(2);
      expect(writes).toEqual([
        [
          productRelationshipRevisions,
          expect.objectContaining({ changeKind: 'CORRECTED', reason: 'Corrected explanation', revision: 2 }),
        ],
      ]);
    }),
  );

  it.effect('ends Current by setting the exclusive end and appending history', () =>
    Effect.gen(function* end() {
      const writes: unknown[] = [];
      const transaction = {
        insert: (table: typeof productRelationshipRevisions) => ({
          values: (value: typeof productRelationshipRevisions.$inferInsert) => {
            writes.push([table, value]);
            return Effect.succeed([]);
          },
        }),
        select: () => ({ from: () => locked(row) }),
        update: (table: typeof productRelationships) => {
          expect(table).toBe(productRelationships);
          return { set: (value: Partial<typeof row>) => updated({ ...row, ...value }) };
        },
      };
      // @ts-expect-error Mock exposes only the exercised Drizzle chains.
      const service = productRelationshipPersistenceForScope(transaction, scope);
      const result = yield* service.remove({
        ...evidence,
        effectiveTo: '2026-09-17T12:00:00.000Z',
        evidenceRefs: ['catalog-record:2'],
        expectedRevision: 1,
        reason: 'Ended by operator',
        relationshipId,
      });
      expect(
        Match.value(result).pipe(
          Match.tag('removed', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(writes).toEqual([
        [
          productRelationshipRevisions,
          expect.objectContaining({
            changeKind: 'ENDED',
            effectiveTo: new Date('2026-09-17T12:00:00.000Z'),
            revision: 2,
          }),
        ],
      ]);
    }),
  );
});
