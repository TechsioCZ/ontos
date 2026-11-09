import { PaymentTermDefinitionSnapshotSchema } from '@app/payment-term-catalog-contracts/payment-term';
import { PaymentTermRefSchema } from '@app/payment-term-catalog-contracts/resources/payment-term';
import { DateTime, Option, Schema, SchemaGetter } from 'effect';

import { PaymentExecutionBindingSchema } from './payment-execution-binding.ts';
import {
  PaymentCustomerConfigurationIdSchema,
  PaymentIdSchema,
  PaymentIntentKeySchema,
  PaymentMaterialHashSchema,
  PaymentOperationIdSchema,
  PaymentOperationKeySchema,
  PaymentPurchaseCorrelationIdSchema,
  PaymentRevisionSchema,
} from './payment-identifiers.ts';
import { PaymentMonetaryAmountSchema } from './payment-money.ts';
import { PaymentExecutionProvenanceSchema } from './payment-provenance.ts';
import {
  PaymentFundsHoldReasonSchema,
  PaymentMethodSchema,
  PaymentOperationKindSchema,
  PaymentOperationOutcomeSchema,
  PaymentRefundBasisKindSchema,
} from './payment-vocabulary.ts';

/**
 * An actual execution instant (never a frozen business T): `DateTime.Utc` in the decoded model and a
 * canonical millisecond ISO-8601 UTC string on the wire.
 */
export const PaymentInstantSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value
      ? undefined
      : 'must be a canonical UTC instant with millisecond precision';
  }),
).pipe(
  Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), {
    decode: SchemaGetter.transform(DateTime.makeUnsafe),
    encode: SchemaGetter.transform(DateTime.formatIso),
  }),
);
/** The wire form of `PaymentInstantSchema`, for JSON-only contracts such as Outbox payloads. */
export const PaymentInstantJsonSchema = Schema.toEncoded(PaymentInstantSchema);

/**
 * The immutable meaning of one Payment intent (#1148 "Payment"): exact payable amount and currency,
 * selected method, resolved `PaymentTermRef` with the exact C15 semantic snapshot accepted for it and
 * the immutable execution binding. Provider secrets are never part of it; the binding only names the
 * qualified provider family, account reference and environment.
 */
export const PaymentIntentViewSchema = Schema.Struct({
  aggregateVersion: PaymentRevisionSchema,
  amount: PaymentMonetaryAmountSchema,
  coverageRevision: PaymentRevisionSchema,
  createdAt: PaymentInstantSchema,
  customerConfigurationId: PaymentCustomerConfigurationIdSchema,
  executionBinding: PaymentExecutionBindingSchema,
  intentKey: PaymentIntentKeySchema,
  method: PaymentMethodSchema,
  paymentId: PaymentIdSchema,
  paymentTermRef: PaymentTermRefSchema,
  predecessorPaymentId: Schema.OptionFromNullOr(PaymentIdSchema),
  provenance: PaymentExecutionProvenanceSchema,
  purchaseCorrelationId: PaymentPurchaseCorrelationIdSchema,
  termSemanticEvidence: PaymentTermDefinitionSnapshotSchema,
});
export type PaymentIntentView = typeof PaymentIntentViewSchema.Type;

/** One immutable logical operation with its Current business outcome (#1148 "Payment Operation"). */
export const PaymentOperationViewSchema = Schema.Struct({
  amount: PaymentMonetaryAmountSchema,
  binding: PaymentExecutionBindingSchema,
  createdAt: PaymentInstantSchema,
  kind: PaymentOperationKindSchema,
  materialHash: PaymentMaterialHashSchema,
  operationId: PaymentOperationIdSchema,
  operationKey: PaymentOperationKeySchema,
  outcome: PaymentOperationOutcomeSchema,
  outcomeRevision: PaymentRevisionSchema,
  provenance: PaymentExecutionProvenanceSchema,
  refundBasisKind: Schema.OptionFromNullOr(PaymentRefundBasisKindSchema),
  targetOperationId: Schema.OptionFromNullOr(PaymentOperationIdSchema),
});
export type PaymentOperationView = typeof PaymentOperationViewSchema.Type;

/** Proven collection with every confirmed return and live reservation counted once. */
export const PaymentCoverageEstablishedSchema = Schema.TaggedStruct('ESTABLISHED', {
  collected: PaymentMonetaryAmountSchema,
  collectOperationId: PaymentOperationIdSchema,
  confirmedReturned: PaymentMonetaryAmountSchema,
  remaining: PaymentMonetaryAmountSchema,
  reserved: PaymentMonetaryAmountSchema,
});
/** Ambiguous or inconsistent evidence: held for reconciliation, never invented funds. */
export const PaymentCoverageHeldSchema = Schema.TaggedStruct('HELD', {
  reason: PaymentFundsHoldReasonSchema,
});
/** No COLLECT reached EFFECT_CONFIRMED; the live one, if any, is named. */
export const PaymentCoverageNotCollectedSchema = Schema.TaggedStruct('NOT_COLLECTED', {
  liveCollectOperationId: Schema.OptionFromNullOr(PaymentOperationIdSchema),
});
/** Zero payable: there is nothing to collect and no fictitious COLLECT exists. */
export const PaymentCoverageZeroPayableSchema = Schema.TaggedStruct('ZERO_PAYABLE', {});

/** Current funds summary, derived by the shared funds calculator (never stored separately). */
export const PaymentCoverageSummarySchema = Schema.Union([
  PaymentCoverageEstablishedSchema,
  PaymentCoverageHeldSchema,
  PaymentCoverageNotCollectedSchema,
  PaymentCoverageZeroPayableSchema,
]);
export type PaymentCoverageSummary = typeof PaymentCoverageSummarySchema.Type;

/** Unresolved monetary state that blocks successor intents and competing collections. */
export const PaymentUnresolvedStateSchema = Schema.Struct({
  hasUnresolvedEffect: Schema.Boolean,
  openReconciliationCaseCount: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  unresolvedOperationIds: Schema.Array(PaymentOperationIdSchema),
});
