import { findPostgresFailure } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, asc, eq, or } from 'drizzle-orm';
import { DateTime, Effect, Option, Result, Schema } from 'effect';

import {
  CommitmentProtectionRejected,
  CommitmentProtectionSchema,
  CommitmentProtectionUnavailable,
} from '../../shared/domain/commitment-protection.ts';
import type {
  CommitmentProtection,
  CommitmentProtectionPersistence,
  EstablishCommitmentProtectionError,
} from '../../shared/domain/commitment-protection.ts';
import { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import { currentBindingRequirementsMatch, lockBindingCorrectionScopes } from './binding-correction-serialization.ts';
import {
  inventoryCommitmentProtectionHistory,
  inventoryCommitmentProtectionScopeContract,
  inventoryCommitmentProtections,
} from './commitment-protection-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type ProtectionRow = typeof inventoryCommitmentProtections.$inferSelect;
type HistoryRow = typeof inventoryCommitmentProtectionHistory.$inferSelect;
type ProtectionEffectId = typeof ReservationAuthorityEffectIdSchema.Type;

const persistenceReadEffectId = Result.getOrThrow(
  Schema.decodeResult(ReservationAuthorityEffectIdSchema)('commitment-protection:persistence-read'),
);

const unavailable = (effectId: ProtectionEffectId, cause?: unknown) => {
  const failure = new CommitmentProtectionUnavailable({
    code: 'commitment_protection_unavailable',
    effectId,
    reason: 'Commitment Protection persistence is temporarily unavailable',
    retryable: true,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const rejected = (effectId: ProtectionEffectId, reason: CommitmentProtectionRejected['reason']) =>
  new CommitmentProtectionRejected({ code: 'commitment_protection_rejected', effectId, reason });

const uniqueViolationSqlState = ['23', '505'].join('');
const foreignKeyViolationSqlState = ['23', '503'].join('');
const checkViolationSqlState = ['23', '514'].join('');

export const mapCommitmentProtectionWriteError = (
  effectId: ProtectionEffectId,
  cause: unknown,
): EstablishCommitmentProtectionError => {
  const revision = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState && constraint === 'inventory_commitment_protection_history_revision_uk',
  );
  if (Option.isSome(revision)) {
    return rejected(effectId, 'REVISION_CONFLICT');
  }
  const sibling = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState && constraint === 'inventory_commitment_protections_reservation_attempt_uk',
  );
  if (Option.isSome(sibling)) {
    return rejected(effectId, 'SIBLING_PROTECTION_FORBIDDEN');
  }
  const identity = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState &&
      [
        'commitment_protections_pkey',
        'inventory_commitment_protections_scope_id_uk',
        'inventory_commitment_protections_confirmation_uk',
        'inventory_commitment_protections_authority_effect_uk',
      ].includes(constraint ?? ''),
  );
  if (Option.isSome(identity)) {
    return rejected(effectId, 'PROTECTION_IDENTITY_CONFLICT');
  }
  const { constraintNames } = inventoryCommitmentProtectionScopeContract;
  const confirmationScopeConstraints = new Set<string>([constraintNames.confirmation, constraintNames.reservation]);
  const confirmation = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      (code === foreignKeyViolationSqlState &&
        [
          'inventory_commitment_protections_confirmation_fk',
          'inventory_commitment_protections_reservation_fk',
        ].includes(constraint ?? '')) ||
      (code === checkViolationSqlState && confirmationScopeConstraints.has(constraint ?? '')),
  );
  if (Option.isSome(confirmation)) {
    return rejected(effectId, 'CONFIRMATION_SCOPE_MISMATCH');
  }
  const authority = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      (code === foreignKeyViolationSqlState &&
        constraint === 'inventory_commitment_protections_backend_configuration_fk') ||
      (code === checkViolationSqlState && constraint === constraintNames.authority),
  );
  if (Option.isSome(authority)) {
    return rejected(effectId, 'AUTHORITY_SCOPE_MISMATCH');
  }
  const proof = findPostgresFailure(
    cause,
    ({ code, constraint }) => code === checkViolationSqlState && constraint === constraintNames.snapshot,
  );
  if (Option.isSome(proof)) {
    return rejected(effectId, 'PROOF_SCOPE_MISMATCH');
  }
  const invalid = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === checkViolationSqlState &&
      [
        'inventory_commitment_protections_meaning_ck',
        'inventory_commitment_protections_health_ck',
        'inventory_commitment_protection_history_health_ck',
      ].includes(constraint ?? ''),
  );
  return Option.isSome(invalid) ? rejected(effectId, 'INVALID_PROTECTION') : unavailable(effectId, cause);
};

const instantAsDate = (instant: string) => DateTime.toDateUtc(DateTime.makeUnsafe(instant));

const valuesFor = (protection: CommitmentProtection) => ({
  attemptId: protection.confirmation.reservation.origin.attemptId,
  authorityEffectId: protection.authorityEvidence.effectId,
  confirmationId: protection.confirmation.ref.resourceId,
  currentHealthState: protection.health.state,
  currentRevision: protection.revision,
  establishedAt: instantAsDate(protection.establishedAt),
  issuerBackendId: protection.authorityEvidence.issuer.backendId,
  issuerBackendKind: protection.authorityEvidence.issuer.backend,
  ownerConfigurationId: protection.confirmation.reservation.authority.configurationId,
  ownerEvidenceRef: protection.authorityEvidence.evidence.ownerEvidenceRef,
  protectionId: protection.ref.resourceId,
  reservationId: protection.confirmation.reservation.ref.resourceId,
  snapshot: protection,
  tenantId: protection.ref.tenantId,
  updatedAt: instantAsDate(protection.health.observation.effectiveAt),
});

const decodeSnapshot = (effectId: ProtectionEffectId, snapshot: CommitmentProtection) =>
  Schema.decodeEffect(CommitmentProtectionSchema)(snapshot).pipe(
    Effect.mapError((cause) => unavailable(effectId, cause)),
  );

export const decodeCommitmentProtectionHistoryRows = (
  effectId: ProtectionEffectId,
  rows: readonly Pick<HistoryRow, 'snapshot'>[],
) => Effect.forEach(rows, ({ snapshot }) => decodeSnapshot(effectId, snapshot), { concurrency: 1 });

export const commitmentProtectionPersistenceForScope = (
  transaction: ScopedTransaction,
  operationScope: Pick<OperationalScope, 'tenantId'>,
): CommitmentProtectionPersistence => {
  const requireCandidateTenant = (protection: CommitmentProtection) =>
    protection.ref.tenantId === operationScope.tenantId
      ? Effect.void
      : Effect.fail(rejected(protection.authorityEvidence.effectId, 'TENANT_SCOPE_MISMATCH'));

  const decodeRow = (row: ProtectionRow) =>
    Schema.decodeEffect(ReservationAuthorityEffectIdSchema)(row.authorityEffectId).pipe(
      Effect.mapError((cause) => unavailable(persistenceReadEffectId, cause)),
      Effect.flatMap((effectId) => decodeSnapshot(effectId, row.snapshot)),
    );

  const appendHistory = (protection: CommitmentProtection) =>
    transaction
      .insert(inventoryCommitmentProtectionHistory)
      .values({
        healthState: protection.health.state,
        protectionId: protection.ref.resourceId,
        revision: protection.revision,
        snapshot: protection,
        tenantId: protection.ref.tenantId,
        transitionedAt: instantAsDate(protection.health.observation.effectiveAt),
      })
      .pipe(
        Effect.mapError((cause) => mapCommitmentProtectionWriteError(protection.authorityEvidence.effectId, cause)),
        Effect.asVoid,
      );

  const findByRef: CommitmentProtectionPersistence['findByRef'] = Effect.fn(
    'CommitmentProtectionPersistence.findByRef',
  )(function* findProtection(ref) {
    if (ref.tenantId !== operationScope.tenantId) {
      return yield* unavailable(persistenceReadEffectId);
    }
    const [row] = yield* transaction
      .select()
      .from(inventoryCommitmentProtections)
      .where(
        and(
          eq(inventoryCommitmentProtections.tenantId, operationScope.tenantId),
          eq(inventoryCommitmentProtections.protectionId, ref.resourceId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError((cause) => unavailable(persistenceReadEffectId, cause)));
    return row === undefined ? Option.none<CommitmentProtection>() : Option.some(yield* decodeRow(row));
  });

  const findByReservationAttempt: CommitmentProtectionPersistence['findByReservationAttempt'] = Effect.fn(
    'CommitmentProtectionPersistence.findByReservationAttempt',
  )(function* findProtectionByReservationAttempt(reservationId, attemptId) {
    const [row] = yield* transaction
      .select()
      .from(inventoryCommitmentProtections)
      .where(
        and(
          eq(inventoryCommitmentProtections.tenantId, operationScope.tenantId),
          eq(inventoryCommitmentProtections.reservationId, reservationId),
          eq(inventoryCommitmentProtections.attemptId, attemptId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError((cause) => unavailable(persistenceReadEffectId, cause)));
    return row === undefined ? Option.none<CommitmentProtection>() : Option.some(yield* decodeRow(row));
  });

  const createOrRead: CommitmentProtectionPersistence['createOrRead'] = Effect.fn(
    'CommitmentProtectionPersistence.createOrRead',
  )(function* createOrReadProtection(candidate) {
    yield* requireCandidateTenant(candidate);
    const bindingRequirements = candidate.confirmation.reservation.requirements.map((requirement) => ({
      bindingId: requirement.bindingRef.resourceId,
      exactSelectionMeaning: requirement.exactSelectionMeaning,
      stockItemId: requirement.stockItem.stockItemRef.resourceId,
      tenantId: candidate.ref.tenantId,
    }));
    yield* lockBindingCorrectionScopes(transaction, bindingRequirements).pipe(
      Effect.mapError((cause) => unavailable(candidate.authorityEvidence.effectId, cause)),
    );
    const [existingBeforeInsert] = yield* transaction
      .select()
      .from(inventoryCommitmentProtections)
      .where(
        and(
          eq(inventoryCommitmentProtections.tenantId, operationScope.tenantId),
          or(
            eq(inventoryCommitmentProtections.protectionId, candidate.ref.resourceId),
            and(
              eq(inventoryCommitmentProtections.reservationId, candidate.confirmation.reservation.ref.resourceId),
              eq(inventoryCommitmentProtections.attemptId, candidate.confirmation.reservation.origin.attemptId),
            ),
            eq(inventoryCommitmentProtections.confirmationId, candidate.confirmation.ref.resourceId),
            eq(inventoryCommitmentProtections.authorityEffectId, candidate.authorityEvidence.effectId),
          ),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError((cause) => unavailable(candidate.authorityEvidence.effectId, cause)));
    if (existingBeforeInsert !== undefined) {
      if (
        existingBeforeInsert.reservationId === candidate.confirmation.reservation.ref.resourceId &&
        existingBeforeInsert.attemptId === candidate.confirmation.reservation.origin.attemptId &&
        existingBeforeInsert.protectionId !== candidate.ref.resourceId
      ) {
        return yield* rejected(candidate.authorityEvidence.effectId, 'SIBLING_PROTECTION_FORBIDDEN');
      }
      if (
        existingBeforeInsert.protectionId !== candidate.ref.resourceId ||
        existingBeforeInsert.confirmationId !== candidate.confirmation.ref.resourceId ||
        existingBeforeInsert.authorityEffectId !== candidate.authorityEvidence.effectId
      ) {
        return yield* rejected(candidate.authorityEvidence.effectId, 'PROTECTION_IDENTITY_CONFLICT');
      }
      return { outcome: 'EXISTING' as const, protection: yield* decodeRow(existingBeforeInsert) };
    }
    const bindingsRemainCurrent = yield* currentBindingRequirementsMatch(transaction, bindingRequirements).pipe(
      Effect.mapError((cause) => unavailable(candidate.authorityEvidence.effectId, cause)),
    );
    if (!bindingsRemainCurrent) {
      return yield* rejected(candidate.authorityEvidence.effectId, 'CONFIRMATION_SCOPE_MISMATCH');
    }
    const [inserted] = yield* transaction
      .insert(inventoryCommitmentProtections)
      .values(valuesFor(candidate))
      .onConflictDoNothing()
      .returning()
      .pipe(Effect.mapError((cause) => mapCommitmentProtectionWriteError(candidate.authorityEvidence.effectId, cause)));
    if (inserted !== undefined) {
      const persisted = yield* decodeRow(inserted);
      yield* appendHistory(persisted);
      return { outcome: 'INSERTED' as const, protection: persisted };
    }
    const [reservationAttemptProtection] = yield* transaction
      .select()
      .from(inventoryCommitmentProtections)
      .where(
        and(
          eq(inventoryCommitmentProtections.tenantId, operationScope.tenantId),
          eq(inventoryCommitmentProtections.reservationId, candidate.confirmation.reservation.ref.resourceId),
          eq(inventoryCommitmentProtections.attemptId, candidate.confirmation.reservation.origin.attemptId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError((cause) => unavailable(candidate.authorityEvidence.effectId, cause)));
    if (reservationAttemptProtection !== undefined) {
      if (reservationAttemptProtection.protectionId !== candidate.ref.resourceId) {
        return yield* rejected(candidate.authorityEvidence.effectId, 'SIBLING_PROTECTION_FORBIDDEN');
      }
      return { outcome: 'EXISTING' as const, protection: yield* decodeRow(reservationAttemptProtection) };
    }
    const [identityCollision] = yield* transaction
      .select()
      .from(inventoryCommitmentProtections)
      .where(
        and(
          eq(inventoryCommitmentProtections.tenantId, operationScope.tenantId),
          or(
            eq(inventoryCommitmentProtections.protectionId, candidate.ref.resourceId),
            eq(inventoryCommitmentProtections.confirmationId, candidate.confirmation.ref.resourceId),
            eq(inventoryCommitmentProtections.authorityEffectId, candidate.authorityEvidence.effectId),
          ),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError((cause) => unavailable(candidate.authorityEvidence.effectId, cause)));
    if (identityCollision === undefined) {
      return yield* unavailable(candidate.authorityEvidence.effectId);
    }
    return yield* rejected(candidate.authorityEvidence.effectId, 'PROTECTION_IDENTITY_CONFLICT');
  });

  const readHistory: CommitmentProtectionPersistence['readHistory'] = (ref) =>
    ref.tenantId === operationScope.tenantId
      ? transaction
          .select()
          .from(inventoryCommitmentProtectionHistory)
          .where(
            and(
              eq(inventoryCommitmentProtectionHistory.tenantId, operationScope.tenantId),
              eq(inventoryCommitmentProtectionHistory.protectionId, ref.resourceId),
            ),
          )
          .orderBy(asc(inventoryCommitmentProtectionHistory.revision))
          .pipe(
            Effect.mapError((cause) => unavailable(persistenceReadEffectId, cause)),
            Effect.flatMap((rows) => decodeCommitmentProtectionHistoryRows(persistenceReadEffectId, rows)),
          )
      : Effect.fail(unavailable(persistenceReadEffectId));

  const saveRevision: CommitmentProtectionPersistence['saveRevision'] = Effect.fn(
    'CommitmentProtectionPersistence.saveRevision',
  )(function* saveProtectionRevision({ current, next }) {
    yield* requireCandidateTenant(current);
    if (next.ref.tenantId !== operationScope.tenantId || !Schema.is(CommitmentProtectionSchema)(next)) {
      return yield* rejected(current.authorityEvidence.effectId, 'INVALID_PROTECTION');
    }
    const [row] = yield* transaction
      .update(inventoryCommitmentProtections)
      .set(valuesFor(next))
      .where(
        and(
          eq(inventoryCommitmentProtections.tenantId, operationScope.tenantId),
          eq(inventoryCommitmentProtections.protectionId, current.ref.resourceId),
          eq(inventoryCommitmentProtections.currentRevision, current.revision),
        ),
      )
      .returning()
      .pipe(Effect.mapError((cause) => mapCommitmentProtectionWriteError(current.authorityEvidence.effectId, cause)));
    if (row === undefined) {
      return yield* rejected(current.authorityEvidence.effectId, 'REVISION_CONFLICT');
    }
    const persisted = yield* decodeRow(row);
    yield* appendHistory(persisted);
    return persisted;
  });

  return Object.freeze({ createOrRead, findByRef, findByReservationAttempt, readHistory, saveRevision });
};
