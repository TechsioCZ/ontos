/* oxlint-disable anti-slop/no-unknown-parameters -- The HTTP mapper is a schema-decoded generic boundary and revalidates every value before release; expires: 2027-03-31. */
import { Cause, Clock, Effect, Match, Option, Random, Redacted, Ref, Result, Schema } from 'effect';
import { HttpEffect, HttpServerResponse } from 'effect/unstable/http';
import type { HttpServerRequest } from 'effect/unstable/http';

import type { OperationalScopeRequest } from '../operations/context.ts';
import type { TrustedPrincipalContext } from '../actions/context.ts';
import { transportIdentifier } from '../actions/string-schemas.ts';
import { withRequestPermissionDecisions } from '../permissions/context-access.ts';
import type { ReadRegistration } from '../reads/definition.ts';
import type { ReadCoreError } from '../reads/errors.ts';
import { isReadCoreError } from '../reads/errors.ts';
import { ReadRuntime } from '../reads/runtime.ts';
import { observeReadPhase, readServerTiming, recordReadTiming } from '../reads/diagnostics.ts';
import type { ReadTiming } from '../reads/diagnostics.ts';

// Opaque diagnostics only: no services, sockets, identities or request data survive a request.
const isolateReads = Ref.makeUnsafe<{ readonly id: string | null; readonly ordinal: number }>({
  id: null,
  ordinal: 0,
});
const nextIsolateRead = Random.nextInt.pipe(
  Effect.flatMap((random) =>
    Ref.modify(isolateReads, (previous) => {
      const next = { id: previous.id ?? Math.abs(random).toString(36), ordinal: previous.ordinal + 1 };
      return [next, next];
    }),
  ),
);

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

const ReadCorrelationIdSchema = transportIdentifier.pipe(Schema.brand('ReadCorrelationId'));
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
  /** Trusted receiver configuration, never supplied by the HTTP caller. */
  readonly audience?: string;
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
  DomainProblem extends GovernedReadDomainProblem = never,
>(
  options: {
    /** Trusted receiver configuration, never supplied by the HTTP caller. */
    readonly audience?: string;
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
  } & Readonly<{ mapDomainError?: ((error: DomainErrorSchema['Type']) => DomainProblem) | undefined }>,
) {
  return Effect.fn('GovernedReadHttp.handle')(function* handleGovernedRead({
    payload,
    request,
  }: GovernedReadRequest<Schema.Schema.Type<InputSchema>>) {
    const isolate = yield* nextIsolateRead;
    const timings = yield* Ref.make<readonly ReadTiming[]>([]);
    let encodeStartedAt: bigint | undefined;
    yield* HttpEffect.appendPreResponseHandler(
      Effect.fn('GovernedRead.reportTiming')(function* reportReadTiming(
        _request: HttpServerRequest.HttpServerRequest,
        response: HttpServerResponse.HttpServerResponse,
      ) {
        if (encodeStartedAt !== undefined) {
          yield* recordReadTiming(timings, 'read-encode', encodeStartedAt);
        }
        const entries = yield* Ref.get(timings);
        yield* Effect.logInfo('Governed read phases completed').pipe(
          Effect.annotateLogs({ isolate, readKey: options.registration.descriptor.readKey, timings: entries }),
        );
        const previous = response.headers['server-timing'];
        const header = `owner-isolate;desc="${isolate.id}:${isolate.ordinal}", ${readServerTiming(entries)}`;
        return HttpServerResponse.setHeader(
          response,
          'server-timing',
          previous === undefined ? header : `${previous}, ${header}`,
        );
      }),
    );
    let correlationId: string | undefined;
    const execute = Effect.gen(function* executeGovernedRead() {
      correlationId = request.headers['x-correlation-id'];
      if (correlationId === undefined || correlationId.trim().length === 0) {
        return yield* Effect.fail(options.problems.invalid());
      }
      // The correlation identifier is persisted into read evidence and log annotations, so an unbounded
      // caller-chosen value must be refused here rather than stored. Branching on the decode result keeps the
      // schema's diagnostic out of the problem shape without discarding it in an error callback.
      if (Result.isFailure(Schema.decodeResult(ReadCorrelationIdSchema)(correlationId))) {
        return yield* Effect.fail(options.problems.invalid());
      }
      const principal = yield* options
        .authenticatePrincipal(Redacted.make(request.headers['authorization']), {
          authentication: options.problems.authentication,
          unavailable: options.problems.unavailable,
        })
        .pipe(observeReadPhase('read-authentication', timings));
      const runtime = yield* ReadRuntime;
      let receivingAudience: Pick<OperationalScopeRequest, 'audience'> = {};
      if (options.audience !== undefined) {
        receivingAudience = { audience: options.audience };
      }
      return yield* runtime
        .runRead({
          ...receivingAudience,
          decodedInput: payload,
          inputFormat: 'decoded',
          principal,
          registration: options.registration,
          timings,
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
              | DomainProblem
              | Internal
              | Invalid
              | NotFound
              | PolicyConflict
              | PolicyIneligible
              | Unavailable,
              HttpServerRequest.HttpServerRequest
            > => {
              if (isReadCoreError(error)) {
                const problem = classifyReadCoreError(error, options.problems);
                const diagnostic =
                  problem.status === 503 || problem.status === 500
                    ? Effect.logError('Governed read failed').pipe(
                        Effect.annotateLogs({
                          code: error.code,
                          correlationId,
                          failureTag: error._tag,
                          readKey: options.registration.descriptor.readKey,
                          reason: error.reason,
                        }),
                      )
                    : Effect.void;
                return diagnostic.pipe(Effect.andThen(failProblem(problem)));
              }
              const { domainErrorSchema } = options.registration.descriptor;
              if (domainErrorSchema === undefined || options.mapDomainError === undefined) {
                return failProblem(options.problems.internal());
              }
              const decoded = Schema.decodeUnknownOption(domainErrorSchema)(error);
              if (Option.isNone(decoded)) {
                return failProblem(options.problems.internal());
              }
              const problem = options.mapDomainError(decoded.value);
              return isGovernedReadDomainProblem(problem)
                ? Effect.fail(problem)
                : failProblem(options.problems.internal());
            },
          ),
        );
    });

    return yield* execute.pipe(
      withRequestPermissionDecisions,
      Effect.catchCauseIf(Cause.hasDies, () =>
        Effect.annotateLogs(Effect.logError('Unexpected governed-read HTTP defect'), {
          correlationId: correlationId === undefined || correlationId.trim().length === 0 ? 'missing' : correlationId,
        }).pipe(Effect.andThen(Effect.fail(options.problems.internal()))),
      ),
      Effect.onExit(
        Effect.fn('GovernedRead.beginEncoding')(function* beginEncoding() {
          encodeStartedAt = yield* Clock.monotonicTimeNanos;
        }),
      ),
    );
  });
}
