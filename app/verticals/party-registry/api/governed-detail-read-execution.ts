import type { HttpServerRequest } from '@modern-js/plugin-bff/effect-edge';
import {
  ReadEvidenceValidationError,
  ReadHandlerExecutionError,
  ReadResultValidationError,
  ReadRuntime,
} from '@app/core-runtime';
import type { ReadCoreError, ReadRegistration } from '@app/core-runtime';
import { Effect, HttpEffect, HttpServerResponse } from '@modern-js/plugin-bff/effect-edge';
import { Cause, Match, Redacted, Schema } from 'effect';
import { authenticateOperationPrincipal } from './auth/action-principal.ts';

interface ReadProblems<
  Authentication,
  Forbidden,
  Internal,
  Invalid,
  NotFound,
  Policy,
  Unavailable,
> {
  readonly authentication: (cause?: unknown) => Authentication;
  readonly forbidden: (cause?: unknown) => Forbidden;
  readonly internal: (cause?: unknown) => Internal;
  readonly invalid: (cause?: unknown) => Invalid;
  readonly notFound: (cause?: unknown) => NotFound;
  readonly policy: (status: 409 | 422, cause?: unknown) => Policy;
  readonly unavailable: (cause?: unknown) => Unavailable;
}

const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer')),
);
const isInternalReadError = Schema.is(
  Schema.Union([ReadEvidenceValidationError, ReadHandlerExecutionError, ReadResultValidationError]),
);
const hasInternalReadFailure = (cause: Cause.Cause<ReadCoreError>) =>
  cause.reasons.some((reason) => Cause.isFailReason(reason) && isInternalReadError(reason.error));

const mapReadProblem = <A, F, I, V, N, P, U>(
  problem: ReadProblems<A, F, I, V, N, P, U>,
  error: ReadCoreError,
) =>
  Match.value(error).pipe(
    Match.tags({
      ModuleStateCheckUnavailableError: problem.unavailable,
      ModuleStateDeniedError: problem.forbidden,
      OperationAuthenticationRequired: problem.authentication,
      OperationContextDenied: problem.forbidden,
      OperationContextInvalid: problem.forbidden,
      OperationContextUnavailable: problem.unavailable,
      ReadEvidencePersistenceError: problem.unavailable,
      ReadEvidenceValidationError: problem.internal,
      ReadHandlerExecutionError: problem.internal,
      ReadHandlerNotFound: problem.notFound,
      ReadHandlerUnavailable: problem.unavailable,
      ReadInputValidationError: problem.invalid,
      ReadPermissionDenied: problem.forbidden,
      ReadPermissionUnavailable: problem.unavailable,
      ReadPolicyDenied: (failure) => problem.policy(failure.httpStatus, failure),
      ReadPolicyEvaluationError: problem.unavailable,
      ReadResultValidationError: problem.internal,
    }),
    Match.exhaustive,
  );

export const executeGovernedRead = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  HandlerError,
  Requirements,
  A,
  F,
  I,
  V,
  N,
  P,
  U,
>(options: {
  readonly registration: ReadRegistration<
    InputSchema,
    ResultSchema,
    Owner,
    Services,
    HandlerError,
    Requirements
  >;
  readonly problem: ReadProblems<A, F, I, V, N, P, U>;
  readonly isAuthenticationProblem: (
    value: ReturnType<typeof mapReadProblem<A, F, I, V, N, P, U>>,
  ) => boolean;
  readonly internalFailureMessage?: string;
}) =>
  Effect.fn(function* executeRead({
    payload,
    request,
  }: {
    readonly payload: unknown;
    readonly request: HttpServerRequest.HttpServerRequest;
  }) {
    const { problem } = options;
    const correlationId = request.headers['x-correlation-id'];
    if (correlationId === undefined || correlationId.trim().length === 0) {
      return yield* Effect.fail(problem.invalid());
    }
    const principal = yield* authenticateOperationPrincipal(
      Redacted.make(request.headers['authorization']),
      {
        authentication: () => problem.authentication(),
        unavailable: () => problem.unavailable(),
      },
    );
    const runtime = yield* ReadRuntime;
    const read = runtime.runRead({
      input: payload,
      principal,
      registration: options.registration,
      transport: { correlationId },
    });
    const message = options.internalFailureMessage;
    const loggedRead =
      message === undefined
        ? read
        : read.pipe(
            Effect.tapCauseIf(hasInternalReadFailure, (cause) =>
              Effect.logError(message).pipe(Effect.annotateLogs({ cause })),
            ),
          );
    return yield* loggedRead.pipe(
      Effect.catch((error) => {
        const mapped = mapReadProblem(problem, error);
        return (options.isAuthenticationProblem(mapped) ? bearerChallenge : Effect.void).pipe(
          Effect.andThen(Effect.fail(mapped)),
        );
      }),
    );
  });
