import { Cause, Effect, Exit, Result, Schema } from 'effect';
import type { Redacted } from 'effect';
import type { Headers } from 'effect/http';

import type { ActionTransportMetadata } from '../actions/context.ts';
import type { ActionRegistration } from '../actions/definition.ts';
import { ActionAlreadyCommitted } from '../actions/errors.ts';
import type { ActionCoreError } from '../actions/errors.ts';
import type { DomainEventContractMap } from '../actions/events.ts';
import type { ActionProposalSuccess, ActionSuccessContract } from '../actions/proposal-accepted.ts';
import { transportIdentifier } from '../actions/string-schemas.ts';
import type { OperationalScopeRequest } from '../operations/context.ts';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import { ActionRuntime } from '../actions/runtime.ts';
import { withOwnerServerTiming } from './owner-server-timing.ts';

export { ActionProposalAcceptedSchema } from '../actions/proposal-accepted.ts';

export interface ActionHttpEndpointHeaders {
  readonly idempotencyKey: string | undefined;
  /**
   * O80: the explicit proposal intent. It travels beside the payload like the other transport
   * metadata, and an endpoint whose contract carries no 202 refuses it (O85).
   */
  readonly intent?: 'propose' | undefined;
  readonly traceId: string | undefined;
}

const ActionIdempotencyKeySchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand('ActionIdempotencyKey'),
);
const ActionCorrelationIdSchema = transportIdentifier.pipe(Schema.brand('ActionCorrelationId'));
const ActionIntentSchema = Schema.Literal('propose');
const ActionTraceIdSchema = transportIdentifier.pipe(Schema.brand('ActionTraceId'));

/**
 * Reads the Action transport headers an HTTP handler owns. Endpoint contracts declare no header
 * codec: the composed API decodes closed, and a header codec would receive every browser header.
 * Every caller-supplied transport identifier is bounded here, because each one is persisted verbatim
 * into the action invocation audit row: an unbounded value lets the caller choose the audit
 * correlation and inflate the row up to the ingress header limit. A supplied Idempotency-Key is decoded
 * alongside the trace identifier; absence of an Idempotency-Key still reaches the runtime's own 428
 * precondition. The proposal intent is a closed literal, so only `propose` is ever transported (O80).
 */
export const decodeActionEndpointHeaders = Effect.fn('HttpInstrumentationSeam.decodeActionEndpointHeaders')(
  function* decodeActionEndpointHeadersEffect(
    headers: Headers.Headers,
  ): Effect.fn.Return<ActionHttpEndpointHeaders, Schema.SchemaError> {
    const idempotencyKey = headers['idempotency-key'];
    const intent = headers['x-action-intent'];
    const traceId = headers['x-trace-id'];
    const decodedIdempotencyKey =
      idempotencyKey === undefined ? undefined : yield* Schema.decodeEffect(ActionIdempotencyKeySchema)(idempotencyKey);
    // A proposal intent is the only intent a module endpoint transports; it is a closed literal, so an
    // unrecognized value is a decode failure rather than a silently ignored request mode (O80).
    const decodedIntent =
      intent === undefined ? undefined : yield* Schema.decodeUnknownEffect(ActionIntentSchema)(intent);
    const decodedTraceId = traceId === undefined ? undefined : yield* Schema.decodeEffect(ActionTraceIdSchema)(traceId);
    if (decodedIntent === undefined) {
      return { idempotencyKey: decodedIdempotencyKey, traceId: decodedTraceId };
    }
    return { idempotencyKey: decodedIdempotencyKey, intent: decodedIntent, traceId: decodedTraceId };
  },
);

export interface ActionHttpRequestHeaders {
  readonly authorization: Redacted.Redacted<string | undefined>;
  readonly 'x-correlation-id'?: string | undefined;
}

export interface ActionHttpPrincipalAuthentication<Problem, Requirements> {
  readonly authenticate: (
    authorization: Redacted.Redacted<string | undefined>,
  ) => Effect.Effect<TrustedPrincipalContext, Problem, Requirements>;
}

export type ActionHttpErrorAfterCommittedRecovery<DomainError> =
  | Exclude<ActionCoreError, ActionAlreadyCommitted>
  | DomainError;

interface GovernedActionHttpRunnerBaseInput<
  PayloadSchema extends Schema.ConstraintDecoder<unknown> & Schema.ConstraintEncoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
  Services,
  HandlerRequirements,
  InvalidProblem,
  InternalProblem,
  PrincipalProblem,
  PrincipalRequirements,
  SuccessContract extends ActionSuccessContract = 'result',
> {
  /** Trusted receiver configuration, never a request header or payload field. */
  readonly audience?: string;
  readonly endpointHeaders: ActionHttpEndpointHeaders;
  readonly internalProblem: () => InternalProblem;
  readonly invalidCorrelationProblem: () => InvalidProblem;
  readonly payload: NoInfer<PayloadSchema['Type']>;
  readonly principal: ActionHttpPrincipalAuthentication<PrincipalProblem, PrincipalRequirements>;
  readonly registration: ActionRegistration<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Owner,
    Services,
    HandlerRequirements
  >;
  readonly requestHeaders: ActionHttpRequestHeaders;
  /**
   * O85: the endpoint's own declared success contract, mirrored from its `success` schema. An endpoint
   * that declares `result-or-proposal` answers the parked-proposal 202; every other endpoint keeps the
   * single result type, so its response contract is never widened on the runner's behalf.
   */
  readonly successContract?: SuccessContract | undefined;
}

type ActionHttpCommittedRecovery<RecoveryResult, DomainError, MappedProblem> =
  | {
      readonly mapError: (error: ActionCoreError | DomainError) => MappedProblem;
      readonly recoverAlreadyCommitted?: undefined;
    }
  | {
      readonly mapError: (error: ActionHttpErrorAfterCommittedRecovery<DomainError>) => MappedProblem;
      /** Endpoint-owned translation of a committed retry into its declared success contract. */
      readonly recoverAlreadyCommitted: (failure: ActionAlreadyCommitted) => RecoveryResult;
    };

export type GovernedActionHttpRunnerInput<
  PayloadSchema extends Schema.ConstraintDecoder<unknown> & Schema.ConstraintEncoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
  Services,
  HandlerRequirements,
  MappedProblem,
  InvalidProblem,
  InternalProblem,
  PrincipalProblem,
  PrincipalRequirements,
  RecoveryResult = never,
  SuccessContract extends ActionSuccessContract = 'result',
> = GovernedActionHttpRunnerBaseInput<
  PayloadSchema,
  ResultSchema,
  DomainErrorSchema,
  DomainEvents,
  Owner,
  Services,
  HandlerRequirements,
  InvalidProblem,
  InternalProblem,
  PrincipalProblem,
  PrincipalRequirements,
  SuccessContract
> &
  ActionHttpCommittedRecovery<RecoveryResult, DomainErrorSchema['Type'], MappedProblem>;

export type GovernedActionHttpEndpointInput<
  PayloadSchema extends Schema.ConstraintDecoder<unknown> & Schema.ConstraintEncoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
  Services,
  HandlerRequirements,
  MappedProblem,
  InvalidProblem,
  InternalProblem,
  RecoveryResult = never,
  SuccessContract extends ActionSuccessContract = 'result',
> = Omit<
  GovernedActionHttpRunnerBaseInput<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Owner,
    Services,
    HandlerRequirements,
    InvalidProblem,
    InternalProblem,
    never,
    never,
    SuccessContract
  >,
  'payload' | 'principal'
> & {
  readonly payload: NoInfer<PayloadSchema['Type']>;
} & ActionHttpCommittedRecovery<RecoveryResult, DomainErrorSchema['Type'], MappedProblem>;

const recoverUnexpectedDefect = <Value, Failure, InternalFailure, Requirements>(
  effect: Effect.Effect<Value, Failure, Requirements>,
  actionKey: string,
  safeCorrelationId: string,
  internalProblem: () => InternalFailure,
): Effect.Effect<Value, Failure | InternalFailure, Requirements> =>
  Effect.exit(effect).pipe(
    Effect.flatMap((exit): Effect.Effect<Value, Failure | InternalFailure> => {
      if (Exit.isSuccess(exit)) {
        return Effect.succeed(exit.value);
      }
      if (!exit.cause.reasons.some(Cause.isDieReason)) {
        return Effect.failCause(exit.cause);
      }
      return Effect.logError('Unexpected governed Action HTTP defect', exit.cause).pipe(
        Effect.annotateLogs({ actionKey, correlationId: safeCorrelationId }),
        Effect.andThen(Effect.fail(internalProblem())),
      );
    }),
  );

/**
 * Executes one decoded Action HTTP request while leaving all endpoint semantics in the owner.
 * The caller owns authentication and the exhaustive public Action/domain failure mapping.
 */
export const runGovernedActionHttp = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown> & Schema.ConstraintEncoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
  Services,
  HandlerRequirements,
  MappedProblem,
  InvalidProblem,
  InternalProblem,
  PrincipalProblem,
  PrincipalRequirements,
  RecoveryResult = never,
  SuccessContract extends ActionSuccessContract = 'result',
>(
  input: GovernedActionHttpRunnerInput<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Owner,
    Services,
    HandlerRequirements,
    MappedProblem,
    InvalidProblem,
    InternalProblem,
    PrincipalProblem,
    PrincipalRequirements,
    RecoveryResult,
    SuccessContract
  >,
): Effect.Effect<
  ResultSchema['Type'] | RecoveryResult | ActionProposalSuccess<SuccessContract>,
  InternalProblem | InvalidProblem | MappedProblem | PrincipalProblem,
  ActionRuntime | HandlerRequirements | PrincipalRequirements
> => {
  const correlationId = input.requestHeaders['x-correlation-id'];
  const correlationIsInvalid = correlationId === undefined || correlationId.trim().length === 0;
  const safeCorrelationId = correlationIsInvalid ? 'invalid' : correlationId;
  const program = Effect.gen(function* runGovernedActionProgram() {
    if (correlationIsInvalid) {
      return yield* Effect.fail(input.invalidCorrelationProblem());
    }
    // The correlation identifier is written verbatim into the invocation row and log annotations, so an
    // unbounded caller-chosen value must be refused here rather than persisted. Branching on the decode result
    // keeps the schema's diagnostic out of the response shape without discarding it in an error callback.
    if (Result.isFailure(Schema.decodeUnknownResult(ActionCorrelationIdSchema)(correlationId))) {
      return yield* Effect.fail(input.invalidCorrelationProblem());
    }

    const principal = yield* input.principal.authenticate(input.requestHeaders.authorization);
    const encodedPayload = yield* Schema.encodeEffect(input.registration.descriptor.payloadSchema)(input.payload).pipe(
      Effect.orDie,
    );
    const runtime = yield* ActionRuntime;
    let receivingAudience: Pick<OperationalScopeRequest, 'audience'> = {};
    if (input.audience !== undefined) {
      receivingAudience = { audience: input.audience };
    }
    let transport: ActionTransportMetadata;
    if (input.endpointHeaders.idempotencyKey === undefined) {
      transport =
        input.endpointHeaders.traceId === undefined
          ? { correlationId }
          : { correlationId, traceId: input.endpointHeaders.traceId };
    } else {
      transport =
        input.endpointHeaders.traceId === undefined
          ? {
              correlationId,
              idempotencyKey: input.endpointHeaders.idempotencyKey,
            }
          : {
              correlationId,
              idempotencyKey: input.endpointHeaders.idempotencyKey,
              traceId: input.endpointHeaders.traceId,
            };
    }
    // O80: an explicit proposal intent reaches the runner only from the endpoint's own transport
    // metadata; a result-only endpoint answers it with a refusal inside the runtime (O85).
    if (input.endpointHeaders.intent !== undefined) {
      transport = { ...transport, intent: input.endpointHeaders.intent };
    }
    const action = runtime.runAction({
      ...receivingAudience,
      payload: encodedPayload,
      principal,
      registration: input.registration,
      successContract: input.successContract,
      transport,
    });
    if (input.recoverAlreadyCommitted === undefined) {
      return yield* action.pipe(Effect.mapError(input.mapError));
    }
    const endpointResult = action.pipe(
      Effect.catchIf(Schema.is(ActionAlreadyCommitted), (failure) =>
        Effect.sync(() => input.recoverAlreadyCommitted(failure)),
      ),
    );
    return yield* endpointResult.pipe(Effect.mapError(input.mapError));
  });

  // The owner's phases go back to its caller in `server-timing`, whatever the Action ends in.
  return recoverUnexpectedDefect(
    withOwnerServerTiming(program),
    input.registration.descriptor.actionKey,
    safeCorrelationId,
    input.internalProblem,
  );
};

/** Binds one deployment's generated principal adapter without owning endpoint semantics. */
export const bindGovernedActionHttp =
  <PrincipalProblem, PrincipalRequirements>(
    principal: ActionHttpPrincipalAuthentication<PrincipalProblem, PrincipalRequirements>,
  ) =>
  <
    PayloadSchema extends Schema.ConstraintDecoder<unknown> & Schema.ConstraintEncoder<unknown>,
    ResultSchema extends Schema.ConstraintDecoder<unknown>,
    DomainErrorSchema extends Schema.ConstraintDecoder<{
      readonly _tag: string;
    }>,
    DomainEvents extends DomainEventContractMap,
    Owner extends string,
    Services,
    HandlerRequirements,
    MappedProblem,
    InvalidProblem,
    InternalProblem,
    RecoveryResult = never,
    SuccessContract extends ActionSuccessContract = 'result',
  >(
    input: GovernedActionHttpEndpointInput<
      PayloadSchema,
      ResultSchema,
      DomainErrorSchema,
      DomainEvents,
      Owner,
      Services,
      HandlerRequirements,
      MappedProblem,
      InvalidProblem,
      InternalProblem,
      RecoveryResult,
      SuccessContract
    >,
  ) =>
    runGovernedActionHttp({ ...input, principal });
