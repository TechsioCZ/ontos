import { Schema } from 'effect';

import { PaymentRecoveryTriggerSchema } from './evidence-contract.ts';
import { PaymentIdSchema, PaymentOperationIdSchema, PaymentProviderAccountRefSchema } from './payment-identifiers.ts';
import {
  PaymentGatewayProviderFamilySchema,
  PaymentOperationKindSchema,
  PaymentOperationOutcomeSchema,
} from './payment-vocabulary.ts';
import {
  GatewayBindingStatusSchema,
  GatewayCredentialStatusSchema,
  GatewayEnvironmentSchema,
  ProviderDispatchStateSchema,
  ProviderNotSentReasonSchema,
} from './psp-vocabulary.ts';

/**
 * Browser-safe gateway configuration contracts (#1155-#1158). Nothing here carries a secret: the
 * credential material stays behind `GatewayCredentialSecretRefSchema`, which names it only.
 */

const uuidText = Schema.String.check(Schema.isUUID());
const revisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const countSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

/** Stable OntOS identity of one Provider Account Binding. Historical bindings stay addressable (#1155). */
export const GatewayProviderAccountBindingIdSchema = uuidText.pipe(Schema.brand('GatewayProviderAccountBindingId'));
export type GatewayProviderAccountBindingId = typeof GatewayProviderAccountBindingIdSchema.Type;

/**
 * `pab_` account ref minted by the configuration Action. It decodes into the C16 Payment provider
 * account ref so the execution binding (`PaymentGatewayAccountBindingSchema`) accepts it unchanged.
 */
export const GatewayProviderAccountRefSchema = Schema.String.check(Schema.isPattern(/^pab_[0-9a-f]{32}$/u)).pipe(
  Schema.decodeTo(PaymentProviderAccountRefSchema),
);
export type GatewayProviderAccountRef = typeof GatewayProviderAccountRefSchema.Type;

const digitsText = (maximumLength: number) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^[0-9]{1,${maximumLength}}$`, 'u')));

/** Stripe account identifier. Branded so that it cannot be passed where another identifier is expected. */
const StripeAccountIdSchema = Schema.String.check(Schema.isPattern(/^acct_[A-Za-z0-9]{1,64}$/u)).pipe(
  Schema.brand('StripeAccountId'),
);

/** Merchant identity per gateway family. Only the family's own identity shape decodes. */
export const GatewayMerchantIdentitySchema = Schema.Union([
  Schema.TaggedStruct('GOPAY', { goid: digitsText(20) }),
  Schema.TaggedStruct('STRIPE', { accountId: StripeAccountIdSchema }),
  Schema.TaggedStruct('COMGATE', { merchantId: digitsText(20) }),
]);
export type GatewayMerchantIdentity = typeof GatewayMerchantIdentitySchema.Type;

/** Name of credential material held by the secret store. The value itself is never part of a contract. */
export const GatewayCredentialSecretRefSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,120}$/u));
export type GatewayCredentialSecretRef = typeof GatewayCredentialSecretRefSchema.Type;

/** Absolute https URL, at most 2000 characters. Plain http and whitespace-containing values are rejected. */
export const GatewayHttpsUrlSchema = Schema.String.check(
  Schema.isMaxLength(2000),
  Schema.isPattern(/^https:\/\/[^\s/?#]+\S*$/u),
);
export type GatewayHttpsUrl = typeof GatewayHttpsUrlSchema.Type;

/** Unguessable 22-character base64url token that correlates a browser return to one Payment (#1157). */
export const GatewayReturnTokenSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/u));
export type GatewayReturnToken = typeof GatewayReturnTokenSchema.Type;

/** The two C16 recovery triggers the reconciliation driver may recommend (plan §2.2). */
const GatewayReconciliationTriggerSchema = PaymentRecoveryTriggerSchema.pick([
  'EXECUTION_OUTCOME_UNKNOWN',
  'OUTCOME_OVERDUE',
]);
const CUSTOMER_ACTION_STATUSES = ['AWAITING_PROVIDER', 'REDIRECT_AVAILABLE', 'NOT_AVAILABLE'] as const;

/** Credential revision as read back to administrators. No secret reference is exposed. */
export const GatewayCredentialRevisionViewSchema = Schema.Struct({
  bindingId: GatewayProviderAccountBindingIdSchema,
  credentialRevision: revisionSchema,
  status: GatewayCredentialStatusSchema,
});
export type GatewayCredentialRevisionView = typeof GatewayCredentialRevisionViewSchema.Type;

/** Provider Account Binding without any secret or secret reference. */
export const GatewayProviderAccountBindingViewSchema = Schema.Struct({
  bindingId: GatewayProviderAccountBindingIdSchema,
  environment: GatewayEnvironmentSchema,
  merchantIdentity: GatewayMerchantIdentitySchema,
  providerAccountRef: GatewayProviderAccountRefSchema,
  providerFamily: PaymentGatewayProviderFamilySchema,
  revision: revisionSchema,
  status: GatewayBindingStatusSchema,
});
export type GatewayProviderAccountBindingView = typeof GatewayProviderAccountBindingViewSchema.Type;

/** Declarative gateway enablement for one family in one Customer Configuration scope (#1155). */
export const GatewayEnablementViewSchema = Schema.Struct({
  enabled: Schema.Boolean,
  providerFamily: PaymentGatewayProviderFamilySchema,
  revision: revisionSchema,
});

/** One operation the reconciliation driver must still resolve (#1158). Absent keys mean "not applicable". */
export const GatewayReconciliationDebtRowSchema = Schema.Struct({
  ledgerState: ProviderDispatchStateSchema,
  notSentReason: Schema.optionalKey(ProviderNotSentReasonSchema),
  oldestPendingAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  operationId: PaymentOperationIdSchema,
  operationKind: PaymentOperationKindSchema,
  paymentId: PaymentIdSchema,
  pendingEvidenceCount: countSchema,
  recommendedTrigger: GatewayReconciliationTriggerSchema,
});
export type GatewayReconciliationDebtRow = typeof GatewayReconciliationDebtRowSchema.Type;

/** Redirect state of a customer-facing collection. The redirect URL appears only after acknowledgement (#1156). */
export const GatewayCustomerActionViewSchema = Schema.Struct({
  redirectUrl: Schema.optionalKey(GatewayHttpsUrlSchema),
  status: Schema.Literals(CUSTOMER_ACTION_STATUSES),
});
export type GatewayCustomerActionView = typeof GatewayCustomerActionViewSchema.Type;

/** Browser return status. It reports Payment-owned state only and never proves a financial effect (#1157). */
export const GatewayReturnStatusViewSchema = Schema.Struct({
  dispatchState: ProviderDispatchStateSchema,
  outcome: PaymentOperationOutcomeSchema,
});
export type GatewayReturnStatusView = typeof GatewayReturnStatusViewSchema.Type;
