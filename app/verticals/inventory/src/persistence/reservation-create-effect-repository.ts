import { defineScopedRoutine, findPostgresFailure } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import {
  InventoryReservationCreateRejected,
  InventoryReservationCreateUnavailable,
  EstablishedReservationCreateEffectSchema,
  ReservationCreateEffectSchema,
} from '../../shared/domain/inventory-reservation-create.ts';
import type {
  InventoryReservationCreateRequest,
  ReservationCreateEffect,
} from '../../shared/domain/inventory-reservation-create.ts';
import type { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import { ReservationAuthorityEffectIdSchema as ReservationAuthorityEffectId } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import type { ReservationCreateEffectPersistence } from '../services/inventory-reservation-create.service.ts';
import { inventoryReservationCreateEffects } from './reservation-create-effect-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const workerRowSchema = Schema.Struct({ record: ReservationCreateEffectSchema });
export const readReservationCreateEffectForWorkerRoutine = defineScopedRoutine({
  name: 'read_reservation_create_effect_for_worker',
  ownerModuleKey: 'commerce.inventory',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: workerRowSchema,
  routineKey: 'inventory.read-reservation-create-effect-for-worker',
  schema: 'inventory',
});
export const finalizeReservationCreateEffectForWorkerRoutine = defineScopedRoutine({
  name: 'finalize_reservation_create_effect_for_worker',
  ownerModuleKey: 'commerce.inventory',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: workerRowSchema,
  routineKey: 'inventory.finalize-reservation-create-effect-for-worker',
  schema: 'inventory',
});

const unavailable = (effectId: typeof ReservationAuthorityEffectIdSchema.Type, cause?: unknown) => {
  const failure = new InventoryReservationCreateUnavailable({
    code: 'inventory_reservation_create_unavailable',
    effectId,
    reason: 'Reservation create-effect persistence is temporarily unavailable',
    retryable: true,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const rejected = (
  effectId: typeof ReservationAuthorityEffectIdSchema.Type,
  reason: InventoryReservationCreateRejected['reason'],
) => new InventoryReservationCreateRejected({ code: 'inventory_reservation_create_rejected', effectId, reason });

const uniqueViolationSqlState = ['23', '505'].join('');
const checkViolationSqlState = ['23', '514'].join('');
const invalidEffectId = ReservationAuthorityEffectId.make('invalid-reservation-create-effect');
const unknownEffectId = ReservationAuthorityEffectId.make('unknown-reservation-create-effect');
const unresolvedEffectsId = ReservationAuthorityEffectId.make('unresolved-reservation-create-effects');

export const mapReservationCreateEffectWriteError = (
  effectId: typeof ReservationAuthorityEffectIdSchema.Type,
  cause: unknown,
) => {
  const staleBinding = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === checkViolationSqlState && constraint === 'inventory_reservation_create_effects_stale_binding_ck',
  );
  if (Option.isSome(staleBinding)) {
    return rejected(effectId, 'INVALID_BACKEND_OBSERVATION');
  }
  const attempt = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState && constraint === 'inventory_reservation_create_effects_attempt_uk',
  );
  if (Option.isSome(attempt)) {
    return rejected(effectId, 'ATTEMPT_HAS_UNRESOLVED_EFFECT');
  }
  const identity = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState && constraint === 'inventory_reservation_create_effects_pkey',
  );
  return Option.isSome(identity) ? rejected(effectId, 'EFFECT_ID_CONFLICT') : unavailable(effectId, cause);
};

const decodeRow = (row: typeof inventoryReservationCreateEffects.$inferSelect) =>
  Schema.decodeEffect(ReservationAuthorityEffectId)(row.effectId).pipe(
    Effect.mapError((cause) => unavailable(invalidEffectId, cause)),
    Effect.flatMap((decodedEffectId) =>
      Schema.decodeEffect(ReservationCreateEffectSchema)(row.recordJson).pipe(
        Effect.mapError((cause) => unavailable(decodedEffectId, cause)),
      ),
    ),
  );

const insertValues = (request: InventoryReservationCreateRequest) => {
  const record = { _tag: 'REQUESTED' as const, request };
  return {
    attemptId: request.reservation.origin.attemptId,
    backendConfigurationId: request.authority.configurationId,
    backendId: request.authority.selection.backendId,
    customerConfigurationId: request.authority.customerConfigurationId,
    effectId: request.effectId,
    legalEntityId: request.legalEntityId,
    mutationId: request.mutationId,
    recordJson: record,
    requestedAt: DateTime.toDateUtc(DateTime.makeUnsafe(request.requestedAt)),
    requestJson: request,
    reservationId: request.reservation.ref.resourceId,
    sourceActionInvocationId: request.sourceActionInvocationId,
    state: record._tag,
    tenantId: request.authority.tenantId,
  };
};

export const reservationCreateEffectPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): ReservationCreateEffectPersistence => {
  const readRows = (effectId: typeof ReservationAuthorityEffectIdSchema.Type) =>
    transaction
      .select()
      .from(inventoryReservationCreateEffects)
      .where(
        and(
          eq(inventoryReservationCreateEffects.tenantId, scope.tenantId),
          eq(inventoryReservationCreateEffects.effectId, effectId),
        ),
      )
      .for('update')
      .limit(1)
      .pipe(Effect.mapError((cause) => unavailable(effectId, cause)));

  const read: ReservationCreateEffectPersistence['read'] = (effectId) =>
    readRows(effectId).pipe(
      Effect.flatMap(([row]) => (row === undefined ? Effect.succeedNone : decodeRow(row).pipe(Effect.asSome))),
    );

  const findByAttempt: ReservationCreateEffectPersistence['findByAttempt'] = (attemptId) =>
    transaction
      .select()
      .from(inventoryReservationCreateEffects)
      .where(
        and(
          eq(inventoryReservationCreateEffects.tenantId, scope.tenantId),
          eq(inventoryReservationCreateEffects.attemptId, attemptId),
        ),
      )
      .for('update')
      .limit(1)
      .pipe(
        Effect.mapError((cause) => unavailable(unknownEffectId, cause)),
        Effect.flatMap(([row]) => (row === undefined ? Effect.succeedNone : decodeRow(row).pipe(Effect.asSome))),
      );

  const createOrRead: ReservationCreateEffectPersistence['createOrRead'] = Effect.fn(
    'ReservationCreateEffectPersistence.createOrRead',
  )(function* createOrReadEffect(request) {
    if (request.authority.tenantId !== scope.tenantId) {
      return yield* rejected(request.effectId, 'TENANT_SCOPE_MISMATCH');
    }
    const [inserted] = yield* transaction
      .insert(inventoryReservationCreateEffects)
      .values(insertValues(request))
      .onConflictDoNothing()
      .returning()
      .pipe(Effect.mapError((cause) => mapReservationCreateEffectWriteError(request.effectId, cause)));
    if (inserted !== undefined) {
      return { effect: yield* decodeRow(inserted), outcome: 'INSERTED' as const };
    }
    const existing = yield* read(request.effectId);
    if (Option.isSome(existing)) {
      return { effect: existing.value, outcome: 'EXISTING' as const };
    }
    const competing = yield* findByAttempt(request.reservation.origin.attemptId);
    return yield* Option.match(competing, {
      onNone: () => Effect.fail(unavailable(request.effectId)),
      onSome: (record) =>
        Effect.fail(
          rejected(
            request.effectId,
            Schema.is(EstablishedReservationCreateEffectSchema)(record)
              ? 'ATTEMPT_ALREADY_BOUND'
              : 'ATTEMPT_HAS_UNRESOLVED_EFFECT',
          ),
        ),
    });
  });

  const save: ReservationCreateEffectPersistence['save'] = Effect.fn('ReservationCreateEffectPersistence.save')(
    function* saveEffect(expected, next) {
      if (expected.request.effectId !== next.request.effectId || next.request.authority.tenantId !== scope.tenantId) {
        return yield* rejected(expected.request.effectId, 'EFFECT_ID_CONFLICT');
      }
      const [updated] = yield* transaction
        .update(inventoryReservationCreateEffects)
        .set({ recordJson: next, state: next._tag, updatedAt: sql`now()` })
        .where(
          and(
            eq(inventoryReservationCreateEffects.tenantId, scope.tenantId),
            eq(inventoryReservationCreateEffects.effectId, expected.request.effectId),
            eq(inventoryReservationCreateEffects.state, expected._tag),
          ),
        )
        .returning()
        .pipe(Effect.mapError((cause) => mapReservationCreateEffectWriteError(expected.request.effectId, cause)));
      if (updated !== undefined) {
        return yield* decodeRow(updated);
      }
      const current = yield* read(expected.request.effectId);
      return yield* Effect.fromOption(current).pipe(
        Effect.mapError((cause) => unavailable(expected.request.effectId, cause)),
      );
    },
  );

  return Object.freeze({ createOrRead, findByAttempt, read, save });
};

/** Current unresolved effects constrain planned/known Allocations until authoritative resolution. */
export const listUnresolvedReservationCreateEffects = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<readonly ReservationCreateEffect[], InventoryReservationCreateUnavailable> =>
  transaction
    .select()
    .from(inventoryReservationCreateEffects)
    .where(
      and(
        eq(inventoryReservationCreateEffects.tenantId, scope.tenantId),
        inArray(inventoryReservationCreateEffects.state, ['REQUESTED', 'RECONCILIATION_REQUIRED', 'INDETERMINATE']),
      ),
    )
    .pipe(
      Effect.mapError((cause) => unavailable(unresolvedEffectsId, cause)),
      Effect.flatMap((rows) => Effect.forEach(rows, decodeRow, { concurrency: 1 })),
    );

/** Worker adapter over the Core-verified, lifetime-bound owner scope. */
export const reservationCreateEffectPersistenceForWorkerScope = (
  scope: OutboxWorkerLegalEntityScope,
): ReservationCreateEffectPersistence => ({
  createOrRead: (request) => Effect.fail(unavailable(request.effectId)),
  findByAttempt: () => Effect.fail(unavailable(unknownEffectId)),
  read: (effectId) =>
    scope.routineInvoker.invoke(readReservationCreateEffectForWorkerRoutine, [effectId]).pipe(
      Effect.mapError((cause) => unavailable(effectId, cause)),
      Effect.map(([row]) => (row === undefined ? Option.none() : Option.some(row.record))),
    ),
  save: (expected, terminal) =>
    scope.routineInvoker
      .invoke(finalizeReservationCreateEffectForWorkerRoutine, [expected.request.effectId, terminal])
      .pipe(
        Effect.mapError((cause) => mapReservationCreateEffectWriteError(expected.request.effectId, cause)),
        Effect.flatMap(([row]) =>
          row === undefined ? Effect.fail(unavailable(expected.request.effectId)) : Effect.succeed(row.record),
        ),
      ),
});
