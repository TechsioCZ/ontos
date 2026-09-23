import {
  ExternalIdentityAdmission,
  ReadRuntime,
  TrustedPrincipalContextSchema,
  activatePrincipalBindingAction,
  defineRead,
  defineSystemModuleEntrypoint,
  externalIdentitySubjectForBinding,
  changePrincipalBindingStatusAction,
  readPrincipalBinding,
  resolveExternalSubjectFromTransaction,
  reservePrincipalBindingAction,
} from '@app/core-runtime';
import type {
  ActionCoreError,
  ExternalIdentityAdmissionContext,
  ReadCoreError,
  TrustedPrincipalContext,
} from '@app/core-runtime';
import {
  ExternalIdentityError,
  AuthenticationNamespaceIdSchema,
  AuthBindingIdSchema,
  ExternalAuthenticationSubjectSchema,
  ResolveExternalSubjectResultSchema,
  TenantIdSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import type {
  ExternalAuthenticationSubject,
  ReadPrincipalBindingPayloadSchema,
  ReadPrincipalBindingResultSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import type { ExternalIdentityFailure } from '@app/core-runtime/auth/external-identity-admission';
import {
  TrustedAuthenticationAdmissionService,
  TrustedExternalSubjectAdmissionService,
  externalIdentityFailure,
} from '@app/core-runtime/auth/external-identity-admission';
import { ExternalIdentityApi } from '@app/shared-contracts';
import type {
  ActivatePrincipalBindingRequestSchema,
  ChangePrincipalBindingStatusRequestSchema,
  ExternalGatewayContextRequestSchema,
  ExternalIdentityApiGroup,
  ExternalIdentityConflictProblemSchema,
  ExternalIdentityForbiddenProblemSchema,
  ExternalIdentityIneligibleProblemSchema,
  ExternalIdentityInternalProblemSchema,
  ExternalIdentityInvalidProblemSchema,
  ExternalIdentityNotFoundProblemSchema,
  ExternalIdentityThrottledProblemSchema,
  ExternalIdentityUnauthorizedProblemSchema,
  ExternalIdentityUnavailableProblemSchema,
  ResolveExternalSubjectRequestSchema,
  ReservePrincipalBindingRequestSchema,
} from '@app/shared-contracts/external-identity';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Context, Crypto, Effect, Match, Option, Predicate, Redacted, Schema } from 'effect';

import { ShellAuthenticationApi } from '../../../shared/api.ts';
import { issueGatewayContextAssertion } from '../gateway-issuer.ts';
import type { GatewayIssuerError } from '../gateway-issuer.ts';
import { validateAuthorizedLegalEntity } from '../legal-entity-selection.ts';
import type {
  LegalEntitySelectionForbiddenError,
  LegalEntitySelectionUnavailableError,
} from '../legal-entity-selection.ts';
import { runGovernedActionHttp } from '@app/core-runtime/http/action-runner';
import { ExternalIdentityHttpConfigurationService } from './configuration.ts';
import type { ExternalIdentityWorkloadOperation } from './configuration.ts';
import {
  ExternalIdentityHttpCorrelationId,
  provideExternalIdentityHttpCorrelation,
  provideExternalIdentityHttpWorkload,
} from './request-context.ts';
import { safeExternalIdentityHttpEffect } from './http-error-seam.ts';
import { ExternalIdentityWorkloadAuthorization } from './workload-authorization.ts';
import type {
  ExternalIdentityWorkloadAuthenticationError,
  ExternalIdentityWorkloadAuthorizationInput,
  ExternalIdentityWorkloadForbiddenError,
  ExternalIdentityWorkloadGrantInput,
  ExternalIdentityWorkloadRateLimitedError,
  ExternalIdentityWorkloadUnavailableError,
} from './workload-authorization.ts';

export { externalIdentityWorkloadAuthorizationLive } from './workload-authorization.ts';

type ExternalIdentityFailureCode = ExternalIdentityFailure['code'];
export { ExternalIdentityHttpConfigurationSchema, ExternalIdentityHttpConfigurationService } from './configuration.ts';
export type { ExternalIdentityHttpConfiguration } from './configuration.ts';
export { ExternalIdentityWorkloadAuthorization } from './workload-authorization.ts';

type ExternalIdentityProblem =
  | Schema.Schema.Type<typeof ExternalIdentityConflictProblemSchema>
  | Schema.Schema.Type<typeof ExternalIdentityForbiddenProblemSchema>
  | Schema.Schema.Type<typeof ExternalIdentityIneligibleProblemSchema>
  | Schema.Schema.Type<typeof ExternalIdentityInternalProblemSchema>
  | Schema.Schema.Type<typeof ExternalIdentityInvalidProblemSchema>
  | Schema.Schema.Type<typeof ExternalIdentityNotFoundProblemSchema>
  | Schema.Schema.Type<typeof ExternalIdentityThrottledProblemSchema>
  | Schema.Schema.Type<typeof ExternalIdentityUnauthorizedProblemSchema>
  | Schema.Schema.Type<typeof ExternalIdentityUnavailableProblemSchema>;

const problem = <Tag extends string, Status extends number>(
  _tag: Tag,
  status: Status,
  detail: string,
  title: string,
  type: string,
) => ({ _tag, detail, status, title, type });

const failureWithCause = <Failure extends object, CauseValue>(failure: Failure, cause: CauseValue): Failure =>
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });

const CORE_IDENTITY_MODULE_KEY = 'core.identity';
const CORRELATION_ID_HEADER = 'x-correlation-id';
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const missingAuthorization = Redacted.make(Option.getOrUndefined(Option.none<string>()));
const missingTraceId = Option.getOrUndefined(Option.none<string>());
const ExternalIdentityHttpHeadersSchema = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Undefined]));
type ExternalIdentityHttpHeaders = Schema.Schema.Type<typeof ExternalIdentityHttpHeadersSchema>;

const invalidProblem = (detail = 'The external identity request is invalid') =>
  problem(
    'ExternalIdentityInvalidProblem',
    400,
    detail,
    'External identity request is invalid',
    'https://ontos.dev/problems/external-identity-invalid',
  );
const unauthorizedProblem = (detail = 'The external identity workload is not authenticated') =>
  problem(
    'ExternalIdentityUnauthorizedProblem',
    401,
    detail,
    'External identity workload authentication is required',
    'https://ontos.dev/problems/external-identity-unauthorized',
  );
const forbiddenProblem = (detail = 'The workload is not authorized for this external identity operation') =>
  problem(
    'ExternalIdentityForbiddenProblem',
    403,
    detail,
    'External identity operation is forbidden',
    'https://ontos.dev/problems/external-identity-forbidden',
  );
const notFoundProblem = (detail = 'The external identity binding was not found') =>
  problem(
    'ExternalIdentityNotFoundProblem',
    404,
    detail,
    'External identity binding was not found',
    'https://ontos.dev/problems/external-identity-not-found',
  );
const conflictProblem = (detail = 'The external identity binding conflicts with its current state') =>
  problem(
    'ExternalIdentityConflictProblem',
    409,
    detail,
    'External identity binding conflict',
    'https://ontos.dev/problems/external-identity-conflict',
  );
const ineligibleProblem = (detail = 'The external identity operation is ineligible') =>
  problem(
    'ExternalIdentityIneligibleProblem',
    422,
    detail,
    'External identity operation is ineligible',
    'https://ontos.dev/problems/external-identity-ineligible',
  );
const throttledProblem = (detail = 'The external identity operation is temporarily throttled') =>
  problem(
    'ExternalIdentityThrottledProblem',
    429,
    detail,
    'External identity operation is throttled',
    'https://ontos.dev/problems/external-identity-throttled',
  );
const internalProblem = (detail = 'The external identity service failed unexpectedly') =>
  problem(
    'ExternalIdentityInternalProblem',
    500,
    detail,
    'External identity service error',
    'https://ontos.dev/problems/external-identity-internal',
  );
const unavailableProblem = (detail = 'The external identity service is temporarily unavailable') => ({
  ...problem(
    'ExternalIdentityUnavailableProblem',
    503,
    detail,
    'External identity service is unavailable',
    'https://ontos.dev/problems/external-identity-unavailable',
  ),
  retryable: true as const,
});

const safe = safeExternalIdentityHttpEffect(internalProblem);

const mapLegalEntitySelectionProblem = (
  error: LegalEntitySelectionForbiddenError | LegalEntitySelectionUnavailableError,
): ExternalIdentityProblem =>
  Predicate.isTagged(error, 'LegalEntitySelectionForbiddenError') ? forbiddenProblem() : unavailableProblem();

const mapTrustedPrincipalDecodeProblem = (error: Schema.SchemaError): ExternalIdentityProblem =>
  failureWithCause(internalProblem(), error);

const mapIdentityCode = (code: ExternalIdentityFailureCode): ExternalIdentityProblem =>
  Match.value(code).pipe(
    Match.when('identity_invalid', () => invalidProblem()),
    Match.when('identity_unusable', () => ineligibleProblem()),
    Match.when('identity_forbidden', () => forbiddenProblem()),
    Match.when('identity_not_found', () => notFoundProblem()),
    Match.when('identity_conflict', () => conflictProblem()),
    Match.when('identity_ineligible', () => ineligibleProblem()),
    Match.when('identity_unavailable', () => unavailableProblem()),
    Match.exhaustive,
  );

const mapActionError = (error: ActionCoreError | ExternalIdentityError): ExternalIdentityProblem => {
  if (Predicate.isTagged(error, 'ExternalIdentityError')) {
    return mapIdentityCode(error.code);
  }
  if (
    Predicate.isTagged(error, 'ActionPayloadValidationError') ||
    Predicate.isTagged(error, 'ActionIdempotencyKeyRequired')
  ) {
    return invalidProblem(error.reason);
  }
  if (Predicate.isTagged(error, 'ActionPermissionDenied') || Predicate.isTagged(error, 'ModuleStateDeniedError')) {
    return forbiddenProblem(error.reason);
  }
  if (Predicate.isTagged(error, 'ActionPolicyDenied')) {
    return ineligibleProblem(error.reason);
  }
  if (Predicate.isTagged(error, 'ActionAlreadyCommitted') || Predicate.isTagged(error, 'ActionRequestHashConflict')) {
    return conflictProblem(error.reason);
  }
  if (Predicate.isTagged(error, 'ActionInvocationNotFound')) {
    return notFoundProblem(error.reason);
  }
  if (
    Predicate.isTagged(error, 'ActionPermissionCheckError') ||
    Predicate.isTagged(error, 'ActionPolicyEvaluationError') ||
    Predicate.isTagged(error, 'ActionInvocationPersistenceError') ||
    Predicate.isTagged(error, 'ActionCommitIndeterminate') ||
    Predicate.isTagged(error, 'ActionTransactionError') ||
    Predicate.isTagged(error, 'ModuleStateCheckUnavailableError')
  ) {
    return unavailableProblem(error.reason);
  }
  if (Predicate.isTagged(error, 'ActionTrustedContextValidationError')) {
    return unauthorizedProblem(error.reason);
  }
  if (Predicate.isTagged(error, 'OperationAuthenticationRequired')) {
    return unauthorizedProblem(error.reason);
  }
  if (Predicate.isTagged(error, 'OperationContextDenied') || Predicate.isTagged(error, 'OperationContextInvalid')) {
    return forbiddenProblem(error.reason);
  }
  return internalProblem();
};

const mapReadError = (error: ReadCoreError | ExternalIdentityError): ExternalIdentityProblem => {
  if (Predicate.isTagged(error, 'ExternalIdentityError')) {
    return mapIdentityCode(error.code);
  }
  if (Predicate.isTagged(error, 'ReadInputValidationError')) {
    return invalidProblem(error.reason);
  }
  if (Predicate.isTagged(error, 'OperationAuthenticationRequired')) {
    return unauthorizedProblem(error.reason);
  }
  if (
    Predicate.isTagged(error, 'ReadPermissionDenied') ||
    Predicate.isTagged(error, 'ModuleStateDeniedError') ||
    Predicate.isTagged(error, 'OperationContextDenied') ||
    Predicate.isTagged(error, 'OperationContextInvalid')
  ) {
    return forbiddenProblem(error.reason);
  }
  if (Predicate.isTagged(error, 'ReadHandlerNotFound')) {
    return notFoundProblem(error.reason);
  }
  if (Predicate.isTagged(error, 'ReadPolicyDenied')) {
    return error.httpStatus === 409 ? conflictProblem(error.reason) : ineligibleProblem(error.reason);
  }
  if (Predicate.isTagged(error, 'ReadHandlerUnavailable') || Predicate.isTagged(error, 'ReadPermissionUnavailable')) {
    return unavailableProblem(error.reason);
  }
  return internalProblem();
};

const mapWorkloadError = (
  error:
    | ExternalIdentityWorkloadAuthenticationError
    | ExternalIdentityWorkloadForbiddenError
    | ExternalIdentityWorkloadRateLimitedError
    | ExternalIdentityWorkloadUnavailableError,
): ExternalIdentityProblem => {
  if (Predicate.isTagged(error, 'ExternalIdentityWorkloadAuthenticationError')) {
    return unauthorizedProblem(error.reason);
  }
  if (Predicate.isTagged(error, 'ExternalIdentityWorkloadForbiddenError')) {
    return forbiddenProblem(error.reason);
  }
  if (Predicate.isTagged(error, 'ExternalIdentityWorkloadRateLimitedError')) {
    return throttledProblem();
  }
  return unavailableProblem(error.reason);
};

const mapAdmissionError = (error: ExternalIdentityFailure): ExternalIdentityProblem => mapIdentityCode(error.code);

const requiredHeader = (
  headers: ExternalIdentityHttpHeaders,
  name: string,
): Effect.Effect<string, ExternalIdentityProblem> => {
  const value = headers[name];
  return value === undefined || value.trim().length === 0
    ? Effect.fail(invalidProblem(`The ${name} header is required`))
    : Effect.succeed(value);
};

const BindingSubjectLookupInputSchema = Schema.Struct({
  authBindingId: AuthBindingIdSchema,
  authenticationNamespaceId: AuthenticationNamespaceIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

type BindingSubjectReadServices = Readonly<{
  readonly lookup: (input: {
    readonly authBindingId: Schema.Schema.Type<typeof AuthBindingIdSchema>;
    readonly authenticationNamespaceId: Schema.Schema.Type<typeof AuthenticationNamespaceIdSchema>;
    readonly tenantId: string;
  }) => Effect.Effect<ExternalAuthenticationSubject, ExternalIdentityFailure>;
}>;

type ResolveExternalSubjectReadResult = Schema.Schema.Type<typeof ResolveExternalSubjectResultSchema>;
interface ResolveExternalSubjectReadInput {
  readonly admission: ExternalIdentityAdmissionContext;
  readonly subject: ExternalAuthenticationSubject;
  readonly tenantId: string;
}
type ResolveExternalSubjectReadServices = Readonly<{
  readonly resolve: (
    input: ResolveExternalSubjectReadInput,
  ) => Effect.Effect<ResolveExternalSubjectReadResult, ExternalIdentityFailure>;
}>;

const bindingSubjectRead = defineRead<
  typeof BindingSubjectLookupInputSchema,
  typeof ExternalAuthenticationSubjectSchema,
  'core.identity',
  BindingSubjectReadServices,
  ExternalIdentityError,
  never,
  typeof ExternalIdentityError
>(
  {
    accessKind: 'detail',
    domainErrorSchema: ExternalIdentityError,
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: 'module.access' },
      entrypointKey: 'core.identity.read-binding-subject',
      moduleKey: CORE_IDENTITY_MODULE_KEY,
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.identity.read-binding-subject.access.v1',
    },
    inputSchema: BindingSubjectLookupInputSchema,
    legalEntityScope: 'forbidden',
    owningModuleKey: CORE_IDENTITY_MODULE_KEY,
    permissionTarget: 'tenant',
    policies: [],
    readKey: 'core.identity.read-binding-subject',
    resultSchema: ExternalAuthenticationSubjectSchema,
    schemaVersion: '1',
  },
  (input, context) =>
    context.services
      .lookup({
        ...input,
        tenantId: context.scope.tenantId,
      })
      .pipe(
        Effect.mapError((failure) => new ExternalIdentityError({ code: failure.code })),
        Effect.map((result) => ({ evidence: { resultCount: 1 }, result })),
      ),
  (transaction) =>
    Effect.succeed({
      lookup: (input: {
        readonly authBindingId: Schema.Schema.Type<typeof AuthBindingIdSchema>;
        readonly authenticationNamespaceId: Schema.Schema.Type<typeof AuthenticationNamespaceIdSchema>;
        readonly tenantId: string;
      }) => externalIdentitySubjectForBinding(transaction, input),
    }),
  () => ({ kind: 'tenant', permission: 'access' }),
);

const resolveExternalSubjectRead = defineRead<
  typeof ExternalAuthenticationSubjectSchema,
  typeof ResolveExternalSubjectResultSchema,
  'core.identity',
  ResolveExternalSubjectReadServices,
  ExternalIdentityError,
  ExternalIdentityAdmission,
  typeof ExternalIdentityError
>(
  {
    accessKind: 'detail',
    domainErrorSchema: ExternalIdentityError,
    entrypoint: defineSystemModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: 'module.access' },
      entrypointKey: 'core.identity.resolve-external-subject',
      moduleKey: CORE_IDENTITY_MODULE_KEY,
      role: 'api',
    }),
    evidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'core.identity.resolve-external-subject.access.v1',
    },
    inputSchema: ExternalAuthenticationSubjectSchema,
    legalEntityScope: 'forbidden',
    owningModuleKey: CORE_IDENTITY_MODULE_KEY,
    permissionTarget: 'tenant',
    policies: [],
    readKey: 'core.identity.resolve-external-subject',
    resultSchema: ResolveExternalSubjectResultSchema,
    schemaVersion: '1',
  },
  (subject, context) =>
    Effect.serviceOption(ExternalIdentityAdmission).pipe(
      Effect.flatMap((admission) =>
        Option.isNone(admission)
          ? Effect.fail(new ExternalIdentityError({ code: 'identity_unavailable' }))
          : context.services
              .resolve({
                admission: admission.value,
                subject,
                tenantId: context.scope.tenantId,
              })
              .pipe(Effect.mapError((failure) => new ExternalIdentityError({ code: failure.code }))),
      ),
      Effect.map((result) => ({ evidence: { resultCount: 1 }, result })),
    ),
  (transaction) => Effect.succeed({ resolve: resolveExternalSubjectFromTransaction(transaction) }),
  () => ({ kind: 'tenant', permission: 'access' }),
);

const runBindingRead = (
  principal: TrustedPrincipalContext,
  input: Schema.Schema.Type<typeof ReadPrincipalBindingPayloadSchema>,
  audience: string,
) =>
  Effect.all({ correlation: ExternalIdentityHttpCorrelationId, runtime: ReadRuntime }, { concurrency: 1 }).pipe(
    Effect.flatMap(({ correlation, runtime }) =>
      runtime.runRead({
        audience,
        input,
        principal,
        registration: readPrincipalBinding,
        transport: { correlationId: correlation },
      }),
    ),
    Effect.mapError(mapReadError),
  );

const runBindingSubjectRead = (
  principal: TrustedPrincipalContext,
  input: Schema.Schema.Type<typeof BindingSubjectLookupInputSchema>,
  audience: string,
) =>
  Effect.all({ correlation: ExternalIdentityHttpCorrelationId, runtime: ReadRuntime }, { concurrency: 1 }).pipe(
    Effect.flatMap(({ correlation, runtime }) =>
      runtime.runRead({
        audience,
        input,
        principal,
        registration: bindingSubjectRead,
        transport: { correlationId: correlation },
      }),
    ),
    Effect.mapError(mapReadError),
  );

const runResolveRead = (
  principal: TrustedPrincipalContext,
  subject: ExternalAuthenticationSubject,
  admission: ExternalIdentityAdmissionContext,
  audience: string,
) =>
  Effect.all({ correlation: ExternalIdentityHttpCorrelationId, runtime: ReadRuntime }, { concurrency: 1 }).pipe(
    Effect.flatMap(({ correlation, runtime }) =>
      runtime.runRead({
        audience,
        input: subject,
        principal,
        registration: resolveExternalSubjectRead,
        transport: { correlationId: correlation },
      }),
    ),
    Effect.provideContext(Context.make(ExternalIdentityAdmission, admission)),
    Effect.mapError(mapReadError),
  );

const subjectFromPayload = (
  payload: Pick<ExternalAuthenticationSubject, 'authenticationNamespaceId' | 'providerSubjectId' | 'subjectType'>,
): ExternalAuthenticationSubject => ({
  authenticationNamespaceId: payload.authenticationNamespaceId,
  providerSubjectId: payload.providerSubjectId,
  subjectType: payload.subjectType,
});

const requireBinding = (
  principal: TrustedPrincipalContext,
  authBindingId: Schema.Schema.Type<typeof AuthBindingIdSchema>,
  audience: string,
) =>
  runBindingRead(principal, { authBindingId, lookup: 'binding' }, audience).pipe(
    Effect.catchIf(Predicate.isTagged('ExternalIdentityForbiddenProblem'), () => Effect.fail(notFoundProblem())),
    Effect.filterOrFail(
      (result) => result.outcome === 'FOUND',
      () => notFoundProblem(),
    ),
  );

const requireSubjectBinding = (
  principal: TrustedPrincipalContext,
  subject: Schema.Schema.Type<typeof ExternalAuthenticationSubjectSchema>,
  audience: string,
) =>
  runBindingRead(principal, { ...subject, lookup: 'subject' }, audience).pipe(
    Effect.catchIf(Predicate.isTagged('ExternalIdentityForbiddenProblem'), () => Effect.fail(notFoundProblem())),
    Effect.filterOrFail(
      (result) => result.outcome === 'FOUND',
      () => notFoundProblem(),
    ),
  );

const requireBindingSubject = (
  principal: TrustedPrincipalContext,
  binding: Schema.Schema.Type<typeof ReadPrincipalBindingResultSchema> & { readonly outcome: 'FOUND' },
  audience: string,
) =>
  runBindingSubjectRead(
    principal,
    {
      authBindingId: binding.authBindingId,
      authenticationNamespaceId: binding.authenticationNamespaceId,
    },
    audience,
  ).pipe(Effect.catchIf(Predicate.isTagged('ExternalIdentityForbiddenProblem'), () => Effect.fail(notFoundProblem())));

interface SubjectAdmissionInput {
  readonly audience: string;
  readonly authenticationRef: string;
  readonly subject: ExternalAuthenticationSubject;
  readonly tenantId: string;
}

interface AuthenticationAdmissionInput {
  readonly audience: string;
  readonly authenticationRef: string;
  readonly binding: Schema.Schema.Type<typeof ReadPrincipalBindingResultSchema> & { readonly outcome: 'FOUND' };
  readonly subject: ExternalAuthenticationSubject;
  readonly tenantId: string;
}

const mapAdmissionNonceError = (cause: unknown): ExternalIdentityFailure =>
  failureWithCause(externalIdentityFailure('identity_unavailable', 'Admission nonce generation is unavailable'), cause);

const nextAdmissionUuid = (crypto: Crypto.Crypto) => crypto.randomUUIDv4.pipe(Effect.mapError(mapAdmissionNonceError));

const makeSubjectAdmission = Effect.fn('ExternalIdentityHttp.makeSubjectAdmission')(function* makeSubjectAdmission(
  input: SubjectAdmissionInput,
) {
  const decodedTenantId = yield* Schema.decodeEffect(TenantIdSchema)(input.tenantId).pipe(
    Effect.mapError((error) =>
      failureWithCause(
        externalIdentityFailure('identity_invalid', 'The workload tenant identifier is malformed'),
        error,
      ),
    ),
  );
  const crypto = yield* Crypto.Crypto;
  const match = {
    audience: input.audience,
    authContextRef: input.authenticationRef,
    authenticationNamespaceId: input.subject.authenticationNamespaceId,
    nonce: yield* nextAdmissionUuid(crypto),
    operationRef: yield* nextAdmissionUuid(crypto),
    providerSubjectId: input.subject.providerSubjectId,
    subjectType: input.subject.subjectType,
    tenantId: decodedTenantId,
  };
  const service = yield* TrustedExternalSubjectAdmissionService;
  const admission = yield* service.admit(match);
  return { admission, match: { expected: match, kind: 'subject' as const } };
});

const makeAuthenticationAdmission = Effect.fn('ExternalIdentityHttp.makeAuthenticationAdmission')(
  function* makeAuthenticationAdmission(input: AuthenticationAdmissionInput) {
    const decodedTenantId = yield* Schema.decodeEffect(TenantIdSchema)(input.tenantId).pipe(
      Effect.mapError((error) =>
        failureWithCause(
          externalIdentityFailure('identity_invalid', 'The workload tenant identifier is malformed'),
          error,
        ),
      ),
    );
    const crypto = yield* Crypto.Crypto;
    const expected = {
      audience: input.audience,
      authBindingId: input.binding.authBindingId,
      authContextRef: input.authenticationRef,
      authenticationNamespaceId: input.subject.authenticationNamespaceId,
      bindingRevision: input.binding.bindingRevision,
      nonce: yield* nextAdmissionUuid(crypto),
      operationRef: yield* nextAdmissionUuid(crypto),
      principalId: input.binding.principalId,
      subjectType: input.subject.subjectType,
      tenantId: decodedTenantId,
    };
    const service = yield* TrustedAuthenticationAdmissionService;
    const admission = yield* service.verify(expected);
    return {
      admission,
      match: {
        expected: {
          audience: input.audience,
          authBindingId: expected.authBindingId,
          authContextRef: expected.authContextRef,
          authenticationNamespaceId: expected.authenticationNamespaceId,
          bindingRevision: expected.bindingRevision,
          nonce: expected.nonce,
          operationRef: expected.operationRef,
          principalId: expected.principalId,
          tenantId: expected.tenantId,
        },
        kind: 'authentication' as const,
      },
    };
  },
);

const runReserveAction = (
  principal: TrustedPrincipalContext,
  payload: Schema.Schema.Type<typeof ReservePrincipalBindingRequestSchema>,
  idempotencyKey: string,
  audience: string,
  admission: ExternalIdentityAdmissionContext,
) =>
  ExternalIdentityHttpCorrelationId.pipe(
    Effect.flatMap((correlation) =>
      Effect.provideContext(
        runGovernedActionHttp({
          audience,
          endpointHeaders: { idempotencyKey, traceId: missingTraceId },
          internalProblem,
          invalidCorrelationProblem: invalidProblem,
          mapError: mapActionError,
          payload: payload.reservation,
          principal: { authenticate: () => Effect.succeed(principal) },
          registration: reservePrincipalBindingAction,
          requestHeaders: { authorization: missingAuthorization, [CORRELATION_ID_HEADER]: correlation },
        }),
        Context.make(ExternalIdentityAdmission, admission),
      ),
    ),
  );

const runActivateAction = (
  principal: TrustedPrincipalContext,
  payload: Schema.Schema.Type<typeof ActivatePrincipalBindingRequestSchema>,
  idempotencyKey: string,
  audience: string,
  admission: ExternalIdentityAdmissionContext,
) =>
  ExternalIdentityHttpCorrelationId.pipe(
    Effect.flatMap((correlation) =>
      Effect.provideContext(
        runGovernedActionHttp({
          audience,
          endpointHeaders: { idempotencyKey, traceId: missingTraceId },
          internalProblem,
          invalidCorrelationProblem: invalidProblem,
          mapError: mapActionError,
          payload: payload.activation,
          principal: { authenticate: () => Effect.succeed(principal) },
          registration: activatePrincipalBindingAction,
          requestHeaders: { authorization: missingAuthorization, [CORRELATION_ID_HEADER]: correlation },
        }),
        Context.make(ExternalIdentityAdmission, admission),
      ),
    ),
  );

const statusAction = (
  principal: TrustedPrincipalContext,
  payload: Schema.Schema.Type<typeof ChangePrincipalBindingStatusRequestSchema>,
  idempotencyKey: string,
  audience: string,
  correlation: string,
) =>
  runGovernedActionHttp({
    audience,
    endpointHeaders: { idempotencyKey, traceId: missingTraceId },
    internalProblem,
    invalidCorrelationProblem: invalidProblem,
    mapError: mapActionError,
    payload: payload.change,
    principal: { authenticate: () => Effect.succeed(principal) },
    registration: changePrincipalBindingStatusAction,
    requestHeaders: { authorization: missingAuthorization, [CORRELATION_ID_HEADER]: correlation },
  });

const runStatusAction = (
  principal: TrustedPrincipalContext,
  payload: Schema.Schema.Type<typeof ChangePrincipalBindingStatusRequestSchema>,
  idempotencyKey: string,
  audience: string,
  admission: ExternalIdentityAdmissionContext | undefined,
) =>
  ExternalIdentityHttpCorrelationId.pipe(
    Effect.flatMap((correlation) =>
      admission === undefined
        ? statusAction(principal, payload, idempotencyKey, audience, correlation)
        : Effect.provideContext(
            statusAction(principal, payload, idempotencyKey, audience, correlation),
            Context.make(ExternalIdentityAdmission, admission),
          ),
    ),
  );

const authenticateWorkloadPrincipal = (apiKey: Redacted.Redacted<string | undefined>) =>
  ExternalIdentityWorkloadAuthorization.pipe(
    Effect.flatMap((authorization) => authorization.authenticate(apiKey)),
    Effect.mapError(mapWorkloadError),
  );

const requireWorkload = (input: ExternalIdentityWorkloadAuthorizationInput) =>
  ExternalIdentityWorkloadAuthorization.pipe(
    Effect.flatMap((authorization) => authorization.authorize(input)),
    Effect.mapError(mapWorkloadError),
  );

const requireWorkloadGrant = (principal: TrustedPrincipalContext, input: ExternalIdentityWorkloadGrantInput) =>
  ExternalIdentityWorkloadAuthorization.pipe(
    Effect.flatMap((authorization) => authorization.authorizePrincipal(principal, input)),
    Effect.mapError(mapWorkloadError),
  );

const requireBindingWorkloadGrant = (
  principal: TrustedPrincipalContext,
  operation: ExternalIdentityWorkloadOperation,
  authenticationNamespaceId: string,
) =>
  requireWorkloadGrant(principal, { operation, targetAuthenticationNamespaceId: authenticationNamespaceId }).pipe(
    // A binding-id request must not disclose whether an inaccessible binding exists.
    Effect.catchIf(Predicate.isTagged('ExternalIdentityForbiddenProblem'), () => Effect.fail(notFoundProblem())),
  );

const recoverGatewayIssuerError = (error: GatewayIssuerError): ExternalIdentityProblem =>
  error.code === 'gateway_audience_invalid'
    ? invalidProblem('The requested gateway audience is not available')
    : unavailableProblem('The gateway assertion issuer is unavailable');

interface ExternalIdentityHandlerRequest {
  readonly headers: ExternalIdentityHttpHeaders;
}

interface ReservePrincipalBindingHandlerInput {
  readonly payload: Schema.Schema.Type<typeof ReservePrincipalBindingRequestSchema>;
  readonly request: ExternalIdentityHandlerRequest;
}

interface ActivatePrincipalBindingHandlerInput {
  readonly payload: Schema.Schema.Type<typeof ActivatePrincipalBindingRequestSchema>;
  readonly request: ExternalIdentityHandlerRequest;
}

interface ChangePrincipalBindingStatusHandlerInput {
  readonly payload: Schema.Schema.Type<typeof ChangePrincipalBindingStatusRequestSchema>;
  readonly request: ExternalIdentityHandlerRequest;
}

interface ReadPrincipalBindingHandlerInput {
  readonly payload: Schema.Schema.Type<typeof ReadPrincipalBindingPayloadSchema>;
  readonly request: ExternalIdentityHandlerRequest;
}

interface ResolveExternalSubjectHandlerInput {
  readonly payload: Schema.Schema.Type<typeof ResolveExternalSubjectRequestSchema>;
  readonly request: ExternalIdentityHandlerRequest;
}

interface IssueExternalGatewayContextHandlerInput {
  readonly payload: Schema.Schema.Type<typeof ExternalGatewayContextRequestSchema>;
  readonly request: ExternalIdentityHandlerRequest;
}

const reservePrincipalBindingHandler = Effect.fn('ExternalIdentityHttp.reservePrincipalBinding')(
  ({ payload, request }: ReservePrincipalBindingHandlerInput) =>
    safe(
      Effect.gen(function* reservePrincipalBindingHttp() {
        const requestCorrelation = yield* requiredHeader(request.headers, CORRELATION_ID_HEADER);
        const idempotencyKey = yield* requiredHeader(request.headers, IDEMPOTENCY_KEY_HEADER);
        return yield* provideExternalIdentityHttpCorrelation(
          requestCorrelation,
          Effect.gen(function* reservePrincipalBindingHandlerBody() {
            const principal = yield* requireWorkload({
              apiKey: Redacted.make(request.headers['x-api-key']),
              operation: 'reserve',
              targetAuthenticationNamespaceId: payload.reservation.authenticationNamespaceId,
            });
            const configuration = yield* ExternalIdentityHttpConfigurationService;
            const admission = yield* provideExternalIdentityHttpWorkload(
              {
                authenticationRef: payload.authenticationRef,
                operation: 'reserve',
                principal,
                providerSubjectId: payload.reservation.providerSubjectId,
                targetAuthenticationNamespaceId: payload.reservation.authenticationNamespaceId,
              },
              makeSubjectAdmission({
                audience: configuration.providerEndpointAudience,
                authenticationRef: payload.authenticationRef,
                subject: payload.reservation,
                tenantId: principal.tenantId,
              }).pipe(Effect.mapError(mapAdmissionError)),
            );
            return yield* runReserveAction(
              principal,
              payload,
              idempotencyKey,
              configuration.providerEndpointAudience,
              admission,
            );
          }),
        );
      }),
    ),
);

const activatePrincipalBindingHandler = Effect.fn('ExternalIdentityHttp.activatePrincipalBinding')(
  ({ payload, request }: ActivatePrincipalBindingHandlerInput) =>
    safe(
      Effect.gen(function* activatePrincipalBindingHttp() {
        const requestCorrelation = yield* requiredHeader(request.headers, CORRELATION_ID_HEADER);
        const idempotencyKey = yield* requiredHeader(request.headers, IDEMPOTENCY_KEY_HEADER);
        return yield* provideExternalIdentityHttpCorrelation(
          requestCorrelation,
          Effect.gen(function* activatePrincipalBindingHandlerBody() {
            const principal = yield* authenticateWorkloadPrincipal(Redacted.make(request.headers['x-api-key']));
            const configuration = yield* ExternalIdentityHttpConfigurationService;
            const binding = yield* requireBinding(
              principal,
              payload.activation.authBindingId,
              configuration.providerEndpointAudience,
            );
            yield* requireBindingWorkloadGrant(principal, 'activate', binding.authenticationNamespaceId);
            const subject = yield* requireBindingSubject(principal, binding, configuration.providerEndpointAudience);
            const admission = yield* provideExternalIdentityHttpWorkload(
              {
                authenticationRef: payload.authenticationRef,
                binding: {
                  authBindingId: binding.authBindingId,
                  bindingRevision: binding.bindingRevision,
                  principalId: binding.principalId,
                },
                operation: 'activate',
                principal,
                providerSubjectId: subject.providerSubjectId,
                targetAuthenticationNamespaceId: binding.authenticationNamespaceId,
              },
              makeSubjectAdmission({
                audience: configuration.providerEndpointAudience,
                authenticationRef: payload.authenticationRef,
                subject,
                tenantId: principal.tenantId,
              }).pipe(Effect.mapError(mapAdmissionError)),
            );
            return yield* runActivateAction(
              principal,
              payload,
              idempotencyKey,
              configuration.providerEndpointAudience,
              admission,
            );
          }),
        );
      }),
    ),
);

const changePrincipalBindingStatusHandler = Effect.fn('ExternalIdentityHttp.changePrincipalBindingStatus')(
  ({ payload, request }: ChangePrincipalBindingStatusHandlerInput) =>
    safe(
      Effect.gen(function* changePrincipalBindingStatusHttp() {
        const requestCorrelation = yield* requiredHeader(request.headers, CORRELATION_ID_HEADER);
        const idempotencyKey = yield* requiredHeader(request.headers, IDEMPOTENCY_KEY_HEADER);
        return yield* provideExternalIdentityHttpCorrelation(
          requestCorrelation,
          Effect.gen(function* changePrincipalBindingStatusHandlerBody() {
            const principal = yield* authenticateWorkloadPrincipal(Redacted.make(request.headers['x-api-key']));
            const configuration = yield* ExternalIdentityHttpConfigurationService;
            const binding = yield* requireBinding(
              principal,
              payload.change.authBindingId,
              configuration.providerEndpointAudience,
            );
            yield* requireBindingWorkloadGrant(principal, 'status', binding.authenticationNamespaceId);
            let admission: ExternalIdentityAdmissionContext | undefined;
            if (payload.change.requestedStatus === 'active') {
              const { authenticationRef } = payload;
              if (authenticationRef === undefined) {
                return yield* Effect.fail(invalidProblem('Re-enabling a binding requires an authenticationRef'));
              }
              const subject = yield* requireBindingSubject(principal, binding, configuration.providerEndpointAudience);
              admission = yield* provideExternalIdentityHttpWorkload(
                {
                  authenticationRef,
                  binding: {
                    authBindingId: binding.authBindingId,
                    bindingRevision: binding.bindingRevision,
                    principalId: binding.principalId,
                  },
                  operation: 'status',
                  principal,
                  providerSubjectId: subject.providerSubjectId,
                  targetAuthenticationNamespaceId: binding.authenticationNamespaceId,
                },
                makeSubjectAdmission({
                  audience: configuration.providerEndpointAudience,
                  authenticationRef,
                  subject,
                  tenantId: principal.tenantId,
                }).pipe(Effect.mapError(mapAdmissionError)),
              );
            }
            return yield* runStatusAction(
              principal,
              payload,
              idempotencyKey,
              configuration.providerEndpointAudience,
              admission,
            );
          }),
        );
      }),
    ),
);

const readPrincipalBindingHandler = Effect.fn('ExternalIdentityHttp.readPrincipalBinding')(
  ({ payload, request }: ReadPrincipalBindingHandlerInput) =>
    safe(
      Effect.gen(function* readPrincipalBindingHttp() {
        const requestCorrelation = yield* requiredHeader(request.headers, CORRELATION_ID_HEADER);
        return yield* provideExternalIdentityHttpCorrelation(
          requestCorrelation,
          Effect.gen(function* readPrincipalBindingHandlerBody() {
            const apiKey = Redacted.make(request.headers['x-api-key']);
            const principal = yield* authenticateWorkloadPrincipal(apiKey);
            const configuration = yield* ExternalIdentityHttpConfigurationService;
            if (payload.lookup === 'binding') {
              const binding = yield* requireBinding(
                principal,
                payload.authBindingId,
                configuration.providerEndpointAudience,
              );
              yield* requireBindingWorkloadGrant(principal, 'read', binding.authenticationNamespaceId);
              return binding;
            }
            yield* requireWorkloadGrant(principal, {
              operation: 'read',
              targetAuthenticationNamespaceId: payload.authenticationNamespaceId,
            });
            return yield* runBindingRead(principal, payload, configuration.providerEndpointAudience);
          }),
        );
      }),
    ),
);

const resolveExternalSubjectHandler = Effect.fn('ExternalIdentityHttp.resolveExternalSubject')(
  ({ payload, request }: ResolveExternalSubjectHandlerInput) =>
    safe(
      Effect.gen(function* resolveExternalSubjectHttp() {
        const requestCorrelation = yield* requiredHeader(request.headers, CORRELATION_ID_HEADER);
        return yield* provideExternalIdentityHttpCorrelation(
          requestCorrelation,
          Effect.gen(function* resolveExternalSubjectHandlerBody() {
            const subject = subjectFromPayload(payload);
            const principal = yield* requireWorkload({
              apiKey: Redacted.make(request.headers['x-api-key']),
              operation: 'resolve',
              targetAuthenticationNamespaceId: payload.authenticationNamespaceId,
            });
            const configuration = yield* ExternalIdentityHttpConfigurationService;
            const binding = yield* requireSubjectBinding(principal, subject, configuration.providerEndpointAudience);
            const admission = yield* provideExternalIdentityHttpWorkload(
              {
                authenticationRef: payload.authenticationRef,
                binding: {
                  authBindingId: binding.authBindingId,
                  bindingRevision: binding.bindingRevision,
                  principalId: binding.principalId,
                },
                operation: 'resolve',
                principal,
                providerSubjectId: subject.providerSubjectId,
                targetAuthenticationNamespaceId: payload.authenticationNamespaceId,
              },
              makeAuthenticationAdmission({
                audience: configuration.providerEndpointAudience,
                authenticationRef: payload.authenticationRef,
                binding,
                subject,
                tenantId: principal.tenantId,
              }).pipe(Effect.mapError(mapAdmissionError)),
            );
            return yield* runResolveRead(principal, subject, admission, configuration.providerEndpointAudience);
          }),
        );
      }),
    ),
);

const issueExternalGatewayContextHandler = Effect.fn('ExternalIdentityHttp.issueExternalGatewayContext')(
  ({ payload, request }: IssueExternalGatewayContextHandlerInput) =>
    safe(
      Effect.gen(function* issueExternalGatewayContextHttp() {
        const requestCorrelation = yield* requiredHeader(request.headers, CORRELATION_ID_HEADER);
        return yield* provideExternalIdentityHttpCorrelation(
          requestCorrelation,
          Effect.gen(function* issueExternalGatewayContextHandlerBody() {
            const subject = subjectFromPayload(payload);
            const principal = yield* requireWorkload({
              apiKey: Redacted.make(request.headers['x-api-key']),
              operation: 'gateway-context',
              targetAudience: payload.audience,
              targetAuthenticationNamespaceId: payload.authenticationNamespaceId,
            });
            const configuration = yield* ExternalIdentityHttpConfigurationService;
            const binding = yield* requireSubjectBinding(principal, subject, configuration.providerEndpointAudience);
            const admission = yield* provideExternalIdentityHttpWorkload(
              {
                authenticationRef: payload.authenticationRef,
                binding: {
                  authBindingId: binding.authBindingId,
                  bindingRevision: binding.bindingRevision,
                  principalId: binding.principalId,
                },
                operation: 'gateway-context',
                principal,
                providerSubjectId: subject.providerSubjectId,
                targetAudience: payload.audience,
                targetAuthenticationNamespaceId: payload.authenticationNamespaceId,
              },
              makeAuthenticationAdmission({
                audience: payload.audience,
                authenticationRef: payload.authenticationRef,
                binding,
                subject,
                tenantId: principal.tenantId,
              }).pipe(Effect.mapError(mapAdmissionError)),
            );
            const resolved = yield* runResolveRead(
              principal,
              subject,
              admission,
              configuration.providerEndpointAudience,
            );
            let legalEntityId: typeof principal.legalEntityId;
            if (payload.legalEntityId !== undefined) {
              const selected = yield* validateAuthorizedLegalEntity({
                legalEntityId: payload.legalEntityId,
                principalId: resolved.principalId,
                tenantId: resolved.tenantId,
              }).pipe(Effect.mapError(mapLegalEntitySelectionProblem));
              const { legalEntityId: selectedLegalEntityId } = selected;
              legalEntityId = selectedLegalEntityId;
            }
            const gatewayPrincipalBase: TrustedPrincipalContext = {
              authBindingId: resolved.authBindingId,
              authContextRef: payload.authenticationRef,
              authenticationNamespaceId: resolved.authenticationNamespaceId,
              authMethod: 'session',
              principalId: resolved.principalId,
              tenantId: resolved.tenantId,
            };
            const gatewayPrincipal: TrustedPrincipalContext =
              legalEntityId === undefined ? gatewayPrincipalBase : { ...gatewayPrincipalBase, legalEntityId };
            const validatedGatewayPrincipal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)(
              gatewayPrincipal,
            ).pipe(Effect.mapError(mapTrustedPrincipalDecodeProblem));
            return yield* issueGatewayContextAssertion({
              audience: payload.audience,
              principal: validatedGatewayPrincipal,
            }).pipe(Effect.mapError(recoverGatewayIssuerError));
          }),
        );
      }),
    ),
);

const buildExternalIdentityHandlers = (handlers: HttpApiBuilder.Handlers.FromGroup<typeof ExternalIdentityApiGroup>) =>
  handlers
    .handle('reservePrincipalBinding', reservePrincipalBindingHandler)
    .handle('activatePrincipalBinding', activatePrincipalBindingHandler)
    .handle('changePrincipalBindingStatus', changePrincipalBindingStatusHandler)
    .handle('readPrincipalBinding', readPrincipalBindingHandler)
    .handle('resolveExternalSubject', resolveExternalSubjectHandler)
    .handle('issueExternalGatewayContext', issueExternalGatewayContextHandler);

const externalIdentityStandaloneApiGroupLive = HttpApiBuilder.group(
  ExternalIdentityApi,
  'externalIdentity',
  buildExternalIdentityHandlers,
);

/** Shell-owned group layer with a concrete handler chain proven by the native
 * strict Effect API boundary analyzer. */
export const externalIdentityGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'externalIdentity', (handlers) =>
  handlers
    .handle('reservePrincipalBinding', reservePrincipalBindingHandler)
    .handle('activatePrincipalBinding', activatePrincipalBindingHandler)
    .handle('changePrincipalBindingStatus', changePrincipalBindingStatusHandler)
    .handle('readPrincipalBinding', readPrincipalBindingHandler)
    .handle('resolveExternalSubject', resolveExternalSubjectHandler)
    .handle('issueExternalGatewayContext', issueExternalGatewayContextHandler),
);
export const externalIdentityStandaloneGroupLive = externalIdentityStandaloneApiGroupLive;
