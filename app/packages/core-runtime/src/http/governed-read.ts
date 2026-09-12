/* oxlint-disable anti-slop/no-unknown-parameters -- The HTTP mapper is a schema-decoded generic boundary and revalidates every value before release; expires: 2027-03-31. */
import { Cause, Effect, Match, Option, Redacted, Schema } from 'effect';
import { HttpEffect, HttpServerResponse } from 'effect/unstable/http';
import type { HttpServerRequest } from 'effect/unstable/http';

import type { TrustedPrincipalContext } from '../actions/context.ts';
import type { ReadRegistration } from '../reads/definition.ts';
import type { ReadCoreError } from '../reads/errors.ts';
import { isReadCoreError } from '../reads/errors.ts';
import { ReadRuntime } from '../reads/runtime.ts';

interface HttpProblem<Status extends number> {
  readonly status: Status;
}

export type GovernedReadDomainProblem =
  | Readonly<{
      readonly _tag: string;
      readonly detail: string;
      readonly instance?: string;
      readonly reasonCode: string;
      readonly status: 409 | 422;
      readonly title: string;
      readonly type: string;
    }>
  | Readonly<{
      readonly _tag: string;
      readonly detail: string;
      readonly instance?: string;
      readonly reasonCode: string;
      readonly retryable: true;
      readonly status: 503;
      readonly title: string;
      readonly type: string;
    }>;

const GovernedReadDomainProblemSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.String,
    detail: Schema.String,
    instance: Schema.optionalKey(Schema.String),
    reasonCode: Schema.String,
    status: Schema.Union([Schema.Literal(409), Schema.Literal(422)]),
    title: Schema.String,
    type: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.String,
    detail: Schema.String,
    instance: Schema.optionalKey(Schema.String),
    reasonCode: Schema.String,
    retryable: Schema.Literal(true),
    status: Schema.Literal(503),
    title: Schema.String,
    type: Schema.String,
  }),
]);

const governedReadDomainProblemFields = new Set([
  '_tag',
  'detail',
  'instance',
  'reasonCode',
  'retryable',
  'status',
  'title',
  'type',
]);
const domainProblemSchemaAccepts = Schema.is(GovernedReadDomainProblemSchema);
const isGovernedReadDomainProblem = (value: unknown): boolean =>
  domainProblemSchemaAccepts(value) && Object.keys(value).every((key) => governedReadDomainProblemFields.has(key));

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

type GovernedReadHttpHandler<Payload, Result, Failure, Requirements> = (
  request: GovernedReadRequest<Payload>,
) => Effect.Effect<Result, Failure, Requirements>;

type GovernedReadHttpFailures<
  Authentication,
  Forbidden,
  Internal,
  Invalid,
  NotFound,
  PolicyConflict,
  PolicyIneligible,
  Unavailable,
> = Authentication | Forbidden | Internal | Invalid | NotFound | PolicyConflict | PolicyIneligible | Unavailable;

type GovernedReadHttpRequirements<VerifierRequirements> =
  | HttpServerRequest.HttpServerRequest
  | ReadRuntime
  | VerifierRequirements;

type GovernedReadAuthenticatorFailure<Authenticator> = Authenticator extends (
  ...arguments_: never[]
) => Effect.Effect<unknown, infer Failure, unknown>
  ? Failure
  : never;

type GovernedReadAuthenticatorRequirements<Authenticator> = Authenticator extends (
  ...arguments_: never[]
) => Effect.Effect<unknown, unknown, infer Requirements>
  ? Requirements
  : never;

type GovernedReadDomainMapperResult<Mapper> = Mapper extends (...arguments_: never[]) => infer Problem
  ? Problem
  : never;

const invokeGovernedReadDomainMapper = <
  DomainFailure,
  Mapper extends (error: DomainFailure) => GovernedReadDomainProblem,
>(
  mapper: Mapper,
  error: DomainFailure,
): GovernedReadDomainMapperResult<Mapper> =>
  // SAFETY: calling the exact mapper produces its declared ReturnType; TypeScript cannot
  // retain that relationship for a still-generic function value.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Validated generic invocation; expires: 2027-03-31.
  mapper(error) as GovernedReadDomainMapperResult<Mapper>;

interface GovernedReadHttpOptions<
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
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
> {
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
  readonly registration: ReadRegistration<
    InputSchema,
    ResultSchema,
    Owner,
    Services,
    HandlerError,
    ReadRequirements,
    DomainErrorSchema
  >;
}

/* jscpd:ignore-start -- The overload declaration intentionally repeats the generic HTTP contract; the implementation is singular below. */
export function makeGovernedReadHttpHandler<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  HandlerError,
  ReadRequirements,
  Authenticator,
  Authentication extends HttpProblem<401>,
  Forbidden extends HttpProblem<403>,
  Internal extends HttpProblem<500>,
  Invalid extends HttpProblem<400>,
  NotFound extends HttpProblem<404>,
  PolicyConflict extends HttpProblem<409>,
  PolicyIneligible extends HttpProblem<422>,
  Unavailable extends HttpProblem<503>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{
    readonly _tag: string;
  }> = typeof Schema.Never,
>(
  options: Omit<
    GovernedReadHttpOptions<
      InputSchema,
      ResultSchema,
      Owner,
      Services,
      HandlerError,
      ReadRequirements,
      GovernedReadAuthenticatorRequirements<Authenticator>,
      Authentication,
      Forbidden,
      Internal,
      Invalid,
      NotFound,
      PolicyConflict,
      PolicyIneligible,
      Unavailable,
      DomainErrorSchema
    >,
    'authenticatePrincipal'
  > &
    Readonly<{
      authenticatePrincipal: Authenticator &
        GovernedReadPrincipalAuthentication<
          GovernedReadAuthenticatorRequirements<Authenticator>,
          Authentication,
          Unavailable
        >;
      mapDomainError?: undefined;
    }>,
): GovernedReadHttpHandler<
  Schema.Schema.Type<InputSchema>,
  Schema.Schema.Type<ResultSchema>,
  | GovernedReadHttpFailures<
      Authentication,
      Forbidden,
      Internal,
      Invalid,
      NotFound,
      PolicyConflict,
      PolicyIneligible,
      Unavailable
    >
  | GovernedReadAuthenticatorFailure<Authenticator>,
  GovernedReadHttpRequirements<GovernedReadAuthenticatorRequirements<Authenticator>>
>;
/* jscpd:ignore-end */
export function makeGovernedReadHttpHandler<
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  HandlerError,
  ReadRequirements,
  Authenticator,
  Authentication extends HttpProblem<401>,
  Forbidden extends HttpProblem<403>,
  Internal extends HttpProblem<500>,
  Invalid extends HttpProblem<400>,
  NotFound extends HttpProblem<404>,
  PolicyConflict extends HttpProblem<409>,
  PolicyIneligible extends HttpProblem<422>,
  Unavailable extends HttpProblem<503>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainErrorMapper extends (error: DomainErrorSchema['Type']) => GovernedReadDomainProblem,
>(
  options: Omit<
    GovernedReadHttpOptions<
      InputSchema,
      ResultSchema,
      Owner,
      Services,
      HandlerError,
      ReadRequirements,
      GovernedReadAuthenticatorRequirements<Authenticator>,
      Authentication,
      Forbidden,
      Internal,
      Invalid,
      NotFound,
      PolicyConflict,
      PolicyIneligible,
      Unavailable,
      DomainErrorSchema
    >,
    'authenticatePrincipal'
  > &
    Readonly<{
      authenticatePrincipal: Authenticator &
        GovernedReadPrincipalAuthentication<
          GovernedReadAuthenticatorRequirements<Authenticator>,
          Authentication,
          Unavailable
        >;
      mapDomainError: DomainErrorMapper;
    }>,
): GovernedReadHttpHandler<
  Schema.Schema.Type<InputSchema>,
  Schema.Schema.Type<ResultSchema>,
  | GovernedReadHttpFailures<
      Authentication,
      Forbidden,
      Internal,
      Invalid,
      NotFound,
      PolicyConflict,
      PolicyIneligible,
      Unavailable
    >
  | GovernedReadDomainMapperResult<DomainErrorMapper>
  | GovernedReadAuthenticatorFailure<Authenticator>,
  GovernedReadHttpRequirements<GovernedReadAuthenticatorRequirements<Authenticator>>
>;
export function makeGovernedReadHttpHandler<
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
  DomainErrorSchema extends Schema.ConstraintDecoder<{
    readonly _tag: string;
  }> = typeof Schema.Never,
  DomainErrorMapper extends ((error: DomainErrorSchema['Type']) => GovernedReadDomainProblem) | undefined = undefined,
>(
  options: {
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
    readonly registration: ReadRegistration<
      InputSchema,
      ResultSchema,
      Owner,
      Services,
      HandlerError,
      ReadRequirements,
      DomainErrorSchema
    >;
  } & Readonly<{ mapDomainError?: DomainErrorMapper }>,
) {
  return Effect.fn('GovernedReadHttp.handle')(function* handleGovernedRead({
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
        .pipe(
          Effect.catch(
            (
              error,
            ): Effect.Effect<
              never,
              | Authentication
              | Forbidden
              | GovernedReadDomainMapperResult<DomainErrorMapper>
              | Internal
              | Invalid
              | NotFound
              | PolicyConflict
              | PolicyIneligible
              | Unavailable,
              HttpServerRequest.HttpServerRequest
            > => {
              if (isReadCoreError(error)) {
                return failProblem(classifyReadCoreError(error, options.problems));
              }
              const { domainErrorSchema } = options.registration.descriptor;
              if (domainErrorSchema === undefined || options.mapDomainError === undefined) {
                return failProblem(options.problems.internal());
              }
              const decoded = Schema.decodeUnknownOption(domainErrorSchema)(error);
              if (Option.isNone(decoded)) {
                return failProblem(options.problems.internal());
              }
              const problem = invokeGovernedReadDomainMapper<
                DomainErrorSchema['Type'],
                Exclude<DomainErrorMapper, undefined>
              >(
                // SAFETY: the undefined branch returned above; this is the exact declared mapper.
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Narrowed generic optional mapper; expires: 2027-03-31.
                options.mapDomainError as Exclude<DomainErrorMapper, undefined>,
                decoded.value,
              );
              return isGovernedReadDomainProblem(problem)
                ? Effect.fail(problem)
                : failProblem(options.problems.internal());
            },
          ),
        );
    });

    return yield* execute.pipe(
      Effect.catchCauseIf(Cause.hasDies, () =>
        Effect.annotateLogs(Effect.logError('Unexpected governed-read HTTP defect'), {
          correlationId: correlationId === undefined || correlationId.trim().length === 0 ? 'missing' : correlationId,
        }).pipe(Effect.andThen(Effect.fail(options.problems.internal()))),
      ),
    );
  });
}
