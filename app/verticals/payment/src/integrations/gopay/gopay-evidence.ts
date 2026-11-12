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
import { GopayPaymentSchema, GopayRefundHistorySchema, gopayGoidOf, gopayProviderObjectId } from './gopay-wire.ts';
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
 * - A lookup miss, "not found" or an ambiguous history is INDETERMINATE without evidence, never NOT_EFFECTED.
 * - Findings are emitted only for the operations named by the expected effect.
 */

const SOURCE_REVISION = 0;

/** Origins a GoPay provider response can come from (never-sent facts use `gopay:local:`). */
export type GopayResponseOrigin = Exclude<ProviderEvidenceOrigin, 'LOCAL_NOT_SENT' | 'NOTIFICATION_SIGNED'>;

const gopayPaymentRef = (id: ProviderObjectId): ProviderObjectRef => ({ _tag: 'GOPAY_PAYMENT', id });

/** `gopay:<origin>:<providerObjectId>:<operationId>:<factKind>:<amountMinor>` (plan §2.5), origin in lower case. */
export const gopaySourceOccurrenceId = (input: {
  readonly amountMinor: number;
  readonly factKind: ProviderEvidenceFactKind;
  readonly operationId: string;
  readonly origin: GopayResponseOrigin;
  readonly paymentRef: ProviderObjectId;
}): string =>
  `gopay:${input.origin.toLowerCase()}:${input.paymentRef}:${input.operationId}:${input.factKind}:${input.amountMinor}`;

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
 * refund history proves completion. A response for another payment id is a VERIFICATION_CONFLICT.
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

/** Where a refund history entry lies relative to the dispatch instant. */
const RefundEntryTimingSchema = Schema.Literals(['AFTER_DISPATCH', 'BEFORE_DISPATCH', 'UNCERTAIN']);
type RefundEntryTiming = typeof RefundEntryTimingSchema.Type;

const INSTANT_PATTERN = /^(?<local>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)(?<offset>Z|[+-]\d{2}:?\d{2})$/u;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** A history date with full precision (`...T10:15:00.000+0200`, `...+02:00` or `...Z`); None otherwise. */
const instantOf = (text: string): Option.Option<DateTime.Utc> => {
  const groups = INSTANT_PATTERN.exec(text)?.groups;
  const local = groups?.['local'];
  const offset = groups?.['offset'];
  if (local === undefined || offset === undefined) {
    return Option.none();
  }
  const normalizedOffset = offset === 'Z' || offset.includes(':') ? offset : `${offset.slice(0, 3)}:${offset.slice(3)}`;
  return DateTime.make(`${local}${normalizedOffset}`);
};

/**
 * A documented day-only date (`2024-04-04`) has no zone, so it is placed relative to the dispatch only
 * when every zone (UTC-12..UTC+14) agrees; otherwise it is UNCERTAIN and nothing is confirmed.
 */
const dayTiming = (day: string, dispatchedAt: DateTime.Utc): RefundEntryTiming =>
  Option.match(DateTime.make(`${day}T00:00:00.000Z`), {
    onNone: () => 'UNCERTAIN',
    onSome: (midnight) => {
      if (DateTime.isGreaterThanOrEqualTo(DateTime.add(midnight, { hours: -14 }), dispatchedAt)) {
        return 'AFTER_DISPATCH';
      }
      return DateTime.isLessThanOrEqualTo(DateTime.add(midnight, { hours: 36 }), dispatchedAt)
        ? 'BEFORE_DISPATCH'
        : 'UNCERTAIN';
    },
  });

const entryTiming = (entry: GopayRefundHistoryEntry, dispatchedAt: DateTime.Utc): RefundEntryTiming =>
  DAY_PATTERN.test(entry.date_requested)
    ? dayTiming(entry.date_requested, dispatchedAt)
    : Option.match(instantOf(entry.date_requested), {
        onNone: () => 'UNCERTAIN',
        onSome: (requestedAt) =>
          DateTime.isGreaterThanOrEqualTo(requestedAt, dispatchedAt) ? 'AFTER_DISPATCH' : 'BEFORE_DISPATCH',
      });

/**
 * Binds the refund history to one expected refund (#1156, #1158); Some is the confirming entry.
 * Entries of another amount or currency are ignored. Among exact-amount entries, any whose request date
 * cannot be placed relative to the dispatch makes the result INDETERMINATE (None); otherwise exactly one
 * entry requested at or after the dispatch (`date_requested >= dispatchedAt`) in state SUCCESS confirms.
 * Zero or several candidates, a REQUESTED or FAILED candidate, an entry of another payment or an unknown
 * dispatch instant are None. GoPay entries carry no refund id, so nothing else can bind them.
 */
export const matchGopayRefundHistory = (input: {
  readonly dispatchedAt: Option.Option<DateTime.Utc>;
  readonly expectedAmount: PaymentMonetaryAmount;
  readonly history: GopayRefundHistory;
  readonly paymentRef: ProviderObjectId;
}): Option.Option<GopayRefundHistoryEntry> => {
  if (
    Option.isNone(input.dispatchedAt) ||
    input.history.some((entry) => gopayProviderObjectId(entry.id) !== input.paymentRef)
  ) {
    return Option.none();
  }
  const dispatchedAt = input.dispatchedAt.value;
  const timed = input.history.flatMap((entry) =>
    Match.value(compareObservedAmount(input.expectedAmount, fromGopayAmount(entry))).pipe(
      Match.tag('MATCH', () => [{ entry, timing: entryTiming(entry, dispatchedAt) }]),
      Match.tag('MISMATCH', () => []),
      Match.exhaustive,
    ),
  );
  if (timed.some(({ timing }) => timing === 'UNCERTAIN')) {
    return Option.none();
  }
  const candidates = timed.filter(({ timing }) => timing === 'AFTER_DISPATCH');
  return candidates.length === 1
    ? Arr.head(candidates).pipe(
        Option.map(({ entry }) => entry),
        Option.filter((entry) => entry.state === 'SUCCESS'),
      )
    : Option.none();
};

const refundLookupFinding = (input: {
  readonly dispatchedAt: Option.Option<DateTime.Utc>;
  readonly expected: CollectionExpectation;
  readonly observedAt: DateTime.Utc;
  readonly origin: GopayResponseOrigin;
  readonly payment: GopayPayment;
  readonly refunds: Option.Option<GopayRefundHistory>;
}): ProviderFindingResult => {
  const paymentRef = gopayProviderObjectId(input.payment.id);
  const providerRefs = [gopayPaymentRef(paymentRef)];
  const subject = { operationId: input.expected.operationId, operationKind: 'REFUND' as const };
  const confirming = input.refunds.pipe(
    Option.flatMap((history) =>
      matchGopayRefundHistory({
        dispatchedAt: input.dispatchedAt,
        expectedAmount: input.expected.amount,
        history,
        paymentRef,
      }),
    ),
  );
  return Option.match(confirming, {
    onNone: () => bareFinding('INDETERMINATE', subject, providerRefs),
    onSome: (entry) =>
      findingOf({
        ...subject,
        customerAction: Option.none(),
        evidence: Option.some(
          evidenceOf({
            amountMinor: entry.amount,
            discrepancy: Option.none(),
            economicEffectKey: gopayRefundEffectKey(paymentRef, input.expected.operationId),
            factFamily: 'REFUND_EXECUTION',
            factKind: 'REFUND_CONFIRMED',
            observedAmount: Option.some(fromGopayAmount(entry)),
            observedAt: input.observedAt,
            operationId: input.expected.operationId,
            origin: input.origin,
            paymentRef,
            providerOccurredAt: Option.fromUndefinedOr(entry.date_last_change).pipe(Option.flatMap(instantOf)),
          }),
        ),
        finding: 'EFFECT_CONFIRMED',
        orderReference: Option.none(),
        providerRefs,
      }),
  });
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
 * - REFUND: one REFUND finding from the refund history (`matchGopayRefundHistory`). The payment state is
 *   not refund proof; the payment `order_number` belongs to the collection and is not reported for it.
 * - NOT_FOUND is INDETERMINATE; another payment id or another GoID is VERIFICATION_CONFLICT; neither has evidence.
 */
export const mapGopayLookup = (input: {
  readonly observedAt: DateTime.Utc;
  readonly origin: GopayResponseOrigin;
  readonly paymentRef: ProviderObjectId;
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
              dispatchedAt: input.request.dispatchedAt,
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
