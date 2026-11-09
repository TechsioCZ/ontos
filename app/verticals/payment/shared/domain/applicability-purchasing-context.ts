import { Schema } from 'effect';

/**
 * Payment's consumer binding of the trusted Commerce Purchasing Context (#1147), mirroring the
 * Commerce Customer Context `pricing-purchase-context-verification` contract: the exact Channel,
 * Commerce Market, context revision and buyer subject of one purchase. Tenant and Selling Legal
 * Entity are never taken from here; they come from the verified Core scope. Payment does not interpret
 * these values: it forwards them so the Customer Context owner decides whose Current entitlement and
 * policy applies to this exact purchase.
 */
const opaqueText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
export const PaymentPurchasingContextRefSchema = opaqueText.pipe(
  Schema.brand('PaymentPurchasingContextRef'),
  Schema.decodeTo(opaqueText),
);
export const PaymentPurchasingContextRevisionSchema = opaqueText.pipe(
  Schema.brand('PaymentPurchasingContextRevision'),
  Schema.decodeTo(opaqueText),
);
export const PaymentPurchasingChannelIdSchema = opaqueText.pipe(
  Schema.brand('PaymentPurchasingChannelId'),
  Schema.decodeTo(opaqueText),
);
export const PaymentPurchasingMarketIdSchema = opaqueText.pipe(
  Schema.brand('PaymentPurchasingMarketId'),
  Schema.decodeTo(opaqueText),
);
export const PaymentPurchasingProfileIdSchema = opaqueText.pipe(
  Schema.brand('PaymentPurchasingProfileId'),
  Schema.decodeTo(opaqueText),
);
export const PaymentPurchasingTenantIdSchema = opaqueText.pipe(
  Schema.brand('PaymentPurchasingTenantId'),
  Schema.decodeTo(opaqueText),
);
export const PaymentGuestEvidenceRefSchema = opaqueText.pipe(
  Schema.brand('PaymentGuestEvidenceRef'),
  Schema.decodeTo(opaqueText),
);
export const PaymentGuestSessionRefSchema = opaqueText.pipe(
  Schema.brand('PaymentGuestSessionRef'),
  Schema.decodeTo(opaqueText),
);

/** Customer Context profile identity of the buyer (Retail Customer or Counterparty Purchasing Profile). */
export const PaymentPurchasingProfileRefSchema = Schema.Struct({
  moduleId: Schema.Literal('commerce.customer-context'),
  resourceId: PaymentPurchasingProfileIdSchema,
  resourceType: Schema.Literals([
    'commerce.customer-context.retail-customer-profile',
    'commerce.customer-context.counterparty-purchasing-profile',
  ]),
  tenantId: PaymentPurchasingTenantIdSchema,
});

/** The buyer whose Current entitlement/policy the owner decides; a guest is a distinct subject. */
export const PaymentPurchasingSubjectSchema = Schema.Union([
  Schema.Struct({
    guestEvidenceRef: PaymentGuestEvidenceRefSchema,
    guestSessionRef: PaymentGuestSessionRefSchema,
    kind: Schema.Literal('GUEST'),
  }),
  Schema.Struct({
    kind: Schema.Literal('PROFILE'),
    profileRef: PaymentPurchasingProfileRefSchema,
  }),
]);
export type PaymentPurchasingSubject = typeof PaymentPurchasingSubjectSchema.Type;

export const PaymentPurchasingContextSchema = Schema.Struct({
  channelId: PaymentPurchasingChannelIdSchema,
  contextRef: PaymentPurchasingContextRefSchema,
  contextRevision: PaymentPurchasingContextRevisionSchema,
  marketId: PaymentPurchasingMarketIdSchema,
  subject: PaymentPurchasingSubjectSchema,
});
export type PaymentPurchasingContext = typeof PaymentPurchasingContextSchema.Type;
