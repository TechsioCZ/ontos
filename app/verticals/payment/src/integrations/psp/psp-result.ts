import { Schema } from 'effect';

import {
  PaymentEconomicEffectKeySchema,
  PaymentEvidenceRefSchema,
  PaymentMaterialHashSchema,
  PaymentOperationIdSchema,
  PaymentSourceOccurrenceIdSchema,
} from '../../../shared/domain/payment-identifiers.ts';
import { PaymentMonetaryAmountSchema } from '../../../shared/domain/payment-money.ts';
import {
  PaymentGatewayProviderFamilySchema,
  PaymentObservationFactKindSchema,
  PaymentOperationKindSchema,
  PaymentSourceFactFamilySchema,
} from '../../../shared/domain/payment-vocabulary.ts';
import { GatewayHttpsUrlSchema } from '../../../shared/domain/psp-configuration.ts';
import { ProviderFindingSchema } from '../../../shared/domain/psp-vocabulary.ts';
import { GatewayIdempotencyKeySchema, GatewayOrderReferenceSchema } from './psp-correlation.ts';
import { ProviderAmountDiscrepancySchema } from './psp-money.ts';
import { ProviderObjectRefSchema } from './psp-request.ts';

/**
 * Provider-neutral results of the C17 adapters (#1156-#1158). Evidence is C17-owned until a
 * workload-admitted submission hands it to the public A8 Action (plan D8).
 */

/** Every C16 observation fact except UNRECOGNIZED: adapters never invent an unrecognized fact. */
export const ProviderEvidenceFactKindSchema = PaymentObservationFactKindSchema.pick([
  'COLLECTION_PENDING',
  'COLLECTION_CONFIRMED',
  'COLLECTION_NOT_EFFECTED',
  'CANCEL_CONFIRMED',
  'CANCEL_NOT_EFFECTED',
  'REFUND_PENDING',
  'REFUND_INDETERMINATE',
  'REFUND_CONFIRMED',
  'REFUND_NOT_EFFECTED',
  'SETTLEMENT_OBSERVED',
  'SOURCE_CORRECTION',
]);
export type ProviderEvidenceFactKind = typeof ProviderEvidenceFactKindSchema.Type;

/** COLLECT and CANCEL facts are GATEWAY_OUTCOME; REFUND facts are REFUND_EXECUTION (plan §2.5). */
export const ProviderEvidenceFactFamilySchema = PaymentSourceFactFamilySchema.pick([
  'GATEWAY_OUTCOME',
  'REFUND_EXECUTION',
]);
export type ProviderEvidenceFactFamily = typeof ProviderEvidenceFactFamilySchema.Type;

const sourceRevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const reasonText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/** One provider fact about one Payment Operation, in C16 observation vocabulary. */
export const ProviderEvidenceSchema = Schema.Struct({
  /** Present when the provider amount differs from the expected one; such evidence never confirms. */
  discrepancy: Schema.Option(ProviderAmountDiscrepancySchema),
  economicEffectKey: Schema.Option(PaymentEconomicEffectKeySchema),
  factFamily: ProviderEvidenceFactFamilySchema,
  factKind: ProviderEvidenceFactKindSchema,
  observedAmount: Schema.Option(PaymentMonetaryAmountSchema),
  providerOccurredAt: Schema.Option(Schema.DateTimeUtc),
  providerRefs: Schema.Array(ProviderObjectRefSchema),
  /** Short snake_case reason such as `provider_cancel_unsupported` or `withheld_for_cancellation`. */
  reason: Schema.Option(reasonText),
  sourceOccurrenceId: PaymentSourceOccurrenceIdSchema,
  sourceRevision: sourceRevisionSchema,
});
export type ProviderEvidence = typeof ProviderEvidenceSchema.Type;

export const ProviderFindingTargetSchema = Schema.Struct({
  operationId: PaymentOperationIdSchema,
  operationKind: PaymentOperationKindSchema,
});
export type ProviderFindingTarget = typeof ProviderFindingTargetSchema.Type;

export const ProviderCustomerActionSchema = Schema.Struct({ redirectUrl: GatewayHttpsUrlSchema });
export type ProviderCustomerAction = typeof ProviderCustomerActionSchema.Type;

/**
 * What an adapter concluded about one operation. Named `...Result` because `ProviderFinding` is the
 * W0 vocabulary literal type carried in `finding`.
 */
export const ProviderFindingResultSchema = Schema.Struct({
  customerAction: Schema.Option(ProviderCustomerActionSchema),
  evidence: Schema.Option(ProviderEvidenceSchema),
  finding: ProviderFindingSchema,
  /** Lookup-verified order reference (GoPay order_number, Comgate refId, Stripe metadata). */
  orderReference: Schema.Option(GatewayOrderReferenceSchema),
  providerRefs: Schema.Array(ProviderObjectRefSchema),
  target: ProviderFindingTargetSchema,
});
export type ProviderFindingResult = typeof ProviderFindingResultSchema.Type;

/** Non-secret request header. Authorization is added by the adapter at send time, never stored. */
export const ProviderRequestHeaderSchema = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,64}$/u)),
  value: Schema.String.check(Schema.isMaxLength(1000)),
});
export type ProviderRequestHeader = typeof ProviderRequestHeaderSchema.Type;

const replayWindowMsSchema = Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 86_400_000, minimum: 1 }));

/**
 * A mutation fully built before any send. It holds no secret, so it can be persisted for exact
 * Stripe replay. `endpointRef` is adapter-owned (e.g. `stripe:POST:/v1/checkout/sessions`) and is
 * the only route an adapter `send`/`replay` uses.
 */
export const PreparedProviderRequestSchema = Schema.Struct({
  body: Schema.Uint8Array,
  endpointRef: PaymentEvidenceRefSchema,
  family: PaymentGatewayProviderFamilySchema,
  headers: Schema.Array(ProviderRequestHeaderSchema),
  idempotencyKey: Schema.Option(GatewayIdempotencyKeySchema),
  orderReference: GatewayOrderReferenceSchema,
  /** sha256 hex over the endpoint, body and non-secret headers. */
  requestHash: PaymentMaterialHashSchema,
  /** Stripe 86_400_000; GoPay and Comgate never replay. */
  replayWindowMs: Schema.Option(replayWindowMsSchema),
});
export type PreparedProviderRequest = typeof PreparedProviderRequestSchema.Type;

/** Result of one provider send or replay that produced a classifiable response. */
export const ProviderDispatchResponseSchema = Schema.Union([
  Schema.TaggedStruct('ACKNOWLEDGED', { finding: ProviderFindingResultSchema }),
  Schema.TaggedStruct('REJECTED_BEFORE_EFFECT', { finding: ProviderFindingResultSchema }),
]);
export type ProviderDispatchResponse = typeof ProviderDispatchResponseSchema.Type;
