/**
 * The read adapter's runner for a read written `{ run }` (obligations in `reads/sdk-contract.ts`,
 * `ExecuteRunFormRead`). The read runtime has decided the read's own authority, its policies and the
 * admitted composition revision before it hands the read here; this file builds the owner binding and
 * the caller source, opens the kernel session (which decides the owner rule before any module code),
 * runs the module's `run`, and then answers the read: result validation, read evidence in its own
 * fenced transaction, field projection and release, or the read's failure with its evidence.
 */
import { Cause, Effect, Exit, Option, Predicate, Schema } from 'effect';

import { withOptional } from '../access/decision/optional.ts';
import { OwnerAuthorizationOverlay } from '../access/enforcement/owner-overlay.ts';
import { bindScopedWorkloadAdmission } from '../access/enforcement/workload-admission.ts';
import { ExecutionRuleViolation, READ_EXECUTION_BUDGET } from '../execution/contract.ts';
import type { CallRecord, KernelExecution, OwnerBinding } from '../execution/contract.ts';
import { KernelSessions } from '../execution/kernel-sessions.ts';
import { TransactionAborted } from '../sdk/index.ts';
import type { RequestExecution } from '../sdk/index.ts';
import type { AccessQuestions, ReadCalls, ReadRunContext } from '../sdk/read.ts';
import { validateReadEvidenceMetadata } from './context.ts';
import type { ReadHandlerResult } from './context.ts';
import {
  getReadCalls,
  getReadDomainErrorSchema,
  getReadRun,
  getReadServiceFactory,
  projectReadResultFields,
} from './definition.ts';
import type { ReadRegistration } from './definition.ts';
import {
  ReadHandlerExecutionError,
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
  ReadResultValidationError,
} from './errors.ts';
import type { ReadCoreError, ReadEvidencePersistenceError } from './errors.ts';
import type { PersistReadEvidenceInput } from './repository.ts';
import { ReadRunEvidence } from './run-evidence.ts';
import { callEvidenceRows } from './run-evidence-live.ts';
import type { ExecuteRunFormRead, RunFormReadInput } from './sdk-contract.ts';

/** Keeps the original failure as the non-enumerable `cause` of the error the caller receives. */
export const preserveFailureCause = <Failure extends object>(failure: Failure, cause: unknown): Failure =>
  Object.defineProperty(failure, 'cause', {
    configurable: false,
    enumerable: false,
    value: cause,
    writable: false,
  });

/**
 * What a read's own code may answer the caller: Core's not found, unavailable and denied answers pass;
 * a failure the descriptor's `domainErrorSchema` declares passes decoded; anything else is a generic
 * execution failure, so no owner detail crosses the Core Read boundary.
 */
export const sanitizeReadHandlerFailure = <
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  Failure,
>(
  domainErrorSchema: DomainErrorSchema | undefined,
  failure: Failure,
):
  | DomainErrorSchema['Type']
  | ReadHandlerExecutionError
  | ReadHandlerNotFound
  | ReadHandlerUnavailable
  | ReadPermissionDenied => {
  if (
    Schema.is(ReadHandlerUnavailable)(failure) ||
    Schema.is(ReadHandlerNotFound)(failure) ||
    Schema.is(ReadPermissionDenied)(failure)
  ) {
    return failure;
  }
  if (domainErrorSchema !== undefined) {
    const decoded = Schema.decodeUnknownOption(domainErrorSchema)(failure);
    if (Option.isSome(decoded)) {
      return decoded.value;
    }
  }
  return new ReadHandlerExecutionError({
    code: 'read_handler_execution_failed',
    reason: 'The read handler failed unexpectedly',
  });
};

/** What one `run` left behind, read from the session before it closed. */
interface RunObservation<Value, Failure> {
  readonly callRecords: readonly CallRecord[];
  readonly exit: Exit.Exit<ReadHandlerResult<Value>, Failure>;
  readonly ownerDenied: boolean;
}

const NO_CALL_RECORDS: readonly CallRecord[] = Object.freeze([]);

const isTransactionAborted = Schema.is(TransactionAborted);
const isExecutionRuleViolation = Schema.is(ExecutionRuleViolation);

const failuresOf = <Failure>(cause: Cause.Cause<Failure>): readonly Failure[] =>
  cause.reasons.flatMap((reason) => (Cause.isFailReason(reason) ? [reason.error] : []));

const abortReasonsOf = (cause: Cause.Cause<unknown>): ReadonlySet<TransactionAborted['reason']> =>
  new Set(failuresOf(cause).flatMap((failure) => (isTransactionAborted(failure) ? [failure.reason] : [])));

const ruleViolationsOf = (cause: Cause.Cause<unknown>): readonly ExecutionRuleViolation[] =>
  cause.reasons.flatMap((reason) =>
    Cause.isDieReason(reason) && isExecutionRuleViolation(reason.defect) ? [reason.defect] : [],
  );

const ownerDenial = (): ReadPermissionDenied =>
  new ReadPermissionDenied({
    code: 'read_permission_denied',
    reason: 'The owner-local authorization state denies this Read',
  });

const outcomeCodeOf = <Failure>(failure: Failure): string =>
  Predicate.hasProperty(failure, 'code') && Predicate.isString(failure.code) && failure.code.length > 0
    ? failure.code
    : 'read_handler_failed';

/**
 * The read's answer for a failed `run` (or a failed session open) that is not a denial. An owner rule
 * that could not answer is permission unavailable, as on the one-transaction path; any other abort and
 * any kernel rule violation is a retryable unavailability; a domain failure is sanitized as today.
 * Defects and interruptions that are none of these pass unchanged.
 */
const answerForFailure = <DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>, Failure>(
  cause: Cause.Cause<Failure>,
  domainErrorSchema: DomainErrorSchema | undefined,
): Effect.Effect<Cause.Cause<DomainErrorSchema['Type'] | ReadCoreError>> => {
  const aborts = abortReasonsOf(cause);
  if (aborts.has('owner_unavailable')) {
    return Effect.succeed(
      Cause.fail(
        preserveFailureCause(
          new ReadPermissionUnavailable({
            code: 'read_permission_unavailable',
            reason: 'Owner-local Read authorization is temporarily unavailable',
          }),
          cause,
        ),
      ),
    );
  }
  if (aborts.size > 0) {
    return Effect.succeed(
      Cause.fail(
        preserveFailureCause(
          new ReadHandlerUnavailable({
            code: 'read_handler_unavailable',
            reason: aborts.has('budget_exhausted')
              ? 'The Read spent its execution budget'
              : 'The Read could not complete its owner transaction',
          }),
          cause,
        ),
      ),
    );
  }
  const violations = ruleViolationsOf(cause);
  if (violations.length > 0) {
    return Effect.logError('A { run } Read broke an execution kernel rule', ...violations).pipe(
      Effect.as(
        Cause.fail(
          preserveFailureCause(
            new ReadHandlerUnavailable({
              code: 'read_handler_unavailable',
              reason: 'The Read broke an execution rule',
            }),
            cause,
          ),
        ),
      ),
    );
  }
  const [failure] = failuresOf(cause);
  if (failure !== undefined) {
    return Effect.succeed(Cause.fail(sanitizeReadHandlerFailure(domainErrorSchema, failure)));
  }
  // Only defects or interruptions remain: they pass unchanged.
  return Effect.succeed(
    Cause.fromReasons(cause.reasons.flatMap((reason) => (Cause.isFailReason(reason) ? [] : [reason]))),
  );
};

const executeRunFormReadEffect = Effect.fn('ReadRuntime.executeRunFormRead')(function* executeRunFormReadEffect<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  HandlerError,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  registration: ReadRegistration<
    InputSchema,
    ResultSchema,
    Owner,
    Services,
    HandlerError,
    Requirements,
    DomainErrorSchema
  >,
  input: RunFormReadInput,
): Effect.fn.Return<
  ResultSchema['Type'],
  DomainErrorSchema['Type'] | ReadCoreError,
  KernelSessions | OwnerAuthorizationOverlay | ReadRunEvidence | Requirements
> {
  const { descriptor } = registration;
  const run = getReadRun(registration);
  const isDecodedInput = Schema.is(Schema.toType(descriptor.inputSchema));
  const { decodedInput } = input;
  if (run === undefined || !isDecodedInput(decodedInput)) {
    return yield* new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'The Read is not a { run } read with its decoded input',
    });
  }
  const serviceFactory = getReadServiceFactory(registration);
  const overlay = yield* OwnerAuthorizationOverlay;
  const sessions = yield* KernelSessions;
  const runEvidence = yield* ReadRunEvidence;

  // 1. The owner side, closed over everything read-specific; the engine never sees a read.
  const owner: OwnerBinding<Services, Requirements> = {
    build: (transaction, scope, compositionRevision) =>
      serviceFactory(transaction, scope, compositionRevision, input.listAccess),
    decide: (transaction, operationAt) =>
      overlay.authorize(transaction, Object.freeze({ ...input.ownerQuestion, operationAt })),
    seal: (transaction) =>
      bindScopedWorkloadAdmission(
        transaction,
        { carrier: input.workloadAdmission.carrier, scope: input.scope },
        input.workloadAdmission.decision,
      ),
  };
  const execution: KernelExecution<ReadCalls, RequestExecution> = Object.freeze({
    budget: READ_EXECUTION_BUDGET,
    // The execution's scope object itself, the one its lease was opened with: the lease and the gateway
    // delegation recognise exactly that instance, so a copy (or the pre-scope principal) is refused.
    callerSource: withOptional(
      { _tag: 'RequestPrincipal' as const, principal: input.scope },
      'audience',
      input.audience,
    ),
    calls: getReadCalls(registration),
    facts: input.facts,
    scope: input.scope,
    transactionMode: 'read_only' as const,
  });

  // 2-3. The session decides the owner rule first; `run` starts only for an execution it allows. The
  // session closes when `run` ends, so no capability outlives it.
  const observation: RunObservation<ResultSchema['Type'], HandlerError | TransactionAborted> = yield* input.lease(
    Effect.scoped(
      Effect.gen(function* observeRun() {
        const opened = yield* Effect.exit(sessions.open(execution, owner));
        if (Exit.isFailure(opened)) {
          return { callRecords: NO_CALL_RECORDS, exit: Exit.failCause(opened.cause), ownerDenied: false };
        }
        const session = opened.value;
        const context: ReadRunContext<Services, ReadCalls, AccessQuestions> = withOptional(
          withOptional(
            {
              access: input.access,
              call: session.capabilities.call,
              execution: session.capabilities.execution,
              readKey: descriptor.readKey,
              scope: input.scope,
              transaction: session.capabilities.transaction,
            },
            // The gate's own field answer, present exactly for the reads it decided (O17, O25).
            'deniedFieldPaths',
            input.usesAccessGate ? input.deniedFieldPaths : undefined,
          ),
          'listAccess',
          input.listAccess,
        );
        // The budget bounds the whole of `run`, not only the start of each call and transaction: a run
        // still working when it is spent is interrupted (its open call or transaction with it) and the
        // read answers unavailable. The budget counts from the session's opening, so the owner check
        // already spent part of it.
        const remainingMillis = yield* session.remainingMillis;
        const exit = yield* Effect.exit(
          Effect.suspend(() => run(decodedInput, Object.freeze(context))).pipe(
            Effect.timeoutOrElse({
              duration: remainingMillis,
              orElse: () => Effect.fail(new TransactionAborted({ reason: 'budget_exhausted' })),
            }),
          ),
        );
        // No new work, every admitted call and transaction ended and accounted for, then the snapshot.
        yield* session.settle;
        const ownerDenied = yield* session.ownerDenied;
        const callRecords = yield* session.callRecords;
        return { callRecords, exit, ownerDenied };
      }),
    ),
  );

  const callRows = callEvidenceRows(observation.callRecords, {
    accessKind: descriptor.accessKind,
    captureMode: descriptor.evidencePolicy.captureMode,
    policyKey: descriptor.evidencePolicy.policyKey,
    readKey: descriptor.readKey,
    scope: input.scope,
    servingModuleKey: descriptor.owningModuleKey,
  });
  const readRow = (
    row: Pick<PersistReadEvidenceInput, 'outcome' | 'outcomeCode' | 'outcomeStage' | 'resultCount'> &
      Partial<Pick<PersistReadEvidenceInput, 'resultFingerprintHash' | 'resultFingerprintSchema'>>,
  ): PersistReadEvidenceInput =>
    withOptional(
      {
        accessKind: descriptor.accessKind,
        captureMode: descriptor.evidencePolicy.captureMode,
        policyKey: descriptor.evidencePolicy.policyKey,
        readKey: descriptor.readKey,
        scope: input.scope,
        servingModuleKey: descriptor.owningModuleKey,
        ...row,
        ...input.permissionTargetMetadata,
      },
      'queryHash',
      input.queryHash,
    );
  /** One fenced, scoped write transaction: the read's own row and one row per call, all or none. */
  const settle = (
    row: PersistReadEvidenceInput,
  ): Effect.Effect<void, ReadEvidencePersistenceError | ReadHandlerUnavailable> =>
    runEvidence
      .settle({ admittedRevision: input.facts.compositionRevision, rows: [row, ...callRows], scope: input.scope })
      .pipe(
        Effect.mapError((failure) =>
          isTransactionAborted(failure)
            ? preserveFailureCause(
                new ReadHandlerUnavailable({
                  code: 'read_handler_unavailable',
                  reason: 'The Read evidence could not be written under the admitted composition',
                }),
                failure,
              )
            : failure,
        ),
      );
  const failedRow = (outcomeCode: string) =>
    readRow({ outcome: 'failed', outcomeCode, outcomeStage: 'execution', resultCount: 0 });
  /** Best effort: an evidence failure is logged and never replaces the read's own failure. */
  const settleFailure = (outcomeCode: string) =>
    Effect.exit(settle(failedRow(outcomeCode))).pipe(
      Effect.flatMap((evidenceExit) =>
        Exit.isFailure(evidenceExit)
          ? Effect.logError('The failed { run } Read evidence could not be written', evidenceExit.cause)
          : Effect.void,
      ),
    );

  // 5. Denied, whatever `run` returned: the session holds an owner denial, or `open` or `run` failed
  // with one, or the read's own code refused the caller.
  const { exit } = observation;
  const moduleDenial = Exit.isFailure(exit)
    ? failuresOf(exit.cause).find((failure) => Schema.is(ReadPermissionDenied)(failure))
    : undefined;
  const ownerDenied =
    observation.ownerDenied || (Exit.isFailure(exit) && abortReasonsOf(exit.cause).has('owner_denied'));
  if (ownerDenied || moduleDenial !== undefined) {
    const denial = Schema.is(ReadPermissionDenied)(moduleDenial) ? moduleDenial : ownerDenial();
    const evidenceExit = yield* Effect.exit(
      settle(
        readRow({ outcome: 'denied', outcomeCode: 'read_permission_denied', outcomeStage: 'authz', resultCount: 0 }),
      ),
    );
    // As on the one-transaction path: required evidence that could not be committed is the answer (the
    // denial stays in the cause), and no data is released either way.
    return yield* Effect.failCause(
      Exit.isFailure(evidenceExit) ? Cause.combine(evidenceExit.cause, Cause.fail(denial)) : Cause.fail(denial),
    );
  }

  // 6. Every other failure: the read's answer, with its failed row and the call rows.
  if (Exit.isFailure(exit)) {
    const answer = yield* answerForFailure(exit.cause, getReadDomainErrorSchema(registration));
    const [answerFailure] = failuresOf(answer);
    yield* settleFailure(answerFailure === undefined ? 'read_handler_defect' : outcomeCodeOf(answerFailure));
    return yield* Effect.failCause(answer);
  }

  // 4. Success: validate the result and its evidence, commit the evidence, then release the projection.
  const handlerResult = exit.value;
  const [result, evidence] = yield* Effect.all(
    [
      Schema.decodeUnknownEffect(Schema.toType(descriptor.resultSchema), { onExcessProperty: 'error' })(
        handlerResult.result,
      ).pipe(
        Effect.mapError((parseIssue) =>
          preserveFailureCause(
            new ReadResultValidationError({
              code: 'read_result_invalid',
              reason: 'The read result does not match its declared schema',
            }),
            parseIssue,
          ),
        ),
      ),
      validateReadEvidenceMetadata(descriptor.evidencePolicy.captureMode, handlerResult.evidence),
    ],
    { concurrency: 1 },
  ).pipe(Effect.tapError((validationFailure) => validationFailure.pipe(outcomeCodeOf, settleFailure)));
  yield* settle(
    readRow(
      withOptional(
        withOptional(
          {
            outcome: 'allowed' as const,
            outcomeCode: 'read_allowed',
            outcomeStage: 'evidence' as const,
            resultCount: evidence.resultCount,
          },
          'resultFingerprintHash',
          evidence.resultFingerprintHash,
        ),
        'resultFingerprintSchema',
        evidence.resultFingerprintSchema,
      ),
    ),
  );
  // The complete payload was validated and its evidence committed above; the caller receives the
  // projection of the field groups it may read (O17), released as computed.
  const projected = projectReadResultFields(result, input.deniedFieldPaths, descriptor.resultSchema);
  if (Option.isNone(projected)) {
    return yield* new ReadPermissionUnavailable({
      code: 'read_permission_unavailable',
      reason: 'The read result could not be projected onto the field groups this caller may read',
    });
  }
  return projected.value;
});

export const executeRunFormRead: ExecuteRunFormRead = executeRunFormReadEffect;
