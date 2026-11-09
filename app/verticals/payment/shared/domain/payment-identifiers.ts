import { Schema } from 'effect';

/**
 * Payment-owned identities stay distinct (#1148 "Identities and revisions that must remain distinct"):
 * Payment, Payment Operation, Observation, Authorization, Core invocation and Composition revision
 * are never interchangeable. Owner-generated identities are UUIDs; foreign references are opaque,
 * bounded, trimmed text that Payment never interprets.
 */
const uuidText = Schema.String.check(Schema.isUUID());
const opaqueText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200), Schema.isTrimmed());
const businessKeyText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[\u0021-\u007E]+$/u),
);
const sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

export const PaymentIdSchema = uuidText.pipe(Schema.brand('PaymentId'), Schema.decodeTo(uuidText));
export const PaymentOperationIdSchema = uuidText.pipe(Schema.brand('PaymentOperationId'), Schema.decodeTo(uuidText));
export const PaymentObservationIdSchema = uuidText.pipe(
  Schema.brand('PaymentObservationId'),
  Schema.decodeTo(uuidText),
);
export const PaymentAuthorizationIdSchema = uuidText.pipe(
  Schema.brand('PaymentAuthorizationId'),
  Schema.decodeTo(uuidText),
);
export const PaymentSourceAuthorityIdSchema = uuidText.pipe(
  Schema.brand('PaymentSourceAuthorityId'),
  Schema.decodeTo(uuidText),
);
export const PaymentRecoveryIdSchema = uuidText.pipe(Schema.brand('PaymentRecoveryId'), Schema.decodeTo(uuidText));
export const PaymentReconciliationCaseIdSchema = uuidText.pipe(
  Schema.brand('PaymentReconciliationCaseId'),
  Schema.decodeTo(uuidText),
);
export const PaymentReconciliationDecisionIdSchema = uuidText.pipe(
  Schema.brand('PaymentReconciliationDecisionId'),
  Schema.decodeTo(uuidText),
);
export const PaymentTenantIdSchema = uuidText.pipe(Schema.brand('PaymentTenantId'), Schema.decodeTo(uuidText));
export const PaymentLegalEntityIdSchema = uuidText.pipe(
  Schema.brand('PaymentLegalEntityId'),
  Schema.decodeTo(uuidText),
);
export const PaymentPrincipalIdSchema = uuidText.pipe(Schema.brand('PaymentPrincipalId'), Schema.decodeTo(uuidText));
export const PaymentActionInvocationIdSchema = uuidText.pipe(
  Schema.brand('PaymentActionInvocationId'),
  Schema.decodeTo(uuidText),
);
/** Application Composition revision R of one execution; runtime provenance, never Payment identity. */
export const PaymentCompositionRevisionSchema = sha256Hex.pipe(
  Schema.brand('PaymentCompositionRevision'),
  Schema.decodeTo(sha256Hex),
);
/** Hash of an operation's canonical material request; the business replay comparator (#1151). */
export const PaymentMaterialHashSchema = sha256Hex.pipe(
  Schema.brand('PaymentMaterialHash'),
  Schema.decodeTo(sha256Hex),
);

/** Caller business keys: idempotency anchors, never provider keys or gateway JTIs. */
export const PaymentIntentKeySchema = businessKeyText.pipe(
  Schema.brand('PaymentIntentKey'),
  Schema.decodeTo(businessKeyText),
);
export const PaymentOperationKeySchema = businessKeyText.pipe(
  Schema.brand('PaymentOperationKey'),
  Schema.decodeTo(businessKeyText),
);
export const PaymentAuthorizationIssuanceKeySchema = businessKeyText.pipe(
  Schema.brand('PaymentAuthorizationIssuanceKey'),
  Schema.decodeTo(businessKeyText),
);

/** Foreign references supplied through owner public contracts; opaque to Payment. */
export const PaymentPurchaseCorrelationIdSchema = opaqueText.pipe(
  Schema.brand('PaymentPurchaseCorrelationId'),
  Schema.decodeTo(opaqueText),
);
export const PaymentOrderCommitmentAttemptIdSchema = opaqueText.pipe(
  Schema.brand('PaymentOrderCommitmentAttemptId'),
  Schema.decodeTo(opaqueText),
);
export const PaymentCustomerConfigurationIdSchema = opaqueText.pipe(
  Schema.brand('PaymentCustomerConfigurationId'),
  Schema.decodeTo(opaqueText),
);
export const PaymentRefundableItemRefSchema = opaqueText.pipe(
  Schema.brand('PaymentRefundableItemRef'),
  Schema.decodeTo(opaqueText),
);
/** Reference to governed owner/source evidence; never a secret, credential or raw provider payload. */
export const PaymentEvidenceRefSchema = opaqueText.pipe(
  Schema.brand('PaymentEvidenceRef'),
  Schema.decodeTo(opaqueText),
);
export const PaymentProviderAccountRefSchema = opaqueText.pipe(
  Schema.brand('PaymentProviderAccountRef'),
  Schema.decodeTo(opaqueText),
);
export const PaymentSourceEnvironmentSchema = opaqueText.pipe(
  Schema.brand('PaymentSourceEnvironment'),
  Schema.decodeTo(opaqueText),
);
export const PaymentSourceSystemSchema = opaqueText.pipe(
  Schema.brand('PaymentSourceSystem'),
  Schema.decodeTo(opaqueText),
);
export const PaymentSourceOccurrenceIdSchema = opaqueText.pipe(
  Schema.brand('PaymentSourceOccurrenceId'),
  Schema.decodeTo(opaqueText),
);
export const PaymentEconomicEffectKeySchema = opaqueText.pipe(
  Schema.brand('PaymentEconomicEffectKey'),
  Schema.decodeTo(opaqueText),
);
export const PaymentDeliveryOfferRefSchema = opaqueText.pipe(
  Schema.brand('PaymentDeliveryOfferRef'),
  Schema.decodeTo(opaqueText),
);
export const PaymentPickupCapabilityRefSchema = opaqueText.pipe(
  Schema.brand('PaymentPickupCapabilityRef'),
  Schema.decodeTo(opaqueText),
);

/** Authorized business reason recorded with an operator/configuration decision. */
export const PaymentReasonSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1000),
  Schema.isTrimmed(),
);

/** Monotonic positive revision counters (coverage, aggregate, outcome, configuration). */
export const PaymentRevisionSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 }),
);
