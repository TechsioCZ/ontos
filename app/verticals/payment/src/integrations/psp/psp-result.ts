import { Match, Option, Schema } from 'effect';

import {
  PaymentEconomicEffectKeySchema,
  PaymentEvidenceRefSchema,
  PaymentMaterialHashSchema,
  PaymentOperationIdSchema,
  PaymentSourceOccurrenceIdSchema,
} from '../../../shared/domain/payment-identifiers.ts';
import {
  PaymentGatewayProviderFamilySchema,
  PaymentOperationKindSchema,
  PaymentSourceFactFamilySchema,
} from '../../../shared/domain/payment-vocabulary.ts';
import { GatewayHttpsUrlSchema } from '../../../shared/domain/psp-configuration.ts';
import { ProviderEvidenceFactKindSchema, ProviderFindingSchema } from '../../../shared/domain/psp-vocabulary.ts';
import { GatewayIdempotencyKeySchema, GatewayOrderReferenceSchema } from './psp-correlation.ts';
import { ProviderAmountDiscrepancySchema, ProviderReportedAmountSchema } from './psp-money.ts';
import { ProviderObjectRefSchema } from './psp-request.ts';
import type { GatewayExpectedEffect } from './psp-request.ts';

/**
 * Provider-neutral results of the C17 adapters (#1156-#1158). Evidence is C17-owned until a
 * workload-admitted submission hands it to the public A8 Action (plan D8).
 */

/** COLLECT and CANCEL facts are GATEWAY_OUTCOME; REFUND facts are REFUND_EXECUTION (plan §2.5). */
export const ProviderEvidenceFactFamilySchema = PaymentSourceFactFamilySchema.pick([
  'GATEWAY_OUTCOME',
  'REFUND_EXECUTION',
]);
export type ProviderEvidenceFactFamily = typeof ProviderEvidenceFactFamilySchema.Type;

const sourceRevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const reasonText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/**
 * One provider fact about one Payment Operation, in C16 observation vocabulary (#1156, #1157).
 *
 * `sourceOccurrenceId` (plan §2.5): Stripe event `stripe:evt:<eventId>`; lookup and dispatch response
 * `<family>:<origin>:<providerObjectId>:<operationId>:<factKind>:<amountMinor>` (the operation id keeps two
 * refunds of the same amount on one provider payment apart); local never-sent facts
 * `<family>:local:<operationId>:<factKind>`. A later contrary provider state is a new occurrence of the
 * contrary fact (e.g. a Stripe refund `failed` after `succeeded` is REFUND_NOT_EFFECTED), never a
 * SOURCE_CORRECTION.
 */
export const ProviderEvidenceSchema = Schema.Struct({
  /** Present when the provider amount or currency differs from the expected one; such evidence never confirms. */
  discrepancy: Schema.Option(ProviderAmountDiscrepancySchema),
  economicEffectKey: Schema.Option(PaymentEconomicEffectKeySchema),
  factFamily: ProviderEvidenceFactFamilySchema,
  factKind: ProviderEvidenceFactKindSchema,
  /** The authentic provider amount in the provider's own currency, never converted or dropped. */
  observedAmount: Schema.Option(ProviderReportedAmountSchema),
  /**
   * The instant OntOS received the provider response, lookup result or verified signed notification
   * that proves this fact (Effect Clock right after decoding). It becomes the evidence `verifiedAt`.
   */
  observedAt: Schema.DateTimeUtc,
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

export const ProviderCustomerActionSchema = Schema.Struct({ redirectUrl: GatewayHttpsUrlSchema });

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
 * the only route an adapter `send`/`replay` uses. Preparation is pure over its request, and the
 * executor prepares only while the ledger holds no prepared request, so a `requestHash` that differs
 * from a persisted one can only mean changed material: the ledger answers CONFLICT and nothing is sent.
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

/**
 * The ledger's replay window of one dispatch: `startsAt` = ledger `preparedAt`, `expiresAt` =
 * `preparedAt + replayWindowMs`. A replay may be sent only while `startsAt <= now < expiresAt`.
 */
export const ProviderReplayWindowSchema = Schema.Struct({
  expiresAt: Schema.DateTimeUtc,
  startsAt: Schema.DateTimeUtc,
});

/** The exact persisted request of one dispatch and the window it may be replayed in (Stripe only). */
export const ProviderReplayRequestSchema = Schema.Struct({
  prepared: PreparedProviderRequestSchema,
  window: ProviderReplayWindowSchema,
});
export type ProviderReplayRequest = typeof ProviderReplayRequestSchema.Type;

/**
 * Result of one provider send or replay that produced a classifiable response. `finding` is about the sent
 * operation; `targetFinding` is what the same answer proved about a CANCEL_OR_VOID's collection target (for
 * example a collection already paid when the cancel was refused), so that proof is kept as well.
 */
const dispatchResponseFields = {
  finding: ProviderFindingResultSchema,
  targetFinding: Schema.Option(ProviderFindingResultSchema),
};
export const ProviderDispatchResponseSchema = Schema.Union([
  Schema.TaggedStruct('ACKNOWLEDGED', dispatchResponseFields),
  Schema.TaggedStruct('REJECTED_BEFORE_EFFECT', dispatchResponseFields),
]);
export type ProviderDispatchResponse = typeof ProviderDispatchResponseSchema.Type;

/** The finding about a CANCEL_OR_VOID's collection target among one answer's findings; none for other kinds. */
export const cancelTargetFindingOf = (
  findings: readonly ProviderFindingResult[],
  expected: GatewayExpectedEffect,
): Option.Option<ProviderFindingResult> =>
  Match.valueTags(expected, {
    CANCEL_OR_VOID: ({ target }) =>
      Option.fromUndefinedOr(findings.find((finding) => finding.target.operationId === target.operationId)),
    COLLECT: () => Option.none<ProviderFindingResult>(),
    REFUND: () => Option.none<ProviderFindingResult>(),
  });
