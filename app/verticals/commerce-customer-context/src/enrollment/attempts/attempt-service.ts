import { Effect, Schema } from 'effect';

import {
  ClaimEnrollmentTransitionInputSchema,
  isEnrollmentAttemptTerminal,
  ReconcileEnrollmentOutcomeInputSchema,
  ReconcileEnrollmentResolutionSchema,
  ReconcileEnrollmentRequestSchema,
  RecordEnrollmentOutcomeInputSchema,
  ReadEnrollmentAttemptInputSchema,
  ReadEnrollmentOwnerOperationInputSchema,
  StartEnrollmentAttemptInputSchema,
  TerminateEnrollmentAttemptInputSchema,
} from '../../../shared/enrollment-contracts.ts';
import type {
  ClaimEnrollmentTransitionInput,
  CommercePortalAccountSubject,
  DerivedEnrollmentAttemptState,
  EnrollmentAttemptSnapshot,
  EnrollmentOwnerOperationSnapshot,
  EnrollmentOwnerOutcomeSignal,
  RecordEnrollmentOutcomeInput,
  ReadEnrollmentAttemptInput,
  ReadEnrollmentOwnerOperationInput,
  ReconcileEnrollmentOutcomeInput,
  ReconcileEnrollmentRequest,
  ReconcileEnrollmentResolution,
  StartEnrollmentAttemptInput,
  TerminateEnrollmentAttemptInput,
} from '../../../shared/enrollment-contracts.ts';
import type {
  AttemptClaimResult,
  AttemptCreateResult,
  AttemptRecordResult,
  AttemptTerminateResult,
  CommerceEnrollmentAttemptPersistence,
} from './attempt-persistence.ts';
import { CommerceEnrollmentAttemptRejected } from './errors.ts';
import type { CommerceEnrollmentAttemptError } from './errors.ts';

// oxlint-disable-next-line effect-native/require-context-service-for-service-interface -- This owner capability is installed through the scoped transaction factory and intentionally has no ambient Context identity; expires: 2027-03-31.
export interface CommerceEnrollmentAttemptService {
  readonly claimTransition: (
    input: ClaimEnrollmentTransitionInput,
  ) => Effect.Effect<AttemptClaimResult, CommerceEnrollmentAttemptError>;
  readonly read: (
    input: ReadEnrollmentAttemptInput,
  ) => Effect.Effect<EnrollmentAttemptSnapshot, CommerceEnrollmentAttemptError>;
  readonly readOwnerOperation: (
    input: ReadEnrollmentOwnerOperationInput,
  ) => Effect.Effect<EnrollmentOwnerOperationSnapshot, CommerceEnrollmentAttemptError>;
  readonly reconcileOutcome: (
    input: ReconcileEnrollmentRequest,
  ) => Effect.Effect<AttemptRecordResult, CommerceEnrollmentAttemptError>;
  readonly recordOutcome: (
    input: RecordEnrollmentOutcomeInput,
  ) => Effect.Effect<AttemptRecordResult, CommerceEnrollmentAttemptError>;
  readonly start: (
    input: StartEnrollmentAttemptInput,
  ) => Effect.Effect<AttemptCreateResult, CommerceEnrollmentAttemptError>;
  readonly terminate: (
    input: TerminateEnrollmentAttemptInput,
  ) => Effect.Effect<AttemptTerminateResult, CommerceEnrollmentAttemptError>;
}

/**
 * Owner-specific authoritative lookup used only for an indeterminate transition.  The caller
 * supplies the immutable original invocation identity; the authority returns the final metadata
 * and opaque reconciliation reference after its own provider/API read.
 */
export interface CommerceEnrollmentAttemptReconciliationAuthority {
  readonly resolve: (
    input: ReconcileEnrollmentRequest,
  ) => Effect.Effect<ReconcileEnrollmentResolution, CommerceEnrollmentAttemptError>;
}

/** The final owner outcome that is about to be journalled, before any durable write happens. */
export interface CommerceEnrollmentAttemptPendingOutcome {
  readonly ownerModuleKey: string;
  /** The owner's own signal about its transition.  It can never name COMPLETE. */
  readonly signal?: EnrollmentOwnerOutcomeSignal;
  readonly status: 'FAILED' | 'SUCCEEDED';
  readonly transitionKey: string;
}

/**
 * The authority that concludes what the Attempt's state is once this outcome lands.  It is a port
 * rather than a direct dependency so that the Attempt store stays journey-agnostic: which owner
 * transitions a journey requires is orchestration vocabulary, installed at the composition root.
 */
export interface CommerceEnrollmentAttemptCompletionAuthority {
  readonly derive: (
    attempt: EnrollmentAttemptSnapshot,
    outcome: CommerceEnrollmentAttemptPendingOutcome,
  ) => Effect.Effect<DerivedEnrollmentAttemptState, CommerceEnrollmentAttemptError>;
}

const invalid = (reason: string): InstanceType<typeof CommerceEnrollmentAttemptRejected> =>
  new CommerceEnrollmentAttemptRejected({
    code: 'attempt_invalid',
    reason: reason.slice(0, 500),
    retryable: false,
  });

const invalidWithCause = (reason: string, cause: unknown): InstanceType<typeof CommerceEnrollmentAttemptRejected> =>
  Object.defineProperty(invalid(reason), 'cause', { enumerable: false, value: cause });

const decodeResolution = (
  resolution: ReconcileEnrollmentResolution,
): Effect.Effect<ReconcileEnrollmentResolution, CommerceEnrollmentAttemptError> =>
  Schema.decodeEffect(ReconcileEnrollmentResolutionSchema)(resolution).pipe(
    Effect.mapError((cause) => invalidWithCause('The owner reconciliation result is invalid', cause)),
  );

const decodeOrReject = <Input>(
  schema: Schema.ConstraintDecoder<Input>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This helper is the shared request boundary and decodes the value before any persistence call.
  input: unknown,
): Effect.Effect<Input, CommerceEnrollmentAttemptError> =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) => invalidWithCause('The Enrollment Attempt request is invalid', cause)),
  );

const subjectsEqual = (left: CommercePortalAccountSubject, right: CommercePortalAccountSubject): boolean =>
  left.authenticationNamespaceId === right.authenticationNamespaceId &&
  left.providerSubjectId === right.providerSubjectId &&
  left.subjectType === right.subjectType;

const ensureSubjectConsistent = (
  attempt: EnrollmentAttemptSnapshot,
  supplied: CommercePortalAccountSubject | undefined,
): Effect.Effect<void, CommerceEnrollmentAttemptError> =>
  supplied === undefined || attempt.accountSubject === undefined || subjectsEqual(attempt.accountSubject, supplied)
    ? Effect.void
    : Effect.fail(
        new CommerceEnrollmentAttemptRejected({
          attemptId: attempt.portalEnrollmentAttemptId,
          code: 'attempt_conflict',
          reason: 'The provider subject does not match the immutable subject recorded on the Attempt',
          retryable: false,
        }),
      );

type MutableReconciliationOutcome = {
  -readonly [Key in keyof ReconcileEnrollmentOutcomeInput]?: ReconcileEnrollmentOutcomeInput[Key];
};

/**
 * The derived state the Attempt takes once this outcome is journalled.  It is computed from the
 * journey definition and the durable owner journal, never read out of the request, so no owner can
 * assert COMPLETE for a journey whose other required transitions have not happened.
 */
const derivedStateFor = (
  completion: CommerceEnrollmentAttemptCompletionAuthority,
  attempt: EnrollmentAttemptSnapshot,
  outcome: CommerceEnrollmentAttemptPendingOutcome,
): Effect.Effect<DerivedEnrollmentAttemptState, CommerceEnrollmentAttemptError> => completion.derive(attempt, outcome);

const pendingOutcome = (input: {
  readonly nextState?: EnrollmentOwnerOutcomeSignal;
  readonly ownerModuleKey: string;
  readonly status: 'FAILED' | 'SUCCEEDED';
  readonly transitionKey: string;
}): CommerceEnrollmentAttemptPendingOutcome => {
  const outcome = {
    ownerModuleKey: input.ownerModuleKey,
    status: input.status,
    transitionKey: input.transitionKey,
  };
  return input.nextState === undefined ? outcome : { ...outcome, signal: input.nextState };
};

const persistDecodedReconciliation = (
  persistence: CommerceEnrollmentAttemptPersistence,
  completion: CommerceEnrollmentAttemptCompletionAuthority,
  attempt: EnrollmentAttemptSnapshot,
  decodedOutcome: ReconcileEnrollmentOutcomeInput,
): Effect.Effect<AttemptRecordResult, CommerceEnrollmentAttemptError> =>
  derivedStateFor(completion, attempt, pendingOutcome(decodedOutcome)).pipe(
    Effect.flatMap((derivedState) => persistence.reconcile(decodedOutcome, derivedState)),
  );

const persistReconciliationResolution = (
  persistence: CommerceEnrollmentAttemptPersistence,
  completion: CommerceEnrollmentAttemptCompletionAuthority,
  attempt: EnrollmentAttemptSnapshot,
  decodedInput: ReconcileEnrollmentRequest,
  resolution: ReconcileEnrollmentResolution,
): Effect.Effect<AttemptRecordResult, CommerceEnrollmentAttemptError> =>
  decodeResolution(resolution).pipe(
    Effect.flatMap((decodedResolution) => {
      const outcome: MutableReconciliationOutcome = {
        actorPrincipalId: decodedResolution.actorPrincipalId,
        expectedRevision: decodedInput.expectedRevision,
        ownerInvocationId: decodedInput.ownerInvocationId,
        ownerModuleKey: decodedInput.ownerModuleKey,
        portalEnrollmentAttemptId: decodedInput.portalEnrollmentAttemptId,
        reconciliationRef: decodedResolution.reconciliationRef,
        status: decodedResolution.status,
        tenantId: decodedInput.tenantId,
        transitionKey: decodedInput.transitionKey,
      };
      if (decodedResolution.accountSubject !== undefined) {
        outcome.accountSubject = decodedResolution.accountSubject;
      }
      if (decodedResolution.failureCode !== undefined) {
        outcome.failureCode = decodedResolution.failureCode;
      }
      if (decodedResolution.failureReason !== undefined) {
        outcome.failureReason = decodedResolution.failureReason;
      }
      if (decodedResolution.nextState !== undefined) {
        outcome.nextState = decodedResolution.nextState;
      }
      if (decodedResolution.outcomeCode !== undefined) {
        outcome.outcomeCode = decodedResolution.outcomeCode;
      }
      if (decodedResolution.resultDigest !== undefined) {
        outcome.resultDigest = decodedResolution.resultDigest;
      }
      if (decodedResolution.resultReference !== undefined) {
        outcome.resultReference = decodedResolution.resultReference;
      }
      return ensureSubjectConsistent(attempt, decodedResolution.accountSubject).pipe(
        Effect.flatMap(() =>
          Schema.decodeUnknownEffect(ReconcileEnrollmentOutcomeInputSchema)(outcome).pipe(
            Effect.mapError((cause) => invalidWithCause('The owner reconciliation result is invalid', cause)),
            Effect.flatMap((decodedOutcome) =>
              persistDecodedReconciliation(persistence, completion, attempt, decodedOutcome),
            ),
          ),
        ),
      );
    }),
  );

const reconcileAttempt = (
  persistence: CommerceEnrollmentAttemptPersistence,
  reconciliationAuthority: CommerceEnrollmentAttemptReconciliationAuthority,
  completion: CommerceEnrollmentAttemptCompletionAuthority,
  decodedInput: ReconcileEnrollmentRequest,
  attempt: EnrollmentAttemptSnapshot,
): Effect.Effect<AttemptRecordResult, CommerceEnrollmentAttemptError> =>
  isEnrollmentAttemptTerminal(attempt.state)
    ? Effect.fail(
        new CommerceEnrollmentAttemptRejected({
          attemptId: attempt.portalEnrollmentAttemptId,
          code: 'attempt_terminal',
          reason: 'A terminal Enrollment Attempt cannot be reconciled',
          retryable: false,
        }),
      )
    : reconciliationAuthority
        .resolve(decodedInput)
        .pipe(
          Effect.flatMap((resolution) =>
            persistReconciliationResolution(persistence, completion, attempt, decodedInput, resolution),
          ),
        );

const reconcileInput = (
  persistence: CommerceEnrollmentAttemptPersistence,
  reconciliationAuthority: CommerceEnrollmentAttemptReconciliationAuthority,
  completion: CommerceEnrollmentAttemptCompletionAuthority,
  decodedInput: ReconcileEnrollmentRequest,
): Effect.Effect<AttemptRecordResult, CommerceEnrollmentAttemptError> =>
  persistence
    .read({
      portalEnrollmentAttemptId: decodedInput.portalEnrollmentAttemptId,
      tenantId: decodedInput.tenantId,
    })
    .pipe(
      Effect.flatMap((attempt) =>
        reconcileAttempt(persistence, reconciliationAuthority, completion, decodedInput, attempt),
      ),
    );

/**
 * Record one final owner outcome.  The Attempt is read, its immutable subject re-checked, the new
 * state derived from the journey and the journal, and only then is the durable routine entered.
 */
const recordDecodedOutcome = (
  persistence: CommerceEnrollmentAttemptPersistence,
  completion: CommerceEnrollmentAttemptCompletionAuthority,
  attempt: EnrollmentAttemptSnapshot,
  decodedInput: RecordEnrollmentOutcomeInput,
): Effect.Effect<AttemptRecordResult, CommerceEnrollmentAttemptError> =>
  ensureSubjectConsistent(attempt, decodedInput.accountSubject).pipe(
    Effect.flatMap(() => derivedStateFor(completion, attempt, pendingOutcome(decodedInput))),
    Effect.flatMap((derivedState) => persistence.record(decodedInput, derivedState)),
  );

const recordOutcomeForInput = (
  persistence: CommerceEnrollmentAttemptPersistence,
  completion: CommerceEnrollmentAttemptCompletionAuthority,
  decodedInput: RecordEnrollmentOutcomeInput,
): Effect.Effect<AttemptRecordResult, CommerceEnrollmentAttemptError> =>
  persistence
    .read({
      portalEnrollmentAttemptId: decodedInput.portalEnrollmentAttemptId,
      tenantId: decodedInput.tenantId,
    })
    .pipe(
      Effect.flatMap((attempt) =>
        isEnrollmentAttemptTerminal(attempt.state)
          ? Effect.fail(
              new CommerceEnrollmentAttemptRejected({
                attemptId: attempt.portalEnrollmentAttemptId,
                code: 'attempt_terminal',
                reason: 'A terminal Enrollment Attempt cannot record a new owner outcome',
                retryable: false,
              }),
            )
          : recordDecodedOutcome(persistence, completion, attempt, decodedInput),
      ),
    );

/**
 * Business façade over the owner routine capability.  The façade performs the cheap protocol
 * checks before entering a routine; the routine repeats all identity, revision and lease checks
 * inside the Commerce transaction so a caller cannot bypass the durable fence.
 */
export const commerceEnrollmentAttemptServiceForPersistence = (
  persistence: CommerceEnrollmentAttemptPersistence,
  reconciliationAuthority: CommerceEnrollmentAttemptReconciliationAuthority,
  completion: CommerceEnrollmentAttemptCompletionAuthority,
): CommerceEnrollmentAttemptService => ({
  claimTransition: (input) =>
    decodeOrReject(ClaimEnrollmentTransitionInputSchema, input).pipe(
      Effect.flatMap((decodedInput) =>
        persistence
          .read({
            portalEnrollmentAttemptId: decodedInput.portalEnrollmentAttemptId,
            tenantId: decodedInput.tenantId,
          })
          .pipe(
            Effect.flatMap((attempt) =>
              isEnrollmentAttemptTerminal(attempt.state)
                ? Effect.fail(
                    new CommerceEnrollmentAttemptRejected({
                      attemptId: attempt.portalEnrollmentAttemptId,
                      code: 'attempt_terminal',
                      reason: 'A terminal Enrollment Attempt cannot perform another owner effect',
                      retryable: false,
                    }),
                  )
                : ensureSubjectConsistent(attempt, decodedInput.accountSubject),
            ),
            Effect.flatMap(() => persistence.claim(decodedInput)),
          ),
      ),
    ),
  read: (input) =>
    decodeOrReject(ReadEnrollmentAttemptInputSchema, input).pipe(
      Effect.flatMap((decodedInput) => persistence.read(decodedInput)),
    ),
  readOwnerOperation: (input) =>
    decodeOrReject(ReadEnrollmentOwnerOperationInputSchema, input).pipe(
      Effect.flatMap((decodedInput) => persistence.readOperation(decodedInput)),
    ),
  reconcileOutcome: (input) =>
    decodeOrReject(ReconcileEnrollmentRequestSchema, input).pipe(
      Effect.flatMap((decodedInput) => reconcileInput(persistence, reconciliationAuthority, completion, decodedInput)),
    ),
  recordOutcome: (input) =>
    decodeOrReject(RecordEnrollmentOutcomeInputSchema, input).pipe(
      Effect.flatMap((decodedInput) => recordOutcomeForInput(persistence, completion, decodedInput)),
    ),
  start: (input) =>
    decodeOrReject(StartEnrollmentAttemptInputSchema, input).pipe(
      Effect.flatMap((decodedInput) => persistence.create(decodedInput)),
    ),
  terminate: (input) =>
    decodeOrReject(TerminateEnrollmentAttemptInputSchema, input).pipe(
      Effect.flatMap((decodedInput) => persistence.terminate(decodedInput)),
    ),
});
