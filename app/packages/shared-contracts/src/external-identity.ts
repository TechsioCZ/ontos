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
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';

import { GatewayAudienceSchema, GatewayContextResponseSchema } from './gateway-context.ts';
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from './problem-details.ts';

const LegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
const authenticationRef = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const mutationHeaders = Schema.Struct({
  'idempotency-key': Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  'x-correlation-id': Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

export const ExternalIdentityInvalidProblemSchema = makeProblemDetailsSchema('ExternalIdentityInvalidProblem', 400);
export const ExternalIdentityUnauthorizedProblemSchema = makeProblemDetailsSchema(
  'ExternalIdentityUnauthorizedProblem',
  401,
);
export const ExternalIdentityForbiddenProblemSchema = makeProblemDetailsSchema('ExternalIdentityForbiddenProblem', 403);
export const ExternalIdentityNotFoundProblemSchema = makeProblemDetailsSchema('ExternalIdentityNotFoundProblem', 404);
export const ExternalIdentityConflictProblemSchema = makeProblemDetailsSchema('ExternalIdentityConflictProblem', 409);
export const ExternalIdentityIneligibleProblemSchema = makeProblemDetailsSchema(
  'ExternalIdentityIneligibleProblem',
  422,
);
export const ExternalIdentityThrottledProblemSchema = makeProblemDetailsSchema('ExternalIdentityThrottledProblem', 429);
export const ExternalIdentityInternalProblemSchema = makeProblemDetailsSchema('ExternalIdentityInternalProblem', 500);
export const ExternalIdentityUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'ExternalIdentityUnavailableProblem',
  503,
);

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
] as const;

export const ReservePrincipalBindingRequestSchema = Schema.Struct({
  authenticationRef,
  reservation: ReservePrincipalBindingPayloadSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const ActivatePrincipalBindingRequestSchema = Schema.Struct({
  activation: ActivatePrincipalBindingPayloadSchema,
  authenticationRef,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const ChangePrincipalBindingStatusRequestSchema = Schema.Struct({
  authenticationRef: Schema.optionalKey(authenticationRef),
  change: ChangePrincipalBindingStatusPayloadSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const ResolveExternalSubjectRequestSchema = Schema.Struct({
  ...ExternalAuthenticationSubjectSchema.fields,
  authenticationRef,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const ExternalGatewayContextRequestSchema = Schema.Struct({
  ...ResolveExternalSubjectRequestSchema.fields,
  audience: GatewayAudienceSchema,
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

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
