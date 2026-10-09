import {
  externalIdentityFailure,
  TrustedAdmissionObservation,
} from '@app/core-runtime/auth/external-identity-admission';
import type {
  AuthenticationAdmissionRequest,
  ExternalIdentityFailure,
  TrustedAdmissionObservationService,
} from '@app/core-runtime/auth/external-identity-admission';
import { AuthenticationAdmissionObservationSchema } from '@app/core-runtime/auth/external-identity-contracts';
import type { AuthenticationAdmissionObservation } from '@app/core-runtime/auth/external-identity-contracts';
import { Effect, Layer, DateTime, Schema } from 'effect';
import {
  COMMERCE_ADMISSION_DEADLINE_MS,
  COMMERCE_AUTHENTICATION_NAMESPACE_ID,
} from '../../../shared/portal-auth-contracts.ts';
import type { VerifyExternalAuthenticationResult } from '../../../shared/portal-auth-contracts.ts';
import {
  COMMERCE_PORTAL_AUTH_VERIFY_OPERATION,
  CommercePortalAuthVerificationRequestSchema,
} from '../../../shared/portal-auth-verification.ts';
import { CommercePortalAuthVerificationClient } from '../../../src/api/portal-auth-verification/client.ts';
import type { CommercePortalAuthVerificationClientPort } from '../../../src/api/portal-auth-verification/client.ts';
import type { CommercePortalAuthVerificationRequest } from '../../../shared/portal-auth-verification.ts';
import { CommercePortalAuthBindingProjectionResolver } from './projection-resolver.ts';
import type {
  CommercePortalAuthBindingProjection,
  CommercePortalAuthBindingProjectionResolverService,
} from './projection-resolver.ts';

const mapInvalidObservation = (cause: unknown): ExternalIdentityFailure =>
  Object.defineProperty(
    externalIdentityFailure('identity_invalid', 'Commerce admission observation is invalid'),
    'cause',
    { configurable: true, value: cause },
  );

const matchesProviderResult = (
  result: Extract<VerifyExternalAuthenticationResult, { readonly outcome: 'ALLOWED' }>,
  request: CommercePortalAuthVerificationRequest,
): boolean =>
  result.authenticationNamespaceId === request.authenticationNamespaceId &&
  result.providerSubjectId === request.providerSubjectId &&
  result.sessionRef === request.sessionRef &&
  result.subjectType === request.subjectType &&
  result.tenantId === request.tenantId &&
  result.nonce === request.nonce &&
  result.enrollmentAttemptId === request.enrollmentAttemptId;

const providerRequest = (
  input: AuthenticationAdmissionRequest,
  projection: CommercePortalAuthBindingProjection,
): Effect.Effect<CommercePortalAuthVerificationRequest, ExternalIdentityFailure> =>
  input.authenticationNamespaceId !== COMMERCE_AUTHENTICATION_NAMESPACE_ID || input.subjectType !== 'user'
    ? Effect.fail(externalIdentityFailure('identity_invalid', 'Commerce admission subject is not a Commerce user'))
    : Schema.decodeEffect(CommercePortalAuthVerificationRequestSchema)({
        audience: input.audience,
        authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
        nonce: input.nonce,
        operation: COMMERCE_PORTAL_AUTH_VERIFY_OPERATION,
        operationRef: input.operationRef,
        providerSubjectId: projection.providerSubjectId,
        sessionRef: projection.sessionRef,
        subjectType: 'user',
        tenantId: input.tenantId,
      }).pipe(Effect.mapError(mapInvalidObservation));

const toObservation = (
  result: VerifyExternalAuthenticationResult,
  providerRequestValue: CommercePortalAuthVerificationRequest,
  coreRequest: AuthenticationAdmissionRequest,
  projection: CommercePortalAuthBindingProjection,
): Effect.Effect<AuthenticationAdmissionObservation, ExternalIdentityFailure> => {
  if (result.outcome === 'UNAVAILABLE') {
    return Effect.fail(
      externalIdentityFailure('identity_unavailable', 'Commerce provider verification is unavailable'),
    );
  }
  if (result.outcome === 'REJECTED') {
    return Effect.fail(externalIdentityFailure('identity_forbidden', 'Commerce provider verification was rejected'));
  }
  if (!matchesProviderResult(result, providerRequestValue)) {
    return Effect.fail(
      externalIdentityFailure('identity_invalid', 'Commerce provider verification did not match the operation'),
    );
  }
  const observedAtMillis = DateTime.toEpochMillis(result.observedAt);
  if (!Number.isFinite(observedAtMillis)) {
    return Effect.fail(externalIdentityFailure('identity_invalid', 'Commerce provider observation time is invalid'));
  }
  const observation = {
    audience: coreRequest.audience,
    authBindingId: coreRequest.authBindingId,
    authContextRef: coreRequest.authContextRef,
    authenticationNamespaceId: coreRequest.authenticationNamespaceId,
    bindingRevision: projection.bindingRevision,
    expiresAt: DateTime.makeUnsafe(observedAtMillis + COMMERCE_ADMISSION_DEADLINE_MS),
    nonce: coreRequest.nonce,
    observedAt: result.observedAt,
    operationRef: coreRequest.operationRef,
    principalId: coreRequest.principalId,
    tenantId: coreRequest.tenantId,
  };
  return Schema.decodeEffect(AuthenticationAdmissionObservationSchema)(observation).pipe(
    Effect.mapError(mapInvalidObservation),
  );
};

const mapProjectionFailure = (cause: unknown): ExternalIdentityFailure =>
  Object.defineProperty(
    externalIdentityFailure('identity_unavailable', 'Commerce admission projection is unavailable'),
    'cause',
    { configurable: true, value: cause },
  );

const projectionMatchesRequest = (
  request: AuthenticationAdmissionRequest,
  projection: CommercePortalAuthBindingProjection,
): boolean =>
  projection.sessionRef === request.authContextRef &&
  Number.isSafeInteger(projection.bindingRevision) &&
  projection.bindingRevision >= 1;

const mapTransportFailure = (cause: unknown): ExternalIdentityFailure =>
  Object.defineProperty(
    externalIdentityFailure('identity_unavailable', 'Commerce provider verification transport failed'),
    'cause',
    { configurable: true, value: cause },
  );

const observeProjectedAuthentication = (
  client: CommercePortalAuthVerificationClientPort,
  request: AuthenticationAdmissionRequest,
  projection: CommercePortalAuthBindingProjection,
): Effect.Effect<AuthenticationAdmissionObservation, ExternalIdentityFailure> =>
  providerRequest(request, projection).pipe(
    Effect.flatMap((requestValue) =>
      client.verify(requestValue, { requestCorrelation: request.operationRef }).pipe(
        Effect.mapError(mapTransportFailure),
        Effect.flatMap((result) => toObservation(result, requestValue, request, projection)),
      ),
    ),
  );

const observeCommerceAuthentication = (
  resolveProjection: CommercePortalAuthBindingProjectionResolverService['resolve'],
  client: CommercePortalAuthVerificationClientPort,
  request: AuthenticationAdmissionRequest,
): Effect.Effect<AuthenticationAdmissionObservation, ExternalIdentityFailure> =>
  Effect.try({
    catch: mapProjectionFailure,
    try: () => resolveProjection(request),
  }).pipe(
    Effect.flatMap((projection) => {
      if (projection === undefined) {
        return Effect.fail(mapProjectionFailure('Commerce admission binding projection is missing'));
      }
      if (projectionMatchesRequest(request, projection)) {
        return observeProjectedAuthentication(client, request, projection);
      }
      return Effect.fail(
        mapInvalidObservation('Commerce admission binding projection changed during operation admission'),
      );
    }),
  );

export const commercePortalAuthAdmissionObservationLive = Layer.effect(
  TrustedAdmissionObservation,
  Effect.gen(function* makeCommercePortalAuthAdmissionObservation() {
    const resolver = yield* CommercePortalAuthBindingProjectionResolver;
    const client = yield* CommercePortalAuthVerificationClient;
    const service: TrustedAdmissionObservationService = {
      observeAuthentication: (request) => observeCommerceAuthentication(resolver.resolve, client, request),
      observeExternalSubject: () =>
        Effect.fail(externalIdentityFailure('identity_unavailable', 'Commerce subject admission is not installed')),
    };
    return service;
  }),
);
