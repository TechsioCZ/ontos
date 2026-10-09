import type { Effect as EffectType, Option as OptionType } from 'effect';
import { Context, DateTime, Effect, Layer, Match, Option, Schema } from 'effect';

import type { InventoryObligation, ProvisionalInventoryReservation } from '../../shared/domain/inventory-obligation.ts';
import { InventoryEffectLedgerConflict } from '../../shared/domain/inventory-effect-ledger.ts';
import {
  InventoryReservationReleaseRejected,
  InventoryReservationReleaseUnavailable,
  NotReleasableReservationEffectSchema,
  ReservationCommittedBackendObservationSchema,
  ReservationIndeterminateBackendObservationSchema,
  ReservationReleaseCommittedTruthSchema,
  ReservationReleaseNotCommittedOpenTruthSchema,
  ReservationReleaseOrderIndeterminateTruthSchema,
  ReservationReleaseProtectionEstablishedTruthSchema,
  ReservationReleaseProtectionIndeterminateTruthSchema,
  ReleasedReservationEffectSchema,
  WholeReservationReleaseScopeSchema,
} from '../../shared/domain/inventory-reservation-release.ts';
import type {
  InventoryReservationReleaseError,
  ReleaseInventoryReservationPayload,
  ReleaseInventoryReservationResult,
  ReservationReleaseBackendObservation,
  ReservationReleaseEffect,
  ReservationReleaseExactScopeSchema,
  ReservationReleaseMutationIdSchema,
  ReservationReleaseOrderTruth as ReservationReleaseOrderTruthValue,
  ReservationReleaseProtectionTruth as ReservationReleaseProtectionTruthValue,
  ReservationReleaseRequest,
} from '../../shared/domain/inventory-reservation-release.ts';
import type { InventoryReservationRef } from '../../shared/resources/inventory-reservation.ts';
import type { InventoryEffectLedgerService } from './inventory-effect-ledger.service.ts';
import {
  inventoryEffectLedgerId,
  reservationReleaseLedgerIntent,
  reservationReleaseLedgerResolution,
  synchronizeInventoryEffectLedger,
} from './inventory-effect-ledger.service.ts';

export interface ReservationReleaseEffectPersistence {
  readonly createOrRead: (
    candidate: ReservationReleaseEffect,
  ) => EffectType.Effect<
    { readonly effect: ReservationReleaseEffect; readonly outcome: 'INSERTED' | 'EXISTING' },
    InventoryReservationReleaseError
  >;
  readonly findByReservation: (
    ref: InventoryReservationRef,
  ) => EffectType.Effect<OptionType.Option<ReservationReleaseEffect>, InventoryReservationReleaseError>;
  readonly read: (
    effectId: ReservationReleaseRequest['effectId'],
  ) => EffectType.Effect<OptionType.Option<ReservationReleaseEffect>, InventoryReservationReleaseError>;
  readonly save: (
    expected: ReservationReleaseEffect,
    next: Exclude<ReservationReleaseEffect, { readonly _tag: 'REQUESTED' }>,
  ) => EffectType.Effect<ReservationReleaseEffect, InventoryReservationReleaseError>;
}

export interface ReservationReleaseObligationReader {
  readonly read: (
    ref: InventoryReservationRef,
  ) => EffectType.Effect<OptionType.Option<InventoryObligation>, InventoryReservationReleaseError>;
}

export interface ReservationReleaseOrderTruthPort {
  readonly read: (
    reservation: ProvisionalInventoryReservation,
  ) => EffectType.Effect<ReservationReleaseOrderTruthValue, InventoryReservationReleaseError>;
}

export interface ReservationReleaseProtectionTruthPort {
  readonly read: (
    reservation: ProvisionalInventoryReservation,
  ) => EffectType.Effect<ReservationReleaseProtectionTruthValue, InventoryReservationReleaseError>;
}

export interface InventoryReservationReleaseBackend {
  /** The adapter must use request.effectId as the immutable backend idempotency identity. */
  readonly release: (
    request: ReservationReleaseRequest,
  ) => EffectType.Effect<ReservationReleaseBackendObservation, InventoryReservationReleaseError>;
}

const unavailableBackend: InventoryReservationReleaseBackend = {
  release: (request) =>
    DateTime.now.pipe(
      Effect.map((observedAt) => ({
        _tag: 'INDETERMINATE' as const,
        effectId: request.effectId,
        observedAt: DateTime.formatIso(observedAt),
        reason: 'AUTHORITY_OUTCOME_UNKNOWN' as const,
      })),
    ),
};

export const InventoryReservationReleaseBackendPort = Context.Reference<InventoryReservationReleaseBackend>(
  '@app/inventory/services/inventory-reservation-release.service/InventoryReservationReleaseBackendPort',
  { defaultValue: () => unavailableBackend },
);
export const InventoryReservationReleaseBackendUnavailableLive = Layer.succeed(
  InventoryReservationReleaseBackendPort,
  unavailableBackend,
);

const unavailableOrderTruth: ReservationReleaseOrderTruthPort = {
  read: () =>
    DateTime.now.pipe(
      Effect.map((observedAt) => ({
        _tag: 'INDETERMINATE' as const,
        observedAt: DateTime.formatIso(observedAt),
        reason: 'ORDER_EVIDENCE_UNAVAILABLE' as const,
      })),
    ),
};
export const ReservationReleaseOrderTruth = Context.Reference<ReservationReleaseOrderTruthPort>(
  '@app/inventory/services/inventory-reservation-release.service/ReservationReleaseOrderTruth',
  { defaultValue: () => unavailableOrderTruth },
);

const unavailableProtectionTruth: ReservationReleaseProtectionTruthPort = {
  read: () =>
    DateTime.now.pipe(
      Effect.map((observedAt) => ({
        _tag: 'INDETERMINATE' as const,
        observedAt: DateTime.formatIso(observedAt),
        reason: 'PROTECTION_EVIDENCE_UNAVAILABLE' as const,
      })),
    ),
};
export const ReservationReleaseProtectionTruth = Context.Reference<ReservationReleaseProtectionTruthPort>(
  '@app/inventory/services/inventory-reservation-release.service/ReservationReleaseProtectionTruth',
  { defaultValue: () => unavailableProtectionTruth },
);

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- Generated Actions receive this transaction-scoped factory result directly; the worker owns its separate execution Context identity; expires: 2027-03-31.
export interface InventoryReservationReleaseService {
  readonly request: (
    payload: ReleaseInventoryReservationPayload,
    context: {
      readonly actionInvocationId: ReservationReleaseRequest['sourceActionInvocationId'];
      readonly legalEntityId: ReservationReleaseRequest['legalEntityId'];
      readonly requestedAt: string;
      readonly tenantId: string;
    },
  ) => EffectType.Effect<InventoryReservationReleaseDecision, InventoryReservationReleaseError>;
}

interface InventoryReservationReleaseDecision {
  readonly dispatchRequested: boolean;
  readonly result: ReleaseInventoryReservationResult;
}

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- The generated worker owns the matching Context.Service tag; expires: 2027-03-31.
export interface InventoryReservationReleaseExecutionService {
  readonly execute: (
    scope: { readonly legalEntityId: string; readonly tenantId: string },
    request: ReservationReleaseRequest,
  ) => EffectType.Effect<void, InventoryReservationReleaseError>;
}

const rejected = (
  effectId: ReservationReleaseRequest['effectId'] | undefined,
  reason: InventoryReservationReleaseRejected['reason'],
) =>
  effectId === undefined
    ? new InventoryReservationReleaseRejected({ code: 'inventory_reservation_release_rejected', reason })
    : new InventoryReservationReleaseRejected({ code: 'inventory_reservation_release_rejected', effectId, reason });

export const reservationReleaseUnavailable = (
  effectId: ReservationReleaseRequest['effectId'] | undefined,
  reason: string,
  cause?: unknown,
) => {
  const failure =
    effectId === undefined
      ? new InventoryReservationReleaseUnavailable({
          code: 'inventory_reservation_release_unavailable',
          reason,
          retryable: true,
        })
      : new InventoryReservationReleaseUnavailable({
          code: 'inventory_reservation_release_unavailable',
          effectId,
          reason,
          retryable: true,
        });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const mapLedgerError = (effectId: ReservationReleaseRequest['effectId'], cause: unknown) =>
  Schema.is(InventoryEffectLedgerConflict)(cause)
    ? rejected(effectId, 'EFFECT_ID_CONFLICT')
    : reservationReleaseUnavailable(effectId, 'Inventory effect ledger is unavailable', cause);

const sameRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const sameRequestIntent = (
  request: ReservationReleaseRequest,
  payload: ReleaseInventoryReservationPayload,
  context: { readonly legalEntityId: string; readonly tenantId: string },
) =>
  request.effectId === payload.releaseEffectId &&
  request.legalEntityId === context.legalEntityId &&
  request.reservation.origin.attemptId === payload.attemptId &&
  sameRef(request.reservation.ref, payload.reservationRef) &&
  request.reservation.ref.tenantId === context.tenantId;

const resultFor = (effect: ReservationReleaseEffect, replay = false): ReleaseInventoryReservationResult =>
  Match.value(effect).pipe(
    Match.tag('REQUESTED', (requested) => ({ effect: requested, outcome: 'PENDING' as const })),
    Match.tag('RELEASED', (released) => ({
      effect: released,
      outcome:
        replay || released.releaseOutcome === 'ALREADY_RELEASED'
          ? ('ALREADY_RELEASED' as const)
          : ('RELEASED' as const),
    })),
    Match.tag('NOT_RELEASABLE', (notReleasable) => ({ effect: notReleasable, outcome: 'NOT_RELEASABLE' as const })),
    Match.tag('INDETERMINATE', (indeterminate) => ({ effect: indeterminate, outcome: 'INDETERMINATE' as const })),
    Match.exhaustive,
  );

const exactScope = (reservation: ProvisionalInventoryReservation) => ({
  allocations: reservation.requirements.flatMap(({ allocations }) =>
    allocations.map(({ allocationId, positionRef, quantity, stockItemRef }) => ({
      allocationId,
      quantity,
      stockItemRef,
      stockPositionRef: positionRef,
    })),
  ),
  attemptId: reservation.origin.attemptId,
  reservationId: reservation.ref.resourceId,
  tenantId: reservation.ref.tenantId,
});

interface ComparableReleaseAllocation {
  readonly allocationId: string;
  readonly quantity: { readonly amount: string; readonly unitRef: Parameters<typeof sameRef>[0] };
  readonly stockItemRef: Parameters<typeof sameRef>[0];
  readonly stockPositionRef: Parameters<typeof sameRef>[0];
}

const sameAllocation = (left: ComparableReleaseAllocation, right: ComparableReleaseAllocation) =>
  left.allocationId === right.allocationId &&
  left.quantity.amount === right.quantity.amount &&
  sameRef(left.quantity.unitRef, right.quantity.unitRef) &&
  sameRef(left.stockItemRef, right.stockItemRef) &&
  sameRef(left.stockPositionRef, right.stockPositionRef);

const sameExactScope = (
  reservation: ProvisionalInventoryReservation,
  actual: typeof ReservationReleaseExactScopeSchema.Type,
) => {
  const expected = exactScope(reservation);
  return (
    expected.attemptId === actual.attemptId &&
    expected.reservationId === actual.reservationId &&
    expected.tenantId === actual.tenantId &&
    expected.allocations.length === actual.allocations.length &&
    expected.allocations.every((allocation) =>
      actual.allocations.some((candidate) => sameAllocation(allocation, candidate)),
    )
  );
};

const issuerMatchesOriginalAuthority = (
  reservation: ProvisionalInventoryReservation,
  issuer: { readonly backend: string; readonly backendId: string; readonly origin: string },
) =>
  issuer.backend === reservation.authority.selection.backend &&
  issuer.backendId === reservation.authority.selection.backendId &&
  issuer.origin ===
    (reservation.authority.selection.backend === 'external_business_system' ? 'EXTERNAL_BUSINESS_SYSTEM' : 'ONTOS_WMS');

// oxlint-disable-next-line effect-native/no-dependency-parameters -- The generated Action factory binds the transaction-scoped owner persistence and ledger ports; expires: 2027-03-31.
export const makeInventoryReservationReleaseService = (dependencies: {
  readonly effects: ReservationReleaseEffectPersistence;
  readonly ledger: InventoryEffectLedgerService;
  readonly makeMutationId: () => typeof ReservationReleaseMutationIdSchema.Type;
  readonly obligations: ReservationReleaseObligationReader;
}): InventoryReservationReleaseService => ({
  request: Effect.fn('InventoryReservationReleaseService.request')(function* requestRelease(payload, context) {
    if (!Schema.is(WholeReservationReleaseScopeSchema)(payload.scope)) {
      return yield* rejected(payload.releaseEffectId, 'PARTIAL_RELEASE_UNSUPPORTED');
    }
    if (payload.reservationRef.tenantId !== context.tenantId) {
      return yield* rejected(payload.releaseEffectId, 'TENANT_SCOPE_MISMATCH');
    }

    const byEffect = yield* dependencies.effects.read(payload.releaseEffectId);
    if (Option.isSome(byEffect)) {
      if (!sameRequestIntent(byEffect.value.request, payload, context)) {
        return yield* rejected(payload.releaseEffectId, 'EFFECT_ID_CONFLICT');
      }
      yield* dependencies.ledger
        .claim(
          context.tenantId,
          inventoryEffectLedgerId(payload.releaseEffectId),
          reservationReleaseLedgerIntent(byEffect.value),
        )
        .pipe(Effect.mapError((cause) => mapLedgerError(payload.releaseEffectId, cause)));
      return { dispatchRequested: false, result: resultFor(byEffect.value, true) };
    }
    const byReservation = yield* dependencies.effects.findByReservation(payload.reservationRef);
    if (Option.isSome(byReservation)) {
      return yield* rejected(payload.releaseEffectId, 'SIBLING_RELEASE_EFFECT_FORBIDDEN');
    }

    const obligation = yield* dependencies.obligations.read(payload.reservationRef).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(rejected(payload.releaseEffectId, 'RESERVATION_NOT_FOUND')),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (obligation.lifecycleMeaning !== 'PROVISIONAL_RESERVATION') {
      return yield* rejected(payload.releaseEffectId, 'RESERVATION_NOT_PROVISIONAL');
    }
    if (obligation.origin.attemptId !== payload.attemptId) {
      return yield* rejected(payload.releaseEffectId, 'ATTEMPT_SCOPE_MISMATCH');
    }
    const request: ReservationReleaseRequest = {
      effectId: payload.releaseEffectId,
      legalEntityId: context.legalEntityId,
      mutationId: dependencies.makeMutationId(),
      requestedAt: context.requestedAt,
      reservation: obligation,
      sourceActionInvocationId: context.actionInvocationId,
    };
    yield* dependencies.ledger
      .claim(
        context.tenantId,
        inventoryEffectLedgerId(request.effectId),
        reservationReleaseLedgerIntent({ _tag: 'REQUESTED', request, revision: 1 }),
      )
      .pipe(Effect.mapError((cause) => mapLedgerError(request.effectId, cause)));
    const persisted = yield* dependencies.effects.createOrRead({ _tag: 'REQUESTED', request, revision: 1 });
    if (!sameRequestIntent(persisted.effect.request, payload, context)) {
      return yield* rejected(payload.releaseEffectId, 'EFFECT_ID_CONFLICT');
    }
    return {
      dispatchRequested: persisted.outcome === 'INSERTED',
      result: resultFor(persisted.effect, persisted.outcome === 'EXISTING'),
    };
  }),
});

type ReleaseTerminalEffect = Exclude<ReservationReleaseEffect, { readonly _tag: 'REQUESTED' }>;
type ReleaseTerminalWithoutRevision<T> = T extends ReleaseTerminalEffect ? Omit<T, 'revision'> : never;

const advance = Effect.fn('InventoryReservationReleaseExecution.advance')(function* advance(
  // oxlint-disable-next-line effect-native/no-dependency-parameters -- The worker owner binds both durable state ports for one CAS transition; expires: 2027-03-31.
  dependencies: {
    readonly effects: ReservationReleaseEffectPersistence;
    readonly ledger: InventoryEffectLedgerService;
  },
  ledgerRecord: Parameters<InventoryEffectLedgerService['transition']>[0],
  current: ReservationReleaseEffect,
  next: ReleaseTerminalWithoutRevision<ReleaseTerminalEffect>,
) {
  const saved = yield* dependencies.effects.save(current, { ...next, revision: current.revision + 1 });
  yield* synchronizeInventoryEffectLedger(
    dependencies.ledger,
    ledgerRecord,
    reservationReleaseLedgerResolution(saved),
  ).pipe(Effect.mapError((cause) => mapLedgerError(current.request.effectId, cause)));
  return saved;
});

// oxlint-disable-next-line effect-native/no-dependency-parameters -- The worker composition binds the selected backend and owner-local durable ports; expires: 2027-03-31.
export const makeInventoryReservationReleaseExecutionService = (dependencies: {
  readonly backend: InventoryReservationReleaseBackend;
  readonly effects: ReservationReleaseEffectPersistence;
  readonly ledger: InventoryEffectLedgerService;
  readonly orderTruth: ReservationReleaseOrderTruthPort;
  readonly protectionTruth: ReservationReleaseProtectionTruthPort;
}): InventoryReservationReleaseExecutionService => ({
  execute: Effect.fn('InventoryReservationReleaseExecution.execute')(function* execute(scope, request) {
    if (request.reservation.ref.tenantId !== scope.tenantId || request.legalEntityId !== scope.legalEntityId) {
      return yield* rejected(request.effectId, 'TENANT_SCOPE_MISMATCH');
    }
    const current = yield* dependencies.effects.read(request.effectId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(reservationReleaseUnavailable(request.effectId, 'Durable Release intent was not found')),
          onSome: Effect.succeed,
        }),
      ),
    );
    const authoritativeRequest = current.request;
    if (
      authoritativeRequest.legalEntityId !== scope.legalEntityId ||
      authoritativeRequest.reservation.ref.tenantId !== scope.tenantId ||
      authoritativeRequest.mutationId !== request.mutationId ||
      authoritativeRequest.sourceActionInvocationId !== request.sourceActionInvocationId ||
      !sameRef(authoritativeRequest.reservation.ref, request.reservation.ref)
    ) {
      return yield* rejected(request.effectId, 'EFFECT_ID_CONFLICT');
    }
    const ledgerRecord = yield* dependencies.ledger
      .recover(scope.tenantId, inventoryEffectLedgerId(request.effectId), reservationReleaseLedgerIntent(current))
      .pipe(Effect.mapError((cause) => mapLedgerError(request.effectId, cause)));
    if (
      Schema.is(ReleasedReservationEffectSchema)(current) ||
      Schema.is(NotReleasableReservationEffectSchema)(current)
    ) {
      yield* synchronizeInventoryEffectLedger(
        dependencies.ledger,
        ledgerRecord.record,
        reservationReleaseLedgerResolution(current),
      ).pipe(Effect.mapError((cause) => mapLedgerError(request.effectId, cause)));
      return yield* Effect.void;
    }

    const orderTruth = yield* dependencies.orderTruth.read(authoritativeRequest.reservation);
    if (Schema.is(ReservationReleaseCommittedTruthSchema)(orderTruth)) {
      yield* advance(dependencies, ledgerRecord.record, current, {
        _tag: 'NOT_RELEASABLE',
        evidenceRef: orderTruth.evidenceRef,
        observedAt: orderTruth.observedAt,
        reason: 'COMMITTED',
        request: authoritativeRequest,
        safelyReusable: false,
      });
      return yield* Effect.void;
    }
    if (
      Schema.is(ReservationReleaseOrderIndeterminateTruthSchema)(orderTruth) ||
      Schema.is(ReservationReleaseNotCommittedOpenTruthSchema)(orderTruth)
    ) {
      yield* advance(dependencies, ledgerRecord.record, current, {
        _tag: 'INDETERMINATE',
        observedAt: orderTruth.observedAt,
        reason: 'ORDER_OUTCOME_UNKNOWN',
        request: authoritativeRequest,
        safelyReusable: false,
      });
      return yield* Effect.void;
    }

    const protectionTruth = yield* dependencies.protectionTruth.read(authoritativeRequest.reservation);
    if (Schema.is(ReservationReleaseProtectionEstablishedTruthSchema)(protectionTruth)) {
      yield* advance(dependencies, ledgerRecord.record, current, {
        _tag: 'NOT_RELEASABLE',
        evidenceRef: protectionTruth.evidenceRef,
        observedAt: protectionTruth.observedAt,
        reason: 'PROTECTION_ESTABLISHED',
        request: authoritativeRequest,
        safelyReusable: false,
      });
      return yield* Effect.void;
    }
    if (Schema.is(ReservationReleaseProtectionIndeterminateTruthSchema)(protectionTruth)) {
      yield* advance(dependencies, ledgerRecord.record, current, {
        _tag: 'INDETERMINATE',
        observedAt: protectionTruth.observedAt,
        reason: 'PROTECTION_OUTCOME_UNKNOWN',
        request: authoritativeRequest,
        safelyReusable: false,
      });
      return yield* Effect.void;
    }

    const observation = yield* dependencies.backend.release(authoritativeRequest);
    if (observation.effectId !== authoritativeRequest.effectId) {
      return yield* rejected(authoritativeRequest.effectId, 'INVALID_BACKEND_OBSERVATION');
    }
    if (Schema.is(ReservationIndeterminateBackendObservationSchema)(observation)) {
      yield* advance(dependencies, ledgerRecord.record, current, {
        _tag: 'INDETERMINATE',
        observedAt: observation.observedAt,
        reason: 'AUTHORITY_OUTCOME_UNKNOWN',
        request: authoritativeRequest,
        safelyReusable: false,
      });
      return yield* Effect.void;
    }
    if (Schema.is(ReservationCommittedBackendObservationSchema)(observation)) {
      yield* advance(dependencies, ledgerRecord.record, current, {
        _tag: 'NOT_RELEASABLE',
        evidenceRef: observation.evidenceRef,
        observedAt: observation.observedAt,
        reason: 'COMMITTED',
        request: authoritativeRequest,
        safelyReusable: false,
      });
      return yield* Effect.void;
    }
    if (
      !issuerMatchesOriginalAuthority(authoritativeRequest.reservation, observation.issuer) ||
      !sameExactScope(authoritativeRequest.reservation, observation.scope)
    ) {
      return yield* rejected(authoritativeRequest.effectId, 'INVALID_BACKEND_OBSERVATION');
    }
    yield* advance(dependencies, ledgerRecord.record, current, {
      _tag: 'RELEASED',
      activeAllocations: [],
      authorityIssuer: observation.issuer,
      ownerEvidenceRef: observation.ownerEvidenceRef,
      releasedAt: observation.releasedAt,
      releaseOutcome: observation._tag,
      request: authoritativeRequest,
      safelyReusable: true,
      safeReleaseProof: { order: orderTruth, protection: protectionTruth },
    });
    return yield* Effect.void;
  }),
});
