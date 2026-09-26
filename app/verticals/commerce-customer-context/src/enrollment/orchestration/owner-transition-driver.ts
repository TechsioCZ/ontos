import type {
  ActivatePrincipalBindingRequest,
  ExternalIdentityClientError,
  ExternalIdentityClientOptions,
  ExternalIdentityClientPort,
  ReadPrincipalBindingRequest,
  ReadPrincipalBindingResult,
  ReservePrincipalBindingRequest,
} from '@app/shared-contracts/server/external-identity-client';
import { DateTime, Effect, Option, Schema } from 'effect';

import type {
  ClaimEnrollmentTransitionInput,
  CommercePortalAccountSubject,
  EnrollmentAttemptSnapshot,
  EnrollmentOwnerOperationSnapshot,
  ReconcileEnrollmentRequest,
  ReconcileEnrollmentResolution,
  RecordEnrollmentOutcomeInput,
  ReadEnrollmentAttemptInput,
  ReadEnrollmentOwnerOperationInput,
} from '../../../shared/enrollment-contracts.ts';
import {
  ClaimEnrollmentTransitionInputSchema,
  CommercePortalAccountSubjectSchema,
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentBoundedTextSchema,
  EnrollmentDigestSchema,
  EnrollmentKeySchema,
  EnrollmentModuleKeySchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentResourceIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
  ReconcileEnrollmentResolutionSchema,
  RecordEnrollmentOutcomeInputSchema,
} from '../../../shared/enrollment-contracts.ts';
import type { AttemptClaimedResult, AttemptRecordResult } from '../attempts/attempt-persistence.ts';
import { claimedOrIndeterminate } from '../attempts/attempt-persistence.ts';
import type { CommerceEnrollmentAttemptService } from '../attempts/attempt-service.ts';
import {
  CommerceEnrollmentAttemptConflict,
  CommerceEnrollmentAttemptIndeterminate,
  CommerceEnrollmentAttemptRejected,
  CommerceEnrollmentAttemptUnavailable,
  withCause,
} from '../attempts/errors.ts';
import type { CommerceEnrollmentAttemptError } from '../attempts/errors.ts';
import {
  CommerceEnrollmentOwnerEffectRejected,
  CommerceEnrollmentOwnerEffectUnavailable,
} from './owner-transition-errors.ts';
import type {
  CommerceEnrollmentOwnerEffectError,
  CommerceEnrollmentOwnerEffectIndeterminate,
} from './owner-transition-errors.ts';
import { OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE } from '../journeys/retail-self-enrollment-contracts.ts';

type CommerceEnrollmentAttemptRejectedError = Extract<
  CommerceEnrollmentAttemptError,
  { readonly _tag: 'CommerceEnrollmentAttemptRejected' }
>;
type CommerceEnrollmentAttemptIndeterminateError = Extract<
  CommerceEnrollmentAttemptError,
  { readonly _tag: 'CommerceEnrollmentAttemptIndeterminate' }
>;
type CommerceEnrollmentAttemptConflictError = Extract<
  CommerceEnrollmentAttemptError,
  { readonly _tag: 'CommerceEnrollmentAttemptConflict' }
>;
type EnrollmentKey = typeof EnrollmentKeySchema.Type;
type EnrollmentResourceId = typeof EnrollmentResourceIdSchema.Type;

/**
 * Stable transition identity supplied by a trusted owner worker.  The driver deliberately has
 * no transaction or HTTP dependency: each Attempt method is a separate durable phase, and the
 * owner effect runs only after `claimTransition` has returned.
 */
export const CommerceEnrollmentOwnerTransitionSchema = Schema.Struct({
  actorPrincipalId: EnrollmentPrincipalIdSchema,
  correlationId: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
    Schema.brand('CommerceEnrollmentOwnerCorrelationId'),
  ),
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ownerInvocationId: EnrollmentActionInvocationIdSchema,
  ownerModuleKey: EnrollmentModuleKeySchema,
  portalEnrollmentAttemptId: EnrollmentAttemptIdSchema,
  requestDigest: EnrollmentDigestSchema,
  tenantId: EnrollmentTenantIdSchema,
  transitionKey: EnrollmentTransitionKeySchema,
});
export type CommerceEnrollmentOwnerTransition = typeof CommerceEnrollmentOwnerTransitionSchema.Type;

/**
 * Owner output is the only place where an account subject may enter Attempt reconciliation.  A
 * provider/Core adapter must obtain it from its own authoritative result; callers cannot add it
 * to the public claim or record payload.
 */
const ownerEffectOutcomeFields = {
  accountSubject: Schema.optionalKey(CommercePortalAccountSubjectSchema),
  failureCode: Schema.optionalKey(EnrollmentKeySchema),
  failureReason: Schema.optionalKey(EnrollmentBoundedTextSchema),
  /** An owner speaks only about its own transition; COMPLETE is derived, never signalled. */
  nextState: Schema.optionalKey(Schema.Literals(['IN_PROGRESS', 'VERIFICATION_REQUIRED', 'RECONCILIATION_REQUIRED'])),
  outcomeCode: Schema.optionalKey(EnrollmentKeySchema),
  resultDigest: Schema.optionalKey(EnrollmentDigestSchema),
  resultReference: Schema.optionalKey(EnrollmentResourceIdSchema),
};

interface CommerceEnrollmentOwnerEffectOutcomeFields {
  readonly accountSubject?: CommercePortalAccountSubject;
  readonly failureCode?: EnrollmentKey;
  readonly failureReason?: typeof EnrollmentBoundedTextSchema.Type;
  readonly nextState?: 'IN_PROGRESS' | 'VERIFICATION_REQUIRED' | 'RECONCILIATION_REQUIRED';
  readonly outcomeCode?: EnrollmentKey;
  readonly resultDigest?: typeof EnrollmentDigestSchema.Type;
  readonly resultReference?: EnrollmentResourceId;
}

type MutableRecordEnrollmentOutcomeInput = {
  -readonly [Key in keyof RecordEnrollmentOutcomeInput]?: RecordEnrollmentOutcomeInput[Key];
};

export const CommerceEnrollmentOwnerEffectOutcomeSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal('SUCCEEDED'), ...ownerEffectOutcomeFields }),
  Schema.Struct({ status: Schema.Literal('FAILED'), ...ownerEffectOutcomeFields }),
]);
export type CommerceEnrollmentOwnerEffectOutcome = typeof CommerceEnrollmentOwnerEffectOutcomeSchema.Type;

export interface CommerceEnrollmentOwnerReconciliationInput extends CommerceEnrollmentOwnerTransition {
  /** The revision observed after the durable fence was refreshed. */
  readonly observedRevision: number;
  /** The journal revision of the immutable owner operation. */
  readonly ownerOperationRevision: number;
  /** The persisted owner result reference, when the original dispatch recorded one. */
  readonly ownerResultReference?: EnrollmentResourceId;
}

export interface CommerceEnrollmentOwnerEffect {
  /** Runs one provider/Core effect after durable claim and outside the Attempt transaction. */
  readonly dispatch: (
    input: CommerceEnrollmentOwnerTransition,
  ) => Effect.Effect<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentOwnerEffectError>;
  /** Performs an authoritative owner read for the exact original invocation. */
  readonly reconcile: (
    input: CommerceEnrollmentOwnerReconciliationInput,
  ) => Effect.Effect<ReconcileEnrollmentResolution, CommerceEnrollmentOwnerEffectError>;
}

/**
 * This port is intentionally narrower than the full Attempt service.  A deployment can implement
 * it with a fresh Action transaction per method or with generated Action clients.  In either case
 * owner HTTP is never hidden inside a transaction callback.
 */
export interface CommerceEnrollmentOwnerAttemptStore {
  readonly claimTransition: CommerceEnrollmentAttemptService['claimTransition'];
  readonly read: CommerceEnrollmentAttemptService['read'];
  readonly readOwnerOperation: CommerceEnrollmentAttemptService['readOwnerOperation'];
  readonly reconcileOutcome: (
    input: ReconcileEnrollmentRequest,
    resolution: ReconcileEnrollmentResolution,
  ) => ReturnType<CommerceEnrollmentAttemptService['reconcileOutcome']>;
  readonly recordOutcome: CommerceEnrollmentAttemptService['recordOutcome'];
}

/**
 * Root composes this factory from its scoped transaction executor. `make` must build a new
 * Attempt service for every call, so claim, read, dispatch recovery and record never share an
 * Action-scoped transaction across owner HTTP. The optional resolution is used only by the
 * reconciliation phase authority.
 */
export interface CommerceEnrollmentOwnerAttemptFreshServiceFactory {
  readonly make: (
    resolution?: ReconcileEnrollmentResolution,
  ) => Effect.Effect<CommerceEnrollmentAttemptService, CommerceEnrollmentAttemptError>;
}

/** Build the production owner store from a fresh-service factory supplied by composition. */
export const commerceEnrollmentOwnerAttemptStoreForFreshService = (
  // oxlint-disable-next-line effect-native/no-dependency-parameters -- Root supplies a fresh transaction-backed service factory for every owner phase; expires: 2027-03-31.
  factory: CommerceEnrollmentOwnerAttemptFreshServiceFactory,
): CommerceEnrollmentOwnerAttemptStore => {
  const runWithFreshService = <Result>(
    // oxlint-disable-next-line effect-native/no-dependency-parameters -- The callback receives a fresh local Attempt service from root composition; expires: 2027-03-31.
    operation: (service: CommerceEnrollmentAttemptService) => Effect.Effect<Result, CommerceEnrollmentAttemptError>,
  ): Effect.Effect<Result, CommerceEnrollmentAttemptError> => factory.make().pipe(Effect.flatMap(operation));
  const claimTransition: CommerceEnrollmentOwnerAttemptStore['claimTransition'] = (input) =>
    runWithFreshService((service) => service.claimTransition(input));
  const read: CommerceEnrollmentOwnerAttemptStore['read'] = (input) =>
    runWithFreshService((service) => service.read(input));
  const readOwnerOperation: CommerceEnrollmentOwnerAttemptStore['readOwnerOperation'] = (input) =>
    runWithFreshService((service) => service.readOwnerOperation(input));
  const reconcileOutcome: CommerceEnrollmentOwnerAttemptStore['reconcileOutcome'] = (input, resolution) =>
    factory.make(resolution).pipe(Effect.flatMap((service) => service.reconcileOutcome(input)));
  const recordOutcome: CommerceEnrollmentOwnerAttemptStore['recordOutcome'] = (input) =>
    runWithFreshService((service) => service.recordOutcome(input));
  return Object.freeze({ claimTransition, read, readOwnerOperation, reconcileOutcome, recordOutcome });
};

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_REQUIRED = true;

export interface CommerceEnrollmentOwnerTransitionDriverOptions {
  readonly attempt: CommerceEnrollmentOwnerAttemptStore;
  readonly leaseDurationMs?: number;
  readonly owner: CommerceEnrollmentOwnerEffect;
  readonly required?: boolean;
  /** Stable worker identity is derived from the immutable owner invocation when omitted. */
  readonly workerId?: (input: CommerceEnrollmentOwnerTransition) => string;
}

export interface CommerceEnrollmentOwnerTransitionDriver {
  readonly execute: (
    input: CommerceEnrollmentOwnerTransition,
  ) => Effect.Effect<CommerceEnrollmentOwnerTransitionExecutionResult, CommerceEnrollmentAttemptError>;
  readonly reconcile: (
    input: CommerceEnrollmentOwnerTransition,
  ) => Effect.Effect<CommerceEnrollmentOwnerTransitionReconciliationResult, CommerceEnrollmentAttemptError>;
}

type CommerceEnrollmentOwnerTransitionExecutionResult =
  | {
      readonly claim: AttemptClaimedResult;
      readonly outcome: 'REPLAYED';
    }
  | {
      readonly claim: AttemptClaimedResult;
      readonly outcome: 'LEASE_HELD';
    }
  | {
      readonly claim: AttemptClaimedResult;
      readonly outcome: 'RECORDED';
      readonly ownerOutcome: CommerceEnrollmentOwnerEffectOutcome;
      readonly recorded: AttemptRecordResult;
    };

type CommerceEnrollmentOwnerTransitionReconciliationResult =
  | {
      readonly attempt: EnrollmentAttemptSnapshot;
      readonly operation: EnrollmentOwnerOperationSnapshot;
      readonly outcome: 'NO_EFFECT';
    }
  | {
      readonly outcome: 'RECORDED';
      readonly recorded: AttemptRecordResult;
      readonly resolution: ReconcileEnrollmentResolution;
    }
  | {
      readonly attempt: EnrollmentAttemptSnapshot;
      readonly operation: EnrollmentOwnerOperationSnapshot;
      readonly outcome: 'REPLAYED';
    };

const invalid = (reason: string, cause?: unknown): CommerceEnrollmentAttemptRejectedError => {
  const error = new CommerceEnrollmentAttemptRejected({
    code: 'attempt_invalid',
    reason: reason.slice(0, 500),
    retryable: false,
  });
  return cause === undefined ? error : withCause(error, cause);
};

const indeterminate = (
  input: Pick<CommerceEnrollmentOwnerTransition, 'ownerInvocationId' | 'portalEnrollmentAttemptId'>,
  reason: string,
  cause?: unknown,
): CommerceEnrollmentAttemptIndeterminateError => {
  const error = new CommerceEnrollmentAttemptIndeterminate({
    attemptId: input.portalEnrollmentAttemptId,
    code: 'attempt_indeterminate',
    ownerInvocationId: input.ownerInvocationId,
    reason: reason.slice(0, 500),
    retryable: true,
  });
  return cause === undefined ? error : withCause(error, cause);
};

const conflict = (
  input: Pick<CommerceEnrollmentOwnerTransition, 'portalEnrollmentAttemptId'>,
  reason: string,
): CommerceEnrollmentAttemptConflictError =>
  new CommerceEnrollmentAttemptConflict({
    attemptId: input.portalEnrollmentAttemptId,
    code: 'attempt_revision_conflict',
    reason: reason.slice(0, 500),
    retryable: true,
  });

const defaultWorkerId = (input: CommerceEnrollmentOwnerTransition): string =>
  `commerce-enrollment-owner:${input.ownerInvocationId}`;

const sameOperationIdentity = (
  input: CommerceEnrollmentOwnerTransition,
  operation: EnrollmentOwnerOperationSnapshot,
): boolean =>
  input.actorPrincipalId === operation.actorPrincipalId &&
  input.ownerInvocationId === operation.ownerInvocationId &&
  input.ownerModuleKey === operation.ownerModuleKey &&
  input.portalEnrollmentAttemptId === operation.portalEnrollmentAttemptId &&
  input.requestDigest === operation.requestDigest &&
  input.tenantId === operation.tenantId &&
  input.transitionKey === operation.transitionKey;

const decodeDriverInput = (
  input: CommerceEnrollmentOwnerTransition,
): Effect.Effect<CommerceEnrollmentOwnerTransition, CommerceEnrollmentAttemptError> =>
  Schema.decodeEffect(CommerceEnrollmentOwnerTransitionSchema, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError((cause) => invalid('The owner transition identity is invalid', cause)),
  );

const decodeOwnerOutcome = (
  input: CommerceEnrollmentOwnerTransition,
  outcome: CommerceEnrollmentOwnerEffectOutcome,
): Effect.Effect<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentAttemptError> =>
  Schema.decodeEffect(CommerceEnrollmentOwnerEffectOutcomeSchema, { onExcessProperty: 'error' })(outcome).pipe(
    Effect.mapError((cause) => indeterminate(input, 'The owner returned an invalid final outcome', cause)),
  );

/** True when the owner's fresh answer is the exact same pending decision already on record. */
const isRepeatedPendingReconciliation = (
  operation: EnrollmentOwnerOperationSnapshot,
  resolution: ReconcileEnrollmentResolution,
): boolean =>
  operation.status === 'FAILED' &&
  operation.failureCode === OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE &&
  resolution.status === 'FAILED' &&
  resolution.failureCode === OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE;

const decodeResolution = (
  input: CommerceEnrollmentOwnerTransition,
  resolution: ReconcileEnrollmentResolution,
): Effect.Effect<ReconcileEnrollmentResolution, CommerceEnrollmentAttemptError> =>
  Schema.decodeEffect(ReconcileEnrollmentResolutionSchema, { onExcessProperty: 'error' })(resolution).pipe(
    Effect.mapError((cause) => indeterminate(input, 'The owner returned an invalid reconciliation result', cause)),
    Effect.filterOrFail(
      (decoded) =>
        decoded.actorPrincipalId === input.actorPrincipalId &&
        String(decoded.reconciliationRef) !== String(input.ownerInvocationId),
      () => indeterminate(input, 'The owner reconciliation result is not bound to the trusted Actor/invocation'),
    ),
  );

const toClaimInput = (
  input: CommerceEnrollmentOwnerTransition,
  workerId: EnrollmentKey,
  leaseDurationMs: number,
  required: boolean,
): Effect.Effect<ClaimEnrollmentTransitionInput, CommerceEnrollmentAttemptError> =>
  Schema.decodeEffect(ClaimEnrollmentTransitionInputSchema)({
    actorPrincipalId: input.actorPrincipalId,
    expectedRevision: input.expectedRevision,
    leaseDurationMs,
    ownerInvocationId: input.ownerInvocationId,
    ownerModuleKey: input.ownerModuleKey,
    portalEnrollmentAttemptId: input.portalEnrollmentAttemptId,
    requestDigest: input.requestDigest,
    required,
    tenantId: input.tenantId,
    transitionKey: input.transitionKey,
    workerId,
  }).pipe(Effect.mapError((cause) => invalid('The durable owner claim request is invalid', cause)));

const toRecordInput = (
  input: CommerceEnrollmentOwnerTransition,
  claim: AttemptClaimedResult,
  outcome: CommerceEnrollmentOwnerEffectOutcome,
  workerId: EnrollmentKey,
): Effect.Effect<RecordEnrollmentOutcomeInput, CommerceEnrollmentAttemptError> => {
  const { lease } = claim.operation;
  if (lease === undefined) {
    return Effect.fail(indeterminate(input, 'The durable owner claim returned no active lease'));
  }
  const candidate: MutableRecordEnrollmentOutcomeInput = {
    actorPrincipalId: input.actorPrincipalId,
    expectedRevision: claim.attempt.revision,
    leaseToken: lease.leaseToken,
    ownerInvocationId: input.ownerInvocationId,
    ownerModuleKey: input.ownerModuleKey,
    portalEnrollmentAttemptId: input.portalEnrollmentAttemptId,
    status: outcome.status,
    tenantId: input.tenantId,
    transitionKey: input.transitionKey,
    workerId,
  };
  if (outcome.accountSubject !== undefined) {
    candidate.accountSubject = outcome.accountSubject;
  }
  if (outcome.failureCode !== undefined) {
    candidate.failureCode = outcome.failureCode;
  }
  if (outcome.failureReason !== undefined) {
    candidate.failureReason = outcome.failureReason;
  }
  if (outcome.nextState !== undefined) {
    candidate.nextState = outcome.nextState;
  }
  if (outcome.outcomeCode !== undefined) {
    candidate.outcomeCode = outcome.outcomeCode;
  }
  if (outcome.resultDigest !== undefined) {
    candidate.resultDigest = outcome.resultDigest;
  }
  if (outcome.resultReference !== undefined) {
    candidate.resultReference = outcome.resultReference;
  }
  return Schema.decodeUnknownEffect(RecordEnrollmentOutcomeInputSchema, { onExcessProperty: 'error' })(candidate).pipe(
    Effect.mapError((cause) => indeterminate(input, 'The owner outcome could not be recorded safely', cause)),
  );
};

const ownerOutcome = (
  status: 'SUCCEEDED' | 'FAILED',
  fields: CommerceEnrollmentOwnerEffectOutcomeFields = {},
): CommerceEnrollmentOwnerEffectOutcome => ({ status, ...fields });

const rejectedOutcome = (
  input: CommerceEnrollmentOwnerTransition,
  error: InstanceType<typeof CommerceEnrollmentOwnerEffectRejected>,
): Effect.Effect<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentAttemptError> =>
  Schema.decodeEffect(EnrollmentKeySchema)('owner_rejected').pipe(
    Effect.flatMap((failureCode) =>
      Schema.decodeEffect(EnrollmentKeySchema)(error.code).pipe(
        Effect.map((outcomeCode) =>
          ownerOutcome('FAILED', {
            failureCode,
            failureReason: error.reason.slice(0, 500),
            outcomeCode,
          }),
        ),
      ),
    ),
    Effect.mapError((cause) => indeterminate(input, 'The owner rejection could not be represented safely', cause)),
  );

const mapOwnerFailure = (
  input: CommerceEnrollmentOwnerTransition,
  error:
    | InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable>
    | InstanceType<typeof CommerceEnrollmentOwnerEffectIndeterminate>,
): CommerceEnrollmentAttemptError => indeterminate(input, error.reason, error);

const readOperationIdentity = (input: CommerceEnrollmentOwnerTransition): ReadEnrollmentOwnerOperationInput => ({
  ownerModuleKey: input.ownerModuleKey,
  portalEnrollmentAttemptId: input.portalEnrollmentAttemptId,
  tenantId: input.tenantId,
  transitionKey: input.transitionKey,
});

const readAttemptIdentity = (input: CommerceEnrollmentOwnerTransition): ReadEnrollmentAttemptInput => ({
  portalEnrollmentAttemptId: input.portalEnrollmentAttemptId,
  tenantId: input.tenantId,
});

const makeReconciliationRequest = (input: CommerceEnrollmentOwnerTransition): ReconcileEnrollmentRequest => ({
  expectedRevision: input.expectedRevision,
  ownerInvocationId: input.ownerInvocationId,
  ownerModuleKey: input.ownerModuleKey,
  portalEnrollmentAttemptId: input.portalEnrollmentAttemptId,
  tenantId: input.tenantId,
  transitionKey: input.transitionKey,
});

/** An unchanged pending decision is not re-recorded: that would bump the revision and reset the sweep budget. */
const recordReconciliationOutcome = (
  store: CommerceEnrollmentOwnerAttemptStore,
  requested: CommerceEnrollmentOwnerTransition,
  attempt: EnrollmentAttemptSnapshot,
  operation: EnrollmentOwnerOperationSnapshot,
  resolution: ReconcileEnrollmentResolution,
): Effect.Effect<CommerceEnrollmentOwnerTransitionReconciliationResult, CommerceEnrollmentAttemptError> =>
  isRepeatedPendingReconciliation(operation, resolution)
    ? Effect.succeed({ attempt, operation, outcome: 'NO_EFFECT' as const })
    : store
        .reconcileOutcome(makeReconciliationRequest({ ...requested, expectedRevision: attempt.revision }), resolution)
        .pipe(
          Effect.map((recorded) => ({ outcome: 'RECORDED' as const, recorded, resolution })),
          Effect.mapError((cause) => indeterminate(requested, 'The owner reconciliation could not be recorded', cause)),
        );

const leaseIsActive = (lease: EnrollmentOwnerOperationSnapshot['lease']): Effect.Effect<boolean> =>
  lease === undefined
    ? Effect.succeed(false)
    : DateTime.now.pipe(Effect.map((now) => DateTime.isLessThan(now, lease.leaseExpiresAt)));

const claimIsDispatchable = Effect.fn('CommerceEnrollmentOwnerTransitionDriver.claimIsDispatchable')(
  function* claimIsDispatchableEffect(
    input: CommerceEnrollmentOwnerTransition,
    claim: AttemptClaimedResult,
    workerId: EnrollmentKey,
  ): Effect.fn.Return<boolean> {
    if (
      claim.outcome !== 'CLAIMED' ||
      claim.operation.status !== 'IN_PROGRESS' ||
      !sameOperationIdentity(input, claim.operation) ||
      claim.operation.lease === undefined ||
      claim.operation.lease.workerId !== workerId ||
      claim.attempt.portalEnrollmentAttemptId !== input.portalEnrollmentAttemptId ||
      claim.attempt.tenantId !== input.tenantId ||
      claim.attempt.revision !== input.expectedRevision + 1 ||
      claim.attempt.lease === undefined ||
      claim.attempt.lease.workerId !== workerId ||
      claim.attempt.lease.leaseToken !== claim.operation.lease.leaseToken
    ) {
      return false;
    }
    const [operationLeaseActive, attemptLeaseActive] = yield* Effect.all(
      [leaseIsActive(claim.operation.lease), leaseIsActive(claim.attempt.lease)],
      { concurrency: 2 },
    );
    return operationLeaseActive && attemptLeaseActive;
  },
);

const driverInvalidConfiguration = (reason: string, cause: unknown): CommerceEnrollmentAttemptRejectedError =>
  invalid(reason, cause);

/**
 * Generic owner transition driver.  It is intentionally a phase machine rather than a helper
 * that accepts a transaction callback: claim persists the intent, dispatch performs one external
 * effect, and record/reconcile are separate CAS phases. Unknown owner results never trigger a
 * second dispatch.
 */
export const commerceEnrollmentOwnerTransitionDriverFor = (
  options: CommerceEnrollmentOwnerTransitionDriverOptions,
): CommerceEnrollmentOwnerTransitionDriver => {
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const required = options.required ?? DEFAULT_REQUIRED;
  const workerIdFor = options.workerId ?? defaultWorkerId;

  const execute = Effect.fn('CommerceEnrollmentOwnerTransitionDriver.execute')(function* executeOwnerTransition(
    rawInput: CommerceEnrollmentOwnerTransition,
  ): Effect.fn.Return<CommerceEnrollmentOwnerTransitionExecutionResult, CommerceEnrollmentAttemptError> {
    const input = yield* decodeDriverInput(rawInput);
    const workerId = yield* Schema.decodeEffect(EnrollmentKeySchema)(workerIdFor(input)).pipe(
      Effect.mapError((cause) => driverInvalidConfiguration('The owner worker identity is invalid', cause)),
    );
    const claimInput = yield* toClaimInput(input, workerId, leaseDurationMs, required);
    const claim = yield* options.attempt
      .claimTransition(claimInput)
      .pipe(Effect.flatMap(claimedOrIndeterminate(input)));
    if (claim.operation.status === 'SUCCEEDED') {
      return { claim, outcome: 'REPLAYED' };
    }
    if (claim.outcome === 'ALREADY_CLAIMED') {
      return { claim, outcome: 'LEASE_HELD' };
    }
    if (claim.operation.status !== 'IN_PROGRESS') {
      return yield* indeterminate(input, 'The durable claim returned an unexpected owner status');
    }
    if (!(yield* claimIsDispatchable(input, claim, workerId))) {
      return yield* indeterminate(
        input,
        'The durable owner claim is missing the exact active worker lease required before dispatch',
      );
    }

    const dispatchResult = yield* Effect.matchEffect(options.owner.dispatch(input), {
      onFailure: (error) => Effect.succeed({ error, kind: 'failure' as const }),
      onSuccess: (outcome) => Effect.succeed({ kind: 'success' as const, outcome }),
    });
    if (dispatchResult.kind === 'failure') {
      if (Schema.is(CommerceEnrollmentOwnerEffectRejected)(dispatchResult.error)) {
        const outcome = yield* rejectedOutcome(input, dispatchResult.error);
        const recordInput = yield* toRecordInput(input, claim, outcome, workerId);
        const recorded = yield* options.attempt
          .recordOutcome(recordInput)
          .pipe(Effect.mapError((cause) => indeterminate(input, 'The owner rejection could not be recorded', cause)));
        return { claim, outcome: 'RECORDED', ownerOutcome: outcome, recorded };
      }
      return yield* mapOwnerFailure(input, dispatchResult.error);
    }
    const outcome = yield* decodeOwnerOutcome(input, dispatchResult.outcome);
    const recordInput = yield* toRecordInput(input, claim, outcome, workerId);
    const recorded = yield* options.attempt
      .recordOutcome(recordInput)
      .pipe(Effect.mapError((cause) => indeterminate(input, 'The owner outcome could not be recorded', cause)));
    return { claim, outcome: 'RECORDED', ownerOutcome: outcome, recorded };
  });

  const reconcile = Effect.fn('CommerceEnrollmentOwnerTransitionDriver.reconcile')(function* reconcileOwnerTransition(
    rawInput: CommerceEnrollmentOwnerTransition,
  ): Effect.fn.Return<CommerceEnrollmentOwnerTransitionReconciliationResult, CommerceEnrollmentAttemptError> {
    const requested = yield* decodeDriverInput(rawInput);
    let attempt = yield* options.attempt.read(readAttemptIdentity(requested));
    if (attempt.state === 'COMPLETE' || attempt.state === 'TERMINATED') {
      return yield* new CommerceEnrollmentAttemptRejected({
        attemptId: requested.portalEnrollmentAttemptId,
        code: 'attempt_terminal',
        reason: 'A terminal Enrollment Attempt has no owner effect to reconcile',
        retryable: false,
      });
    }
    if (attempt.revision !== requested.expectedRevision) {
      return yield* conflict(requested, 'The reconciliation request uses a stale Attempt revision');
    }
    let operation = yield* options.attempt.readOwnerOperation(readOperationIdentity(requested));
    if (!sameOperationIdentity(requested, operation) || operation.actorPrincipalId !== requested.actorPrincipalId) {
      return yield* invalid('The reconciliation request does not match the immutable owner operation');
    }

    // A timed-out worker leaves the SQL row IN_PROGRESS until the next claim fences it. Claim only
    // to perform that fence, then refresh both rows before any owner read.
    let fenced = false;
    if (operation.status === 'IN_PROGRESS') {
      if (yield* leaseIsActive(operation.lease)) {
        return yield* new CommerceEnrollmentAttemptUnavailable({
          attemptId: requested.portalEnrollmentAttemptId,
          code: 'attempt_unavailable',
          reason: 'The owner transition is still leased by another worker',
          retryable: true,
        });
      }
      const fenceWorkerId = yield* Schema.decodeEffect(EnrollmentKeySchema)(workerIdFor(requested)).pipe(
        Effect.mapError((cause) => driverInvalidConfiguration('The owner worker identity is invalid', cause)),
      );
      const fenceInput = yield* toClaimInput(
        { ...requested, expectedRevision: attempt.revision },
        fenceWorkerId,
        leaseDurationMs,
        required,
      );
      yield* options.attempt.claimTransition(fenceInput);
      ({ attempt, operation } = yield* Effect.all(
        {
          attempt: options.attempt.read(readAttemptIdentity(requested)),
          operation: options.attempt.readOwnerOperation(readOperationIdentity(requested)),
        },
        { concurrency: 2 },
      ));
      if (operation.status === 'SUCCEEDED') {
        return { attempt, operation, outcome: 'REPLAYED' };
      }
      if (operation.status !== 'INDETERMINATE' && operation.status !== 'RECONCILIATION_REQUIRED') {
        return yield* indeterminate(requested, 'The expired owner transition was not durably fenced');
      }
      fenced = true;
    }

    if (operation.status === 'SUCCEEDED') {
      return { attempt, operation, outcome: 'REPLAYED' };
    }
    // A FAILED operation is reconcilable exactly when the owner marked its own decision pending
    // rather than refused; every other FAILED operation is a terminal owner rejection.
    if (operation.status === 'FAILED' && operation.failureCode !== OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE) {
      return { attempt, operation, outcome: 'NO_EFFECT' };
    }
    if (
      operation.status !== 'INDETERMINATE' &&
      operation.status !== 'RECONCILIATION_REQUIRED' &&
      operation.status !== 'FAILED'
    ) {
      return yield* indeterminate(requested, 'The owner transition is not ready for reconciliation');
    }
    // Outside the fence path the caller's revision must still be Current; the fence above moved it
    // itself and re-read both rows, so its own move is not a concurrent change.
    if (!fenced && attempt.revision !== requested.expectedRevision) {
      return yield* conflict(requested, 'The durable owner fence changed the Attempt revision; refresh before retry');
    }

    const ownerReconciliationInput =
      operation.resultReference === undefined
        ? {
            ...requested,
            observedRevision: attempt.revision,
            ownerOperationRevision: operation.revision,
          }
        : {
            ...requested,
            observedRevision: attempt.revision,
            ownerOperationRevision: operation.revision,
            ownerResultReference: operation.resultReference,
          };
    const ownerResolution = yield* options.owner.reconcile(ownerReconciliationInput).pipe(
      Effect.mapError((error) =>
        Schema.is(CommerceEnrollmentOwnerEffectRejected)(error)
          ? new CommerceEnrollmentAttemptConflict({
              attemptId: requested.portalEnrollmentAttemptId,
              code: 'attempt_conflict',
              reason: error.reason,
              retryable: false,
            })
          : mapOwnerFailure(requested, error),
      ),
    );
    const resolution = yield* decodeResolution(requested, ownerResolution);
    return yield* recordReconciliationOutcome(options.attempt, requested, attempt, operation, resolution);
  });

  return Object.freeze({ execute, reconcile });
};

/**
 * Enrollment establishes a Tenant-scoped Principal Auth Binding; it never administers one. The
 * disable/revoke status transition stays with its own owner Action, so this adapter deliberately
 * exposes only the two establishing operations and cannot reach
 * `changePrincipalBindingStatus` even when composition asks for it.
 */
type CommerceEnrollmentCoreIdentityDispatchRequest =
  | { readonly operation: 'reserve'; readonly payload: ReservePrincipalBindingRequest }
  | { readonly operation: 'activate'; readonly payload: ActivatePrincipalBindingRequest };

type CoreFoundBindingResult = Extract<ReadPrincipalBindingResult, { readonly outcome: 'FOUND' }>;

export interface CommerceEnrollmentCoreIdentityOwnerEffectOptions {
  readonly client: ExternalIdentityClientPort;
  readonly clientOptions: (input: CommerceEnrollmentOwnerTransition) => ExternalIdentityClientOptions;
  /**
   * Interprets a Core read only after `readResultIsOriginal` has vouched for its provenance. The
   * callback must also establish the original request digest; the published Core read result
   * intentionally does not carry that digest.
   */
  readonly interpretReadResult?: (
    input: CommerceEnrollmentOwnerReconciliationInput,
    result: CoreFoundBindingResult,
  ) => Effect.Effect<ReconcileEnrollmentResolution, CommerceEnrollmentOwnerEffectError>;
  readonly makeDispatchRequest: (
    input: CommerceEnrollmentOwnerTransition,
  ) => CommerceEnrollmentCoreIdentityDispatchRequest;
  readonly makeReconciliationRequest: (
    input: CommerceEnrollmentOwnerReconciliationInput,
  ) => ReadPrincipalBindingRequest;
  /**
   * Whether this exact Core read proves the transition being reconciled already committed.
   *
   * The default is the reservation's own provenance: `originalInvocationId` is the invocation that
   * *created* the binding, so it identifies a reserve and nothing else. A transition that changes a
   * binding Core already holds — activation — supplies its own predicate, because Core publishes no
   * per-transition invocation reference to compare against and the default would report every lost
   * activation response as unavailable forever.
   */
  readonly readResultIsOriginal?: (
    input: CommerceEnrollmentOwnerReconciliationInput,
    result: CoreFoundBindingResult,
  ) => boolean;
}

const coreUnavailable = (cause?: unknown): InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable> => {
  const error = new CommerceEnrollmentOwnerEffectUnavailable({
    code: 'core_identity_unavailable',
    reason: 'The Core external identity service is unavailable',
  });
  return cause === undefined ? error : withCause(error, cause);
};

const coreRejected = (
  code: string,
  reason: string,
  cause?: unknown,
): InstanceType<typeof CommerceEnrollmentOwnerEffectRejected> => {
  const error = new CommerceEnrollmentOwnerEffectRejected({
    code: code.slice(0, 200),
    reason: reason.slice(0, 500),
  });
  return cause === undefined ? error : withCause(error, cause);
};

const ExternalIdentityStatusCarrierSchema = Schema.Struct({ status: Schema.Finite });

const mapExternalIdentityError = (cause: ExternalIdentityClientError): CommerceEnrollmentOwnerEffectError => {
  const status = Schema.is(ExternalIdentityStatusCarrierSchema)(cause) ? cause.status : undefined;
  if (status === undefined || status === 429 || status >= 500) {
    return coreUnavailable(cause);
  }
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 409 || status === 422) {
    return coreRejected('core_identity_rejected', 'Core rejected the external identity transition', cause);
  }
  return coreUnavailable(cause);
};

const decodeResourceId = (
  value: string,
): Effect.Effect<EnrollmentResourceId, InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable>> =>
  Schema.decodeEffect(EnrollmentResourceIdSchema)(value).pipe(Effect.mapError((cause) => coreUnavailable(cause)));

const decodeCoreKey = (
  value: string,
): Effect.Effect<EnrollmentKey, InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable>> =>
  Schema.decodeEffect(EnrollmentKeySchema)(value).pipe(Effect.mapError((cause) => coreUnavailable(cause)));

/**
 * Adapter over the published neutral Core client.  The adapter never imports Core repositories
 * or calls a private registration; reserve/activate/status use the x-api-key client port and
 * reconciliation uses exact binding read or external-subject resolve selected by composition.
 */
/** A reservation is the invocation that created the binding, so Core names it back verbatim. */
const reservationCreatedThisBinding = (
  input: CommerceEnrollmentOwnerReconciliationInput,
  result: CoreFoundBindingResult,
): boolean =>
  Option.isSome(result.originalInvocationId) && result.originalInvocationId.value === input.ownerInvocationId;

export const commerceEnrollmentCoreIdentityOwnerEffectFor = (
  options: CommerceEnrollmentCoreIdentityOwnerEffectOptions,
): CommerceEnrollmentOwnerEffect => {
  const readResultIsOriginal = options.readResultIsOriginal ?? reservationCreatedThisBinding;
  const dispatch = Effect.fn('CommerceEnrollmentCoreIdentityOwnerEffect.dispatch')(function* dispatchCoreIdentity(
    input: CommerceEnrollmentOwnerTransition,
  ): Effect.fn.Return<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentOwnerEffectError> {
    const request = options.makeDispatchRequest(input);
    const mutationOptions = { ...options.clientOptions(input), idempotencyKey: input.ownerInvocationId };
    if (request.operation === 'reserve') {
      const result = yield* options.client
        .reservePrincipalBinding(request.payload, mutationOptions)
        .pipe(Effect.mapError(mapExternalIdentityError));
      if (
        result.outcome === 'EXISTING' &&
        (result.bindingStatus === 'disabled' || result.bindingStatus === 'revoked')
      ) {
        return yield* coreRejected('core_binding_not_current', 'Core returned a non-current existing binding');
      }
      const { outcomeCode, resultReference } = yield* Effect.all(
        {
          outcomeCode: decodeCoreKey(result.outcome === 'RESERVED' ? 'core_binding_reserved' : 'core_binding_existing'),
          resultReference: decodeResourceId(result.authBindingId),
        },
        { concurrency: 2 },
      );
      return ownerOutcome('SUCCEEDED', {
        outcomeCode,
        resultReference,
      });
    }
    const result = yield* options.client
      .activatePrincipalBinding(request.payload, mutationOptions)
      .pipe(Effect.mapError(mapExternalIdentityError));
    const { outcomeCode, resultReference } = yield* Effect.all(
      {
        outcomeCode: decodeCoreKey('core_binding_activated'),
        resultReference: decodeResourceId(result.authBindingId),
      },
      { concurrency: 2 },
    );
    return ownerOutcome('SUCCEEDED', { outcomeCode, resultReference });
  });

  const reconcile = Effect.fn('CommerceEnrollmentCoreIdentityOwnerEffect.reconcile')(function* reconcileCoreIdentity(
    input: CommerceEnrollmentOwnerReconciliationInput,
  ): Effect.fn.Return<ReconcileEnrollmentResolution, CommerceEnrollmentOwnerEffectError> {
    const result = yield* options.client
      .readPrincipalBinding(options.makeReconciliationRequest(input), options.clientOptions(input))
      .pipe(Effect.mapError(mapExternalIdentityError));
    if (
      result.outcome !== 'FOUND' ||
      options.interpretReadResult === undefined ||
      !readResultIsOriginal(input, result)
    ) {
      return yield* coreUnavailable();
    }
    return yield* options.interpretReadResult(input, result);
  });

  return Object.freeze({ dispatch, reconcile });
};
