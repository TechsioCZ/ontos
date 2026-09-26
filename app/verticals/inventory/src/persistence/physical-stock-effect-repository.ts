import { defineScopedRoutine } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import {
  PhysicalStockEffectIdSchema,
  PhysicalStockEffectRecordSchema,
  PhysicalStockEffectUnavailable,
} from '../../shared/domain/physical-stock-effect.ts';
import type {
  PhysicalStockEffectId,
  PhysicalStockEffectRecord,
  PhysicalStockEffectRequest,
} from '../../shared/domain/physical-stock-effect.ts';
import { inventoryPhysicalStockEffects } from './physical-stock-effect-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const workerRowSchema = Schema.Struct({ record: PhysicalStockEffectRecordSchema });
export const readPhysicalStockEffectForWorkerRoutine = defineScopedRoutine({
  name: 'read_physical_stock_effect_for_worker',
  ownerModuleKey: 'commerce.inventory',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ],
  resultSchema: workerRowSchema,
  routineKey: 'inventory.read-physical-stock-effect-for-worker',
  schema: 'inventory',
});
export const finalizePhysicalStockEffectForWorkerRoutine = defineScopedRoutine({
  name: 'finalize_physical_stock_effect_for_worker',
  ownerModuleKey: 'commerce.inventory',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: workerRowSchema,
  routineKey: 'inventory.finalize-physical-stock-effect-for-worker',
  schema: 'inventory',
});

export interface PhysicalStockEffectPersistence {
  readonly createOrRead: (
    request: PhysicalStockEffectRequest,
  ) => Effect.Effect<
    { readonly effect: PhysicalStockEffectRecord; readonly outcome: 'EXISTING' | 'INSERTED' },
    PhysicalStockEffectUnavailable
  >;
  readonly read: (
    effectId: PhysicalStockEffectId,
  ) => Effect.Effect<Option.Option<PhysicalStockEffectRecord>, PhysicalStockEffectUnavailable>;
  readonly saveTerminal: (
    expected: PhysicalStockEffectRequest,
    terminal: Exclude<PhysicalStockEffectRecord, { readonly _tag: 'REQUESTED' }>,
  ) => Effect.Effect<PhysicalStockEffectRecord, PhysicalStockEffectUnavailable>;
}

const unavailable = (effectId: PhysicalStockEffectId | undefined, cause?: unknown) => {
  const failure =
    effectId === undefined
      ? new PhysicalStockEffectUnavailable({
          code: 'physical_stock_effect_unavailable',
          reason: 'Physical stock effect persistence is temporarily unavailable',
          retryable: true,
        })
      : new PhysicalStockEffectUnavailable({
          code: 'physical_stock_effect_unavailable',
          effectId,
          reason: 'Physical stock effect persistence is temporarily unavailable',
          retryable: true,
        });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const candidateForRow = (row: typeof inventoryPhysicalStockEffects.$inferSelect) => {
  if (row.state === 'APPLIED') {
    return { _tag: row.state, evidence: row.evidenceJson, request: row.requestJson };
  }
  if (row.state === 'REJECTED' || row.state === 'INDETERMINATE') {
    return { _tag: row.state, reason: row.terminalReason, request: row.requestJson };
  }
  return { _tag: 'REQUESTED', request: row.requestJson };
};

const decodeRow = (row: typeof inventoryPhysicalStockEffects.$inferSelect) => {
  const candidate = candidateForRow(row);
  return Schema.decodeEffect(PhysicalStockEffectIdSchema)(row.effectId).pipe(
    Effect.mapError((cause) => unavailable(undefined, cause)),
    Effect.flatMap((decodedEffectId) =>
      Schema.decodeUnknownEffect(PhysicalStockEffectRecordSchema)(candidate).pipe(
        Effect.mapError((cause) => unavailable(decodedEffectId, cause)),
      ),
    ),
  );
};

const terminalValues = (terminal: Exclude<PhysicalStockEffectRecord, { readonly _tag: 'REQUESTED' }>) =>
  Match.value(terminal).pipe(
    Match.tag('APPLIED', ({ evidence }) => ({
      evidenceJson: evidence,
      state: 'APPLIED' as const,
      terminalReason: null,
      updatedAt: sql`now()`,
    })),
    Match.tag('REJECTED', ({ reason }) => ({
      evidenceJson: null,
      state: 'REJECTED' as const,
      terminalReason: reason,
      updatedAt: sql`now()`,
    })),
    Match.tag('INDETERMINATE', ({ reason }) => ({
      evidenceJson: null,
      state: 'INDETERMINATE' as const,
      terminalReason: reason,
      updatedAt: sql`now()`,
    })),
    Match.exhaustive,
  );

export const physicalStockEffectPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): PhysicalStockEffectPersistence => {
  const readRows = (effectId: PhysicalStockEffectId) =>
    transaction
      .select()
      .from(inventoryPhysicalStockEffects)
      .where(
        and(
          eq(inventoryPhysicalStockEffects.tenantId, scope.tenantId),
          eq(inventoryPhysicalStockEffects.effectId, effectId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError((cause) => unavailable(effectId, cause)));

  const read: PhysicalStockEffectPersistence['read'] = (effectId) =>
    readRows(effectId).pipe(
      Effect.flatMap(([row]) => (row === undefined ? Effect.succeedNone : decodeRow(row).pipe(Effect.asSome))),
    );

  const createOrRead: PhysicalStockEffectPersistence['createOrRead'] = Effect.fn(
    'PhysicalStockEffectPersistence.createOrRead',
  )(function* createOrReadEffect(request) {
    if (request.positionRef.tenantId !== scope.tenantId) {
      return yield* unavailable(request.effectId);
    }
    const [inserted] = yield* transaction
      .insert(inventoryPhysicalStockEffects)
      .values({
        backendConfigurationId: request.backendConfigurationRef.resourceId,
        backendId: request.backendId,
        customerConfigurationId: request.customerConfigurationId,
        effectId: request.effectId,
        kind: request.kind,
        legalEntityId: request.legalEntityId,
        positionId: request.positionRef.resourceId,
        quantityAmount: request.quantity.amount,
        requestedAt: DateTime.toDateUtc(DateTime.makeUnsafe(request.requestedAt)),
        requestJson: request,
        state: 'REQUESTED',
        stockItemId: request.stockItemRef.resourceId,
        stockLocationId: request.stockLocationRef.resourceId,
        tenantId: scope.tenantId,
        unitResourceId: request.quantity.unitRef.resourceId,
      })
      .onConflictDoNothing({ target: inventoryPhysicalStockEffects.effectId })
      .returning()
      .pipe(Effect.mapError((cause) => unavailable(request.effectId, cause)));
    if (inserted !== undefined) {
      return { effect: yield* decodeRow(inserted), outcome: 'INSERTED' as const };
    }
    const existing = yield* read(request.effectId);
    return yield* Option.match(existing, {
      onNone: () => Effect.fail(unavailable(request.effectId)),
      onSome: (effect) => Effect.succeed({ effect, outcome: 'EXISTING' as const }),
    });
  });

  const saveTerminal: PhysicalStockEffectPersistence['saveTerminal'] = Effect.fn(
    'PhysicalStockEffectPersistence.saveTerminal',
  )(function* saveTerminalEffect(expected, terminal) {
    const [updated] = yield* transaction
      .update(inventoryPhysicalStockEffects)
      .set(terminalValues(terminal))
      .where(
        and(
          eq(inventoryPhysicalStockEffects.tenantId, scope.tenantId),
          eq(inventoryPhysicalStockEffects.effectId, expected.effectId),
          eq(inventoryPhysicalStockEffects.state, 'REQUESTED'),
        ),
      )
      .returning()
      .pipe(Effect.mapError((cause) => unavailable(expected.effectId, cause)));
    if (updated !== undefined) {
      return yield* decodeRow(updated);
    }
    const current = yield* read(expected.effectId);
    return yield* Effect.fromOption(current).pipe(Effect.mapError((cause) => unavailable(expected.effectId, cause)));
  });

  return Object.freeze({ createOrRead, read, saveTerminal });
};

/** Worker adapter over the Core-verified, lifetime-bound owner scope. */
export const physicalStockEffectPersistenceForWorkerScope = (
  scope: OutboxWorkerLegalEntityScope,
): PhysicalStockEffectPersistence => ({
  createOrRead: (request) => Effect.fail(unavailable(request.effectId)),
  read: (effectId) =>
    scope.routineInvoker.invoke(readPhysicalStockEffectForWorkerRoutine, [effectId]).pipe(
      Effect.mapError((cause) => unavailable(effectId, cause)),
      Effect.map(([row]) => (row === undefined ? Option.none() : Option.some(row.record))),
    ),
  saveTerminal: (expected, terminal) =>
    scope.routineInvoker.invoke(finalizePhysicalStockEffectForWorkerRoutine, [expected.effectId, terminal]).pipe(
      Effect.mapError((cause) => unavailable(expected.effectId, cause)),
      Effect.flatMap(([row]) =>
        row === undefined ? Effect.fail(unavailable(expected.effectId)) : Effect.succeed(row.record),
      ),
    ),
});
