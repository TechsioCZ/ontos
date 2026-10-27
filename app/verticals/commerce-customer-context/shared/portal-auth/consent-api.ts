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
/** Fixed demo wording, not a claim that a Privacy catalog or purpose has been provisioned. */
export const DEMO_NEWSLETTER_NOTICE = {
  language: 'cs',
  noticeVersionId: 'demo-newsletter.cs.v1',
  wording:
    'Souhlasím se zasíláním novinek a obchodních nabídek AKROS na svůj kontaktní e-mail. Souhlas je dobrovolný, není podmínkou nákupu a mohu jej kdykoli odvolat v části Můj účet. Odvolání neovlivní zákonnost předchozího zpracování.',
} as const;
export const CustomerNoticeVersionIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)).pipe(
  Schema.brand('CustomerNoticeVersionId'),
);
const revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const CustomerConsentRequestIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('CustomerConsentRequestId'),
);

export const CustomerConsentNoticeSchema = Schema.Struct({
  language: Schema.String,
  noticeVersionId: CustomerNoticeVersionIdSchema,
  wording: Schema.String,
});
export const CustomerOwnConsentSchema = Schema.Struct({
  decision: Schema.Literals(['ABSENT', 'GRANTED', 'WITHDRAWN']),
  notice: CustomerConsentNoticeSchema,
  revision,
});
export const UpdateCustomerOwnConsentSchema = Schema.Struct({
  decision: Schema.Literals(['GRANTED', 'WITHDRAWN']),
  expectedRevision: revision,
  noticeAcknowledged: Schema.Boolean,
  noticeVersionId: CustomerNoticeVersionIdSchema,
  requestId: CustomerConsentRequestIdSchema,
}).check(
  Schema.makeFilter((input) =>
    input.decision === 'WITHDRAWN' || input.noticeAcknowledged
      ? undefined
      : 'An explicit grant requires acknowledgement',
  ),
);
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
