import { defineScopedRoutine, findPostgresFailure } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import {
  InventoryReservationReleaseRejected,
  ReservationReleaseEffectIdSchema,
  ReservationReleaseEffectSchema,
  RequestedReleaseEffectSchema,
} from '../../shared/domain/inventory-reservation-release.ts';
import type {
  InventoryReservationReleaseError,
  ReservationReleaseEffect,
} from '../../shared/domain/inventory-reservation-release.ts';
import type { ReservationReleaseEffectPersistence } from '../services/inventory-reservation-release.service.ts';
import { reservationReleaseUnavailable } from '../services/inventory-reservation-release.service.ts';
import {
  inventoryReservationReleaseEffectHistory,
  inventoryReservationReleaseEffects,
} from './reservation-release-effect-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type EffectRow = typeof inventoryReservationReleaseEffects.$inferSelect;

const workerRowSchema = Schema.Struct({ record: ReservationReleaseEffectSchema });
export const readReservationReleaseEffectForWorkerRoutine = defineScopedRoutine({
  name: 'read_reservation_release_effect_for_worker',
  ownerModuleKey: 'commerce.inventory',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: workerRowSchema,
  routineKey: 'inventory.read-reservation-release-effect-for-worker',
  schema: 'inventory',
});
export const finalizeReservationReleaseEffectForWorkerRoutine = defineScopedRoutine({
  name: 'finalize_reservation_release_effect_for_worker',
  ownerModuleKey: 'commerce.inventory',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'jsonb' },
  ],
  resultSchema: workerRowSchema,
  routineKey: 'inventory.finalize-reservation-release-effect-for-worker',
  schema: 'inventory',
});

const rejected = (
  effectId: typeof ReservationReleaseEffectIdSchema.Type,
  reason: InventoryReservationReleaseRejected['reason'],
) => new InventoryReservationReleaseRejected({ code: 'inventory_reservation_release_rejected', effectId, reason });

const uniqueViolationSqlState = ['23', '505'].join('');
const persistenceUnavailableReason = 'Reservation Release persistence is temporarily unavailable';
export const mapReservationReleaseEffectWriteError = (
  effectId: typeof ReservationReleaseEffectIdSchema.Type,
  cause: unknown,
): InventoryReservationReleaseError => {
  const sibling = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState && constraint === 'inventory_reservation_release_effects_reservation_uk',
  );
  if (Option.isSome(sibling)) {
    return rejected(effectId, 'SIBLING_RELEASE_EFFECT_FORBIDDEN');
  }
  const identity = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState &&
      [
        'inventory_reservation_release_effects_scope_effect_uk',
        'inventory_reservation_release_effects_mutation_uk',
      ].includes(constraint ?? ''),
  );
  if (Option.isSome(identity)) {
    return rejected(effectId, 'EFFECT_ID_CONFLICT');
  }
  const revision = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState && constraint === 'inventory_reservation_release_effect_history_revision_uk',
  );
  return Option.isSome(revision)
    ? rejected(effectId, 'REVISION_CONFLICT')
    : reservationReleaseUnavailable(effectId, persistenceUnavailableReason, cause);
};

const decodeRow = (row: EffectRow) =>
  Schema.decodeEffect(ReservationReleaseEffectSchema)(row.snapshot).pipe(
    Effect.mapError((cause) =>
      reservationReleaseUnavailable(
        ReservationReleaseEffectIdSchema.make(row.releaseEffectId),
        'Persisted Reservation Release effect is invalid',
        cause,
      ),
    ),
  );

const transitionedAt = (effect: ReservationReleaseEffect) =>
  Match.value(effect).pipe(
    Match.tag('REQUESTED', ({ request }) => request.requestedAt),
    Match.tag('RELEASED', ({ releasedAt }) => releasedAt),
    Match.tag('NOT_RELEASABLE', 'INDETERMINATE', ({ observedAt }) => observedAt),
    Match.exhaustive,
  );

const valuesFor = (effect: ReservationReleaseEffect) => {
  const releaseColumns = Match.value(effect).pipe(
    Match.tag('RELEASED', ({ ownerEvidenceRef, releasedAt }) => ({
      ownerEvidenceRef,
      releasedAt: DateTime.toDateUtc(DateTime.makeUnsafe(releasedAt)),
    })),
    Match.tag('REQUESTED', 'INDETERMINATE', 'NOT_RELEASABLE', () => ({
      ownerEvidenceRef: null,
      releasedAt: null,
    })),
    Match.exhaustive,
  );
  return {
    attemptId: effect.request.reservation.origin.attemptId,
    currentRevision: effect.revision,
    currentState: effect._tag,
    issuerBackendId: effect.request.reservation.authority.selection.backendId,
    issuerBackendKind: effect.request.reservation.authority.selection.backend,
    legalEntityId: effect.request.legalEntityId,
    mutationId: effect.request.mutationId,
    ownerConfigurationId: effect.request.reservation.authority.configurationId,
    ownerEvidenceRef: releaseColumns.ownerEvidenceRef,
    releasedAt: releaseColumns.releasedAt,
    releaseEffectId: effect.request.effectId,
    requestedAt: DateTime.toDateUtc(DateTime.makeUnsafe(effect.request.requestedAt)),
    reservationId: effect.request.reservation.ref.resourceId,
    snapshot: effect,
    sourceActionInvocationId: effect.request.sourceActionInvocationId,
    tenantId: effect.request.reservation.ref.tenantId,
    updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe(transitionedAt(effect))),
  };
};

export const reservationReleaseEffectPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): ReservationReleaseEffectPersistence => {
  const read: ReservationReleaseEffectPersistence['read'] = (effectId) =>
    transaction
      .select()
      .from(inventoryReservationReleaseEffects)
      .where(
        and(
          eq(inventoryReservationReleaseEffects.tenantId, scope.tenantId),
          eq(inventoryReservationReleaseEffects.releaseEffectId, effectId),
        ),
      )
      .for('update')
      .limit(1)
      .pipe(
        Effect.mapError((cause) => reservationReleaseUnavailable(effectId, persistenceUnavailableReason, cause)),
        Effect.flatMap(([row]) => (row === undefined ? Effect.succeedNone : decodeRow(row).pipe(Effect.asSome))),
      );

  const findByReservation: ReservationReleaseEffectPersistence['findByReservation'] = (ref) =>
    ref.tenantId === scope.tenantId
      ? transaction
          .select()
          .from(inventoryReservationReleaseEffects)
          .where(
            and(
              eq(inventoryReservationReleaseEffects.tenantId, scope.tenantId),
              eq(inventoryReservationReleaseEffects.reservationId, ref.resourceId),
            ),
          )
          .for('update')
          .limit(1)
          .pipe(
            Effect.mapError((cause) => reservationReleaseUnavailable(undefined, persistenceUnavailableReason, cause)),
            Effect.flatMap(([row]) => (row === undefined ? Effect.succeedNone : decodeRow(row).pipe(Effect.asSome))),
          )
      : Effect.fail(rejected(ReservationReleaseEffectIdSchema.make('cross-tenant-release'), 'TENANT_SCOPE_MISMATCH'));

  const appendHistory = (effect: ReservationReleaseEffect) =>
    transaction
      .insert(inventoryReservationReleaseEffectHistory)
      .values({
        releaseEffectId: effect.request.effectId,
        revision: effect.revision,
        snapshot: effect,
        state: effect._tag,
        tenantId: effect.request.reservation.ref.tenantId,
        transitionedAt: DateTime.toDateUtc(DateTime.makeUnsafe(transitionedAt(effect))),
      })
      .pipe(
        Effect.mapError((cause) => mapReservationReleaseEffectWriteError(effect.request.effectId, cause)),
        Effect.asVoid,
      );

  const createOrRead: ReservationReleaseEffectPersistence['createOrRead'] = Effect.fn(
    'ReservationReleaseEffectPersistence.createOrRead',
  )(function* createOrRead(candidate) {
    if (
      !Schema.is(RequestedReleaseEffectSchema)(candidate) ||
      candidate.request.reservation.ref.tenantId !== scope.tenantId
    ) {
      return yield* rejected(candidate.request.effectId, 'TENANT_SCOPE_MISMATCH');
    }
    const [inserted] = yield* transaction
      .insert(inventoryReservationReleaseEffects)
      .values(valuesFor(candidate))
      .onConflictDoNothing()
      .returning()
      .pipe(Effect.mapError((cause) => mapReservationReleaseEffectWriteError(candidate.request.effectId, cause)));
    if (inserted !== undefined) {
      const persisted = yield* decodeRow(inserted);
      yield* appendHistory(persisted);
      return { effect: persisted, outcome: 'INSERTED' as const };
    }
    const existing = yield* read(candidate.request.effectId);
    if (Option.isSome(existing)) {
      return { effect: existing.value, outcome: 'EXISTING' as const };
    }
    const sibling = yield* findByReservation(candidate.request.reservation.ref);
    return yield* Option.match(sibling, {
      onNone: () =>
        Effect.fail(
          reservationReleaseUnavailable(candidate.request.effectId, 'Release insert conflict could not be resolved'),
        ),
      onSome: () => Effect.fail(rejected(candidate.request.effectId, 'SIBLING_RELEASE_EFFECT_FORBIDDEN')),
    });
  });

  const save: ReservationReleaseEffectPersistence['save'] = Effect.fn('ReservationReleaseEffectPersistence.save')(
    function* saveEffect(expected, next) {
      if (
        expected.request.effectId !== next.request.effectId ||
        next.request.reservation.ref.tenantId !== scope.tenantId ||
        next.revision !== expected.revision + 1
      ) {
        return yield* rejected(expected.request.effectId, 'REVISION_CONFLICT');
      }
      const [updated] = yield* transaction
        .update(inventoryReservationReleaseEffects)
        .set(valuesFor(next))
        .where(
          and(
            eq(inventoryReservationReleaseEffects.tenantId, scope.tenantId),
            eq(inventoryReservationReleaseEffects.releaseEffectId, expected.request.effectId),
            eq(inventoryReservationReleaseEffects.currentRevision, expected.revision),
            eq(inventoryReservationReleaseEffects.currentState, expected._tag),
          ),
        )
        .returning()
        .pipe(Effect.mapError((cause) => mapReservationReleaseEffectWriteError(expected.request.effectId, cause)));
      if (updated === undefined) {
        return yield* rejected(expected.request.effectId, 'REVISION_CONFLICT');
      }
      const persisted = yield* decodeRow(updated);
      yield* appendHistory(persisted);
      return persisted;
    },
  );

  return Object.freeze({ createOrRead, findByReservation, read, save });
};

export const reservationReleaseEffectPersistenceForWorkerScope = (
  scope: OutboxWorkerLegalEntityScope,
): ReservationReleaseEffectPersistence => ({
  createOrRead: (candidate) =>
    Effect.fail(reservationReleaseUnavailable(candidate.request.effectId, 'Worker cannot create Release intents')),
  findByReservation: () =>
    Effect.fail(reservationReleaseUnavailable(undefined, 'Worker cannot search unrelated Release intents')),
  read: (effectId) =>
    scope.routineInvoker.invoke(readReservationReleaseEffectForWorkerRoutine, [effectId]).pipe(
      Effect.mapError((cause) => reservationReleaseUnavailable(effectId, 'Release effect read failed', cause)),
      Effect.map(([row]) => (row === undefined ? Option.none() : Option.some(row.record))),
    ),
  save: (expected, next) =>
    scope.routineInvoker
      .invoke(finalizeReservationReleaseEffectForWorkerRoutine, [expected.request.effectId, expected.revision, next])
      .pipe(
        Effect.mapError((cause) =>
          reservationReleaseUnavailable(expected.request.effectId, 'Release effect finalization failed', cause),
        ),
        Effect.flatMap(([row]) =>
          row === undefined
            ? Effect.fail(reservationReleaseUnavailable(expected.request.effectId, 'Release effect was not finalized'))
            : Effect.succeed(row.record),
        ),
      ),
});
