import { findPostgresFailure } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, asc, eq, or } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import {
  ReservationConfirmationRejected,
  ReservationConfirmationSchema,
  ReservationConfirmationUnavailable,
} from '../../shared/domain/reservation-confirmation.ts';
import type {
  ReservationConfirmation,
  ReservationConfirmationError,
  ReservationConfirmationPersistence,
} from '../../shared/domain/reservation-confirmation.ts';
import type { ReservationConfirmationRef } from '../../shared/resources/reservation-confirmation.ts';
import { currentBindingRequirementsMatch, lockBindingCorrectionScopes } from './binding-correction-serialization.ts';
import {
  inventoryReservationConfirmationHistory,
  inventoryReservationConfirmationScopeContract,
  inventoryReservationConfirmations,
} from './reservation-confirmation-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type ConfirmationRow = typeof inventoryReservationConfirmations.$inferSelect;
type HistoryRow = typeof inventoryReservationConfirmationHistory.$inferSelect;

const unavailable = (cause?: unknown) => {
  const failure = new ReservationConfirmationUnavailable({
    code: 'reservation_confirmation_unavailable',
    reason: 'Reservation Confirmation persistence is temporarily unavailable',
    retryable: true,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const rejected = (reason: ReservationConfirmationRejected['reason'], confirmationRef?: ReservationConfirmationRef) =>
  confirmationRef === undefined
    ? new ReservationConfirmationRejected({ code: 'reservation_confirmation_rejected', reason })
    : new ReservationConfirmationRejected({ code: 'reservation_confirmation_rejected', confirmationRef, reason });

const uniqueViolationSqlState = ['23', '505'].join('');
const foreignKeyViolationSqlState = ['23', '503'].join('');
const checkViolationSqlState = ['23', '514'].join('');

export const mapReservationConfirmationWriteError = (cause: unknown): ReservationConfirmationError => {
  const revision = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState && constraint === 'inventory_reservation_confirmation_history_revision_uk',
  );
  if (Option.isSome(revision)) {
    return rejected('REVISION_CONFLICT');
  }
  const identity = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState &&
      [
        'reservation_confirmations_pkey',
        'inventory_reservation_confirmations_scope_id_uk',
        'inventory_reservation_confirmations_authority_effect_uk',
      ].includes(constraint ?? ''),
  );
  if (Option.isSome(identity)) {
    return rejected('CONFIRMATION_IDENTITY_CONFLICT');
  }
  const sibling = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState && constraint === 'inventory_reservation_confirmations_reservation_attempt_uk',
  );
  if (Option.isSome(sibling)) {
    return rejected('SIBLING_CONFIRMATION_FORBIDDEN');
  }
  const { constraintNames } = inventoryReservationConfirmationScopeContract;
  const scopeConstraints = new Set<string>([
    constraintNames.authority,
    constraintNames.reservation,
    constraintNames.snapshot,
  ]);
  const scope = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      (code === foreignKeyViolationSqlState &&
        [
          'inventory_reservation_confirmations_reservation_fk',
          'inventory_reservation_confirmations_backend_configuration_fk',
        ].includes(constraint ?? '')) ||
      (code === checkViolationSqlState && scopeConstraints.has(constraint ?? '')),
  );
  return Option.isSome(scope) ? rejected('RESERVATION_SCOPE_MISMATCH') : unavailable(cause);
};

const instantAsDate = (instant: string) => DateTime.toDateUtc(DateTime.makeUnsafe(instant));

const valuesFor = (confirmation: ReservationConfirmation) => ({
  attemptId: confirmation.reservation.origin.attemptId,
  authorityEffectId: confirmation.authorityEvidence.effectId,
  confirmationId: confirmation.ref.resourceId,
  currentHealthState: confirmation.health.state,
  currentRevision: confirmation.revision,
  expiresAt: instantAsDate(confirmation.expiresAt),
  issuedAt: instantAsDate(confirmation.issuedAt),
  issuerBackendId: confirmation.authorityEvidence.issuer.backendId,
  issuerBackendKind: confirmation.authorityEvidence.issuer.backend,
  ownerConfigurationId: confirmation.reservation.authority.configurationId,
  ownerEvidenceRef: confirmation.issuanceRank.ownerEvidenceRef,
  reservationId: confirmation.reservation.ref.resourceId,
  snapshot: confirmation,
  tenantId: confirmation.ref.tenantId,
  updatedAt: instantAsDate(confirmation.health.observation.effectiveAt),
});

const decodeSnapshot = (snapshot: ReservationConfirmation) =>
  Schema.decodeEffect(ReservationConfirmationSchema)(snapshot).pipe(Effect.mapError(unavailable));

export const decodeReservationConfirmationHistoryRows = (rows: readonly HistoryRow[]) =>
  Effect.forEach(rows, ({ snapshot }) => decodeSnapshot(snapshot), { concurrency: 1 });

export const reservationConfirmationPersistenceForScope = (
  transaction: ScopedTransaction,
  operationScope: OperationalScope,
): ReservationConfirmationPersistence => {
  const requireTenant = (
    tenantId: string,
    confirmationRef?: ReservationConfirmationRef,
  ): Effect.Effect<void, ReservationConfirmationRejected> =>
    tenantId === operationScope.tenantId
      ? Effect.void
      : Effect.fail(rejected('TENANT_SCOPE_MISMATCH', confirmationRef));

  const decodeRow = (row: ConfirmationRow) => decodeSnapshot(row.snapshot);

  const appendHistory = (confirmation: ReservationConfirmation) =>
    transaction
      .insert(inventoryReservationConfirmationHistory)
      .values({
        confirmationId: confirmation.ref.resourceId,
        healthState: confirmation.health.state,
        revision: confirmation.revision,
        snapshot: confirmation,
        tenantId: confirmation.ref.tenantId,
        transitionedAt: instantAsDate(confirmation.health.observation.effectiveAt),
      })
      .pipe(Effect.mapError(mapReservationConfirmationWriteError), Effect.asVoid);

  const findByRef: ReservationConfirmationPersistence['findByRef'] = Effect.fn(
    'ReservationConfirmationPersistence.findByRef',
  )(function* findConfirmation(ref) {
    yield* requireTenant(ref.tenantId, ref);
    const [row] = yield* transaction
      .select()
      .from(inventoryReservationConfirmations)
      .where(
        and(
          eq(inventoryReservationConfirmations.tenantId, operationScope.tenantId),
          eq(inventoryReservationConfirmations.confirmationId, ref.resourceId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    return row === undefined ? Option.none<ReservationConfirmation>() : Option.some(yield* decodeRow(row));
  });

  const findByReservationAttempt: ReservationConfirmationPersistence['findByReservationAttempt'] = Effect.fn(
    'ReservationConfirmationPersistence.findByReservationAttempt',
  )(function* findConfirmationByReservationAttempt(reservationRef, attemptId) {
    yield* requireTenant(reservationRef.tenantId);
    const [row] = yield* transaction
      .select()
      .from(inventoryReservationConfirmations)
      .where(
        and(
          eq(inventoryReservationConfirmations.tenantId, operationScope.tenantId),
          eq(inventoryReservationConfirmations.reservationId, reservationRef.resourceId),
          eq(inventoryReservationConfirmations.attemptId, attemptId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    return row === undefined ? Option.none<ReservationConfirmation>() : Option.some(yield* decodeRow(row));
  });

  const createOrRead: ReservationConfirmationPersistence['createOrRead'] = Effect.fn(
    'ReservationConfirmationPersistence.createOrRead',
  )(function* createOrReadConfirmation(candidate) {
    yield* requireTenant(candidate.ref.tenantId, candidate.ref);
    const bindingRequirements = candidate.reservation.requirements.map((requirement) => ({
      bindingId: requirement.bindingRef.resourceId,
      exactSelectionMeaning: requirement.exactSelectionMeaning,
      stockItemId: requirement.stockItem.stockItemRef.resourceId,
      tenantId: candidate.ref.tenantId,
    }));
    yield* lockBindingCorrectionScopes(transaction, bindingRequirements).pipe(Effect.mapError(unavailable));
    const [existingBeforeInsert] = yield* transaction
      .select()
      .from(inventoryReservationConfirmations)
      .where(
        and(
          eq(inventoryReservationConfirmations.tenantId, operationScope.tenantId),
          or(
            eq(inventoryReservationConfirmations.confirmationId, candidate.ref.resourceId),
            and(
              eq(inventoryReservationConfirmations.reservationId, candidate.reservation.ref.resourceId),
              eq(inventoryReservationConfirmations.attemptId, candidate.reservation.origin.attemptId),
            ),
            eq(inventoryReservationConfirmations.authorityEffectId, candidate.authorityEvidence.effectId),
          ),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (existingBeforeInsert !== undefined) {
      return { confirmation: yield* decodeRow(existingBeforeInsert), outcome: 'EXISTING' as const };
    }
    const bindingsRemainCurrent = yield* currentBindingRequirementsMatch(transaction, bindingRequirements).pipe(
      Effect.mapError(unavailable),
    );
    if (!bindingsRemainCurrent) {
      return yield* rejected('RESERVATION_SCOPE_MISMATCH', candidate.ref);
    }
    const [inserted] = yield* transaction
      .insert(inventoryReservationConfirmations)
      .values(valuesFor(candidate))
      .onConflictDoNothing()
      .returning()
      .pipe(Effect.mapError(mapReservationConfirmationWriteError));
    if (inserted !== undefined) {
      const persisted = yield* decodeRow(inserted);
      yield* appendHistory(persisted);
      return { confirmation: persisted, outcome: 'INSERTED' as const };
    }
    const [existing] = yield* transaction
      .select()
      .from(inventoryReservationConfirmations)
      .where(
        and(
          eq(inventoryReservationConfirmations.tenantId, operationScope.tenantId),
          or(
            eq(inventoryReservationConfirmations.confirmationId, candidate.ref.resourceId),
            and(
              eq(inventoryReservationConfirmations.reservationId, candidate.reservation.ref.resourceId),
              eq(inventoryReservationConfirmations.attemptId, candidate.reservation.origin.attemptId),
            ),
            eq(inventoryReservationConfirmations.authorityEffectId, candidate.authorityEvidence.effectId),
          ),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (existing === undefined) {
      return yield* unavailable();
    }
    return { confirmation: yield* decodeRow(existing), outcome: 'EXISTING' as const };
  });

  const readHistory: ReservationConfirmationPersistence['readHistory'] = (ref) =>
    requireTenant(ref.tenantId, ref).pipe(
      Effect.flatMap(() =>
        transaction
          .select()
          .from(inventoryReservationConfirmationHistory)
          .where(
            and(
              eq(inventoryReservationConfirmationHistory.tenantId, operationScope.tenantId),
              eq(inventoryReservationConfirmationHistory.confirmationId, ref.resourceId),
            ),
          )
          .orderBy(asc(inventoryReservationConfirmationHistory.revision))
          .pipe(Effect.mapError(unavailable), Effect.flatMap(decodeReservationConfirmationHistoryRows)),
      ),
    );

  const saveRevision: ReservationConfirmationPersistence['saveRevision'] = Effect.fn(
    'ReservationConfirmationPersistence.saveRevision',
  )(function* saveConfirmationRevision({ current, next }) {
    yield* requireTenant(current.ref.tenantId, current.ref);
    const [row] = yield* transaction
      .update(inventoryReservationConfirmations)
      .set(valuesFor(next))
      .where(
        and(
          eq(inventoryReservationConfirmations.tenantId, operationScope.tenantId),
          eq(inventoryReservationConfirmations.confirmationId, current.ref.resourceId),
          eq(inventoryReservationConfirmations.currentRevision, current.revision),
        ),
      )
      .returning()
      .pipe(Effect.mapError(mapReservationConfirmationWriteError));
    if (row === undefined) {
      return yield* rejected('REVISION_CONFLICT', current.ref);
    }
    const persisted = yield* decodeRow(row);
    yield* appendHistory(persisted);
    return persisted;
  });

  return Object.freeze({ createOrRead, findByRef, findByReservationAttempt, readHistory, saveRevision });
};
