/* oxlint-disable effect-native/no-dependency-parameters -- The owner factory binds durable ledger and authority ports once; expires: 2027-03-31. */
import type { Effect as EffectType, Option as OptionType } from 'effect';
import { DateTime, Effect, Match, Option, PartitionedSemaphore, Result, Schema } from 'effect';

import {
  AuthoritativeSuccessInventoryEffectRecoveryObservationSchema,
  IndeterminateInventoryEffectRecoveryObservationSchema,
  InventoryEffectRecoveryAuthorityObservationSchema,
  InventoryEffectRecoveryRejected,
  inventoryEffectRecoveryFenceFor,
} from '../../shared/domain/inventory-effect-recovery.ts';
import type {
  InventoryEffectRecoveryAuthorityObservation,
  InventoryEffectRecoveryRequest,
  InventoryEffectRecoveryResult,
} from '../../shared/domain/inventory-effect-recovery.ts';
import {
  inventoryEffectLedgerStateForResolution,
  sameInventoryEffectIntent,
} from './inventory-effect-ledger.service.ts';
import type {
  InventoryEffectLedgerError,
  InventoryEffectLedgerIntent,
  InventoryEffectLedgerRecord,
  InventoryEffectLedgerResolution,
} from '../../shared/domain/inventory-effect-ledger.ts';
import { CommitmentProtectionSchema } from '../../shared/domain/commitment-protection.ts';
import type { CommitmentProtectionPersistence } from '../../shared/domain/commitment-protection.ts';
import {
  EstablishedReservationCreateEffectSchema,
  ReservationCreateEffectSchema,
  ResolvedNoReservationCreateEffectSchema,
} from '../../shared/domain/inventory-reservation-create.ts';
import type { ReservationCreateEffect } from '../../shared/domain/inventory-reservation-create.ts';
import {
  NotReleasableReservationEffectSchema,
  ReleasedReservationEffectSchema,
  ReservationReleaseEffectSchema,
} from '../../shared/domain/inventory-reservation-release.ts';
import type { ReservationReleaseEffect } from '../../shared/domain/inventory-reservation-release.ts';
import type { InventoryEffectLedgerRejected } from '../../shared/domain/inventory-effect-ledger-rejected.ts';
import type { InventoryEffectLedgerUnavailable } from '../../shared/domain/inventory-effect-ledger-unavailable.ts';
import type { InventoryEffectRecoveryAuthority } from './inventory-effect-recovery-authority.ts';
import type { InventoryEffectLedgerService } from './inventory-effect-ledger.service.ts';
import type { ReservationCreateEffectPersistence } from './inventory-reservation-create.service.ts';
import type { ReservationReleaseEffectPersistence } from './inventory-reservation-release.service.ts';

export interface InventoryEffectRecoveryRecordReader {
  readonly read: (
    effectId: InventoryEffectRecoveryRequest['effectId'],
  ) => EffectType.Effect<OptionType.Option<InventoryEffectLedgerRecord>, InventoryEffectLedgerUnavailable>;
}

export interface InventoryEffectRecoveryOwnerPersistence {
  readonly apply: (
    original: InventoryEffectLedgerRecord,
    resolution: InventoryEffectLedgerResolution,
  ) => EffectType.Effect<void, InventoryEffectRecoveryRejected>;
}

export type InventoryEffectRecoveryError = InventoryEffectLedgerError | InventoryEffectRecoveryRejected;

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- The generated recovery Action receives this owner-local factory result directly; it has no independent runtime Context identity; expires: 2027-03-31.
export interface InventoryEffectRecoveryService {
  readonly recover: (
    request: InventoryEffectRecoveryRequest,
  ) => EffectType.Effect<InventoryEffectRecoveryResult, InventoryEffectRecoveryError>;
}

const rejected = (
  effectId: InventoryEffectRecoveryRequest['effectId'],
  reason: InventoryEffectRecoveryRejected['reason'],
) => new InventoryEffectRecoveryRejected({ code: 'inventory_effect_recovery_rejected', effectId, reason });

const ownerFailure = (
  effectId: InventoryEffectRecoveryRequest['effectId'],
  reason: InventoryEffectRecoveryRejected['reason'],
  cause?: unknown,
) => {
  const failure = rejected(effectId, reason);
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const canonicalCreateEffect = Schema.fromJsonString(ReservationCreateEffectSchema);
const canonicalReleaseEffect = Schema.fromJsonString(ReservationReleaseEffectSchema);
const canonicalProtection = Schema.fromJsonString(CommitmentProtectionSchema);
const instantMillis = (value: string): number => DateTime.toEpochMillis(DateTime.makeUnsafe(value));
const occursBefore = (earlier: string, later: string): boolean => instantMillis(earlier) < instantMillis(later);
const sameEncoded = <Value>(schema: Schema.Codec<Value, string>, left: Value, right: Value) =>
  Result.getOrThrow(Schema.encodeResult(schema)(left)) === Result.getOrThrow(Schema.encodeResult(schema)(right));

const requireOwnerEffect = <Value>(
  effectId: InventoryEffectRecoveryRequest['effectId'],
  current: OptionType.Option<Value>,
) =>
  Effect.fromOption(current).pipe(Effect.mapError((cause) => ownerFailure(effectId, 'OWNER_EFFECT_NOT_FOUND', cause)));

const applyCreateResolution = Effect.fn('InventoryEffectRecovery.applyCreateResolution')(function* applyCreate(
  persistence: Pick<ReservationCreateEffectPersistence, 'read' | 'save'>,
  recoveryEffectId: InventoryEffectRecoveryRequest['effectId'],
  effect: Exclude<ReservationCreateEffect, { readonly _tag: 'REQUESTED' }>,
) {
  const current = yield* persistence.read(effect.request.effectId).pipe(
    Effect.mapError((cause) => ownerFailure(recoveryEffectId, 'OWNER_PERSISTENCE_UNAVAILABLE', cause)),
    Effect.flatMap((stored) => requireOwnerEffect(recoveryEffectId, stored)),
  );
  if (Schema.is(ReservationCreateEffectSchema)(current) && sameEncoded(canonicalCreateEffect, current, effect)) {
    return yield* Effect.void;
  }
  if (
    Schema.is(EstablishedReservationCreateEffectSchema)(current) ||
    Schema.is(ResolvedNoReservationCreateEffectSchema)(current)
  ) {
    return yield* ownerFailure(recoveryEffectId, 'OWNER_STATE_CONFLICT');
  }
  const saved = yield* persistence
    .save(current, effect)
    .pipe(Effect.mapError((cause) => ownerFailure(recoveryEffectId, 'OWNER_PERSISTENCE_UNAVAILABLE', cause)));
  if (!sameEncoded(canonicalCreateEffect, saved, effect)) {
    return yield* ownerFailure(recoveryEffectId, 'OWNER_STATE_CONFLICT');
  }
  return yield* Effect.void;
});

const applyReleaseResolution = Effect.fn('InventoryEffectRecovery.applyReleaseResolution')(function* applyRelease(
  persistence: Pick<ReservationReleaseEffectPersistence, 'read' | 'save'>,
  recoveryEffectId: InventoryEffectRecoveryRequest['effectId'],
  effect: Exclude<ReservationReleaseEffect, { readonly _tag: 'REQUESTED' | 'INDETERMINATE' }>,
) {
  const current = yield* persistence.read(effect.request.effectId).pipe(
    Effect.mapError((cause) => ownerFailure(recoveryEffectId, 'OWNER_PERSISTENCE_UNAVAILABLE', cause)),
    Effect.flatMap((stored) => requireOwnerEffect(recoveryEffectId, stored)),
  );
  if (sameEncoded(canonicalReleaseEffect, current, effect)) {
    return yield* Effect.void;
  }
  if (Schema.is(ReleasedReservationEffectSchema)(current) || Schema.is(NotReleasableReservationEffectSchema)(current)) {
    return yield* ownerFailure(recoveryEffectId, 'OWNER_STATE_CONFLICT');
  }
  const saved = yield* persistence
    .save(current, effect)
    .pipe(Effect.mapError((cause) => ownerFailure(recoveryEffectId, 'OWNER_PERSISTENCE_UNAVAILABLE', cause)));
  if (!sameEncoded(canonicalReleaseEffect, saved, effect)) {
    return yield* ownerFailure(recoveryEffectId, 'OWNER_STATE_CONFLICT');
  }
  return yield* Effect.void;
});

const applyProtectionResolution = Effect.fn('InventoryEffectRecovery.applyProtectionResolution')(
  function* applyProtection(
    persistence: Pick<CommitmentProtectionPersistence, 'createOrRead'>,
    recoveryEffectId: InventoryEffectRecoveryRequest['effectId'],
    protection: typeof CommitmentProtectionSchema.Type,
  ) {
    const stored = yield* persistence
      .createOrRead(protection)
      .pipe(Effect.mapError((cause) => ownerFailure(recoveryEffectId, 'OWNER_PERSISTENCE_UNAVAILABLE', cause)));
    if (!sameEncoded(canonicalProtection, stored.protection, protection)) {
      return yield* ownerFailure(recoveryEffectId, 'OWNER_STATE_CONFLICT');
    }
    return yield* Effect.void;
  },
);

export const makeInventoryEffectRecoveryOwnerPersistence = (dependencies: {
  readonly creates: Pick<ReservationCreateEffectPersistence, 'read' | 'save'>;
  readonly protections: Pick<CommitmentProtectionPersistence, 'createOrRead'>;
  readonly releases: Pick<ReservationReleaseEffectPersistence, 'read' | 'save'>;
}): InventoryEffectRecoveryOwnerPersistence => ({
  apply: Effect.fn('InventoryEffectRecoveryOwnerPersistence.apply')(function* apply(original, resolution) {
    yield* Match.value(resolution).pipe(
      Match.tag('RESERVATION_CREATE', ({ effect }) =>
        Schema.is(EstablishedReservationCreateEffectSchema)(effect) ||
        Schema.is(ResolvedNoReservationCreateEffectSchema)(effect)
          ? applyCreateResolution(dependencies.creates, original.effectId, effect)
          : Effect.fail(ownerFailure(original.effectId, 'INVALID_AUTHORITY_OUTCOME')),
      ),
      Match.tag('RESERVATION_RELEASE', ({ effect }) =>
        Schema.is(ReleasedReservationEffectSchema)(effect) || Schema.is(NotReleasableReservationEffectSchema)(effect)
          ? applyReleaseResolution(dependencies.releases, original.effectId, effect)
          : Effect.fail(ownerFailure(original.effectId, 'INVALID_AUTHORITY_OUTCOME')),
      ),
      Match.tag('ESTABLISH_COMMITMENT_PROTECTION', ({ effect }) =>
        Match.value(effect).pipe(
          Match.tag('PROTECTED', ({ protection }) =>
            applyProtectionResolution(dependencies.protections, original.effectId, protection),
          ),
          Match.tag('NOT_PROTECTABLE', () => Effect.void),
          Match.exhaustive,
        ),
      ),
      Match.tag('PHYSICAL_RECEIPT', 'PHYSICAL_ISSUE', () => Effect.void),
      Match.exhaustive,
    );
  }),
});

const validateProtectionResolution = (
  effectId: InventoryEffectRecoveryRequest['effectId'],
  resolution: InventoryEffectLedgerResolution,
): EffectType.Effect<void, InventoryEffectRecoveryRejected> =>
  Match.value(resolution).pipe(
    Match.tag('ESTABLISH_COMMITMENT_PROTECTION', ({ effect }) =>
      Match.value(effect).pipe(
        Match.tag('NOT_PROTECTABLE', () => Effect.void),
        Match.tag('PROTECTED', ({ protection }) => {
          if (protection.establishedAt !== protection.authorityEvidence.evidence.validFrom) {
            return Effect.fail(rejected(effectId, 'PROTECTION_PROOF_TIME_MISMATCH'));
          }
          return occursBefore(protection.establishedAt, protection.confirmation.expiresAt)
            ? Effect.void
            : Effect.fail(rejected(effectId, 'PROTECTION_ESTABLISHED_AFTER_CONFIRMATION_EXPIRY'));
        }),
        Match.exhaustive,
      ),
    ),
    Match.orElse(() => Effect.void),
  );

const terminal = (record: InventoryEffectLedgerRecord): InventoryEffectRecoveryResult => ({
  _tag: 'ALREADY_TERMINAL',
  effectId: record.effectId,
  record,
});

const reconcileTerminalOwner = Effect.fn('InventoryEffectRecovery.reconcileTerminalOwner')(
  function* reconcileTerminalOwner(
    owners: InventoryEffectRecoveryOwnerPersistence,
    record: InventoryEffectLedgerRecord,
  ) {
    if (record.resolution === null) {
      return yield* rejected(record.effectId, 'INVALID_AUTHORITY_OUTCOME');
    }
    yield* validateProtectionResolution(record.effectId, record.resolution);
    yield* owners.apply(record, record.resolution);
    return terminal(record);
  },
);

const isTerminal = (record: InventoryEffectLedgerRecord) =>
  record.currentState === 'SUCCEEDED' || record.currentState === 'REJECTED';

const indeterminate = (
  request: InventoryEffectRecoveryRequest,
  learnedAt: string,
  reason: Extract<InventoryEffectRecoveryResult, { readonly _tag: 'INDETERMINATE' }>['reason'],
  record: InventoryEffectLedgerRecord | null,
  occurredAt?: string,
): InventoryEffectRecoveryResult => {
  const debt = {
    _tag: 'INDETERMINATE' as const,
    effectId: request.effectId,
    fence: inventoryEffectRecoveryFenceFor(request.expectedKind),
    kind: request.expectedKind,
    learnedAt,
    possibleEffectOccurred: true as const,
    reason,
    reconciliationRequired: true as const,
    tenantId: request.tenantId,
  };
  if (record === null) {
    return occurredAt === undefined ? debt : { ...debt, occurredAt };
  }
  return occurredAt === undefined ? { ...debt, record } : { ...debt, occurredAt, record };
};

const kindForIntent = (intent: InventoryEffectLedgerIntent) =>
  Match.value(intent).pipe(
    Match.tag('RESERVATION_CREATE', () => 'RESERVATION_CREATE' as const),
    Match.tag('RESERVATION_RELEASE', () => 'RESERVATION_RELEASE' as const),
    Match.tag('ESTABLISH_COMMITMENT_PROTECTION', () => 'ESTABLISH_COMMITMENT_PROTECTION' as const),
    Match.tag('PHYSICAL_RECEIPT', () => 'PHYSICAL_RECEIPT' as const),
    Match.tag('PHYSICAL_ISSUE', () => 'PHYSICAL_ISSUE' as const),
    Match.exhaustive,
  );

const verifyAuthorityIdentity = (
  request: InventoryEffectRecoveryRequest,
  record: InventoryEffectLedgerRecord,
  observation: InventoryEffectRecoveryAuthorityObservation,
): EffectType.Effect<void, InventoryEffectRecoveryRejected> => {
  if (observation.effectId !== record.effectId) {
    return Effect.fail(rejected(request.effectId, 'AUTHORITY_IDENTITY_MISMATCH'));
  }
  if (observation.kind !== kindForIntent(record.intent)) {
    return Effect.fail(rejected(request.effectId, 'AUTHORITY_KIND_MISMATCH'));
  }
  return sameInventoryEffectIntent(observation.intent, record.intent)
    ? Effect.void
    : Effect.fail(rejected(request.effectId, 'AUTHORITY_INTENT_MISMATCH'));
};

const validateProtectionTiming = (
  request: InventoryEffectRecoveryRequest,
  observation: InventoryEffectRecoveryAuthorityObservation,
): EffectType.Effect<void, InventoryEffectRecoveryRejected> =>
  Schema.is(AuthoritativeSuccessInventoryEffectRecoveryObservationSchema)(observation)
    ? Match.value(observation.resolution).pipe(
        Match.tag('ESTABLISH_COMMITMENT_PROTECTION', ({ effect }) =>
          Match.value(effect).pipe(
            Match.tag('NOT_PROTECTABLE', () => Effect.fail(rejected(request.effectId, 'INVALID_AUTHORITY_OUTCOME'))),
            Match.tag('PROTECTED', ({ protection }) => {
              const proofAt = protection.authorityEvidence.evidence.validFrom;
              if (
                observation.occurredAt !== protection.establishedAt ||
                protection.establishedAt !== proofAt ||
                observation.ownerEvidenceRef !== protection.authorityEvidence.evidence.ownerEvidenceRef
              ) {
                return Effect.fail(rejected(request.effectId, 'PROTECTION_PROOF_TIME_MISMATCH'));
              }
              return occursBefore(protection.establishedAt, protection.confirmation.expiresAt)
                ? Effect.void
                : Effect.fail(rejected(request.effectId, 'PROTECTION_ESTABLISHED_AFTER_CONFIRMATION_EXPIRY'));
            }),
            Match.exhaustive,
          ),
        ),
        Match.orElse(() => Effect.void),
      )
    : Effect.void;

const validateOriginal = (
  request: InventoryEffectRecoveryRequest,
  record: InventoryEffectLedgerRecord,
): EffectType.Effect<void, InventoryEffectRecoveryRejected> => {
  if (record.tenantId !== request.tenantId) {
    return Effect.fail(rejected(request.effectId, 'TENANT_SCOPE_MISMATCH'));
  }
  if (kindForIntent(record.intent) !== request.expectedKind) {
    return Effect.fail(rejected(request.effectId, 'EFFECT_KIND_MISMATCH'));
  }
  return Effect.void;
};

const resultForTerminalObservation = (
  observation: Exclude<InventoryEffectRecoveryAuthorityObservation, { readonly _tag: 'INDETERMINATE' }>,
  record: InventoryEffectLedgerRecord,
): InventoryEffectRecoveryResult =>
  Match.value(observation).pipe(
    Match.tag('AUTHORITATIVE_SUCCESS', ({ learnedAt, occurredAt, ownerEvidenceRef }) => ({
      _tag: 'RECOVERED' as const,
      effectId: record.effectId,
      learnedAt,
      occurredAt,
      ownerEvidenceRef,
      record,
    })),
    Match.tag('DEFINITIVE_NON_EFFECT', ({ learnedAt, ownerEvidenceRef, provenAt }) => ({
      _tag: 'DEFINITIVE_NON_EFFECT' as const,
      effectId: record.effectId,
      learnedAt,
      ownerEvidenceRef,
      provenAt,
      record,
    })),
    Match.exhaustive,
  );

const resolveRevisionConflict = (
  records: InventoryEffectRecoveryRecordReader,
  effectId: InventoryEffectRecoveryRequest['effectId'],
  failure: InventoryEffectLedgerRejected,
) =>
  records.read(effectId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(failure),
        onSome: (latest) => (isTerminal(latest) ? Effect.succeed(latest) : Effect.fail(failure)),
      }),
    ),
  );

export const makeInventoryEffectRecoveryService = Effect.fn('InventoryEffectRecoveryService.make')(
  function* makeInventoryEffectRecoveryService(dependencies: {
    readonly authority: InventoryEffectRecoveryAuthority;
    readonly ledger: InventoryEffectLedgerService;
    readonly owners: InventoryEffectRecoveryOwnerPersistence;
    readonly records: InventoryEffectRecoveryRecordReader;
  }) {
    // Collapse only the same owner identity; unrelated recoveries remain parallel.
    // Durable ledger CAS remains the cross-process authority.
    const recoveryPermits = yield* PartitionedSemaphore.make<string>({ permits: 1 });

    const recoverOne = Effect.fn('InventoryEffectRecovery.recoverOne')(function* recoverOne(
      request: InventoryEffectRecoveryRequest,
    ) {
      const read = yield* dependencies.records.read(request.effectId).pipe(Effect.result);
      if (Result.isFailure(read)) {
        return indeterminate(request, DateTime.formatIso(yield* DateTime.now), 'OWNER_UNAVAILABLE', null);
      }
      if (Option.isNone(read.success)) {
        return indeterminate(request, DateTime.formatIso(yield* DateTime.now), 'TEMPORARY_NOT_FOUND', null);
      }
      const original = read.success.value;
      yield* validateOriginal(request, original);
      if (isTerminal(original)) {
        return yield* reconcileTerminalOwner(dependencies.owners, original);
      }
      const recovered = yield* dependencies.ledger.recover(request.tenantId, request.effectId, original.intent);
      if (isTerminal(recovered.record)) {
        return yield* reconcileTerminalOwner(dependencies.owners, recovered.record);
      }
      const observation = yield* dependencies.authority.recoverOriginal(recovered.record).pipe(
        Effect.flatMap(Schema.decodeEffect(InventoryEffectRecoveryAuthorityObservationSchema)),
        Effect.mapError((cause) => Object.assign(rejected(request.effectId, 'INVALID_AUTHORITY_OUTCOME'), { cause })),
      );
      yield* verifyAuthorityIdentity(request, recovered.record, observation);
      yield* validateProtectionTiming(request, observation);

      if (Schema.is(IndeterminateInventoryEffectRecoveryObservationSchema)(observation)) {
        const current =
          recovered.record.currentState === 'INDETERMINATE'
            ? recovered.record
            : yield* dependencies.ledger.transition(recovered.record, {
                currentState: 'INDETERMINATE',
                resolution: null,
              });
        return indeterminate(request, observation.learnedAt, observation.reason, current, observation.occurredAt);
      }

      const expectedState = Schema.is(AuthoritativeSuccessInventoryEffectRecoveryObservationSchema)(observation)
        ? ('SUCCEEDED' as const)
        : ('REJECTED' as const);
      if (inventoryEffectLedgerStateForResolution(observation.resolution) !== expectedState) {
        return yield* rejected(request.effectId, 'INVALID_AUTHORITY_OUTCOME');
      }
      yield* dependencies.owners.apply(recovered.record, observation.resolution);
      const next = yield* dependencies.ledger
        .transition(recovered.record, { currentState: expectedState, resolution: observation.resolution })
        .pipe(
          Effect.catchTag('InventoryEffectLedgerRejected', (failure) =>
            failure.reason === 'REVISION_CONFLICT'
              ? resolveRevisionConflict(dependencies.records, request.effectId, failure)
              : Effect.fail(failure),
          ),
        );
      return next.currentState === expectedState ? resultForTerminalObservation(observation, next) : terminal(next);
    });

    return Object.freeze({
      recover: (request: InventoryEffectRecoveryRequest) =>
        recoveryPermits.withPermit(`${request.tenantId}:${request.effectId}`)(recoverOne(request)),
    }) satisfies InventoryEffectRecoveryService;
  },
);
