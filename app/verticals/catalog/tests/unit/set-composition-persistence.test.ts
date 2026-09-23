import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Match, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SetCompositionRevisionSchema } from '../../shared/domain/set-composition.ts';
import { setCompositionComponents, setCompositionRevisions, setCompositions } from '../../src/database/schema.ts';
import type { productVariants, products } from '../../src/database/schema.ts';
import {
  setCompositionPersistenceForScope,
  SetCompositionPersistenceUnavailable,
} from '../../src/persistence/set-composition-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '33333333-3333-4333-8333-333333333333';
const compositionId = '44444444-4444-4444-8444-444444444444';
const principalId = '55555555-5555-4555-8555-555555555555';
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType: `commerce.catalog.${resourceType}`,
  tenantId,
});
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:set-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'set-test',
};
const revision = Schema.decodeUnknownSync(SetCompositionRevisionSchema)({
  components: [
    {
      componentId: '66666666-6666-4666-8666-666666666666',
      quantity: { amount: '1', unitRef: ref('product-unit', '77777777-7777-4777-8777-777777777777') },
      selection: {
        productRef: ref('product', '88888888-8888-4888-8888-888888888888'),
        variantRef: ref('variant', '99999999-9999-4999-8999-999999999999'),
      },
    },
    {
      componentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      quantity: { amount: '2', unitRef: ref('product-unit', '77777777-7777-4777-8777-777777777777') },
      selection: {
        productRef: ref('product', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
        variantRef: ref('variant', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
      },
    },
  ],
  productRef: ref('product', productId),
  provenance: { changeKind: 'INITIAL', evidenceRefs: ['catalog:verified'], reason: 'Initial fixed composition' },
  reference: { resourceRef: ref('set-composition', compositionId), revision: 1 },
  variantRef: ref('variant', variantId),
});
const input = {
  actingPrincipalId: principalId,
  actionInvocationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  effectiveFrom: new Date('2026-09-17T00:00:00.000Z'),
  expectedRevision: 0,
  lifecycleState: 'ACTIVE' as const,
  revision,
};
const selectedRows = (rows: readonly unknown[]) => ({
  where: () => ({ for: () => ({ limit: () => Effect.succeed(rows) }), limit: () => Effect.succeed(rows) }),
});
const queriedRows = (rows: readonly unknown[]) => ({
  where: () => ({
    limit: () => Effect.succeed(rows),
    pipe: (map: (effect: Effect.Effect<readonly unknown[]>) => Effect.Effect<readonly unknown[]>) =>
      map(Effect.succeed(rows)),
  }),
});
type PublishSelectTable =
  | typeof products
  | typeof productVariants
  | typeof setCompositions
  | typeof setCompositionRevisions;
type HistorySelectTable = typeof setCompositions | typeof setCompositionRevisions | typeof setCompositionComponents;
const futureHistoryQuery = <O extends object, R extends object, C extends object>(
  table: HistorySelectTable,
  state: { componentReads: number; revisionReads: number },
  owner: O,
  rows: readonly R[],
  componentRows: readonly (readonly C[])[],
) => ({
  where: () => ({
    limit: () => {
      if (table === setCompositions) {
        return Effect.succeed([owner]);
      }
      const selected = rows[state.revisionReads % 3 === 1 ? 1 : 0];
      state.revisionReads += 1;
      return Effect.succeed([selected]);
    },
    pipe: (map: (effect: Effect.Effect<readonly object[]>) => Effect.Effect<readonly object[]>) => {
      if (table === setCompositionRevisions) {
        return map(Effect.succeed(rows));
      }
      const selected = componentRows[state.componentReads % 3 === 1 ? 1 : 0];
      state.componentReads += 1;
      return map(Effect.succeed(selected));
    },
  }),
});
const futureHistoryTransaction = <O extends object, R extends object, C extends object>(
  owner: O,
  rows: readonly R[],
  componentRows: readonly (readonly C[])[],
) => {
  const state = { componentReads: 0, revisionReads: 0 };
  return {
    select: () => ({
      from: (table: HistorySelectTable) => futureHistoryQuery(table, state, owner, rows, componentRows),
    }),
  };
};

describe('Set composition persistence', () => {
  it.effect('appends the complete fixed composition as one immutable revision', () =>
    Effect.gen(function* appendRevision() {
      const writes: { table: unknown; value: unknown }[] = [];
      const verified: unknown[] = [];
      const transaction = {
        insert: (table: typeof setCompositions | typeof setCompositionRevisions | typeof setCompositionComponents) => ({
          values: (
            value:
              | typeof setCompositions.$inferInsert
              | typeof setCompositionRevisions.$inferInsert
              | typeof setCompositionComponents.$inferInsert,
          ) => {
            writes.push({ table, value });
            return Effect.succeed([]);
          },
        }),
        select: () => ({
          from: (
            table: typeof products | typeof productVariants | typeof setCompositions | typeof setCompositionRevisions,
          ) =>
            selectedRows(
              table === setCompositions || table === setCompositionRevisions
                ? []
                : [{ lifecycleState: 'ACTIVE', productId, variantId }],
            ),
        }),
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = setCompositionPersistenceForScope(transaction, scope, {
        verify: (candidate) => {
          verified.push(candidate);
          return Effect.succeed(true);
        },
      });
      const outcome = yield* service.publish(input);
      expect(verified).toEqual([{ at: input.effectiveFrom, revision }]);
      expect(
        Match.value(outcome).pipe(
          Match.tag('published', ({ revision: number }) => number),
          Match.orElse(() => 0),
        ),
      ).toBe(1);
      expect(writes).toHaveLength(4);
      expect(writes[0]).toEqual({
        table: setCompositions,
        value: expect.objectContaining({ compositionId, currentRevision: 1, productId, variantId }),
      });
      expect(writes[1]).toEqual({
        table: setCompositionRevisions,
        value: expect.objectContaining({ changeKind: 'INITIAL', compositionId, revision: 1 }),
      });
      expect(writes.slice(2).map(({ value }) => value)).toEqual([
        expect.objectContaining({ componentId: revision.components[0]?.componentId, quantityAmount: '1' }),
        expect.objectContaining({ componentId: revision.components[1]?.componentId, quantityAmount: '2' }),
      ]);
    }),
  );

  it.effect('rejects a stale expected revision without appending any rows', () =>
    Effect.gen(function* staleRevision() {
      const transaction = {
        insert: () => {
          throw new Error('Stale publication must not write');
        },
        select: () => ({
          from: (table: PublishSelectTable) => {
            if (table === setCompositionRevisions) {
              return selectedRows([]);
            }
            if (table === setCompositions) {
              return selectedRows([{ compositionId, currentRevision: 2, productId, variantId }]);
            }
            return selectedRows([{ lifecycleState: 'ACTIVE', productId, variantId }]);
          },
        }),
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = setCompositionPersistenceForScope(transaction, scope, { verify: () => Effect.succeed(true) });
      const outcome = yield* service.publish(input);
      expect(
        Match.value(outcome).pipe(
          Match.tag('stale', ({ actualRevision }) => actualRevision),
          Match.orElse(() => 0),
        ),
      ).toBe(2);
    }),
  );

  it.effect('recognizes a corrected old quantity but fails closed before advancing Current', () =>
    Effect.gen(function* correctedQuantity() {
      const priorRow = {
        changeKind: 'INITIAL',
        compositionId,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: null,
        evidenceRefs: ['catalog:verified'],
        lifecycleState: 'ACTIVE',
        predecessorRevision: null,
        productId,
        reason: 'Initial fixed composition',
        revision: 1,
        variantId,
      };
      const componentRows = revision.components.map((component) => ({
        componentId: component.componentId,
        componentProductId: component.selection.productRef.resourceId,
        componentVariantId: component.selection.variantRef.resourceId,
        configuration: null,
        packageContentRevision: null,
        packageDefinitionId: null,
        quantityAmount: component.quantity.amount,
        quantityUnitId: component.quantity.unitRef.resourceId,
      }));
      let revisionReads = 0;
      const transaction = {
        insert: () => {
          throw new Error('Correction must not write before impact authority');
        },
        select: () => ({
          from: (table: PublishSelectTable | typeof setCompositionComponents) => {
            if (table === setCompositionRevisions) {
              revisionReads += 1;
              return revisionReads === 1 ? selectedRows([]) : selectedRows([priorRow]);
            }
            if (table === setCompositionComponents) {
              return queriedRows(componentRows);
            }
            if (table === setCompositions) {
              return selectedRows([{ compositionId, currentRevision: 1, productId, variantId }]);
            }
            return selectedRows([{ lifecycleState: 'ACTIVE', productId, variantId }]);
          },
        }),
        update: () => {
          throw new Error('Correction must not advance Current');
        },
      };
      const corrected = Schema.decodeUnknownSync(SetCompositionRevisionSchema)({
        ...revision,
        components: [
          revision.components[0],
          {
            ...revision.components[1],
            quantity: { amount: '3', unitRef: revision.components[1].quantity.unitRef },
          },
        ],
        predecessor: revision.reference,
        provenance: {
          changeKind: 'EVIDENCE_CORRECTION',
          evidenceRefs: ['original-data-error:source-record-42'],
          reason: 'Old source recorded two, actual set held three',
        },
        reference: { ...revision.reference, revision: 2 },
      });
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = setCompositionPersistenceForScope(transaction, scope, { verify: () => Effect.succeed(true) });
      const outcome = yield* service.publish({
        ...input,
        actionInvocationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        effectiveFrom: new Date('2026-09-18T00:00:00.000Z'),
        expectedRevision: 1,
        revision: corrected,
      });
      expect(
        Match.value(outcome).pipe(
          Match.tag('invalid', ({ reason }) => reason),
          Match.orElse(() => ''),
        ),
      ).toBe('Original-data-error correction requires open-selection impact authority');
    }),
  );

  it.effect('returns the retained revision for an exact Action replay without a second write', () =>
    Effect.gen(function* exactReplay() {
      const owner = { compositionId, currentRevision: 1, productId, variantId };
      const row = {
        actingPrincipalId: principalId,
        actionInvocationId: input.actionInvocationId,
        changeKind: 'INITIAL',
        compositionId,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: null,
        evidenceRefs: ['catalog:verified'],
        lifecycleState: 'ACTIVE',
        predecessorRevision: null,
        productId,
        reason: 'Initial fixed composition',
        revision: 1,
        tenantId,
        variantId,
      };
      const components = revision.components.map((component) => ({
        componentId: component.componentId,
        componentProductId: component.selection.productRef.resourceId,
        componentVariantId: component.selection.variantRef.resourceId,
        configuration: null,
        packageContentRevision: null,
        packageDefinitionId: null,
        quantityAmount: component.quantity.amount,
        quantityUnitId: component.quantity.unitRef.resourceId,
      }));
      const transaction = {
        insert: () => {
          throw new Error('Replay must not append');
        },
        select: () => ({
          from: (table: HistorySelectTable) => {
            if (table === setCompositions) {
              return queriedRows([owner]);
            }
            if (table === setCompositionRevisions) {
              return queriedRows([row]);
            }
            return queriedRows(components);
          },
        }),
        update: () => {
          throw new Error('Replay must not advance Current');
        },
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = setCompositionPersistenceForScope(transaction, scope, { verify: () => Effect.succeed(true) });
      const outcome = yield* service.publish(input);
      expect(
        Match.value(outcome).pipe(
          Match.tag('published', ({ revision: number }) => number),
          Match.orElse(() => 0),
        ),
      ).toBe(1);
      const changedPrincipal = yield* service.publish({
        ...input,
        actingPrincipalId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      });
      expect(
        Match.value(changedPrincipal).pipe(
          Match.tag('invalid', ({ reason }) => reason),
          Match.orElse(() => ''),
        ),
      ).toBe('Action invocation payload differs from retained Set revision');
    }),
  );

  it.effect('reads an exact historical revision and as-of Current without changing the stored content', () =>
    Effect.gen(function* historicalAndCurrent() {
      const at = new Date('2026-09-20T00:00:00.000Z');
      const owner = { compositionId, currentRevision: 1, productId, variantId };
      const row = {
        actingPrincipalId: principalId,
        actionInvocationId: input.actionInvocationId,
        changeKind: 'INITIAL',
        compositionId,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: null,
        evidenceRefs: ['catalog:verified'],
        lifecycleState: 'ACTIVE',
        predecessorRevision: null,
        productId,
        reason: 'Initial fixed composition',
        revision: 1,
        tenantId,
        variantId,
      };
      const components = revision.components.map((component) => ({
        componentId: component.componentId,
        componentProductId: component.selection.productRef.resourceId,
        componentVariantId: component.selection.variantRef.resourceId,
        configuration: null,
        packageContentRevision: null,
        packageDefinitionId: null,
        quantityAmount: component.quantity.amount,
        quantityUnitId: component.quantity.unitRef.resourceId,
      }));
      const transaction = {
        select: () => ({
          from: (table: HistorySelectTable) => {
            if (table === setCompositions) {
              return queriedRows([owner]);
            }
            if (table === setCompositionRevisions) {
              return queriedRows([row]);
            }
            return queriedRows(components);
          },
        }),
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = setCompositionPersistenceForScope(transaction, scope);
      const historical = yield* service.readRevision({ compositionId, revision: 1 });
      const current = yield* service.readCurrent({ at, compositionId });
      expect(Option.isSome(historical)).toBe(true);
      expect(Option.isSome(current)).toBe(true);
      if (Option.isSome(historical) && Option.isSome(current)) {
        expect(historical.value.revision).toEqual(revision);
        expect(current.value.revision).toEqual(revision);
      }
    }),
  );

  it.effect('keeps a future material successor out of Current until effective and retains its predecessor', () =>
    Effect.gen(function* futureSuccessor() {
      const future = new Date('2026-10-01T00:00:00.000Z');
      const next = Schema.decodeUnknownSync(SetCompositionRevisionSchema)({
        ...revision,
        components: revision.components.map((component, index) =>
          index === 1
            ? {
                ...component,
                selection: {
                  ...component.selection,
                  variantRef: ref('variant', 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
                },
              }
            : component,
        ),
        predecessor: revision.reference,
        provenance: {
          changeKind: 'MATERIAL_CHANGE',
          evidenceRefs: ['catalog:replacement'],
          reason: 'Replace fixed bracket',
        },
        reference: { resourceRef: revision.reference.resourceRef, revision: 2 },
      });
      const owner = { compositionId, currentRevision: 2, productId, variantId };
      const rows = [revision, next].map((item, index) => ({
        actingPrincipalId: principalId,
        actionInvocationId: input.actionInvocationId,
        changeKind: item.provenance.changeKind,
        compositionId,
        effectiveFrom: index === 0 ? input.effectiveFrom : future,
        effectiveTo: null,
        evidenceRefs: [...item.provenance.evidenceRefs],
        lifecycleState: 'ACTIVE',
        predecessorRevision: index === 0 ? null : 1,
        productId,
        reason: item.provenance.reason,
        revision: item.reference.revision,
        tenantId,
        variantId,
      }));
      const componentRows = [revision, next].map((item) =>
        item.components.map((component) => ({
          componentId: component.componentId,
          componentProductId: component.selection.productRef.resourceId,
          componentVariantId: component.selection.variantRef.resourceId,
          configuration: null,
          packageContentRevision: null,
          packageDefinitionId: null,
          quantityAmount: component.quantity.amount,
          quantityUnitId: component.quantity.unitRef.resourceId,
        })),
      );
      const transaction = futureHistoryTransaction(owner, rows, componentRows);
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = setCompositionPersistenceForScope(transaction, scope);
      const before = yield* service.readCurrent({ at: new Date('2026-09-20T00:00:00.000Z'), compositionId });
      const after = yield* service.readCurrent({ at: new Date('2026-10-02T00:00:00.000Z'), compositionId });
      const historical = yield* service.readRevision({ compositionId, revision: 1 });
      expect(Option.isSome(before) && before.value.revision.reference.revision).toBe(1);
      expect(Option.isSome(after) && after.value.revision.reference.revision).toBe(2);
      expect(Option.isSome(historical) && historical.value.revision).toEqual(revision);
    }),
  );
  it.effect('retirement is a new immutable successor and ends Current only from its effective instant', () =>
    Effect.gen(function* retirement() {
      const retiredAt = new Date('2026-10-01T00:00:00.000Z');
      const retiredRevision = Schema.decodeUnknownSync(SetCompositionRevisionSchema)({
        ...revision,
        predecessor: revision.reference,
        provenance: { changeKind: 'EVIDENCE_CORRECTION', evidenceRefs: ['catalog:retired'], reason: 'Retire Set' },
        reference: { resourceRef: revision.reference.resourceRef, revision: 2 },
      });
      const owner = { compositionId, currentRevision: 2, productId, variantId };
      const rows = [revision, retiredRevision].map((item, index) => ({
        actionInvocationId: index === 0 ? input.actionInvocationId : 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        changeKind: item.provenance.changeKind,
        compositionId,
        effectiveFrom: index === 0 ? input.effectiveFrom : retiredAt,
        effectiveTo: null,
        evidenceRefs: [...item.provenance.evidenceRefs],
        lifecycleState: index === 0 ? 'ACTIVE' : 'RETIRED',
        predecessorRevision: index === 0 ? null : 1,
        productId,
        reason: item.provenance.reason,
        revision: item.reference.revision,
        tenantId,
        variantId,
      }));
      const componentRows = [revision, retiredRevision].map((item) =>
        item.components.map((component) => ({
          componentId: component.componentId,
          componentProductId: component.selection.productRef.resourceId,
          componentVariantId: component.selection.variantRef.resourceId,
          configuration: null,
          packageContentRevision: null,
          packageDefinitionId: null,
          quantityAmount: component.quantity.amount,
          quantityUnitId: component.quantity.unitRef.resourceId,
        })),
      );
      const transaction = futureHistoryTransaction(owner, rows, componentRows);
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = setCompositionPersistenceForScope(transaction, scope);
      const before = yield* service.readCurrent({ at: new Date(retiredAt.getTime() - 1), compositionId });
      const after = yield* service.readCurrent({ at: retiredAt, compositionId });
      expect(Option.isSome(before) && before.value.revision.reference.revision).toBe(1);
      expect(Option.isNone(after)).toBe(true);
    }),
  );
  it.effect('fails closed without the owner Current-basis proof before any query or write', () =>
    Effect.gen(function* noProof() {
      const transaction = {
        insert: () => {
          throw new Error('No write allowed');
        },
        select: () => {
          throw new Error('No query allowed');
        },
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = setCompositionPersistenceForScope(transaction, scope);
      const error = yield* service.publish(input).pipe(Effect.flip);
      expect(Schema.is(SetCompositionPersistenceUnavailable)(error)).toBe(true);
    }),
  );

  it.effect('rejects cross-Tenant composition references before querying', () =>
    Effect.gen(function* crossTenant() {
      const transaction = {
        select: () => {
          throw new Error('No query allowed');
        },
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = setCompositionPersistenceForScope(transaction, scope, { verify: () => Effect.succeed(true) });
      const outcome = yield* service.publish({
        ...input,
        revision: {
          ...revision,
          reference: {
            ...revision.reference,
            resourceRef: { ...revision.reference.resourceRef, tenantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
          },
        },
      });
      expect(
        Match.value(outcome).pipe(
          Match.tag('invalid', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );

  it.effect('does not allow a retired composition to be issued as its initial revision', () =>
    Effect.gen(function* initiallyRetired() {
      const transaction = {
        select: () => {
          throw new Error('Invalid initial retirement must not query');
        },
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = setCompositionPersistenceForScope(transaction, scope, { verify: () => Effect.succeed(true) });
      const outcome = yield* service.publish({ ...input, lifecycleState: 'RETIRED' });
      expect(
        Match.value(outcome).pipe(
          Match.tag('invalid', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );

  it.effect('does not write when exact component basis is invalid', () =>
    Effect.gen(function* invalidBasis() {
      const transaction = {
        insert: () => {
          throw new Error('No write allowed');
        },
        select: () => ({
          from: (
            table: typeof products | typeof productVariants | typeof setCompositions | typeof setCompositionRevisions,
          ) =>
            selectedRows(
              table === setCompositions || table === setCompositionRevisions
                ? []
                : [{ lifecycleState: 'ACTIVE', productId, variantId }],
            ),
        }),
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = setCompositionPersistenceForScope(transaction, scope, { verify: () => Effect.succeed(false) });
      const outcome = yield* service.publish(input);
      expect(
        Match.value(outcome).pipe(
          Match.tag('invalid', ({ reason }) => reason),
          Match.orElse(() => ''),
        ),
      ).toBe('Component Current basis is invalid');
    }),
  );
});
