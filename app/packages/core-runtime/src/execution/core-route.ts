/**
 * Core's in-process route: a call to one of Core's own operations runs through the read runtime's
 * governed `runRead` with the execution's own principal, so the Core operation's own access decision,
 * field groups and evidence apply exactly as for any other caller. No credential is used and no caller
 * kind is selected.
 */
import { Effect, Match, Option, Predicate, Schema } from 'effect';

import type { ReadCoreError } from '../reads/errors.ts';
import type { CallRoute, CallRouteRequest, CoreCallRouteFor, RouteAnswer } from './contract.ts';
import { RouteAnswerSchema } from './contract.ts';
import { coreOperationRegistrations } from './core-operations.ts';
import type { CoreOperationRegistration } from './core-operations.ts';

const [answered, problemAnswer] = RouteAnswerSchema.members;

const problem = (status: number, reason: string, code: string): RouteAnswer =>
  problemAnswer.make({ code, reason, status });

/**
 * A Core read's failure as the problem a module provider would answer: not found 404, permission
 * denied (also a refused module state or operation context) 403, authentication required 401, policy
 * denied its own status, invalid input 400, every unavailable 503, and a broken answer 500.
 */
export const readErrorProblem = (failure: ReadCoreError): RouteAnswer => {
  const status = Match.value(failure).pipe(
    Match.tagsExhaustive({
      ModuleStateCheckUnavailableError: () => 503,
      ModuleStateDeniedError: () => 403,
      OperationAuthenticationRequired: () => 401,
      OperationContextDenied: () => 403,
      OperationContextInvalid: () => 403,
      OperationContextUnavailable: () => 503,
      ReadEvidencePersistenceError: () => 503,
      ReadEvidenceValidationError: () => 500,
      ReadHandlerExecutionError: () => 500,
      ReadHandlerNotFound: () => 404,
      ReadHandlerUnavailable: () => 503,
      ReadInputValidationError: () => 400,
      ReadPermissionDenied: () => 403,
      ReadPermissionUnavailable: () => 503,
      ReadPolicyDenied: ({ httpStatus }) => httpStatus,
      ReadPolicyEvaluationError: () => 503,
      ReadResultValidationError: () => 500,
    }),
  );
  return problem(status, failure.reason, failure._tag);
};

/** Exactly the transport metadata a host builds for a request, from the execution's scope. */
const transportOf = (scope: CallRouteRequest['execution']['scope']) =>
  scope.traceId === undefined
    ? { correlationId: scope.correlationId }
    : { correlationId: scope.correlationId, traceId: scope.traceId };

/**
 * The key the calling module must own, read from the request decoded by the operation's own schema.
 * An undecodable request has none here; the Core read then refuses it as invalid input.
 */
const callerOwnedKeyOf = (registered: CoreOperationRegistration, request: CallRouteRequest): Option.Option<string> => {
  const field = registered.callerOwnedField;
  if (field === undefined) {
    return Option.none();
  }
  return Option.flatMap(Schema.decodeUnknownOption(registered.operation.request)(request.encodedInput), (decoded) =>
    Predicate.hasProperty(decoded, field) && Predicate.isString(decoded[field])
      ? Option.some(decoded[field])
      : Option.none(),
  );
};

export const coreCallRouteFor: CoreCallRouteFor = (runRead) => {
  const registry: ReadonlyMap<string, CoreOperationRegistration> = new Map(
    coreOperationRegistrations.map((registration) => [registration.operation.provider.entrypointKey, registration]),
  );
  const send: CallRoute['send'] = (request) => {
    const { provider } = request.operation;
    const registered = registry.get(provider.entrypointKey);
    if (
      registered === undefined ||
      registered.operation.provider.moduleId !== provider.moduleId ||
      registered.operation.provider.schemaVersion !== provider.schemaVersion
    ) {
      return Effect.succeed(problem(404, 'No such Core operation', 'core_operation_unknown'));
    }
    // An operation that answers only about the caller's own things refuses a key of another module.
    const ownedKey = callerOwnedKeyOf(registered, request);
    if (Option.isSome(ownedKey) && !ownedKey.value.startsWith(`${request.execution.facts.owningModuleKey}.`)) {
      return Effect.succeed(
        problem(403, 'The calling module may ask only about its own operations', 'core_operation_foreign_key'),
      );
    }
    return runRead({
      input: request.encodedInput,
      principal: request.execution.callerSource.principal,
      registration: registered.registration,
      transport: transportOf(request.execution.scope),
    }).pipe(
      Effect.matchEffect({
        onFailure: (failure) => Effect.succeed(readErrorProblem(failure)),
        onSuccess: (result) =>
          Schema.encodeUnknownEffect(registered.operation.response)(result).pipe(
            Effect.map((encoded) => answered.make({ encoded })),
            Effect.orElseSucceed(() =>
              problem(500, 'The Core operation answer does not match its response', 'core_operation_unencodable'),
            ),
          ),
      }),
    );
  };
  return Object.freeze({ send });
};
