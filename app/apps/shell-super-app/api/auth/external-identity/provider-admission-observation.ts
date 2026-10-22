/**
 * Admission observation for the installed external identity provider: validates the workload request context,
 * asks the provider module's declared verification endpoint, and projects its answer into a Core observation that
 * stays valid for the admission deadline the module declares.
 */
import {
  externalIdentityFailure,
  TrustedAdmissionObservation,
} from '@app/core-runtime/auth/external-identity-admission';
import type {
  AuthenticationAdmissionRequest,
  ExternalIdentityFailure,
  ExternalSubjectAdmissionMatch,
} from '@app/core-runtime/auth/external-identity-admission';
import {
  AuthenticationAdmissionObservationSchema,
  ExternalSubjectAdmissionObservationSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import type {
  AuthenticationAdmissionObservation,
  ExternalSubjectAdmissionObservation,
} from '@app/core-runtime/auth/external-identity-contracts';
import { ExternalIdentityVerificationRequestSchema } from '@app/core-runtime/auth/external-identity-provider';
import type {
  ExternalIdentityVerificationRequest,
  ExternalIdentityVerificationResult,
} from '@app/core-runtime/auth/external-identity-provider';
import { DateTime, Effect, Layer, Schema } from 'effect';

import { ExternalIdentityProviderConfigurationService } from '../external-identity-provider.ts';
import type {
  ExternalIdentityProviderConfiguration,
  InstalledExternalIdentityProvider,
} from '../external-identity-provider.ts';
import { InstalledExternalIdentityProviderResolver } from './provider-resolver.ts';
import { ExternalIdentityVerificationClient } from './provider-verification-client.ts';
import { ExternalIdentityHttpWorkloadContext } from './request-context.ts';
import type { ExternalIdentityHttpWorkloadContextValue } from './request-context.ts';

const invalid = (reason: string, cause?: unknown): ExternalIdentityFailure =>
  externalIdentityFailure('identity_invalid', reason, cause);

const unavailable = (reason: string, cause?: unknown): ExternalIdentityFailure =>
  externalIdentityFailure('identity_unavailable', reason, cause);

const providerUnavailable = (cause: unknown): ExternalIdentityFailure =>
  unavailable('Provider verification transport failed', cause);

const mapProviderResult = (cause: unknown): ExternalIdentityFailure =>
  invalid('Provider verification response is invalid', cause);

const getRequestContext = (): Effect.Effect<ExternalIdentityHttpWorkloadContextValue, ExternalIdentityFailure> =>
  Effect.serviceOption(ExternalIdentityHttpWorkloadContext).pipe(
    Effect.flatMap((context) =>
      Effect.fromOption(context, () => unavailable('The external identity request context is unavailable')),
    ),
  );

const isWorkloadPrincipal = (context: ExternalIdentityHttpWorkloadContextValue): boolean =>
  context.principal.authMethod === 'api_key' && context.principal.impersonatedByPrincipalId === undefined;

const validateSharedContext = (
  context: ExternalIdentityHttpWorkloadContextValue,
  input: {
    readonly audience: string;
    readonly authContextRef: string;
    readonly authenticationNamespaceId: string;
    readonly subjectType: string;
    readonly tenantId: string;
  },
  configuration: ExternalIdentityProviderConfiguration,
): Effect.Effect<void, ExternalIdentityFailure> => {
  if (!isWorkloadPrincipal(context)) {
    return Effect.fail(invalid('The external identity workload principal is not a direct API-key principal'));
  }
  if (context.principal.tenantId !== input.tenantId) {
    return Effect.fail(invalid('The external identity workload tenant changed during admission'));
  }
  if (context.authenticationRef !== input.authContextRef) {
    return Effect.fail(invalid('The external identity authentication reference changed during admission'));
  }
  if (context.providerSubjectId.length === 0) {
    return Effect.fail(invalid('The external identity provider subject is unavailable'));
  }
  if (input.authenticationNamespaceId !== configuration.authenticationNamespaceId || input.subjectType !== 'user') {
    return Effect.fail(invalid('The external identity subject is not a user of the configured provider'));
  }
  if (context.targetAuthenticationNamespaceId !== input.authenticationNamespaceId) {
    return Effect.fail(invalid('The external identity target namespace changed during admission'));
  }
  if (context.targetAudience !== undefined && context.targetAudience !== input.audience) {
    return Effect.fail(invalid('The external identity target audience changed during admission'));
  }
  if (context.targetAudience === undefined && input.audience !== configuration.providerEndpointAudience) {
    return Effect.fail(invalid('The external identity provider audience changed during admission'));
  }
  return Effect.void;
};

const validateSubjectContext = (
  context: ExternalIdentityHttpWorkloadContextValue,
  input: ExternalSubjectAdmissionMatch,
  configuration: ExternalIdentityProviderConfiguration,
): Effect.Effect<void, ExternalIdentityFailure> =>
  validateSharedContext(context, input, configuration).pipe(
    Effect.flatMap(() =>
      context.operation === 'reserve' || context.operation === 'activate' || context.operation === 'status'
        ? Effect.void
        : Effect.fail(invalid('The external identity operation cannot admit a subject')),
    ),
    Effect.flatMap(() =>
      context.providerSubjectId === input.providerSubjectId
        ? Effect.void
        : Effect.fail(invalid('The external identity provider subject changed during admission')),
    ),
    Effect.flatMap(() => {
      const hasBinding = context.binding !== undefined;
      if (context.operation === 'reserve' && !hasBinding) {
        return Effect.void;
      }
      if ((context.operation === 'activate' || context.operation === 'status') && hasBinding) {
        return Effect.void;
      }
      return Effect.fail(invalid('The external identity binding projection is inconsistent'));
    }),
  );

const validateAuthenticationContext = (
  context: ExternalIdentityHttpWorkloadContextValue,
  input: AuthenticationAdmissionRequest,
  configuration: ExternalIdentityProviderConfiguration,
): Effect.Effect<void, ExternalIdentityFailure> =>
  validateSharedContext(context, input, configuration).pipe(
    Effect.flatMap(() =>
      context.operation === 'resolve' || context.operation === 'gateway-context'
        ? Effect.void
        : Effect.fail(invalid('The external identity operation cannot admit authentication')),
    ),
    Effect.flatMap(() => {
      const { binding } = context;
      if (binding === undefined) {
        return Effect.fail(invalid('The external identity binding projection is unavailable'));
      }
      if (binding.authBindingId !== input.authBindingId || binding.principalId !== input.principalId) {
        return Effect.fail(invalid('The external identity binding changed during admission'));
      }
      if (!Number.isSafeInteger(binding.bindingRevision) || binding.bindingRevision < 1) {
        return Effect.fail(invalid('The external identity binding revision is malformed'));
      }
      return Effect.void;
    }),
  );

const makeProviderRequest = (input: {
  readonly admission: AuthenticationAdmissionRequest | ExternalSubjectAdmissionMatch;
  readonly configuration: ExternalIdentityProviderConfiguration;
  readonly context: ExternalIdentityHttpWorkloadContextValue;
  readonly installed: InstalledExternalIdentityProvider;
}): Effect.Effect<ExternalIdentityVerificationRequest, ExternalIdentityFailure> =>
  Schema.decodeEffect(ExternalIdentityVerificationRequestSchema)({
    // The request is received by the provider; the Core audience remains bound in the admission below.
    audience: input.configuration.providerEndpointAudience,
    authenticationNamespaceId: input.configuration.authenticationNamespaceId,
    nonce: input.admission.nonce,
    operation: input.installed.declaration.verification.operation,
    operationRef: input.admission.operationRef,
    providerSubjectId: input.context.providerSubjectId,
    sessionRef: input.context.authenticationRef,
    subjectType: 'user',
    tenantId: input.admission.tenantId,
  }).pipe(Effect.mapError((cause) => invalid('The provider verification request is malformed', cause)));

const matchesProviderResult = (
  result: Extract<ExternalIdentityVerificationResult, { readonly outcome: 'ALLOWED' }>,
  request: ExternalIdentityVerificationRequest,
): boolean =>
  result.authenticationNamespaceId === request.authenticationNamespaceId &&
  result.providerSubjectId === request.providerSubjectId &&
  result.sessionRef === request.sessionRef &&
  result.subjectType === request.subjectType &&
  result.tenantId === request.tenantId &&
  result.nonce === request.nonce &&
  result.enrollmentAttemptId === request.enrollmentAttemptId;

const observedExpiry = (
  result: ExternalIdentityVerificationResult,
  deadlineMillis: number,
): Effect.Effect<DateTime.Utc, ExternalIdentityFailure> => {
  const observedAt = DateTime.toEpochMillis(result.observedAt);
  return Number.isFinite(observedAt)
    ? Effect.succeed(DateTime.makeUnsafe(observedAt + deadlineMillis))
    : Effect.fail(invalid('Provider observation time is invalid'));
};

const observeSubjectResult = (
  result: ExternalIdentityVerificationResult,
  request: ExternalIdentityVerificationRequest,
  input: ExternalSubjectAdmissionMatch,
  deadlineMillis: number,
): Effect.Effect<ExternalSubjectAdmissionObservation, ExternalIdentityFailure> => {
  if (result.outcome === 'UNAVAILABLE') {
    return Effect.fail(unavailable('Provider verification is unavailable'));
  }
  if (result.outcome === 'REJECTED') {
    return Effect.fail(externalIdentityFailure('identity_forbidden', 'Provider verification was rejected'));
  }
  if (!matchesProviderResult(result, request)) {
    return Effect.fail(invalid('Provider verification did not match the operation'));
  }
  return observedExpiry(result, deadlineMillis).pipe(
    Effect.flatMap((expiresAt) =>
      Schema.decodeEffect(ExternalSubjectAdmissionObservationSchema)({
        audience: input.audience,
        authContextRef: input.authContextRef,
        authenticationNamespaceId: input.authenticationNamespaceId,
        expiresAt,
        nonce: input.nonce,
        observedAt: result.observedAt,
        operationRef: input.operationRef,
        providerSubjectId: input.providerSubjectId,
        subjectType: input.subjectType,
        tenantId: input.tenantId,
      }),
    ),
    Effect.mapError((cause) => mapProviderResult(cause)),
  );
};

const observeAuthenticationResult = (
  result: ExternalIdentityVerificationResult,
  request: ExternalIdentityVerificationRequest,
  input: AuthenticationAdmissionRequest,
  context: ExternalIdentityHttpWorkloadContextValue,
  deadlineMillis: number,
): Effect.Effect<AuthenticationAdmissionObservation, ExternalIdentityFailure> => {
  if (result.outcome === 'UNAVAILABLE') {
    return Effect.fail(unavailable('Provider verification is unavailable'));
  }
  if (result.outcome === 'REJECTED') {
    return Effect.fail(externalIdentityFailure('identity_forbidden', 'Provider verification was rejected'));
  }
  if (!matchesProviderResult(result, request)) {
    return Effect.fail(invalid('Provider verification did not match the operation'));
  }
  const { binding } = context;
  if (binding === undefined) {
    return Effect.fail(invalid('The external identity binding projection is unavailable'));
  }
  return observedExpiry(result, deadlineMillis).pipe(
    Effect.flatMap((expiresAt) =>
      Schema.decodeEffect(AuthenticationAdmissionObservationSchema)({
        audience: input.audience,
        authBindingId: input.authBindingId,
        authContextRef: input.authContextRef,
        authenticationNamespaceId: input.authenticationNamespaceId,
        bindingRevision: binding.bindingRevision,
        expiresAt,
        nonce: input.nonce,
        observedAt: result.observedAt,
        operationRef: input.operationRef,
        principalId: input.principalId,
        tenantId: input.tenantId,
      }),
    ),
    Effect.mapError((cause) => mapProviderResult(cause)),
  );
};

/** Observes admissions through the verification endpoint the provider module declares. */
export const ProviderAdmissionObservationLive = Layer.effect(
  TrustedAdmissionObservation,
  Effect.gen(function* makeProviderAdmissionObservation() {
    const configuration = yield* ExternalIdentityProviderConfigurationService;
    const resolver = yield* InstalledExternalIdentityProviderResolver;
    const client = yield* ExternalIdentityVerificationClient;
    return {
      observeAuthentication: Effect.fn('ProviderAdmissionObservation.observeAuthentication')(
        function* observeAuthentication(admission) {
          const context = yield* getRequestContext();
          yield* validateAuthenticationContext(context, admission, configuration);
          const installed = yield* resolver.resolve;
          const providerRequest = yield* makeProviderRequest({ admission, configuration, context, installed });
          const result = yield* client
            .verify(installed, providerRequest, { requestCorrelation: providerRequest.operationRef })
            .pipe(Effect.mapError(providerUnavailable));
          return yield* observeAuthenticationResult(
            result,
            providerRequest,
            admission,
            context,
            installed.declaration.admissionDeadlineMs,
          );
        },
      ),
      observeExternalSubject: Effect.fn('ProviderAdmissionObservation.observeExternalSubject')(
        function* observeSubject(admission) {
          const context = yield* getRequestContext();
          yield* validateSubjectContext(context, admission, configuration);
          const installed = yield* resolver.resolve;
          const providerRequest = yield* makeProviderRequest({ admission, configuration, context, installed });
          const result = yield* client
            .verify(installed, providerRequest, { requestCorrelation: providerRequest.operationRef })
            .pipe(Effect.mapError(providerUnavailable));
          return yield* observeSubjectResult(
            result,
            providerRequest,
            admission,
            installed.declaration.admissionDeadlineMs,
          );
        },
      ),
    };
  }),
);
