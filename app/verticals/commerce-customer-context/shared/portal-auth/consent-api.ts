import { makeProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import {
  ConsentAuthorityAuthenticationProblemSchema,
  ConsentAuthorityForbiddenProblemSchema,
  ConsentAuthorityInvalidProblemSchema,
  ConsentAuthorityUnavailableProblemSchema,
} from '@app/consent-authority-contracts/api';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from 'effect/unstable/httpapi';
import { Schema } from 'effect';

export const CUSTOMER_CONSENT_STATUS = {
  authentication: 401,
  conflict: 409,
  forbidden: 403,
  invalid: 400,
  unavailable: 503,
} as const;
export const CustomerNoticeVersionIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('CustomerNoticeVersionId'),
);
const CustomerPurposeVersionIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('CustomerPurposeVersionId'),
);
export const CustomerConsentRequestIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('CustomerConsentRequestId'),
);

export const CustomerConsentNoticeSchema = Schema.Struct({
  language: Schema.String,
  noticeVersionId: CustomerNoticeVersionIdSchema,
  purposeVersionId: CustomerPurposeVersionIdSchema,
  wording: Schema.String,
});
export const CustomerOwnConsentSchema = Schema.Struct({
  decision: Schema.Literals(['ABSENT', 'GRANTED', 'REFUSED', 'WITHDRAWN']),
  notice: CustomerConsentNoticeSchema,
});
export const UpdateCustomerOwnConsentSchema = Schema.Struct({
  decision: Schema.Literals(['GRANTED', 'WITHDRAWN']),
  noticeAcknowledged: Schema.Literal(true),
  noticeVersionId: CustomerNoticeVersionIdSchema,
  purposeVersionId: CustomerPurposeVersionIdSchema,
  requestId: CustomerConsentRequestIdSchema,
});
export type CustomerOwnConsent = typeof CustomerOwnConsentSchema.Type;
export type UpdateCustomerOwnConsent = typeof UpdateCustomerOwnConsentSchema.Type;
export const ConsentConflictProblemSchema = makeProblemDetailsSchema(
  'CustomerConsentConflictProblem',
  CUSTOMER_CONSENT_STATUS.conflict,
  {
    code: Schema.Literal('consent_conflict'),
  },
);
export class CustomerOwnConsentSchemaError extends HttpApiMiddleware.Service<CustomerOwnConsentSchemaError>()(
  'commerce-customer-context/CustomerOwnConsentSchemaError',
  { error: ConsentAuthorityInvalidProblemSchema },
) {}
const errors = [
  ConsentAuthorityAuthenticationProblemSchema,
  ConsentAuthorityForbiddenProblemSchema,
  ConsentAuthorityInvalidProblemSchema,
  ConsentAuthorityUnavailableProblemSchema,
  ConsentConflictProblemSchema,
] as const;
const read = HttpApiGroup.make('customerOwnConsentRead')
  .add(
    HttpApiEndpoint.get('execute', '/api/portal-auth/customer-consent', {
      error: errors,
      success: CustomerOwnConsentSchema,
    }),
  )
  .middleware(CustomerOwnConsentSchemaError);
const update = HttpApiGroup.make('customerOwnConsentUpdate')
  .add(
    HttpApiEndpoint.post('execute', '/api/portal-auth/customer-consent', {
      error: errors,
      payload: UpdateCustomerOwnConsentSchema,
      success: CustomerOwnConsentSchema,
    }),
  )
  .middleware(CustomerOwnConsentSchemaError);
export type CustomerOwnConsentReadGroup = HttpApiGroup.HttpApiGroup<
  'customerOwnConsentRead',
  HttpApiGroup.Endpoints<typeof read>
>;
export type CustomerOwnConsentUpdateGroup = HttpApiGroup.HttpApiGroup<
  'customerOwnConsentUpdate',
  HttpApiGroup.Endpoints<typeof update>
>;
const declaredRead: CustomerOwnConsentReadGroup = read;
const declaredUpdate: CustomerOwnConsentUpdateGroup = update;
export const CustomerOwnConsentReadApi = HttpApi.make('CustomerOwnConsentReadApi')
  .add(declaredRead)
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' });
export const CustomerOwnConsentUpdateApi = HttpApi.make('CustomerOwnConsentUpdateApi')
  .add(declaredUpdate)
  .annotate(HttpApi.ParseOptions, { onExcessProperty: 'error' });
