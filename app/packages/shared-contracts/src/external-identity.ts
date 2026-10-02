import {
  ActivatePrincipalBindingPayloadSchema,
  ActivatePrincipalBindingResultSchema,
  ChangePrincipalBindingStatusPayloadSchema,
  ChangePrincipalBindingStatusResultSchema,
  ExternalAuthenticationSubjectSchema,
  ReservePrincipalBindingPayloadSchema,
  ReservePrincipalBindingResultSchema,
  ReadPrincipalBindingPayloadSchema,
  ReadPrincipalBindingResultSchema,
  ResolveExternalSubjectResultSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, Schema } from '@modern-js/bff-effect/effect-client';

import {
  GatewayAudienceSchema,
  GatewayContextRequestSchema,
  GatewayContextResponseSchema,
  GatewayReloadRequiredProblemSchema,
} from './gateway-context.ts';
import { problemDetailsContentType, problemDetailsFields } from './problem-details.ts';

const LegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
const authenticationRef = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const mutationHeaders = Schema.Struct({
  'idempotency-key': Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  'x-correlation-id': Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

export const ExternalIdentityInvalidProblemSchema = Schema.TaggedStruct('ExternalIdentityInvalidProblem', {
  ...problemDetailsFields,
  status: Schema.Literal(400),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(400));
export const ExternalIdentityUnauthorizedProblemSchema = Schema.TaggedStruct('ExternalIdentityUnauthorizedProblem', {
  ...problemDetailsFields,
  status: Schema.Literal(401),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(401));
export const ExternalIdentityForbiddenProblemSchema = Schema.TaggedStruct('ExternalIdentityForbiddenProblem', {
  ...problemDetailsFields,
  status: Schema.Literal(403),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(403));
export const ExternalIdentityNotFoundProblemSchema = Schema.TaggedStruct('ExternalIdentityNotFoundProblem', {
  ...problemDetailsFields,
  status: Schema.Literal(404),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(404));
export const ExternalIdentityConflictProblemSchema = Schema.TaggedStruct('ExternalIdentityConflictProblem', {
  ...problemDetailsFields,
  status: Schema.Literal(409),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(409));
export const ExternalIdentityIneligibleProblemSchema = Schema.TaggedStruct('ExternalIdentityIneligibleProblem', {
  ...problemDetailsFields,
  status: Schema.Literal(422),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(422));
export const ExternalIdentityThrottledProblemSchema = Schema.TaggedStruct('ExternalIdentityThrottledProblem', {
  ...problemDetailsFields,
  status: Schema.Literal(429),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(429));
export const ExternalIdentityInternalProblemSchema = Schema.TaggedStruct('ExternalIdentityInternalProblem', {
  ...problemDetailsFields,
  status: Schema.Literal(500),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(500));
export const ExternalIdentityUnavailableProblemSchema = Schema.TaggedStruct('ExternalIdentityUnavailableProblem', {
  ...problemDetailsFields,
  retryable: Schema.Literal(true),
  status: Schema.Literal(503),
}).pipe(HttpApiSchema.asJson({ contentType: problemDetailsContentType }), HttpApiSchema.status(503));

export const externalIdentityProblems = [
  ExternalIdentityInvalidProblemSchema,
  ExternalIdentityUnauthorizedProblemSchema,
  ExternalIdentityForbiddenProblemSchema,
  ExternalIdentityNotFoundProblemSchema,
  ExternalIdentityConflictProblemSchema,
  ExternalIdentityIneligibleProblemSchema,
  ExternalIdentityThrottledProblemSchema,
  ExternalIdentityInternalProblemSchema,
  ExternalIdentityUnavailableProblemSchema,
  GatewayReloadRequiredProblemSchema,
] as const;

export const ReservePrincipalBindingRequestSchema = Schema.Struct({
  authenticationRef,
  compositionRevision: GatewayContextRequestSchema.fields.compositionRevision,
  reservation: ReservePrincipalBindingPayloadSchema,
});
export const ActivatePrincipalBindingRequestSchema = Schema.Struct({
  activation: ActivatePrincipalBindingPayloadSchema,
  authenticationRef,
  compositionRevision: GatewayContextRequestSchema.fields.compositionRevision,
});
export const ChangePrincipalBindingStatusRequestSchema = Schema.Struct({
  authenticationRef: Schema.optionalKey(authenticationRef),
  change: ChangePrincipalBindingStatusPayloadSchema,
  compositionRevision: GatewayContextRequestSchema.fields.compositionRevision,
});
export const ResolveExternalSubjectRequestSchema = Schema.Struct({
  ...ExternalAuthenticationSubjectSchema.fields,
  authenticationRef,
  compositionRevision: GatewayContextRequestSchema.fields.compositionRevision,
});
export const ExternalGatewayContextRequestSchema = Schema.Struct({
  ...ResolveExternalSubjectRequestSchema.fields,
  audience: GatewayAudienceSchema,
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
});

/** Service callers are authenticated before these capabilities resolve a customer Principal. */
export const ExternalIdentityApiGroup = HttpApiGroup.make('externalIdentity')
  .add(
    HttpApiEndpoint.post('reservePrincipalBinding', '/auth/identity/external/bindings/reserve', {
      error: externalIdentityProblems,
      headers: mutationHeaders,
      payload: ReservePrincipalBindingRequestSchema,
      success: ReservePrincipalBindingResultSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('activatePrincipalBinding', '/auth/identity/external/bindings/activate', {
      error: externalIdentityProblems,
      headers: mutationHeaders,
      payload: ActivatePrincipalBindingRequestSchema,
      success: ActivatePrincipalBindingResultSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('changePrincipalBindingStatus', '/auth/identity/external/binding/status', {
      error: externalIdentityProblems,
      headers: mutationHeaders,
      payload: ChangePrincipalBindingStatusRequestSchema,
      success: ChangePrincipalBindingStatusResultSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('readPrincipalBinding', '/auth/identity/external/bindings/read', {
      error: externalIdentityProblems,
      payload: ReadPrincipalBindingPayloadSchema,
      success: ReadPrincipalBindingResultSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('resolveExternalSubject', '/auth/identity/external/resolve', {
      error: externalIdentityProblems,
      payload: ResolveExternalSubjectRequestSchema,
      success: ResolveExternalSubjectResultSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('issueExternalGatewayContext', '/auth/identity/external/gateway-context', {
      error: externalIdentityProblems,
      payload: ExternalGatewayContextRequestSchema,
      success: GatewayContextResponseSchema,
    }),
  );

export const ExternalIdentityApi = HttpApi.make('externalIdentityApi').add(ExternalIdentityApiGroup);
