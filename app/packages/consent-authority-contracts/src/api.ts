import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from 'effect/http-api';
import { Schema } from 'effect';
import {
  ConsentSelfServiceRequestSchema,
  TrustedOperationConsentAuthorityFactSchema,
  RecordNoticeProvisionPayloadSchema,
  PrivacyNoticeAuthorityFactSchema,
} from './index.ts';

export const CommerceConsentAuthorityPayloadSchema = Schema.Struct({
  credentialRef: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  request: ConsentSelfServiceRequestSchema,
});
export type CommerceConsentAuthorityPayload = typeof CommerceConsentAuthorityPayloadSchema.Type;
export const ConsentAuthorityInvalidProblemSchema = makeProblemDetailsSchema('ConsentAuthorityInvalidProblem', 400, {
  code: Schema.Literal('invalid_request'),
});
export const ConsentAuthorityAuthenticationProblemSchema = makeProblemDetailsSchema(
  'ConsentAuthorityAuthenticationProblem',
  401,
  {
    code: Schema.Literal('authentication_failed'),
  },
);
export const ConsentAuthorityForbiddenProblemSchema = makeProblemDetailsSchema(
  'ConsentAuthorityForbiddenProblem',
  403,
  {
    code: Schema.Literal('consent_forbidden'),
  },
);
export const ConsentAuthorityUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'ConsentAuthorityUnavailableProblem',
  503,
  {
    code: Schema.Literal('consent_unavailable'),
  },
);
export class CommerceConsentAuthoritySchemaError extends HttpApiMiddleware.Service<CommerceConsentAuthoritySchemaError>()(
  'commerce-customer-context/CommerceConsentAuthoritySchemaError',
  { error: ConsentAuthorityInvalidProblemSchema },
) {}
const group = HttpApiGroup.make('commerceConsentAuthority')
  .add(
    HttpApiEndpoint.post('execute', '/api/portal-auth/consent-authority', {
      error: [
        ConsentAuthorityInvalidProblemSchema,
        ConsentAuthorityAuthenticationProblemSchema,
        ConsentAuthorityForbiddenProblemSchema,
        ConsentAuthorityUnavailableProblemSchema,
      ],
      payload: CommerceConsentAuthorityPayloadSchema,
      success: TrustedOperationConsentAuthorityFactSchema,
    }),
  )
  .middleware(CommerceConsentAuthoritySchemaError);
export type CommerceConsentAuthorityGroup = HttpApiGroup.HttpApiGroup<
  'commerceConsentAuthority',
  HttpApiGroup.Endpoints<typeof group>
>;
const declaredGroup: CommerceConsentAuthorityGroup = group;
export const CommerceConsentAuthorityApi = HttpApi.make('CommerceConsentAuthorityApi')
  .add(declaredGroup)
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' });
const noticeGroup = HttpApiGroup.make('commerceConsentNoticeAuthority')
  .add(
    HttpApiEndpoint.post('execute', '/api/portal-auth/consent-notice-authority', {
      error: [
        ConsentAuthorityInvalidProblemSchema,
        ConsentAuthorityAuthenticationProblemSchema,
        ConsentAuthorityForbiddenProblemSchema,
        ConsentAuthorityUnavailableProblemSchema,
      ],
      payload: RecordNoticeProvisionPayloadSchema,
      success: PrivacyNoticeAuthorityFactSchema,
    }),
  )
  .middleware(CommerceConsentAuthoritySchemaError);
export type CommerceConsentNoticeAuthorityGroup = HttpApiGroup.HttpApiGroup<
  'commerceConsentNoticeAuthority',
  HttpApiGroup.Endpoints<typeof noticeGroup>
>;
const declaredNoticeGroup: CommerceConsentNoticeAuthorityGroup = noticeGroup;
export const CommerceConsentNoticeAuthorityApi = HttpApi.make('CommerceConsentNoticeAuthorityApi')
  .add(declaredNoticeGroup)
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' });
