import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  brandRevisions,
  brands,
  productBrandAssignmentRevisions,
  productBrandAssignments,
  products,
} from '../../src/database/schema.ts';
import { brandPersistenceForScope } from '../../src/persistence/brand-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const brandRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.brand',
  tenantId,
} as const;
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:brand-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'brand-test',
};
const evidence = { actionInvocationId: '55555555-5555-4555-8555-555555555555', principalId };
const evidenceRefs = ['catalog-record:brand'] as const;
const brandRow = { brandId: brandRef.resourceId, currentRevision: 1, lifecycleState: 'ACTIVE', name: 'Alfa', tenantId };
const lockedRows = <T>(rows: T[]) => ({ where: () => ({ for: () => ({ limit: () => Effect.succeed(rows) }) }) });
const noRows = () => lockedRows([]);

describe('Brand persistence', () => {
  it.effect('creates stable Brand identity and appends revision evidence', () =>
    Effect.gen(function* createBrand() {
      const writes: unknown[] = [];
      const transaction = {
        insert: (table: typeof brands | typeof brandRevisions) => ({
          values: (value: typeof brands.$inferInsert | typeof brandRevisions.$inferInsert) => {
            writes.push([table, value]);
            return table === brands ? { returning: () => Effect.succeed([brandRow]) } : Effect.succeed([]);
          },
        }),
        select: () => ({ from: noRows }),
      };
      // @ts-expect-error Mock implements only exercised Drizzle chains.
      const service = brandPersistenceForScope(transaction, scope);
      const result = yield* service.create({
        ...evidence,
        payload: { brandRef, evidenceRefs, name: 'Alfa', reason: 'Verified identity' },
      });
      expect(
        Match.value(result).pipe(
          Match.tag('applied', ({ result: applied }) => applied.revision),
          Match.orElse(() => 0),
        ),
      ).toBe(1);
      expect(writes).toEqual([
        [brands, expect.objectContaining({ brandId: brandRef.resourceId, tenantId })],
        [brandRevisions, expect.objectContaining({ changeKind: 'CREATED', revision: 1, tenantId })],
      ]);
    }),
  );

  it.effect('rejects stale rename without writes', () =>
    Effect.gen(function* rejectStale() {
      const transaction = {
        insert: () => {
          throw new Error('must not write');
        },
        select: () => ({ from: () => lockedRows([brandRow]) }),
        update: () => {
          throw new Error('must not write');
        },
      };
      // @ts-expect-error Mock implements only exercised Drizzle chains.
      const service = brandPersistenceForScope(transaction, scope);
      const result = yield* service.rename({
        ...evidence,
        payload: { brandRef, evidenceRefs, expectedRevision: 2, name: 'Alfa Home', reason: 'Verified continuation' },
      });
      expect(
        Match.value(result).pipe(
          Match.tag('stale', ({ actualRevision }) => actualRevision),
          Match.orElse(() => 0),
        ),
      ).toBe(1);
    }),
  );

  it.effect('sets one Product Brand claim and records its first revision', () =>
    Effect.gen(function* setProductBrand() {
      const writes: unknown[] = [];
      let currentAssignment: typeof productBrandAssignments.$inferInsert | undefined;
      const transaction = {
        insert: (table: typeof productBrandAssignments | typeof productBrandAssignmentRevisions) => ({
          values: (
            value: typeof productBrandAssignments.$inferInsert | typeof productBrandAssignmentRevisions.$inferInsert,
          ) => {
            writes.push([table, value]);
            if (table === productBrandAssignments) {
              currentAssignment = {
                claimKind: 'BRANDED',
                currentRevision: 1,
                productId: productRef.resourceId,
                tenantId,
              };
              return { returning: () => Effect.succeed([value]) };
            }
            return Effect.succeed([]);
          },
        }),
        select: () => ({
          from: (table: typeof products | typeof brands | typeof productBrandAssignments) => {
            if (table === products) {
              return lockedRows([{ productId: productRef.resourceId }]);
            }
            if (table === brands) {
              return lockedRows([brandRow]);
            }
            return lockedRows(currentAssignment === undefined ? [] : [currentAssignment]);
          },
        }),
      };
      // @ts-expect-error Mock implements only exercised Drizzle chains.
      const service = brandPersistenceForScope(transaction, scope);
      const result = yield* service.setProductBrand({
        ...evidence,
        payload: {
          assignment: { brandRef, kind: 'brand' },
          evidenceRefs,
          expectedRevision: 0,
          productRef,
          reason: 'Product label evidence',
        },
      });
      expect(
        Match.value(result).pipe(
          Match.tag('applied', ({ result: applied }) => applied.revision),
          Match.orElse(() => 0),
        ),
      ).toBe(1);
      expect(writes).toEqual([
        [
          productBrandAssignments,
          expect.objectContaining({ brandId: brandRef.resourceId, claimKind: 'BRANDED', currentRevision: 1 }),
        ],
        [
          productBrandAssignmentRevisions,
          expect.objectContaining({ brandId: brandRef.resourceId, claimKind: 'BRANDED', revision: 1 }),
        ],
      ]);
      const second = yield* service.setProductBrand({
        actionInvocationId: '66666666-6666-4666-8666-666666666666',
        payload: {
          assignment: { kind: 'confirmed_unbranded' },
          evidenceRefs,
          expectedRevision: 0,
          productRef,
          reason: 'Competing first claim',
        },
        principalId,
      });
      expect(
        Match.value(second).pipe(
          Match.tag('stale', ({ actualRevision }) => actualRevision),
          Match.orElse(() => 0),
        ),
      ).toBe(1);
      expect(writes).toHaveLength(2);
    }),
  );

  it.effect('rejects a retired Brand before Product assignment writes', () =>
    Effect.gen(function* rejectRetired() {
      const transaction = {
        insert: () => {
          throw new Error('must not write');
        },
        select: () => ({
          from: (table: typeof products | typeof brands | typeof productBrandAssignments) => {
            if (table === products) {
              return lockedRows([{ productId: productRef.resourceId }]);
            }
            if (table === brands) {
              return lockedRows([{ ...brandRow, lifecycleState: 'RETIRED' }]);
            }
            return noRows();
          },
        }),
      };
      // @ts-expect-error Mock implements only exercised Drizzle chains.
      const service = brandPersistenceForScope(transaction, scope);
      const result = yield* service.setProductBrand({
        ...evidence,
        payload: {
          assignment: { brandRef, kind: 'brand' },
          evidenceRefs,
          expectedRevision: 0,
          productRef,
          reason: 'New assignment',
        },
      });
      expect(
        Match.value(result).pipe(
          Match.tag('invalid', ({ reason }) => reason),
          Match.orElse(() => ''),
        ),
      ).toBe('Retired Brand cannot be newly assigned');
    }),
  );
});
