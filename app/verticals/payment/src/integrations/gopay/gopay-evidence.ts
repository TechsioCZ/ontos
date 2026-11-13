import { Match, Option, Schema } from 'effect';
import type { DateTime } from 'effect';

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
import type {
  GatewayExecutionTarget,
  GatewayLookupRequest,
  ProviderObjectId,
  ProviderObjectRef,
} from '../psp/psp-request.ts';
import type {
  ProviderDispatchResponse,
  ProviderEvidence,
  ProviderEvidenceFactFamily,
  ProviderFindingResult,
} from '../psp/psp-result.ts';
import { GOPAY_CANCEL_UNSUPPORTED_REASON } from './gopay-capabilities.ts';
import { fromGopayAmount } from './gopay-money.ts';
import {
  GopayPaymentSchema,
  GopayRefundHistoryEntrySchema,
  GopayRefundHistorySchema,
  gopayGoidOf,
  gopayProviderObjectId,
  gopayRefundHistoryRowObjectId,
} from './gopay-wire.ts';
import type { GopayPayment, GopayRefundHistory, GopayRefundHistoryEntry, GopayRefundResponse } from './gopay-wire.ts';

/**
 * Pure GoPay evidence mapping (#1156, #1157, #1158; plan §2.5 and §4 GoPay). Every function maps an
 * already decoded GoPay response for one GatewayExecutionTarget into provider-neutral findings.
 *
 * Rules:
 * - A response for another GoID, another payment id or another order reference is a
 *   VERIFICATION_CONFLICT without evidence: nothing is ever submitted against another merchant.
 * - REFUNDED and PARTIALLY_REFUNDED prove the collection (never "canceled"); refund completion is
 *   proven only by the refund history.
 * - A refund is attributed to its history row only by the dispatch's pre-dispatch baseline (`matchGopayRefundHistory`).
 * - A lookup miss, "not found" or an unattributable history is INDETERMINATE without evidence, never NOT_EFFECTED.
 * - Findings are emitted only for the operations named by the expected effect.
 */

const SOURCE_REVISION = 0;

/** Origins a GoPay provider response can come from (never-sent facts use `gopay:local:`). */
export type GopayResponseOrigin = Exclude<ProviderEvidenceOrigin, 'LOCAL_NOT_SENT' | 'NOTIFICATION_SIGNED'>;

const gopayPaymentRef = (id: ProviderObjectId): ProviderObjectRef => ({ _tag: 'GOPAY_PAYMENT', id });

/**
 * `gopay:<origin>:<providerObjectId>:<operationId>:<factKind>:<amountMinor>` (plan §2.5), origin in lower case.
 * The provider object is the payment, or for a refund fact proven by the refund history the attributed row.
 */
export const gopaySourceOccurrenceId = (input: {
  readonly amountMinor: number;
  readonly factKind: ProviderEvidenceFactKind;
  readonly occurrenceObjectId: ProviderObjectId;
  readonly operationId: string;
  readonly origin: GopayResponseOrigin;
}): string =>
  `gopay:${input.origin.toLowerCase()}:${input.occurrenceObjectId}:${input.operationId}:${input.factKind}:${input.amountMinor}`;

/** `gopay:local:<operationId>:<factKind>` for facts OntOS states without sending anything. */
const gopayLocalSourceOccurrenceId = (operationId: string, factKind: ProviderEvidenceFactKind): string =>
  `gopay:local:${operationId}:${factKind}`;

/** Refund economic effect key `gopay-refund:<paymentId>:<operationId>` (refunds of a payment are serialized). */
export const gopayRefundEffectKey = (paymentRef: ProviderObjectId, operationId: string): string =>
  `gopay-refund:${paymentRef}:${operationId}`;

interface FindingParts {
  readonly customerAction: Option.Option<string>;
  readonly evidence: Option.Option<ProviderEvidence>;
  readonly finding: ProviderFinding;
  readonly operationId: string;
  readonly operationKind: PaymentOperationKind;
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
  subject: { readonly operationId: string; readonly operationKind: PaymentOperationKind },
  providerRefs: readonly ProviderObjectRef[],
): ProviderFindingResult =>
  findingOf({
    customerAction: Option.none(),
    evidence: Option.none(),
    finding,
    operationId: subject.operationId,
    operationKind: subject.operationKind,
    orderReference: Option.none(),
    providerRefs,
  });

interface EvidenceParts {
  readonly amountMinor: number;
  readonly discrepancy: Option.Option<ProviderAmountDiscrepancy>;
  readonly economicEffectKey: string;
  readonly factFamily: ProviderEvidenceFactFamily;
  readonly factKind: ProviderEvidenceFactKind;
  readonly observedAmount: Option.Option<ProviderReportedAmount>;
  readonly observedAt: DateTime.Utc;
  /** The provider object the fact is about: the payment, or a refund-history row. */
  readonly occurrenceObjectId: ProviderObjectId;
  readonly operationId: string;
  readonly origin: GopayResponseOrigin;
  readonly paymentRef: ProviderObjectId;
  readonly providerOccurredAt: Option.Option<DateTime.Utc>;
}

const evidenceOf = (parts: EvidenceParts): ProviderEvidence => ({
  discrepancy: parts.discrepancy,
  economicEffectKey: Option.some(parts.economicEffectKey),
  factFamily: parts.factFamily,
  factKind: parts.factKind,
  observedAmount: parts.observedAmount,
  observedAt: parts.observedAt,
  providerOccurredAt: parts.providerOccurredAt,
  providerRefs: [gopayPaymentRef(parts.paymentRef)],
  reason: Option.none(),
  sourceOccurrenceId: gopaySourceOccurrenceId(parts),
  sourceRevision: SOURCE_REVISION,
});

// ---------------------------------------------------------------------------------------------
// Identity verification
// ---------------------------------------------------------------------------------------------

/** The payment belongs to the binding's GoID (a non-canonical configured GoID never matches). */
const isBindingMerchant = (target: GatewayExecutionTarget, payment: GopayPayment): boolean =>
  Option.match(gopayGoidOf(target.merchantIdentity), {
    onNone: () => false,
    onSome: (goid) => goid === payment.target.goid,
  });

/**
 * The lookup-verified order reference: the payment belongs to the binding's GoID and its
 * `order_number` is an OntOS order reference. This is the correlation key of plan §2.3 step 2 when the
 * provider payment id is not in the ledger yet.
 */
export const gopayVerifiedOrderReference = (
  target: GatewayExecutionTarget,
  payment: GopayPayment,
): Option.Option<GatewayOrderReference> =>
  isBindingMerchant(target, payment)
    ? Schema.decodeUnknownOption(GatewayOrderReferenceSchema)(payment.order_number)
    : Option.none();

// ---------------------------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------------------------

interface CollectionExpectation {
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
 * A confirmed collection of another amount or currency is VERIFICATION_CONFLICT carrying
 * COLLECTION_CONFIRMED evidence with the discrepancy (it never confirms). Any other state with an
 * amount mismatch is VERIFICATION_CONFLICT without evidence. `createResponse` requires CREATED with a
 * valid https `gw_url`.
 */
const collectionFinding = (input: {
  readonly createResponse: boolean;
  readonly expectation: CollectionExpectation;
  readonly observedAt: DateTime.Utc;
  readonly origin: GopayResponseOrigin;
  readonly payment: GopayPayment;
  readonly target: GatewayExecutionTarget;
}): ProviderFindingResult => {
  const { expectation, payment } = input;
  const paymentRef = gopayProviderObjectId(payment.id);
  const providerRefs = [gopayPaymentRef(paymentRef)];
  const subject = { operationId: expectation.operationId, operationKind: 'COLLECT' as const };
  const expectedOrderReference = deriveProviderCorrelation(expectation.operationId).orderReference;
  if (!isBindingMerchant(input.target, payment) || payment.order_number !== expectedOrderReference) {
    // A create response for another merchant or order is not recorded as this operation's payment.
    return bareFinding('VERIFICATION_CONFLICT', subject, input.createResponse ? [] : providerRefs);
  }
  const observedAmount = fromGopayAmount(payment);
  const discrepancy = Match.value(compareObservedAmount(expectation.amount, observedAmount)).pipe(
    Match.tag('MATCH', () => Option.none<ProviderAmountDiscrepancy>()),
    Match.tag('MISMATCH', (mismatch) => Option.some(mismatch.discrepancy)),
    Match.exhaustive,
  );
  const evidence = (factKind: ProviderEvidenceFactKind): Option.Option<ProviderEvidence> =>
    Option.some(
      evidenceOf({
        amountMinor: observedAmount.amountMinor,
        discrepancy,
        economicEffectKey: paymentRef,
        factFamily: 'GATEWAY_OUTCOME',
        factKind,
        observedAmount: Option.some(observedAmount),
        observedAt: input.observedAt,
        occurrenceObjectId: paymentRef,
        operationId: expectation.operationId,
        origin: input.origin,
        paymentRef,
        providerOccurredAt: Option.none(),
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
 * Maps the `POST /payments/payment` response of a collect dispatch. The response must carry the
 * dispatch `order_number`, the binding GoID and the exact amount and currency; CREATED with `gw_url`
 * is CUSTOMER_ACTION_REQUIRED. A mismatch is acknowledged (the provider accepted a request) as a
 * VERIFICATION_CONFLICT without evidence.
 */
export const mapGopayCreateResponse = (input: {
  readonly expected: CollectionExpectation;
  readonly observedAt: DateTime.Utc;
  readonly payment: GopayPayment;
  readonly target: GatewayExecutionTarget;
}): ProviderDispatchResponse => ({
  _tag: 'ACKNOWLEDGED',
  finding: collectionFinding({
    createResponse: true,
    expectation: input.expected,
    observedAt: input.observedAt,
    origin: 'DISPATCH_RESPONSE',
    payment: input.payment,
    target: input.target,
  }),
  targetFinding: Option.none(),
});

// ---------------------------------------------------------------------------------------------
// Refund
// ---------------------------------------------------------------------------------------------

/**
 * Maps the `POST /payments/payment/{id}/refund` response `{id, result}`. FAILED is
 * REJECTED_BEFORE_EFFECT with REFUND_NOT_EFFECTED; ACCEPTED and FINISHED are REFUND_PENDING until the
 * refund history, read against the dispatch's baseline, proves completion. A response for another payment id is a VERIFICATION_CONFLICT.
 * The response carries no amount, so the occurrence id uses the requested amount and no observed
 * amount is claimed.
 */
export const mapGopayRefundResponse = (input: {
  readonly expected: CollectionExpectation;
  readonly observedAt: DateTime.Utc;
  readonly origin: GopayResponseOrigin;
  readonly paymentRef: ProviderObjectId;
  readonly response: GopayRefundResponse;
}): ProviderDispatchResponse => {
  const { expected, paymentRef } = input;
  const providerRefs = [gopayPaymentRef(paymentRef)];
  const subject = { operationId: expected.operationId, operationKind: 'REFUND' as const };
  if (gopayProviderObjectId(input.response.id) !== paymentRef) {
    return {
      _tag: 'ACKNOWLEDGED',
      finding: bareFinding('VERIFICATION_CONFLICT', subject, providerRefs),
      targetFinding: Option.none(),
    };
  }
  const refundFinding = (finding: ProviderFinding, factKind: ProviderEvidenceFactKind) =>
    findingOf({
      ...subject,
      customerAction: Option.none(),
      evidence: Option.some(
        evidenceOf({
          amountMinor: expected.amount.amountMinor,
          discrepancy: Option.none(),
          economicEffectKey: gopayRefundEffectKey(paymentRef, expected.operationId),
          factFamily: 'REFUND_EXECUTION',
          factKind,
          observedAmount: Option.none(),
          observedAt: input.observedAt,
          occurrenceObjectId: paymentRef,
          operationId: expected.operationId,
          origin: input.origin,
          paymentRef,
          providerOccurredAt: Option.none(),
        }),
      ),
      finding,
      orderReference: Option.none(),
      providerRefs,
    });
  return Match.value(input.response.result).pipe(
    Match.when('FAILED', (): ProviderDispatchResponse => ({
      _tag: 'REJECTED_BEFORE_EFFECT',
      finding: refundFinding('NOT_EFFECTED', 'REFUND_NOT_EFFECTED'),
      targetFinding: Option.none(),
    })),
    Match.orElse((): ProviderDispatchResponse => ({
      _tag: 'ACKNOWLEDGED',
      finding: refundFinding('ACCEPTED_PENDING', 'REFUND_PENDING'),
      targetFinding: Option.none(),
    })),
  );
};

/**
 * The refund-history row ids a payment had before a refund dispatch was sent, read through the dispatch's
 * binding and persisted with the prepared request (`GatewayRefundBaseline`).
 */
export type GopayRefundBaseline = readonly ProviderObjectId[];

const RefundRowConfirmedSchema = Schema.TaggedStruct('CONFIRMED', { row: GopayRefundHistoryEntrySchema });
const RefundRowNotEffectedSchema = Schema.TaggedStruct('NOT_EFFECTED', { row: GopayRefundHistoryEntrySchema });
const RefundRowConflictSchema = Schema.TaggedStruct('CONFLICT', {});
const RefundRowUndecidedSchema = Schema.TaggedStruct('UNDECIDED', {});

/** What the refund history proves about one refund dispatch, given its pre-dispatch baseline. */
export const GopayRefundAttributionSchema = Schema.Union([
  RefundRowConfirmedSchema,
  RefundRowNotEffectedSchema,
  RefundRowConflictSchema,
  RefundRowUndecidedSchema,
]);
export type GopayRefundAttribution = typeof GopayRefundAttributionSchema.Type;

const UNDECIDED: GopayRefundAttribution = RefundRowUndecidedSchema.make({});

/**
 * Attributes a payment's refund history to one refund dispatch by its pre-dispatch baseline (#1156, #1158).
 * GoPay history rows name no request and carry date-only dates, so neither can bind a row to a dispatch. The
 * baseline can, because OntOS serialises GoPay refunds per provider payment (the ledger never prepares a GoPay
 * refund while another refund of the same payment is unresolved): a row that is new since the baseline of an
 * acknowledged dispatch can only be that dispatch's row, unless a refund was made outside OntOS meanwhile.
 *
 * - No baseline (never read, or the dispatch was not acknowledged by GoPay's own response): UNDECIDED.
 * - A baseline row missing from the history, or a repeated row id (the history is not what OntOS read): UNDECIDED.
 * - Zero or several new rows: UNDECIDED (several means another refund happened meanwhile, so none is attributable).
 * - Exactly one new row of another amount or currency: CONFLICT.
 * - Exactly one new row of the exact amount: SUCCESS is CONFIRMED, FAILED is NOT_EFFECTED, REQUESTED is UNDECIDED.
 */
export const matchGopayRefundHistory = (input: {
  readonly baseline: Option.Option<GopayRefundBaseline>;
  readonly expectedAmount: PaymentMonetaryAmount;
  readonly history: GopayRefundHistory;
}): GopayRefundAttribution => {
  if (Option.isNone(input.baseline)) {
    return UNDECIDED;
  }
  const known: ReadonlySet<ProviderObjectId> = new Set(input.baseline.value);
  const rowIds = input.history.map((row) => gopayRefundHistoryRowObjectId(row.id));
  const present = new Set(rowIds);
  if (present.size !== rowIds.length || [...known].some((rowId) => !present.has(rowId))) {
    return UNDECIDED;
  }
  const fresh = input.history.filter((row) => !known.has(gopayRefundHistoryRowObjectId(row.id)));
  const [row] = fresh;
  if (row === undefined || fresh.length !== 1) {
    return UNDECIDED;
  }
  return Match.value(compareObservedAmount(input.expectedAmount, fromGopayAmount(row))).pipe(
    Match.tag('MISMATCH', (): GopayRefundAttribution => RefundRowConflictSchema.make({})),
    Match.tag('MATCH', () =>
      Match.value(row.state).pipe(
        Match.when('SUCCESS', (): GopayRefundAttribution => RefundRowConfirmedSchema.make({ row })),
        Match.when('FAILED', (): GopayRefundAttribution => RefundRowNotEffectedSchema.make({ row })),
        Match.when('REQUESTED', () => UNDECIDED),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  );
};

const refundLookupFinding = (input: {
  readonly baseline: Option.Option<GopayRefundBaseline>;
  readonly expected: CollectionExpectation;
  readonly observedAt: DateTime.Utc;
  readonly origin: GopayResponseOrigin;
  readonly payment: GopayPayment;
  readonly refunds: Option.Option<GopayRefundHistory>;
}): ProviderFindingResult => {
  const paymentRef = gopayProviderObjectId(input.payment.id);
  const providerRefs = [gopayPaymentRef(paymentRef)];
  const subject = { operationId: input.expected.operationId, operationKind: 'REFUND' as const };
  const attribution = Option.match(input.refunds, {
    onNone: () => UNDECIDED,
    onSome: (history) =>
      matchGopayRefundHistory({ baseline: input.baseline, expectedAmount: input.expected.amount, history }),
  });
  // The attributed row's own id is the provider object of the fact, so the evidence identity records it.
  const rowFinding = (finding: ProviderFinding, factKind: ProviderEvidenceFactKind, row: GopayRefundHistoryEntry) =>
    findingOf({
      ...subject,
      customerAction: Option.none(),
      evidence: Option.some(
        evidenceOf({
          amountMinor: row.amount,
          discrepancy: Option.none(),
          economicEffectKey: gopayRefundEffectKey(paymentRef, input.expected.operationId),
          factFamily: 'REFUND_EXECUTION',
          factKind,
          observedAmount: Option.some(fromGopayAmount(row)),
          observedAt: input.observedAt,
          occurrenceObjectId: gopayRefundHistoryRowObjectId(row.id),
          operationId: input.expected.operationId,
          origin: input.origin,
          paymentRef,
          providerOccurredAt: Option.none(),
        }),
      ),
      finding,
      orderReference: Option.none(),
      providerRefs,
    });
  return Match.value(attribution).pipe(
    Match.tag('CONFIRMED', ({ row }) => rowFinding('EFFECT_CONFIRMED', 'REFUND_CONFIRMED', row)),
    Match.tag('NOT_EFFECTED', ({ row }) => rowFinding('NOT_EFFECTED', 'REFUND_NOT_EFFECTED', row)),
    Match.tag('CONFLICT', () => bareFinding('VERIFICATION_CONFLICT', subject, providerRefs)),
    Match.tag('UNDECIDED', () => bareFinding('INDETERMINATE', subject, providerRefs)),
    Match.exhaustive,
  );
};

// ---------------------------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------------------------

/**
 * What the client read for one lookup: the payment (and, for a REFUND, its refund history), or a
 * provider miss (404, PAYMENT_NOT_FOUND). Auth and transport failures are the client's typed
 * Unavailable failures and never reach this mapping.
 */
export const GopayLookupResultSchema = Schema.Union([
  Schema.TaggedStruct('FOUND', {
    payment: GopayPaymentSchema,
    refunds: Schema.Option(GopayRefundHistorySchema),
  }),
  Schema.TaggedStruct('NOT_FOUND', {}),
]);
export type GopayLookupResult = typeof GopayLookupResultSchema.Type;

/** The operation a lookup reports on, as named by the expected effect. */
const lookupSubject = (request: GatewayLookupRequest) =>
  Match.value(request.expected).pipe(
    Match.tag('COLLECT', ({ amount, operationId }) => ({ amount, operationId, operationKind: 'COLLECT' as const })),
    Match.tag('REFUND', ({ amount, operationId }) => ({ amount, operationId, operationKind: 'REFUND' as const })),
    Match.tag('CANCEL_OR_VOID', ({ target }) => ({
      amount: target.amount,
      operationId: target.operationId,
      operationKind: 'COLLECT' as const,
    })),
    Match.exhaustive,
  );

/**
 * Maps a GoPay lookup of `paymentRef` (`GET /payments/payment/{id}`, plus `/refunds` for a REFUND).
 *
 * - COLLECT: one COLLECT finding (see `collectionFinding`).
 * - CANCEL_OR_VOID: one COLLECT finding for the cancel's collection target only. GoPay never received the
 *   cancel (it is UNSUPPORTED); its CANCEL_NOT_EFFECTED is the local `gopayCancelUnsupportedEvidence`.
 * - REFUND: one REFUND finding from the refund history attributed by `refundBaseline`, the baseline of a dispatch
 *   GoPay acknowledged with its own response (`matchGopayRefundHistory`); None never confirms. The payment state
 *   is not refund proof; the payment `order_number` belongs to the collection and is not reported for it.
 * - NOT_FOUND is INDETERMINATE; another payment id or another GoID is VERIFICATION_CONFLICT; neither has evidence.
 */
export const mapGopayLookup = (input: {
  readonly observedAt: DateTime.Utc;
  readonly origin: GopayResponseOrigin;
  readonly paymentRef: ProviderObjectId;
  readonly refundBaseline: Option.Option<GopayRefundBaseline>;
  readonly request: GatewayLookupRequest;
  readonly result: GopayLookupResult;
  readonly target: GatewayExecutionTarget;
}): readonly ProviderFindingResult[] => {
  const subject = lookupSubject(input.request);
  const providerRefs = [gopayPaymentRef(input.paymentRef)];
  return Match.value(input.result).pipe(
    Match.tag('NOT_FOUND', () => [bareFinding('INDETERMINATE', subject, providerRefs)]),
    Match.tag('FOUND', ({ payment, refunds }) => {
      if (gopayProviderObjectId(payment.id) !== input.paymentRef || !isBindingMerchant(input.target, payment)) {
        return [bareFinding('VERIFICATION_CONFLICT', subject, providerRefs)];
      }
      if (subject.operationKind === 'COLLECT') {
        return [
          collectionFinding({
            createResponse: false,
            expectation: subject,
            observedAt: input.observedAt,
            origin: input.origin,
            payment,
            target: input.target,
          }),
        ];
      }
      return Option.isNone(Schema.decodeUnknownOption(GatewayOrderReferenceSchema)(payment.order_number))
        ? [bareFinding('VERIFICATION_CONFLICT', subject, providerRefs)]
        : [
            refundLookupFinding({
              baseline: input.refundBaseline,
              expected: subject,
              observedAt: input.observedAt,
              origin: input.origin,
              payment,
              refunds,
            }),
          ];
    }),
    Match.exhaustive,
  );
};

// ---------------------------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------------------------

/**
 * Local CANCEL_NOT_EFFECTED evidence of a GoPay cancel that was never sent (ledger UNSUPPORTED, plan
 * N8). It is pending governed submission like any other evidence; it never triggers a fallback.
 */
export const gopayCancelUnsupportedEvidence = (input: {
  readonly observedAt: DateTime.Utc;
  readonly operationId: string;
  readonly providerTarget: Option.Option<ProviderObjectRef>;
}): ProviderEvidence => ({
  discrepancy: Option.none(),
  economicEffectKey: Option.none(),
  factFamily: 'GATEWAY_OUTCOME',
  factKind: 'CANCEL_NOT_EFFECTED',
  observedAmount: Option.none(),
  observedAt: input.observedAt,
  providerOccurredAt: Option.none(),
  providerRefs: Option.toArray(input.providerTarget),
  reason: Option.some(GOPAY_CANCEL_UNSUPPORTED_REASON),
  sourceOccurrenceId: gopayLocalSourceOccurrenceId(input.operationId, 'CANCEL_NOT_EFFECTED'),
  sourceRevision: SOURCE_REVISION,
});
