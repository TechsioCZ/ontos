import { Cause, Effect, Match, Redacted } from 'effect';
import type { Schema } from 'effect';
import { HttpEffect, HttpServerResponse } from 'effect/unstable/http';
import type { HttpServerRequest } from 'effect/unstable/http';

import type { TrustedPrincipalContext } from '../actions/context.ts';
import type { ReadRegistration } from '../reads/definition.ts';
import type { ReadCoreError } from '../reads/errors.ts';
import { ReadRuntime } from '../reads/runtime.ts';

interface HttpProblem<Status extends number> {
  readonly status: Status;
}

export const governedReadHttpStatus = {
  authentication: 401,
  forbidden: 403,
  internal: 500,
  invalid: 400,
  notFound: 404,
  policyConflict: 409,
  policyIneligible: 422,
  unavailable: 503,
} as const;

type ProblemFactory<Problem> = () => Problem;

export interface GovernedReadHttpProblemSet<
  Authentication extends HttpProblem<401>,
  Forbidden extends HttpProblem<403>,
  Internal extends HttpProblem<500>,
  Invalid extends HttpProblem<400>,
  NotFound extends HttpProblem<404>,
  PolicyConflict extends HttpProblem<409>,
  PolicyIneligible extends HttpProblem<422>,
  Unavailable extends HttpProblem<503>,
> {
  readonly authentication: ProblemFactory<Authentication>;
  readonly forbidden: ProblemFactory<Forbidden>;
  readonly internal: ProblemFactory<Internal>;
  readonly invalid: ProblemFactory<Invalid>;
  readonly notFound: ProblemFactory<NotFound>;
  readonly policyConflict: ProblemFactory<PolicyConflict>;
  readonly policyIneligible: ProblemFactory<PolicyIneligible>;
  readonly unavailable: ProblemFactory<Unavailable>;
}

export type GovernedReadPrincipalAuthentication<Requirements, Authentication, Unavailable> = (
  authorization: Redacted.Redacted<string | undefined>,
  problems: PrincipalAuthenticationProblems<Authentication, Unavailable>,
) => Effect.Effect<TrustedPrincipalContext, Authentication | Unavailable, Requirements>;

interface PrincipalAuthenticationProblems<Authentication, Unavailable> {
  readonly authentication: ProblemFactory<Authentication>;
  readonly unavailable: ProblemFactory<Unavailable>;
}

/** Exhaustive transport mapping for the closed Core governed-read failure vocabulary. */
export function classifyReadCoreError<
  Authentication extends HttpProblem<401>,
  Forbidden extends HttpProblem<403>,
  Internal extends HttpProblem<500>,
  Invalid extends HttpProblem<400>,
  NotFound extends HttpProblem<404>,
  PolicyConflict extends HttpProblem<409>,
  PolicyIneligible extends HttpProblem<422>,
  Unavailable extends HttpProblem<503>,
>(
  error: ReadCoreError,
  problems: GovernedReadHttpProblemSet<
    Authentication,
    Forbidden,
    Internal,
    Invalid,
    NotFound,
    PolicyConflict,
    PolicyIneligible,
    Unavailable
  >,
): Authentication | Forbidden | Internal | Invalid | NotFound | PolicyConflict | PolicyIneligible | Unavailable;
export function classifyReadCoreError(
  error: ReadCoreError,
  problems: GovernedReadHttpProblemSet<
    HttpProblem<401>,
    HttpProblem<403>,
    HttpProblem<500>,
    HttpProblem<400>,
    HttpProblem<404>,
    HttpProblem<409>,
    HttpProblem<422>,
    HttpProblem<503>
  >,
): HttpProblem<number> {
  const readPolicyDenied = (denial: Extract<ReadCoreError, { _tag: 'ReadPolicyDenied' }>) =>
    denial.httpStatus === 409 ? problems.policyConflict() : problems.policyIneligible();
  return Match.value(error).pipe(
    Match.tags({
      ModuleStateCheckUnavailableError: problems.unavailable,
      ModuleStateDeniedError: problems.forbidden,
      OperationAuthenticationRequired: problems.authentication,
      OperationContextDenied: problems.forbidden,
      OperationContextInvalid: problems.forbidden,
      OperationContextUnavailable: problems.unavailable,
      ReadEvidencePersistenceError: problems.unavailable,
      ReadEvidenceValidationError: problems.internal,
      ReadHandlerExecutionError: problems.internal,
      ReadHandlerNotFound: problems.notFound,
      ReadHandlerUnavailable: problems.unavailable,
      ReadInputValidationError: problems.invalid,
      ReadPermissionDenied: problems.forbidden,
      ReadPermissionUnavailable: problems.unavailable,
      ReadPolicyDenied: readPolicyDenied,
      ReadPolicyEvaluationError: problems.unavailable,
      ReadResultValidationError: problems.internal,
    }),
    Match.exhaustive,
  );
}

const bearerChallenge = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'www-authenticate', 'Bearer')),
);

const failProblem = <Problem extends HttpProblem<number>>(problem: Problem) =>
  (problem.status === 401 ? bearerChallenge : Effect.void).pipe(Effect.andThen(Effect.fail(problem)));

interface GovernedReadRequest<Payload> {
  readonly payload: Payload;
  readonly request: Pick<HttpServerRequest.HttpServerRequest, 'headers'>;
}

export const makeGovernedReadHttpHandler = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  HandlerError,
  ReadRequirements,
  VerifierRequirements,
  Authentication extends HttpProblem<401>,
  Forbidden extends HttpProblem<403>,
  Internal extends HttpProblem<500>,
  Invalid extends HttpProblem<400>,
  NotFound extends HttpProblem<404>,
  PolicyConflict extends HttpProblem<409>,
  PolicyIneligible extends HttpProblem<422>,
  Unavailable extends HttpProblem<503>,
>(options: {
  readonly authenticatePrincipal: GovernedReadPrincipalAuthentication<
    VerifierRequirements,
    Authentication,
    Unavailable
  >;
  readonly problems: GovernedReadHttpProblemSet<
    Authentication,
    Forbidden,
    Internal,
    Invalid,
    NotFound,
    PolicyConflict,
    PolicyIneligible,
    Unavailable
  >;
  readonly registration: ReadRegistration<InputSchema, ResultSchema, Owner, Services, HandlerError, ReadRequirements>;
}) =>
  Effect.fn('GovernedReadHttp.handle')(function* handleGovernedRead({
    payload,
    request,
  }: GovernedReadRequest<Schema.Schema.Type<InputSchema>>) {
    let correlationId: string | undefined;
    const execute = Effect.gen(function* executeGovernedRead() {
      correlationId = request.headers['x-correlation-id'];
      if (correlationId === undefined || correlationId.trim().length === 0) {
        return yield* Effect.fail(options.problems.invalid());
      }
      const principal = yield* options.authenticatePrincipal(Redacted.make(request.headers['authorization']), {
        authentication: options.problems.authentication,
        unavailable: options.problems.unavailable,
      });
      const runtime = yield* ReadRuntime;
      return yield* runtime
        .runRead({
          input: payload,
          principal,
          registration: options.registration,
          transport: { correlationId },
        })
        .pipe(Effect.catch((error) => failProblem(classifyReadCoreError(error, options.problems))));
    });

    return yield* execute.pipe(
      Effect.catchCauseIf(Cause.hasDies, () =>
        Effect.annotateLogs(Effect.logError('Unexpected governed-read HTTP defect'), {
          correlationId: correlationId === undefined || correlationId.trim().length === 0 ? 'missing' : correlationId,
        }).pipe(Effect.andThen(Effect.fail(options.problems.internal()))),
      ),
    );
  });
