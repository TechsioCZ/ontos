import { Cause, Effect, Exit, Schema } from 'effect';
import type { Redacted } from 'effect';
import type { Headers } from 'effect/unstable/http';

import type { ActionTransportMetadata } from '../actions/context.ts';
import type { ActionRegistration } from '../actions/definition.ts';
import { ActionAlreadyCommitted } from '../actions/errors.ts';
import type { ActionCoreError } from '../actions/errors.ts';
import type { DomainEventContractMap } from '../actions/events.ts';
import type { OperationalScopeRequest } from '../operations/context.ts';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import { ActionRuntime } from '../actions/runtime.ts';

export interface ActionHttpEndpointHeaders {
  readonly idempotencyKey: string | undefined;
  readonly traceId: string | undefined;
}

const ActionIdempotencyKeySchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand('ActionIdempotencyKey'),
);

/**
 * Reads the Action transport headers an HTTP handler owns. Endpoint contracts declare no header
 * codec: the composed API decodes closed, and a header codec would receive every browser header.
 * A supplied Idempotency-Key is decoded alone; absence reaches the runtime's own 428 precondition.
 */
export const decodeActionEndpointHeaders = (
  headers: Headers.Headers,
): Effect.Effect<ActionHttpEndpointHeaders, Schema.SchemaError> => {
  const idempotencyKey = headers['idempotency-key'];
  const traceId = headers['x-trace-id'];
  if (idempotencyKey === undefined) {
    return Effect.succeed({ idempotencyKey, traceId });
  }
  return Schema.decodeEffect(ActionIdempotencyKeySchema)(idempotencyKey).pipe(
    Effect.map((decodedKey) => ({ idempotencyKey: decodedKey, traceId })),
  );
};

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
  PrincipalRequirements
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
    never
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
    RecoveryResult
  >,
): Effect.Effect<
  ResultSchema['Type'] | RecoveryResult,
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
    const action = runtime.runAction({
      ...receivingAudience,
      payload: encodedPayload,
      principal,
      registration: input.registration,
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

  return recoverUnexpectedDefect(
    program,
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
      RecoveryResult
    >,
  ) =>
    runGovernedActionHttp({ ...input, principal });
