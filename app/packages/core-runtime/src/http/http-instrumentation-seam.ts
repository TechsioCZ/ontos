import { Cause, Effect, Exit, Schema } from 'effect';
import type { Redacted } from 'effect';

import type { ActionTransportMetadata } from '../actions/context.ts';
import type { ActionRegistration } from '../actions/definition.ts';
import type { ActionCoreError } from '../actions/errors.ts';
import type { DomainEventContractMap } from '../actions/events.ts';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import { ActionRuntime } from '../actions/runtime.ts';

export interface ActionHttpEndpointHeaders {
  readonly idempotencyKey: string | undefined;
  readonly traceId: string | undefined;
}

export interface ActionHttpRequestHeaders {
  readonly authorization: Redacted.Redacted<string | undefined>;
  readonly 'x-correlation-id'?: string | undefined;
}

export interface ActionHttpPrincipalAuthentication<Problem, Requirements> {
  readonly authenticate: (
    authorization: Redacted.Redacted<string | undefined>,
  ) => Effect.Effect<TrustedPrincipalContext, Problem, Requirements>;
}

export interface GovernedActionHttpRunnerInput<
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
> {
  readonly endpointHeaders: ActionHttpEndpointHeaders;
  readonly internalProblem: () => InternalProblem;
  readonly invalidCorrelationProblem: () => InvalidProblem;
  readonly mapError: (error: ActionCoreError | DomainErrorSchema['Type']) => MappedProblem;
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
> = Omit<
  GovernedActionHttpRunnerInput<
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
    never,
    never
  >,
  'payload' | 'principal'
> & {
  readonly payload: NoInfer<PayloadSchema['Type']>;
};

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
    PrincipalRequirements
  >,
): Effect.Effect<
  ResultSchema['Type'],
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
    return yield* runtime
      .runAction({
        payload: encodedPayload,
        principal,
        registration: input.registration,
        transport,
      })
      .pipe(Effect.mapError(input.mapError));
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
      InternalProblem
    >,
  ) =>
    runGovernedActionHttp({ ...input, principal });
