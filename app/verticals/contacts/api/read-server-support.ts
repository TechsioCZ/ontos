/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then, unicorn/switch-case-braces -- Effect owns typed callback composition for the closed Read runtime error union. */
import type { ReadCoreError } from '@app/core-runtime';
import { Effect, HttpEffect, HttpServerResponse } from '@modern-js/plugin-bff/effect-edge';
import { Config } from 'effect';
import { verifyOperationPrincipal } from './auth/action-principal.ts';
import type { ActionPrincipalError } from './auth/action-principal.ts';

interface HttpProblem {
  readonly status: number;
}

interface ReadProblemSet<
  Authentication extends HttpProblem,
  Forbidden extends HttpProblem,
  Internal extends HttpProblem,
  Invalid extends HttpProblem,
  Unavailable extends HttpProblem,
  NotFound extends HttpProblem,
> {
  readonly authentication: () => Authentication;
  readonly forbidden: () => Forbidden;
  readonly internal: () => Internal;
  readonly invalid: () => Invalid;
  readonly notFound?: () => NotFound;
  readonly unavailable: () => Unavailable;
}

const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer')),
);

export const requireCorrelationId = <Problem>(
  correlationId: string | undefined,
  invalid: () => Problem,
) =>
  correlationId === undefined || correlationId.trim().length === 0
    ? Effect.fail(invalid())
    : Effect.succeed(correlationId);

export const verifyReadPrincipal = <
  Authentication extends HttpProblem,
  Unavailable extends HttpProblem,
>(
  authorization: string | undefined,
  problems: {
    readonly authentication: () => Authentication;
    readonly unavailable: () => Unavailable;
  },
) =>
  Config.all({
    ONTOS_GATEWAY_ISSUER: Config.string('ONTOS_GATEWAY_ISSUER'),
    ONTOS_GATEWAY_PUBLIC_JWKS: Config.string('ONTOS_GATEWAY_PUBLIC_JWKS'),
  }).pipe(
    Effect.mapError(problems.unavailable),
    Effect.flatMap((environment) => verifyOperationPrincipal(authorization, { environment })),
    Effect.catch((error: ActionPrincipalError | Unavailable) => {
      if ('status' in error) {
        return Effect.fail(error);
      }
      const principalError = error;
      const unavailable =
        principalError._tag === 'ActionPrincipalConfigurationError' ||
        principalError._tag === 'ActionPrincipalUnavailableError';
      return (unavailable ? Effect.void : bearerChallenge).pipe(
        Effect.andThen(
          Effect.fail(unavailable ? problems.unavailable() : problems.authentication()),
        ),
      );
    }),
  );

export const mapReadProblem = <
  Authentication extends HttpProblem,
  Forbidden extends HttpProblem,
  Internal extends HttpProblem,
  Invalid extends HttpProblem,
  Unavailable extends HttpProblem,
  NotFound extends HttpProblem = never,
>(
  error: ReadCoreError,
  problems: ReadProblemSet<Authentication, Forbidden, Internal, Invalid, Unavailable, NotFound>,
): Authentication | Forbidden | Internal | Invalid | Unavailable | NotFound => {
  switch (error._tag) {
    case 'ReadInputValidationError':
      return problems.invalid();
    case 'OperationAuthenticationRequired':
      return problems.authentication();
    case 'ModuleStateDeniedError':
    case 'OperationContextDenied':
    case 'OperationContextInvalid':
    case 'ReadPermissionDenied':
      return problems.forbidden();
    case 'ReadHandlerNotFound':
      return problems.notFound === undefined ? problems.internal() : problems.notFound();
    case 'ReadPolicyDenied':
      // Contacts read registrations have no policies; reaching this branch is an internal invariant breach.
      return problems.internal();
    case 'ModuleStateCheckUnavailableError':
    case 'OperationContextUnavailable':
    case 'ReadEvidencePersistenceError':
    case 'ReadHandlerUnavailable':
    case 'ReadPermissionUnavailable':
    case 'ReadPolicyEvaluationError':
      return problems.unavailable();
    case 'ReadHandlerExecutionError':
    case 'ReadEvidenceValidationError':
    case 'ReadResultValidationError':
      return problems.internal();
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
};

export const failReadProblem = <Problem extends HttpProblem>(problem: Problem) =>
  (problem.status === 401 ? bearerChallenge : Effect.void).pipe(
    Effect.andThen(Effect.fail(problem)),
  );
