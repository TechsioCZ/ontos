import { Array as Arr, DateTime, Match, Option, Schema } from 'effect';

import type { PaymentMonetaryAmount } from '../../../shared/domain/payment-money.ts';
import type { PaymentOperationKind } from '../../../shared/domain/payment-vocabulary.ts';
import { GatewayHttpsUrlSchema } from '../../../shared/domain/psp-configuration.ts';
import type {
  ProviderEvidenceFactKind,
  ProviderEvidenceOrigin,
  ProviderFinding,
} from '../../../shared/domain/psp-vocabulary.ts';
import { deriveProviderCorrelation, GatewayOrderReferenceSchema } from '../psp/psp-correlation.ts';
import type { GatewayOrderReference } from '../psp/psp-correlation.ts';
import { compareObservedAmount } from '../psp/psp-money.ts';
import type { ProviderAmountDiscrepancy, ProviderReportedAmount } from '../psp/psp-money.ts';
import { ProviderObjectIdSchema } from '../psp/psp-request.ts';
import type { GatewayExpectedEffect, ProviderObjectId, ProviderObjectRef } from '../psp/psp-request.ts';
import { cancelTargetFindingOf } from '../psp/psp-result.ts';
import type {
  ProviderDispatchResponse,
  ProviderEvidence,
  ProviderEvidenceFactFamily,
  ProviderFindingResult,
} from '../psp/psp-result.ts';
import { GOPAY_CANCEL_REJECTED_STATE_REASON } from './gopay-capabilities.ts';
import { fromGopayAmount } from './gopay-money.ts';
import { GopayPaymentSchema, GopayRefundListSchema, GopayRefundSchema } from './gopay-wire.ts';
import type { GopayPayment, GopayPaymentState, GopayRefund, GopayRefundList } from './gopay-wire.ts';

/**
 * Pure GoPay Payments API v4 evidence mapping (#1156, #1157, #1158; plan D-P1). Every function maps an already
 * decoded GoPay response into provider-neutral findings for exactly the operations the expected effect names.
 *
 * Rules:
 * - v4 payments carry no GoID. A payment belongs to an operation only when its id is the one asked for and its
 *   `order_number` is that operation's own order reference; anything else is a VERIFICATION_CONFLICT without
 *   evidence, so nothing is ever submitted for another payment.
 * - REFUNDED and PARTIALLY_REFUNDED prove the collection (never "canceled"); a refund is proven only by its own
 *   refund resource (`Refund-Details`) with the expected amount and currency.
 * - A lookup miss or an ambiguous refund list is INDETERMINATE without evidence, never NOT_EFFECTED.
 * - A cancel is decided by the payment state a lookup shows (`DELETE` answers 204 or 409 only); see
 *   `mapGopayCancelAnswer`.
 */

const SOURCE_REVISION = 0;

/** Origins a GoPay provider response can come from (never-sent facts are the executor's local evidence). */
export type GopayResponseOrigin = Exclude<ProviderEvidenceOrigin, 'LOCAL_NOT_SENT' | 'NOTIFICATION_SIGNED'>;

const gopayPaymentRef = (id: ProviderObjectId): ProviderObjectRef => ({ _tag: 'GOPAY_PAYMENT', id });

/** The refund's own reference; it also names its payment, which `Refund-Details` does not. */
const gopayRefundRef = (paymentRef: ProviderObjectId, refundId: ProviderObjectId): ProviderObjectRef => ({
  _tag: 'GOPAY_REFUND',
  id: refundId,
  paymentId: paymentRef,
});

/** `gopay:<origin>:<providerObjectId>:<operationId>:<factKind>:<amountMinor>` (plan §2.5), origin in lower case. */
export const gopaySourceOccurrenceId = (input: {
  readonly amountMinor: number;
  readonly factKind: ProviderEvidenceFactKind;
  readonly objectId: ProviderObjectId;
  readonly operationId: string;
  readonly origin: GopayResponseOrigin;
}): string =>
  `gopay:${input.origin.toLowerCase()}:${input.objectId}:${input.operationId}:${input.factKind}:${input.amountMinor}`;

/** Refund economic effect key `gopay-refund:<paymentId>:<operationId>` (refunds of a payment are serialized). */
export const gopayRefundEffectKey = (paymentRef: ProviderObjectId, operationId: string): string =>
  `gopay-refund:${paymentRef}:${operationId}`;

interface Subject {
  readonly operationId: string;
  readonly operationKind: PaymentOperationKind;
}

interface FindingParts extends Subject {
  readonly customerAction: Option.Option<string>;
  readonly evidence: Option.Option<ProviderEvidence>;
  readonly finding: ProviderFinding;
  readonly orderReference: Option.Option<GatewayOrderReference>;
  readonly providerRefs: readonly ProviderObjectRef[];
}

const findingOf = (parts: FindingParts): ProviderFindingResult => ({
  customerAction: parts.customerAction.pipe(Option.map((redirectUrl) => ({ redirectUrl }))),
  evidence: parts.evidence,
  finding: parts.finding,
  orderReference: parts.orderReference,
  providerRefs: parts.providerRefs,
  target: { operationId: parts.operationId, operationKind: parts.operationKind },
});

/** A finding that states nothing submittable (INDETERMINATE or VERIFICATION_CONFLICT without evidence). */
const bareFinding = (
  finding: ProviderFinding,
  subject: Subject,
  providerRefs: readonly ProviderObjectRef[],
): ProviderFindingResult =>
  findingOf({
    ...subject,
    customerAction: Option.none(),
    evidence: Option.none(),
    finding,
    orderReference: Option.none(),
    providerRefs,
  });

interface EvidenceParts {
  readonly amountMinor: number;
  readonly discrepancy: Option.Option<ProviderAmountDiscrepancy>;
  readonly economicEffectKey: Option.Option<string>;
  readonly factFamily: ProviderEvidenceFactFamily;
  readonly factKind: ProviderEvidenceFactKind;
  readonly objectId: ProviderObjectId;
  readonly observedAmount: Option.Option<ProviderReportedAmount>;
  readonly observedAt: DateTime.Utc;
  readonly operationId: string;
  readonly origin: GopayResponseOrigin;
  readonly providerOccurredAt: Option.Option<DateTime.Utc>;
  readonly providerRefs: readonly ProviderObjectRef[];
  readonly reason: Option.Option<string>;
}

const evidenceOf = (parts: EvidenceParts): ProviderEvidence => ({
  discrepancy: parts.discrepancy,
  economicEffectKey: parts.economicEffectKey,
  factFamily: parts.factFamily,
  factKind: parts.factKind,
  observedAmount: parts.observedAmount,
  observedAt: parts.observedAt,
  providerOccurredAt: parts.providerOccurredAt,
  providerRefs: parts.providerRefs,
  reason: parts.reason,
  sourceOccurrenceId: gopaySourceOccurrenceId(parts),
  sourceRevision: SOURCE_REVISION,
});

const discrepancyOf = (
  expected: PaymentMonetaryAmount,
  observed: ProviderReportedAmount,
): Option.Option<ProviderAmountDiscrepancy> =>
  Match.value(compareObservedAmount(expected, observed)).pipe(
    Match.tag('MATCH', () => Option.none<ProviderAmountDiscrepancy>()),
    Match.tag('MISMATCH', (mismatch) => Option.some(mismatch.discrepancy)),
    Match.exhaustive,
  );

/** The OntOS order reference a GoPay payment states (its `order_number`); a candidate, never evidence. */
export const gopayOrderReferenceOf = (payment: GopayPayment): Option.Option<GatewayOrderReference> =>
  Schema.decodeUnknownOption(GatewayOrderReferenceSchema)(payment.order_number);

// ---------------------------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------------------------

interface Expectation {
  readonly amount: PaymentMonetaryAmount;
  readonly operationId: string;
}

/**
 * One COLLECT finding for a GoPay payment.
 *
 * | GoPay state                        | finding / fact                                            |
 * |------------------------------------|-----------------------------------------------------------|
 * | CREATED                            | CUSTOMER_ACTION_REQUIRED (gw_url) / COLLECTION_PENDING    |
 * | PAYMENT_METHOD_CHOSEN              | ACCEPTED_PENDING / COLLECTION_PENDING                     |
 * | PAID, PARTIALLY_REFUNDED, REFUNDED | EFFECT_CONFIRMED / COLLECTION_CONFIRMED (amount checked)  |
 * | CANCELED, TIMEOUTED                | NOT_EFFECTED / COLLECTION_NOT_EFFECTED                    |
 * | AUTHORIZED                         | VERIFICATION_CONFLICT (preauthorization is never created) |
 *
 * A confirmed collection of another amount or currency is VERIFICATION_CONFLICT carrying COLLECTION_CONFIRMED
 * evidence with the discrepancy (it never confirms). Any other state with an amount mismatch is
 * VERIFICATION_CONFLICT without evidence. `createResponse` requires CREATED with a valid https `gw_url`.
 */
const collectionFinding = (input: {
  readonly createResponse: boolean;
  readonly expectation: Expectation;
  readonly observedAt: DateTime.Utc;
  readonly origin: GopayResponseOrigin;
  readonly payment: GopayPayment;
  readonly paymentRef: ProviderObjectId;
}): ProviderFindingResult => {
  const { expectation, payment, paymentRef } = input;
  const providerRefs = [gopayPaymentRef(paymentRef)];
  const subject: Subject = { operationId: expectation.operationId, operationKind: 'COLLECT' };
  const expectedOrderReference = deriveProviderCorrelation(expectation.operationId).orderReference;
  if (payment.order_number !== expectedOrderReference) {
    // A create response for another order is not recorded as this operation's payment.
    return bareFinding('VERIFICATION_CONFLICT', subject, input.createResponse ? [] : providerRefs);
  }
  const observedAmount = fromGopayAmount(payment);
  const discrepancy = discrepancyOf(expectation.amount, observedAmount);
  const evidence = (factKind: ProviderEvidenceFactKind): Option.Option<ProviderEvidence> =>
    Option.some(
      evidenceOf({
        amountMinor: observedAmount.amountMinor,
        discrepancy,
        economicEffectKey: Option.some(paymentRef),
        factFamily: 'GATEWAY_OUTCOME',
        factKind,
        objectId: paymentRef,
        observedAmount: Option.some(observedAmount),
        observedAt: input.observedAt,
        operationId: expectation.operationId,
        origin: input.origin,
        providerOccurredAt: Option.none(),
        providerRefs,
        reason: Option.none(),
      }),
    );
  const verified = (
    finding: ProviderFinding,
    statement: Option.Option<ProviderEvidence>,
    customerAction: Option.Option<string> = Option.none(),
  ): ProviderFindingResult =>
    findingOf({
      ...subject,
      customerAction,
      evidence: statement,
      finding,
      orderReference: Option.some(expectedOrderReference),
      providerRefs,
    });
  const mismatched = Option.isSome(discrepancy);
  const confirmed = (): ProviderFindingResult =>
    verified(mismatched ? 'VERIFICATION_CONFLICT' : 'EFFECT_CONFIRMED', evidence('COLLECTION_CONFIRMED'));
  const unconfirmed = (finding: ProviderFinding, factKind: ProviderEvidenceFactKind): ProviderFindingResult =>
    mismatched ? verified('VERIFICATION_CONFLICT', Option.none()) : verified(finding, evidence(factKind));
  const created = (): ProviderFindingResult => {
    const gatewayUrl = Schema.decodeUnknownOption(GatewayHttpsUrlSchema)(payment.gw_url);
    if (mismatched || (input.createResponse && Option.isNone(gatewayUrl))) {
      return verified('VERIFICATION_CONFLICT', Option.none());
    }
    return Option.isSome(gatewayUrl)
      ? verified('CUSTOMER_ACTION_REQUIRED', evidence('COLLECTION_PENDING'), gatewayUrl)
      : verified('ACCEPTED_PENDING', evidence('COLLECTION_PENDING'));
  };
  return Match.value(payment.state).pipe(
    Match.when('CREATED', created),
    Match.when('PAYMENT_METHOD_CHOSEN', () => unconfirmed('ACCEPTED_PENDING', 'COLLECTION_PENDING')),
    Match.when('PAID', confirmed),
    Match.when('PARTIALLY_REFUNDED', confirmed),
    Match.when('REFUNDED', confirmed),
    Match.when('CANCELED', () => unconfirmed('NOT_EFFECTED', 'COLLECTION_NOT_EFFECTED')),
    Match.when('TIMEOUTED', () => unconfirmed('NOT_EFFECTED', 'COLLECTION_NOT_EFFECTED')),
    Match.when('AUTHORIZED', () => verified('VERIFICATION_CONFLICT', Option.none())),
    Match.exhaustive,
  );
};

/**
 * Maps the 201 `Payment-Details` of a collect dispatch (`POST /eshops/{goid}/payments`). The response must carry
 * the dispatch `order_number` and the exact amount and currency; CREATED with an https `gw_url` is
 * CUSTOMER_ACTION_REQUIRED. Anything else is acknowledged (GoPay accepted a request) as a VERIFICATION_CONFLICT
 * without evidence.
 */
export const mapGopayCreateResponse = (input: {
  readonly expected: Expectation;
  readonly observedAt: DateTime.Utc;
  readonly payment: GopayPayment;
}): ProviderDispatchResponse => ({
  _tag: 'ACKNOWLEDGED',
  finding: collectionFinding({
    createResponse: true,
    expectation: input.expected,
    observedAt: input.observedAt,
    origin: 'DISPATCH_RESPONSE',
    payment: input.payment,
    paymentRef: input.payment.id,
  }),
  targetFinding: Option.none(),
});

// ---------------------------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------------------------

/**
 * The cancel operation's own finding from a looked-up state of its target payment:
 *
 * | GoPay state                                    | cancel finding / fact                                        |
 * |------------------------------------------------|--------------------------------------------------------------|
 * | CANCELED, TIMEOUTED                            | EFFECT_CONFIRMED / CANCEL_CONFIRMED (can no longer be paid)  |
 * | PAYMENT_METHOD_CHOSEN, PAID, *REFUNDED         | NOT_EFFECTED / CANCEL_NOT_EFFECTED `provider_cancel_rejected_state` |
 * | CREATED                                        | INDETERMINATE (a cancel may still be in flight)              |
 * | AUTHORIZED, or the target amount differs       | VERIFICATION_CONFLICT                                        |
 *
 * CANCEL_CONFIRMED means "GoPay states this payment can no longer be paid" (plan D-P1, N14); later contrary
 * evidence stays able to correct it.
 */
const cancelFinding = (input: {
  readonly cancelOperationId: string;
  readonly observedAt: DateTime.Utc;
  readonly origin: GopayResponseOrigin;
  readonly payment: GopayPayment;
  readonly paymentRef: ProviderObjectId;
  readonly targetAmount: PaymentMonetaryAmount;
}): ProviderFindingResult => {
  const providerRefs = [gopayPaymentRef(input.paymentRef)];
  const subject: Subject = { operationId: input.cancelOperationId, operationKind: 'CANCEL_OR_VOID' };
  const withEvidence = (
    finding: ProviderFinding,
    factKind: 'CANCEL_CONFIRMED' | 'CANCEL_NOT_EFFECTED',
    reason: Option.Option<string>,
  ): ProviderFindingResult =>
    findingOf({
      ...subject,
      customerAction: Option.none(),
      evidence: Option.some(
        evidenceOf({
          amountMinor: input.targetAmount.amountMinor,
          discrepancy: Option.none(),
          economicEffectKey: Option.none(),
          factFamily: 'GATEWAY_OUTCOME',
          factKind,
          objectId: input.paymentRef,
          observedAmount: Option.none(),
          observedAt: input.observedAt,
          operationId: input.cancelOperationId,
          origin: input.origin,
          providerOccurredAt: Option.none(),
          providerRefs,
          reason,
        }),
      ),
      finding,
      orderReference: Option.none(),
      providerRefs,
    });
  if (Option.isSome(discrepancyOf(input.targetAmount, fromGopayAmount(input.payment)))) {
    return bareFinding('VERIFICATION_CONFLICT', subject, providerRefs);
  }
  const rejected = () =>
    withEvidence('NOT_EFFECTED', 'CANCEL_NOT_EFFECTED', Option.some(GOPAY_CANCEL_REJECTED_STATE_REASON));
  const ended = () => withEvidence('EFFECT_CONFIRMED', 'CANCEL_CONFIRMED', Option.none());
  return Match.value(input.payment.state).pipe(
    Match.when('CANCELED', ended),
    Match.when('TIMEOUTED', ended),
    Match.when('PAYMENT_METHOD_CHOSEN', rejected),
    Match.when('PAID', rejected),
    Match.when('PARTIALLY_REFUNDED', rejected),
    Match.when('REFUNDED', rejected),
    Match.when('CREATED', () => bareFinding('INDETERMINATE', subject, providerRefs)),
    Match.when('AUTHORIZED', () => bareFinding('VERIFICATION_CONFLICT', subject, providerRefs)),
    Match.exhaustive,
  );
};

// ---------------------------------------------------------------------------------------------
// Refund
// ---------------------------------------------------------------------------------------------

const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

/** A `date-time` with a zone (`2025-12-10T10:30:00Z`, `...+01:00`); None for anything else. */
const instantOf = (text: string): Option.Option<DateTime.Utc> =>
  INSTANT_PATTERN.test(text) ? DateTime.make(text).pipe(Option.map(DateTime.toUtc)) : Option.none();

/**
 * One REFUND finding from a `Refund-Details` of the payment `paymentRef`.
 *
 * | refund state | finding / fact                                 |
 * |--------------|------------------------------------------------|
 * | REQUESTED    | ACCEPTED_PENDING / REFUND_PENDING              |
 * | SUCCESS      | EFFECT_CONFIRMED / REFUND_CONFIRMED            |
 * | FAILED       | NOT_EFFECTED / REFUND_NOT_EFFECTED             |
 *
 * A SUCCESS of another amount or currency is VERIFICATION_CONFLICT with REFUND_CONFIRMED evidence carrying the
 * discrepancy; any other state with a mismatch is VERIFICATION_CONFLICT without evidence. Only a provider refund
 * resource read from GoPay can confirm: an id OntOS made up is never looked up as one.
 */
const refundFinding = (input: {
  readonly expectation: Expectation;
  readonly observedAt: DateTime.Utc;
  readonly origin: GopayResponseOrigin;
  readonly paymentRef: ProviderObjectId;
  readonly refund: GopayRefund;
}): ProviderFindingResult => {
  const { expectation, refund } = input;
  const refundId = refund.id;
  const providerRefs = [gopayPaymentRef(input.paymentRef), gopayRefundRef(input.paymentRef, refundId)];
  const subject: Subject = { operationId: expectation.operationId, operationKind: 'REFUND' };
  const observedAmount = fromGopayAmount(refund);
  const discrepancy = discrepancyOf(expectation.amount, observedAmount);
  const withEvidence = (finding: ProviderFinding, factKind: ProviderEvidenceFactKind): ProviderFindingResult =>
    findingOf({
      ...subject,
      customerAction: Option.none(),
      evidence: Option.some(
        evidenceOf({
          amountMinor: observedAmount.amountMinor,
          discrepancy,
          economicEffectKey: Option.some(gopayRefundEffectKey(input.paymentRef, expectation.operationId)),
          factFamily: 'REFUND_EXECUTION',
          factKind,
          objectId: refundId,
          observedAmount: Option.some(observedAmount),
          observedAt: input.observedAt,
          operationId: expectation.operationId,
          origin: input.origin,
          providerOccurredAt:
            factKind === 'REFUND_PENDING' ? Option.none() : refund.updated_at.pipe(Option.flatMap(instantOf)),
          providerRefs,
          reason: Option.none(),
        }),
      ),
      finding,
      orderReference: Option.none(),
      providerRefs,
    });
  const mismatched = Option.isSome(discrepancy);
  return Match.value(refund.state).pipe(
    Match.when('SUCCESS', () =>
      withEvidence(mismatched ? 'VERIFICATION_CONFLICT' : 'EFFECT_CONFIRMED', 'REFUND_CONFIRMED'),
    ),
    Match.when('REQUESTED', () =>
      mismatched
        ? bareFinding('VERIFICATION_CONFLICT', subject, providerRefs)
        : withEvidence('ACCEPTED_PENDING', 'REFUND_PENDING'),
    ),
    Match.when('FAILED', () =>
      mismatched
        ? bareFinding('VERIFICATION_CONFLICT', subject, providerRefs)
        : withEvidence('NOT_EFFECTED', 'REFUND_NOT_EFFECTED'),
    ),
    Match.exhaustive,
  );
};

/**
 * Maps the 201 `Refund-Details` of `POST /payments/{payment_id}/refunds` (see `refundFinding`). REQUESTED is the
 * provider's acceptance only, never completion. FAILED is REJECTED_BEFORE_EFFECT; everything else is ACKNOWLEDGED
 * and names the new refund by its GoPay id, so later lookups read that refund.
 */
export const mapGopayRefundResponse = (input: {
  readonly expected: Expectation;
  readonly observedAt: DateTime.Utc;
  readonly paymentRef: ProviderObjectId;
  readonly refund: GopayRefund;
}): ProviderDispatchResponse => {
  const finding = refundFinding({ ...input, expectation: input.expected, origin: 'DISPATCH_RESPONSE' });
  return {
    _tag: finding.finding === 'NOT_EFFECTED' ? 'REJECTED_BEFORE_EFFECT' : 'ACKNOWLEDGED',
    finding,
    targetFinding: Option.none(),
  };
};

/**
 * The refund of a refund dispatch whose response was lost, from the payment's refund list (#1158): among the
 * refunds of the expected amount and currency, every one must carry a zoned `created_at` and exactly one must be
 * created at or after the dispatch (`created_at >= dispatchedAt`). Anything else (none, several, an undated
 * candidate, an unknown dispatch instant) is None and stays INDETERMINATE.
 */
export const matchGopayRefundList = (input: {
  readonly dispatchedAt: Option.Option<DateTime.Utc>;
  readonly expectedAmount: PaymentMonetaryAmount;
  readonly refunds: GopayRefundList;
}): Option.Option<GopayRefund> => {
  if (Option.isNone(input.dispatchedAt)) {
    return Option.none();
  }
  const dispatchedAt = input.dispatchedAt.value;
  const candidates = input.refunds.filter((refund) =>
    Option.isNone(discrepancyOf(input.expectedAmount, fromGopayAmount(refund))),
  );
  const created = candidates.map((refund) => ({ createdAt: instantOf(refund.created_at), refund }));
  if (created.some(({ createdAt }) => Option.isNone(createdAt))) {
    return Option.none();
  }
  const afterDispatch = created.filter(({ createdAt }) =>
    Option.exists(createdAt, (at) => DateTime.isGreaterThanOrEqualTo(at, dispatchedAt)),
  );
  return afterDispatch.length === 1 ? Arr.head(afterDispatch).pipe(Option.map(({ refund }) => refund)) : Option.none();
};

// ---------------------------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------------------------

/**
 * What the client read for one lookup. Auth, transport and server failures are the client's typed Unavailable
 * failures and never reach this mapping.
 * - PAYMENT: `GET /payments/{payment_id}` for a COLLECT or a CANCEL_OR_VOID.
 * - REFUND: `GET /refunds/{refund_id}` of a recorded refund of `paymentRef`.
 * - REFUND_LIST: the payment and `GET /payments/{payment_id}/refunds` for a refund without a recorded id.
 * - NOT_FOUND: 404.
 */
const GopayLookupResultSchema = Schema.Union([
  Schema.TaggedStruct('NOT_FOUND', {}),
  Schema.TaggedStruct('PAYMENT', { payment: GopayPaymentSchema }),
  Schema.TaggedStruct('REFUND', { refund: GopayRefundSchema, refundRef: ProviderObjectIdSchema }),
  Schema.TaggedStruct('REFUND_LIST', { payment: GopayPaymentSchema, refunds: GopayRefundListSchema }),
]);
export type GopayLookupResult = typeof GopayLookupResultSchema.Type;

const conflictFor = (expected: GatewayExpectedEffect, providerRefs: readonly ProviderObjectRef[]) =>
  Match.value(expected).pipe(
    Match.tag('COLLECT', ({ operationId }) => [
      bareFinding('VERIFICATION_CONFLICT', { operationId, operationKind: 'COLLECT' }, providerRefs),
    ]),
    Match.tag('REFUND', ({ operationId }) => [
      bareFinding('VERIFICATION_CONFLICT', { operationId, operationKind: 'REFUND' }, providerRefs),
    ]),
    Match.tag('CANCEL_OR_VOID', ({ operationId, target }) => [
      bareFinding('VERIFICATION_CONFLICT', { operationId, operationKind: 'CANCEL_OR_VOID' }, providerRefs),
      bareFinding('VERIFICATION_CONFLICT', { operationId: target.operationId, operationKind: 'COLLECT' }, providerRefs),
    ]),
    Match.exhaustive,
  );

const indeterminateFor = (expected: GatewayExpectedEffect, providerRefs: readonly ProviderObjectRef[]) =>
  Match.value(expected).pipe(
    Match.tag('COLLECT', ({ operationId }) =>
      bareFinding('INDETERMINATE', { operationId, operationKind: 'COLLECT' }, providerRefs),
    ),
    Match.tag('REFUND', ({ operationId }) =>
      bareFinding('INDETERMINATE', { operationId, operationKind: 'REFUND' }, providerRefs),
    ),
    Match.tag('CANCEL_OR_VOID', ({ operationId }) =>
      bareFinding('INDETERMINATE', { operationId, operationKind: 'CANCEL_OR_VOID' }, providerRefs),
    ),
    Match.exhaustive,
  );

const paymentFindings = (input: {
  readonly expected: GatewayExpectedEffect;
  readonly observedAt: DateTime.Utc;
  readonly origin: GopayResponseOrigin;
  readonly payment: GopayPayment;
  readonly paymentRef: ProviderObjectId;
}): readonly ProviderFindingResult[] => {
  const providerRefs = [gopayPaymentRef(input.paymentRef)];
  const collectionOf = (expectation: Expectation) =>
    collectionFinding({
      createResponse: false,
      expectation,
      observedAt: input.observedAt,
      origin: input.origin,
      payment: input.payment,
      paymentRef: input.paymentRef,
    });
  return Match.value(input.expected).pipe(
    Match.tag('COLLECT', (collect) => [collectionOf(collect)]),
    Match.tag('CANCEL_OR_VOID', ({ operationId, target }) =>
      input.payment.order_number === deriveProviderCorrelation(target.operationId).orderReference
        ? [
            cancelFinding({
              cancelOperationId: operationId,
              observedAt: input.observedAt,
              origin: input.origin,
              payment: input.payment,
              paymentRef: input.paymentRef,
              targetAmount: target.amount,
            }),
            collectionOf(target),
          ]
        : conflictFor(input.expected, providerRefs),
    ),
    // A payment read alone never proves a refund; the service reads refunds for a REFUND expectation.
    Match.tag('REFUND', () => [indeterminateFor(input.expected, providerRefs)]),
    Match.exhaustive,
  );
};

/**
 * Maps a GoPay lookup of `paymentRef` to findings for exactly the operations `expected` names:
 * - COLLECT: one COLLECT finding (see `collectionFinding`).
 * - CANCEL_OR_VOID: the cancel's finding (see `cancelFinding`) plus its target collection's finding.
 * - REFUND: one REFUND finding from the refund resource (see `refundFinding`); from a refund list only through
 *   `matchGopayRefundList`, otherwise INDETERMINATE.
 * - NOT_FOUND is INDETERMINATE; another payment or refund id, or another order is VERIFICATION_CONFLICT; neither
 *   has evidence.
 */
export const mapGopayLookup = (input: {
  readonly dispatchedAt: Option.Option<DateTime.Utc>;
  readonly expected: GatewayExpectedEffect;
  readonly observedAt: DateTime.Utc;
  readonly origin: GopayResponseOrigin;
  readonly paymentRef: ProviderObjectId;
  readonly result: GopayLookupResult;
}): readonly ProviderFindingResult[] => {
  const { expected, paymentRef } = input;
  const providerRefs = [gopayPaymentRef(paymentRef)];
  const refundOf = (refund: GopayRefund) =>
    Match.value(expected).pipe(
      Match.tag('REFUND', (expectation) => [
        refundFinding({ expectation, observedAt: input.observedAt, origin: input.origin, paymentRef, refund }),
      ]),
      Match.orElse(() => [indeterminateFor(expected, providerRefs)]),
    );
  return Match.value(input.result).pipe(
    Match.tag('NOT_FOUND', () => [indeterminateFor(expected, providerRefs)]),
    Match.tag('PAYMENT', ({ payment }) =>
      payment.id === paymentRef ? paymentFindings({ ...input, payment }) : conflictFor(expected, providerRefs),
    ),
    Match.tag('REFUND', ({ refund, refundRef }) =>
      refund.id === refundRef
        ? refundOf(refund)
        : conflictFor(expected, [...providerRefs, gopayRefundRef(paymentRef, refundRef)]),
    ),
    Match.tag('REFUND_LIST', ({ payment, refunds }) => {
      if (payment.id !== paymentRef || Option.isNone(gopayOrderReferenceOf(payment))) {
        return conflictFor(expected, providerRefs);
      }
      const matched = Match.value(expected).pipe(
        Match.tag('REFUND', ({ amount }) =>
          matchGopayRefundList({ dispatchedAt: input.dispatchedAt, expectedAmount: amount, refunds }),
        ),
        Match.orElse(() => Option.none<GopayRefund>()),
      );
      return Option.match(matched, {
        onNone: () => [indeterminateFor(expected, providerRefs)],
        onSome: refundOf,
      });
    }),
    Match.exhaustive,
  );
};

/** What GoPay answered to `DELETE /payments/{payment_id}`: 204 or 409. Every other answer is OUTCOME_UNKNOWN. */
const GopayCancelAnswerSchema = Schema.Literals(['CANCEL_ACCEPTED', 'CANCEL_REFUSED']);
export type GopayCancelAnswer = typeof GopayCancelAnswerSchema.Type;

const isPendingFinding = (finding: ProviderFindingResult): boolean =>
  finding.finding === 'ACCEPTED_PENDING' || finding.finding === 'CUSTOMER_ACTION_REQUIRED';

/**
 * The cancel's dispatch outcome from its answer and the lookup that always follows it (plan D-P1):
 *
 * | DELETE | lookup                       | cancel                                         | collection target        |
 * |--------|------------------------------|------------------------------------------------|--------------------------|
 * | 204    | CANCELED                     | CANCEL_CONFIRMED (ACKNOWLEDGED)                | COLLECTION_NOT_EFFECTED  |
 * | 204    | anything else                | INDETERMINATE (ACKNOWLEDGED)                   | finding of that state    |
 * | 409    | PAYMENT_METHOD_CHOSEN        | CANCEL_NOT_EFFECTED (REJECTED_BEFORE_EFFECT)   | pending, not kept        |
 * | 409    | PAID, *REFUNDED              | CANCEL_NOT_EFFECTED (REJECTED_BEFORE_EFFECT)   | COLLECTION_CONFIRMED     |
 * | 409    | CANCELED, TIMEOUTED          | CANCEL_CONFIRMED (ACKNOWLEDGED)                | COLLECTION_NOT_EFFECTED  |
 * | 409    | CREATED, miss                | INDETERMINATE (ACKNOWLEDGED)                   | none                     |
 *
 * A conflicting lookup is a VERIFICATION_CONFLICT for both. A pending target finding is never kept: it proves
 * nothing the collection's own record does not already hold.
 */
export const mapGopayCancelAnswer = (input: {
  readonly answer: GopayCancelAnswer;
  readonly expected: GatewayExpectedEffect;
  readonly findings: readonly ProviderFindingResult[];
  readonly paymentRef: ProviderObjectId;
  readonly state: Option.Option<GopayPaymentState>;
}): ProviderDispatchResponse => {
  const { expected, findings } = input;
  const providerRefs = [gopayPaymentRef(input.paymentRef)];
  const own = Option.getOrElse(
    Option.fromUndefinedOr(findings.find((finding) => finding.target.operationId === expected.operationId)),
    () => indeterminateFor(expected, providerRefs),
  );
  const targetFinding = cancelTargetFindingOf(findings, expected).pipe(
    Option.filter((finding) => !isPendingFinding(finding)),
  );
  const contradicted = input.answer === 'CANCEL_ACCEPTED' && !Option.contains(input.state, 'CANCELED');
  if (contradicted && own.finding !== 'VERIFICATION_CONFLICT') {
    return { _tag: 'ACKNOWLEDGED', finding: indeterminateFor(expected, providerRefs), targetFinding };
  }
  return {
    _tag: own.finding === 'NOT_EFFECTED' ? 'REJECTED_BEFORE_EFFECT' : 'ACKNOWLEDGED',
    finding: own,
    targetFinding,
  };
};
