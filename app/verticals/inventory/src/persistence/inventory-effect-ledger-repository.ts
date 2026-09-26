import { defineScopedRoutine } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import {
  InventoryEffectLedgerEffectIdSchema,
  InventoryEffectLedgerRecordSchema,
  InventoryEffectLedgerUnavailable,
} from '../../shared/domain/inventory-effect-ledger.ts';
import type {
  InventoryEffectLedgerIntent,
  InventoryEffectLedgerRecord,
} from '../../shared/domain/inventory-effect-ledger.ts';
import type { InventoryEffectLedgerPersistence } from '../services/inventory-effect-ledger.service.ts';
import {
  canonicalInventoryEffectIntent,
  canonicalInventoryEffectIntentValue,
} from '../services/inventory-effect-ledger.service.ts';
import { inventoryEffectLedger, inventoryEffectLedgerHistory } from './inventory-effect-ledger-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type EffectRow = typeof inventoryEffectLedger.$inferSelect;

const workerRowSchema = Schema.Struct({ record: InventoryEffectLedgerRecordSchema });
const claimRowSchema = Schema.Struct({ inserted: Schema.Boolean, record: InventoryEffectLedgerRecordSchema });
const MODULE_KEY = 'commerce.inventory';
export const claimInventoryEffectLedgerRoutine = defineScopedRoutine({
  name: 'claim_inventory_effect_ledger',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: claimRowSchema,
  routineKey: 'inventory.claim-inventory-effect-ledger',
  schema: 'inventory',
});
export const readInventoryEffectLedgerForWorkerRoutine = defineScopedRoutine({
  name: 'read_inventory_effect_ledger_for_worker',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: workerRowSchema,
  routineKey: 'inventory.read-inventory-effect-ledger-for-worker',
  schema: 'inventory',
});
export const transitionInventoryEffectLedgerForWorkerRoutine = defineScopedRoutine({
  name: 'transition_inventory_effect_ledger_for_worker',
  ownerModuleKey: MODULE_KEY,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: workerRowSchema,
  routineKey: 'inventory.transition-inventory-effect-ledger-for-worker',
  schema: 'inventory',
});

const unavailable = (effectId: typeof InventoryEffectLedgerEffectIdSchema.Type, reason: string, cause?: unknown) => {
  const failure = new InventoryEffectLedgerUnavailable({
    code: 'inventory_effect_ledger_unavailable',
    effectId,
    reason,
    retryable: true,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

interface StableScope {
  readonly attemptId: string | null;
  readonly authorityBackendId: string;
  readonly authorityBackendKind: string;
  readonly authorityConfigurationId: string;
  readonly customerConfigurationId: string;
  readonly legalEntityId: string;
  readonly reservationId: string | null;
}

const stableScopeFor = (intent: InventoryEffectLedgerIntent): StableScope =>
  Match.value(intent).pipe(
    Match.tag('RESERVATION_CREATE', ({ request }) => ({
      attemptId: request.reservation.origin.attemptId,
      authorityBackendId: request.authority.selection.backendId,
      authorityBackendKind: request.authority.selection.backend,
      authorityConfigurationId: request.authority.configurationId,
      customerConfigurationId: request.authority.customerConfigurationId,
      legalEntityId: request.legalEntityId,
      reservationId: request.reservation.ref.resourceId,
    })),
    Match.tag('RESERVATION_RELEASE', ({ request }) => ({
      attemptId: request.reservation.origin.attemptId,
      authorityBackendId: request.reservation.authority.selection.backendId,
      authorityBackendKind: request.reservation.authority.selection.backend,
      authorityConfigurationId: request.reservation.authority.configurationId,
      customerConfigurationId: request.reservation.authority.customerConfigurationId,
      legalEntityId: request.legalEntityId,
      reservationId: request.reservation.ref.resourceId,
    })),
    Match.tag('ESTABLISH_COMMITMENT_PROTECTION', ({ request }) => ({
      attemptId: request.confirmation.reservation.origin.attemptId,
      authorityBackendId: request.confirmation.reservation.authority.selection.backendId,
      authorityBackendKind: request.confirmation.reservation.authority.selection.backend,
      authorityConfigurationId: request.confirmation.reservation.authority.configurationId,
      customerConfigurationId: request.confirmation.reservation.authority.customerConfigurationId,
      legalEntityId: request.legalEntityId,
      reservationId: request.confirmation.reservation.ref.resourceId,
    })),
    Match.tag('PHYSICAL_RECEIPT', 'PHYSICAL_ISSUE', ({ request }) => ({
      attemptId: null,
      authorityBackendId: request.backendId,
      authorityBackendKind: request.backend,
      authorityConfigurationId: request.backendConfigurationRef.resourceId,
      customerConfigurationId: request.customerConfigurationId,
      legalEntityId: request.legalEntityId,
      reservationId: null,
    })),
    Match.exhaustive,
  );

const valuesFor = (record: InventoryEffectLedgerRecord) => {
  const stable = stableScopeFor(record.intent);
  return {
    ...stable,
    currentRevision: record.revision,
    currentState: record.currentState,
    effectId: record.effectId,
    effectKind: record.intent._tag,
    intentCanonical: canonicalInventoryEffectIntent(record.intent),
    intentJson: canonicalInventoryEffectIntentValue(record.intent),
    requestedAt: DateTime.toDateUtc(DateTime.makeUnsafe(record.requestedAt)),
    resolutionJson: record.resolution,
    snapshot: record,
    tenantId: record.tenantId,
    updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe(record.updatedAt)),
  };
};

const decodeRow = (row: EffectRow) =>
  Schema.decodeEffect(InventoryEffectLedgerRecordSchema)(row.snapshot).pipe(
    Effect.mapError((cause) =>
      unavailable(
        InventoryEffectLedgerEffectIdSchema.make(row.effectId),
        'Persisted Inventory effect ledger entry is invalid',
        cause,
      ),
    ),
  );

export const inventoryEffectLedgerPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): InventoryEffectLedgerPersistence => {
  const read: InventoryEffectLedgerPersistence['read'] = (effectId) =>
    transaction
      .select()
      .from(inventoryEffectLedger)
      .where(and(eq(inventoryEffectLedger.tenantId, scope.tenantId), eq(inventoryEffectLedger.effectId, effectId)))
      .for('update')
      .limit(1)
      .pipe(
        Effect.mapError((cause) => unavailable(effectId, 'Inventory effect ledger is temporarily unavailable', cause)),
        Effect.flatMap(([row]) => (row === undefined ? Effect.succeedNone : decodeRow(row).pipe(Effect.asSome))),
      );

  const appendHistory = (record: InventoryEffectLedgerRecord) =>
    transaction
      .insert(inventoryEffectLedgerHistory)
      .values({
        effectId: record.effectId,
        revision: record.revision,
        snapshot: record,
        state: record.currentState,
        tenantId: record.tenantId,
        transitionedAt: DateTime.toDateUtc(DateTime.makeUnsafe(record.updatedAt)),
      })
      .pipe(
        Effect.mapError((cause) => unavailable(record.effectId, 'Inventory effect history is unavailable', cause)),
        Effect.asVoid,
      );

  const createOrRead: InventoryEffectLedgerPersistence['createOrRead'] = Effect.fn(
    'InventoryEffectLedgerPersistence.createOrRead',
  )(function* createOrReadEffect(candidate) {
    if (
      candidate.tenantId !== scope.tenantId ||
      stableScopeFor(candidate.intent).legalEntityId !== scope.legalEntityId
    ) {
      return yield* unavailable(candidate.effectId, 'Inventory effect scope does not match the trusted operation');
    }
    const canonicalIntent = canonicalInventoryEffectIntentValue(candidate.intent);
    const canonicalCandidate: InventoryEffectLedgerRecord = { ...candidate, intent: canonicalIntent };
    const [claimed] = yield* transaction
      .invoke(claimInventoryEffectLedgerRoutine, [canonicalInventoryEffectIntent(canonicalIntent), canonicalCandidate])
      .pipe(
        Effect.mapError((cause) => unavailable(candidate.effectId, 'Inventory effect claim is unavailable', cause)),
      );
    if (claimed === undefined) {
      return yield* unavailable(candidate.effectId, 'Inventory effect claim returned no authoritative record');
    }
    return { outcome: claimed.inserted ? ('INSERTED' as const) : ('EXISTING' as const), record: claimed.record };
  });

  const save: InventoryEffectLedgerPersistence['save'] = Effect.fn('InventoryEffectLedgerPersistence.save')(
    function* saveEffect(expected, next) {
      if (
        expected.tenantId !== scope.tenantId ||
        next.tenantId !== scope.tenantId ||
        expected.effectId !== next.effectId ||
        next.revision !== expected.revision + 1
      ) {
        return Option.none<InventoryEffectLedgerRecord>();
      }
      const [updated] = yield* transaction
        .update(inventoryEffectLedger)
        .set(valuesFor(next))
        .where(
          and(
            eq(inventoryEffectLedger.tenantId, scope.tenantId),
            eq(inventoryEffectLedger.effectId, expected.effectId),
            eq(inventoryEffectLedger.currentRevision, expected.revision),
            eq(inventoryEffectLedger.currentState, expected.currentState),
          ),
        )
        .returning()
        .pipe(
          Effect.mapError((cause) =>
            unavailable(expected.effectId, 'Inventory effect transition is unavailable', cause),
          ),
        );
      if (updated === undefined) {
        return Option.none<InventoryEffectLedgerRecord>();
      }
      const persisted = yield* decodeRow(updated);
      yield* appendHistory(persisted);
      return Option.some(persisted);
    },
  );

  return Object.freeze({ createOrRead, read, save });
};

export const inventoryEffectLedgerPersistenceForWorkerScope = (
  scope: OutboxWorkerLegalEntityScope,
): InventoryEffectLedgerPersistence => ({
  createOrRead: (candidate) =>
    Effect.fail(unavailable(candidate.effectId, 'Workers cannot claim a new Inventory effect')),
  read: (effectId) =>
    scope.routineInvoker.invoke(readInventoryEffectLedgerForWorkerRoutine, [effectId]).pipe(
      Effect.mapError((cause) => unavailable(effectId, 'Inventory effect ledger is temporarily unavailable', cause)),
      Effect.map(([row]) => (row === undefined ? Option.none() : Option.some(row.record))),
    ),
  save: (expected, next) =>
    scope.routineInvoker
      .invoke(transitionInventoryEffectLedgerForWorkerRoutine, [
        expected.effectId,
        expected.revision,
        expected.currentState,
        next,
      ])
      .pipe(
        Effect.mapError((cause) => unavailable(expected.effectId, 'Inventory effect transition is unavailable', cause)),
        Effect.map(([row]) => (row === undefined ? Option.none() : Option.some(row.record))),
      ),
});
