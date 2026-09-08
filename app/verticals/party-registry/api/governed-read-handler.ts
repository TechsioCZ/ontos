import { ReadRuntime } from '@app/core-runtime';
import type { ReadCoreError, ReadRegistration } from '@app/core-runtime';
import { Effect, HttpEffect, HttpServerResponse } from '@modern-js/plugin-bff/effect-edge';
import type { HttpServerRequest } from '@modern-js/plugin-bff/effect-edge';
import { Match, Redacted } from 'effect';
import type { Schema } from 'effect';
import { authenticateOperationPrincipal } from './auth/action-principal.ts';

export interface GovernedReadProblems<Problem> {
  readonly authentication: () => Problem;
  readonly forbidden: () => Problem;
  readonly internal: () => Problem;
  readonly invalid: () => Problem;
  readonly notFound: () => Problem;
  readonly policy: (status: 409 | 422) => Problem;
  readonly unavailable: () => Problem;
  readonly isAuthentication: (problem: Problem) => boolean;
}

const readProblem = <Problem>(error: ReadCoreError, problems: GovernedReadProblems<Problem>) =>
  Match.value(error).pipe(
    Match.tags({
      ModuleStateCheckUnavailableError: () => problems.unavailable,
      ModuleStateDeniedError: () => problems.forbidden,
      OperationAuthenticationRequired: () => problems.authentication,
      OperationContextDenied: () => problems.forbidden,
      OperationContextInvalid: () => problems.forbidden,
      OperationContextUnavailable: () => problems.unavailable,
      ReadEvidencePersistenceError: () => problems.unavailable,
      ReadEvidenceValidationError: () => problems.internal,
      ReadHandlerExecutionError: () => problems.internal,
      ReadHandlerNotFound: () => problems.notFound,
      ReadHandlerUnavailable: () => problems.unavailable,
      ReadInputValidationError: () => problems.invalid,
      ReadPermissionDenied: () => problems.forbidden,
      ReadPermissionUnavailable: () => problems.unavailable,
      ReadPolicyDenied:
        ({ httpStatus }) =>
        () =>
          problems.policy(httpStatus),
      ReadPolicyEvaluationError: () => problems.unavailable,
      ReadResultValidationError: () => problems.internal,
    }),
    Match.exhaustive,
  )();

const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer')),
);

const failReadProblem = <Problem>(
  error: ReadCoreError,
  problems: GovernedReadProblems<Problem>,
) => {
  const problem = readProblem(error, problems);
  return (problems.isAuthentication(problem) ? bearerChallenge : Effect.void).pipe(
    Effect.andThen(Effect.fail(problem)),
  );
};

interface GovernedReadRequest {
  readonly payload: unknown;
  readonly request: HttpServerRequest.HttpServerRequest;
}

/** Preserve the HTTP acquisition order and typed failures for each registered read. */
export const governedReadHandler = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  HandlerError,
  Requirements,
  Problem,
>(options: {
  readonly spanName: string;
  readonly registration: ReadRegistration<
    InputSchema,
    ResultSchema,
    Owner,
    Services,
    HandlerError,
    Requirements
  >;
  readonly problems: GovernedReadProblems<Problem>;
}) =>
  Effect.fn(options.spanName)(function* executeGovernedRead({
    payload,
    request,
  }: GovernedReadRequest) {
    const { problems } = options;
    const correlationId = request.headers['x-correlation-id'];
    if (correlationId === undefined || correlationId.trim().length === 0) {
      return yield* Effect.fail(problems.invalid());
    }
    const principal = yield* authenticateOperationPrincipal(
      Redacted.make(request.headers['authorization']),
      {
        authentication: problems.authentication,
        unavailable: problems.unavailable,
      },
    );
    const runtime = yield* ReadRuntime;
    return yield* runtime
      .runRead({
        input: payload,
        principal,
        registration: options.registration,
        transport: { correlationId },
      })
      .pipe(Effect.catch((error) => failReadProblem(error, problems)));
  });
