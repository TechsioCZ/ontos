/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then, unicorn/switch-case-braces -- Effect owns typed callback composition for the closed Read runtime error union. */
import type { ReadCoreError } from '@app/core-runtime';
import { Effect, HttpEffect, HttpServerResponse } from '@modern-js/plugin-bff/effect-edge';
import { Config } from 'effect';
import { verifyOperationPrincipal } from './auth/action-principal.ts';
import type { ActionPrincipalError } from './auth/action-principal.ts';

interface HttpProblem {
  readonly status: number;
}

interface ReadProblemSet {
  readonly authentication: () => HttpProblem;
  readonly forbidden: () => HttpProblem;
  readonly internal: () => HttpProblem;
  readonly invalid: () => HttpProblem;
  readonly notFound?: () => HttpProblem;
  readonly unavailable: () => HttpProblem;
}

type ReadProblem<Problems extends ReadProblemSet> = {
  [Key in keyof Problems]-?: Problems[Key] extends (...arguments_: never[]) => infer Problem
    ? Problem
    : never;
}[keyof Problems];

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
      if ('status' in error && typeof error.status === 'number') {
        return Effect.fail(error as Unavailable);
      }
      const principalError = error as ActionPrincipalError;
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

export const mapReadProblem = <Problems extends ReadProblemSet>(
  error: ReadCoreError,
  problems: Problems,
): ReadProblem<Problems> => {
  const select = <Key extends keyof Problems>(key: Key): ReadProblem<Problems> =>
    (problems[key] as () => ReadProblem<Problems>)();
  switch (error._tag) {
    case 'ReadInputValidationError':
      return select('invalid');
    case 'OperationAuthenticationRequired':
      return select('authentication');
    case 'ModuleStateDeniedError':
    case 'OperationContextDenied':
    case 'OperationContextInvalid':
    case 'ReadPermissionDenied':
      return select('forbidden');
    case 'ReadHandlerNotFound':
      return problems.notFound === undefined ? select('internal') : select('notFound');
    case 'ReadPolicyDenied':
      // CRM read registrations have no policies; reaching this branch is an internal invariant breach.
      return select('internal');
    case 'ModuleStateCheckUnavailableError':
    case 'OperationContextUnavailable':
    case 'ReadEvidencePersistenceError':
    case 'ReadHandlerUnavailable':
    case 'ReadPermissionUnavailable':
    case 'ReadPolicyEvaluationError':
      return select('unavailable');
    case 'ReadHandlerExecutionError':
    case 'ReadEvidenceValidationError':
    case 'ReadResultValidationError':
      return select('internal');
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
