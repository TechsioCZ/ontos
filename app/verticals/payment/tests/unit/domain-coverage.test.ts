import { describe, expect, it } from 'effect-rstest';
import { Effect, Option, Result, Schema } from 'effect';

import type { PaymentMonetaryAmount } from '../../shared/domain/payment-money.ts';
import { PaymentRefundableItemsBasisSchema } from '../../shared/domain/payment-refund-basis.ts';
import type { PaymentOperationKind, PaymentOperationOutcome } from '../../shared/domain/payment-vocabulary.ts';
import {
  computePaymentFunds,
  decidePrepaidCoverage,
  decideRefundReservation,
  isPrepaidProofCurrent,
  PaymentFundsLedger,
  PrepaidCoverageDecision,
  RefundReservationDecision,
  refundItemAvailability,
  requireExactRefundableItemsAmount,
  requireRefundReservation,
} from '../../src/domain/coverage.ts';
import type { PaymentFundsOperation, PaymentFundsSnapshot } from '../../src/domain/coverage.ts';

const czk = (amountMinor: number): PaymentMonetaryAmount => ({ amountMinor, currency: 'CZK' });
const operation = (
  operationId: string,
  kind: PaymentOperationKind,
  outcome: PaymentOperationOutcome,
  amountMinor: number,
  targetOperationId?: string,
): PaymentFundsOperation => ({ amount: czk(amountMinor), kind, operationId, outcome, targetOperationId });
const collected = (amountMinor = 1000) => operation('collect', 'COLLECT', 'EFFECT_CONFIRMED', amountMinor);
const refund = (operationId: string, outcome: PaymentOperationOutcome, amountMinor: number) =>
  operation(operationId, 'REFUND', outcome, amountMinor, 'collect');
const snapshot = (
  operations: readonly PaymentFundsOperation[],
  overrides: Partial<Omit<PaymentFundsSnapshot, 'operations'>> = {},
): PaymentFundsSnapshot => ({
  collectionCorrections: [],
  operations,
  required: czk(1000),
  unresolvedEvidence: false,
  ...overrides,
});
const items = (request: PaymentMonetaryAmount) => ({ amount: request, basisKind: 'REFUNDABLE_ITEMS' as const });
const compensation = (request: PaymentMonetaryAmount) => ({
  amount: request,
  basisKind: 'FAILED_COMMITMENT_COMPENSATION' as const,
});

describe('#1150 Current funds ledger', () => {
  it('counts confirmed returns and live reservations once against the established collection', () => {
    expect(
      computePaymentFunds(
        snapshot([
          collected(),
          refund('r1', 'EFFECT_CONFIRMED', 300),
          refund('r2', 'PENDING', 100),
          refund('r3', 'INDETERMINATE', 50),
          refund('r4', 'CONFLICT', 25),
          refund('r5', 'NOT_EFFECTED_CONFIRMED', 500),
        ]),
      ),
    ).toEqual(
      PaymentFundsLedger.Established({
        collected: czk(1000),
        collectOperationId: 'collect',
        confirmedReturned: czk(300),
        remaining: czk(525),
        reserved: czk(175),
      }),
    );
  });

  it('ignores a definitively failed refund of an earlier attempt when a retry established the funds', () => {
    // Attempt A was refunded-not-effected and later reconciled not effected; retry B collected.
    const funds = computePaymentFunds(
      snapshot([
        operation('attempt-a', 'COLLECT', 'NOT_EFFECTED_CONFIRMED', 1000),
        operation('refund-of-a', 'REFUND', 'NOT_EFFECTED_CONFIRMED', 400, 'attempt-a'),
        operation('collect', 'COLLECT', 'EFFECT_CONFIRMED', 1000),
      ]),
    );
    expect(funds).toEqual(
      PaymentFundsLedger.Established({
        collected: czk(1000),
        collectOperationId: 'collect',
        confirmedReturned: czk(0),
        remaining: czk(1000),
        reserved: czk(0),
      }),
    );
    // A live or effected refund of another collection still holds the funds.
    const contradictory = computePaymentFunds(
      snapshot([
        operation('attempt-a', 'COLLECT', 'NOT_EFFECTED_CONFIRMED', 1000),
        operation('refund-of-a', 'REFUND', 'PENDING', 400, 'attempt-a'),
        operation('collect', 'COLLECT', 'EFFECT_CONFIRMED', 1000),
      ]),
    );
    expect(PaymentFundsLedger.$is('Held')(contradictory)).toBe(true);
  });

  it('reports no established collection before any confirmed COLLECT', () => {
    expect(computePaymentFunds(snapshot([]))).toEqual(
      PaymentFundsLedger.NotCollected({ liveCollectOperationId: Option.none() }),
    );
    expect(computePaymentFunds(snapshot([operation('c1', 'COLLECT', 'PENDING', 1000)]))).toEqual(
      PaymentFundsLedger.NotCollected({ liveCollectOperationId: Option.some('c1') }),
    );
    expect(computePaymentFunds(snapshot([operation('c1', 'COLLECT', 'NOT_EFFECTED_CONFIRMED', 1000)]))).toEqual(
      PaymentFundsLedger.NotCollected({ liveCollectOperationId: Option.none() }),
    );
  });

  it('holds returns that stand without any proven collection, never dropping the returned money', () => {
    const disproven = operation('collect', 'COLLECT', 'NOT_EFFECTED_CONFIRMED', 1000);
    for (const outcome of ['EFFECT_CONFIRMED', 'PENDING', 'INDETERMINATE'] as const) {
      expect(computePaymentFunds(snapshot([disproven, refund('r1', outcome, 600)]))).toEqual(
        PaymentFundsLedger.Held({ reason: 'INCONSISTENT_EVIDENCE' }),
      );
    }
    // A refund that definitively did not happen returned nothing.
    expect(computePaymentFunds(snapshot([disproven, refund('r1', 'NOT_EFFECTED_CONFIRMED', 600)]))).toEqual(
      PaymentFundsLedger.NotCollected({ liveCollectOperationId: Option.none() }),
    );
  });

  it('holds ambiguous, conflicting or inconsistent evidence for reconciliation', () => {
    expect(computePaymentFunds(snapshot([collected()], { unresolvedEvidence: true }))).toEqual(
      PaymentFundsLedger.Held({ reason: 'UNRESOLVED_EVIDENCE' }),
    );
    expect(computePaymentFunds(snapshot([operation('c1', 'COLLECT', 'CONFLICT', 1000)]))).toEqual(
      PaymentFundsLedger.Held({ reason: 'COLLECTION_IN_CONFLICT' }),
    );
    expect(computePaymentFunds(snapshot([collected(), operation('c2', 'COLLECT', 'EFFECT_CONFIRMED', 1000)]))).toEqual(
      PaymentFundsLedger.Held({ reason: 'INCONSISTENT_EVIDENCE' }),
    );
    expect(
      computePaymentFunds(snapshot([collected(), operation('r1', 'REFUND', 'PENDING', 100, 'other-collect')])),
    ).toEqual(PaymentFundsLedger.Held({ reason: 'INCONSISTENT_EVIDENCE' }));
    expect(computePaymentFunds(snapshot([collected(), refund('r1', 'EFFECT_CONFIRMED', 1200)]))).toEqual(
      PaymentFundsLedger.Held({ reason: 'INCONSISTENT_EVIDENCE' }),
    );
    expect(computePaymentFunds(snapshot([collected()], { collectionCorrections: [czk(1500)] }))).toEqual(
      PaymentFundsLedger.Held({ reason: 'INCONSISTENT_EVIDENCE' }),
    );
  });

  it('#1150 Collection succeeds while cancellation is in flight: a live cancel of proven collection is held', () => {
    expect(
      computePaymentFunds(snapshot([collected(), operation('v1', 'CANCEL_OR_VOID', 'PENDING', 0, 'collect')])),
    ).toEqual(PaymentFundsLedger.Held({ reason: 'CANCELLATION_AGAINST_COLLECTION' }));
    expect(
      computePaymentFunds(
        snapshot([collected(), operation('v1', 'CANCEL_OR_VOID', 'NOT_EFFECTED_CONFIRMED', 0, 'collect')]),
      ),
    ).toEqual(
      PaymentFundsLedger.Established({
        collected: czk(1000),
        collectOperationId: 'collect',
        confirmedReturned: czk(0),
        remaining: czk(1000),
        reserved: czk(0),
      }),
    );
  });

  it('#1151 source correction disproving funds reduces the established collection, not a refund', () => {
    expect(computePaymentFunds(snapshot([collected()], { collectionCorrections: [czk(250)] }))).toEqual(
      PaymentFundsLedger.Established({
        collected: czk(750),
        collectOperationId: 'collect',
        confirmedReturned: czk(0),
        remaining: czk(750),
        reserved: czk(0),
      }),
    );
  });
});

describe('#1149 Current prepaid coverage', () => {
  it('covers only the exact proven collection with nothing returned or reserved', () => {
    expect(decidePrepaidCoverage(snapshot([collected()]))).toEqual(
      PrepaidCoverageDecision.Covered({ collectOperationId: 'collect', covered: czk(1000) }),
    );
  });

  it('#1148 Zero payable: no fictitious collection is required', () => {
    expect(decidePrepaidCoverage(snapshot([], { required: czk(0) }))).toEqual(
      PrepaidCoverageDecision.ZeroPayable({ required: czk(0) }),
    );
  });

  it('is not covered before collection or after any coverage reduction', () => {
    expect(decidePrepaidCoverage(snapshot([]))).toEqual(
      PrepaidCoverageDecision.NotCovered({ reason: 'COLLECTION_NOT_ESTABLISHED' }),
    );
    expect(decidePrepaidCoverage(snapshot([collected()], { collectionCorrections: [czk(1)] }))).toEqual(
      PrepaidCoverageDecision.NotCovered({ reason: 'COLLECTION_REDUCED_BY_CORRECTION' }),
    );
    expect(decidePrepaidCoverage(snapshot([collected(), refund('r1', 'EFFECT_CONFIRMED', 1)]))).toEqual(
      PrepaidCoverageDecision.NotCovered({ reason: 'CONFIRMED_RETURN_REDUCED_COVERAGE' }),
    );
  });

  it('#1150 Refund and prepaid authorization race: a reserving refund makes coverage insufficient', () => {
    expect(decidePrepaidCoverage(snapshot([collected(), refund('r1', 'INDETERMINATE', 1)]))).toEqual(
      PrepaidCoverageDecision.NotCovered({ reason: 'RETURN_PENDING_OR_INDETERMINATE' }),
    );
    expect(
      isPrepaidProofCurrent({
        currentCoverageRevision: 3,
        decision: decidePrepaidCoverage(snapshot([collected(), refund('r1', 'PENDING', 400)])),
        proofCoverageRevision: 3,
      }),
    ).toBe(false);
  });

  it('#1149 a proof is Current only at the same coverage revision while still covered', () => {
    const covered = decidePrepaidCoverage(snapshot([collected()]));

    expect(isPrepaidProofCurrent({ currentCoverageRevision: 2, decision: covered, proofCoverageRevision: 2 })).toBe(
      true,
    );
    expect(isPrepaidProofCurrent({ currentCoverageRevision: 3, decision: covered, proofCoverageRevision: 2 })).toBe(
      false,
    );
  });

  it('holds over-collection or ambiguous evidence instead of promoting it to exact coverage', () => {
    expect(decidePrepaidCoverage(snapshot([collected(1200)]))).toEqual(
      PrepaidCoverageDecision.Held({ reason: 'INCONSISTENT_EVIDENCE' }),
    );
    expect(decidePrepaidCoverage(snapshot([collected()], { unresolvedEvidence: true }))).toEqual(
      PrepaidCoverageDecision.Held({ reason: 'UNRESOLVED_EVIDENCE' }),
    );
  });
});

describe('#1150 refundable funds guard', () => {
  it('#1150 A prior refund is not deducted twice: 1000 collected, 600 refunded, 400 may be reserved', () => {
    const decision = decideRefundReservation(
      snapshot([collected(), refund('r1', 'EFFECT_CONFIRMED', 600)]),
      items(czk(400)),
    );

    expect(RefundReservationDecision.$is('Permitted')(decision)).toBe(true);
    if (RefundReservationDecision.$is('Permitted')(decision)) {
      expect(decision.remainingAfter).toEqual(czk(0));
      expect(decision.collectOperationId).toBe('collect');
    }
  });

  it('#1150 Prior return evidence reduces the remaining budget: 1000 with 400 returned cannot reuse 400', () => {
    const prior = snapshot([collected(), refund('r1', 'EFFECT_CONFIRMED', 400)]);

    expect(decideRefundReservation(prior, items(czk(1000)))).toEqual(
      RefundReservationDecision.Exceeds({ remaining: czk(600) }),
    );
    expect(RefundReservationDecision.$is('Permitted')(decideRefundReservation(prior, items(czk(600))))).toBe(true);
  });

  it('#1150 Prior return evidence reduces the remaining budget: ambiguous overlap is held, not double returned', () => {
    expect(
      decideRefundReservation(
        snapshot([collected(), refund('r1', 'EFFECT_CONFIRMED', 400)], { unresolvedEvidence: true }),
        items(czk(100)),
      ),
    ).toEqual(RefundReservationDecision.Held({ reason: 'UNRESOLVED_EVIDENCE' }));
  });

  it('#1150 Two concurrent refunds overlap: live reservations consume the funds budget', () => {
    expect(
      decideRefundReservation(snapshot([collected(), refund('r1', 'INDETERMINATE', 700)]), items(czk(400))),
    ).toEqual(RefundReservationDecision.Exceeds({ remaining: czk(300) }));
  });

  it('#1150 no refund before proven collection and no zero refund', () => {
    expect(decideRefundReservation(snapshot([]), items(czk(100)))).toEqual(
      RefundReservationDecision.NotCollected({ liveCollectOperationId: Option.none() }),
    );
    expect(decideRefundReservation(snapshot([collected()]), items(czk(0)))).toEqual(
      RefundReservationDecision.AmountNotPositive({ requested: czk(0) }),
    );
  });

  it('#1150 Collected payment but commitment proves no Order: compensation reserves the exact remainder', () => {
    const decision = decideRefundReservation(
      snapshot([collected(), refund('r1', 'EFFECT_CONFIRMED', 300)]),
      compensation(czk(700)),
    );

    expect(RefundReservationDecision.$is('Permitted')(decision)).toBe(true);
    expect(
      decideRefundReservation(snapshot([collected(), refund('r1', 'EFFECT_CONFIRMED', 300)]), compensation(czk(500))),
    ).toEqual(RefundReservationDecision.AmountMismatch({ requiredExact: czk(700) }));
  });

  it('#1150 Pending return cannot be carved out to create partial compensation', () => {
    expect(
      decideRefundReservation(snapshot([collected(), refund('r1', 'INDETERMINATE', 400)]), compensation(czk(600))),
    ).toEqual(RefundReservationDecision.Held({ reason: 'OVERLAPPING_UNRESOLVED_RETURN' }));
  });

  it('#1150 compensation after full refund has nothing left to return', () => {
    expect(
      decideRefundReservation(snapshot([collected(), refund('r1', 'EFFECT_CONFIRMED', 1000)]), compensation(czk(1))),
    ).toEqual(RefundReservationDecision.Exceeds({ remaining: czk(0) }));
  });

  it.effect('maps every refusal to a typed Payment conflict or rejection', () =>
    Effect.gen(function* typedRefusals() {
      const codeOf = (
        operations: readonly PaymentFundsOperation[],
        request: ReturnType<typeof items>,
        overrides: Partial<Omit<PaymentFundsSnapshot, 'operations'>> = {},
      ) =>
        requireRefundReservation(snapshot(operations, overrides), request).pipe(
          Effect.flip,
          Effect.map((failure) => failure.code),
        );

      expect(yield* codeOf([collected(), refund('r1', 'PENDING', 900)], items(czk(200)))).toBe(
        'payment_refundable_funds_exceeded',
      );
      expect(yield* codeOf([collected()], items(czk(1)), { unresolvedEvidence: true })).toBe(
        'payment_held_for_reconciliation',
      );
      expect(yield* codeOf([], items(czk(1)))).toBe('payment_no_established_collection');
      expect(yield* codeOf([collected()], items(czk(0)))).toBe('payment_amount_invalid');
      expect(
        yield* requireRefundReservation(snapshot([collected()]), compensation(czk(1))).pipe(
          Effect.flip,
          Effect.map((failure) => failure.code),
        ),
      ).toBe('payment_refund_amount_mismatch');
      const permitted = yield* requireRefundReservation(snapshot([collected()]), items(czk(1000)));
      expect(permitted.remainingAfter).toEqual(czk(0));
    }),
  );
});

describe('#1150 item atomicity and availability', () => {
  const basis = Schema.decodeUnknownSync(PaymentRefundableItemsBasisSchema)({
    _tag: 'REFUNDABLE_ITEMS',
    items: [
      { amountMinor: 300, currency: 'CZK', itemRef: 'A', sourceEvidenceRef: 'order:item:A' },
      { amountMinor: 500, currency: 'CZK', itemRef: 'B', sourceEvidenceRef: 'order:item:B' },
    ],
  });

  it('#1150 Refund one item from a three-item Order: the amount equals the full item amount', () => {
    const onlyB = Schema.decodeUnknownSync(PaymentRefundableItemsBasisSchema)({
      _tag: 'REFUNDABLE_ITEMS',
      items: [{ amountMinor: 500, currency: 'CZK', itemRef: 'B', sourceEvidenceRef: 'order:item:B' }],
    });

    expect(Result.getOrThrow(requireExactRefundableItemsAmount(onlyB, czk(500)))).toEqual(czk(500));
    expect(Result.getOrThrow(requireExactRefundableItemsAmount(basis, czk(800)))).toEqual(czk(800));
  });

  it('#1150 Attempt to refund half of one item: 250 CZK of a 500 CZK item is rejected', () => {
    const half = requireExactRefundableItemsAmount(basis, czk(550));

    expect(Result.isFailure(half)).toBe(true);
    if (Result.isFailure(half)) {
      expect(half.failure.code).toBe('payment_refund_item_fractioned');
    }
  });

  it('#1150 refundable items must be distinct and non-empty', () => {
    const decode = Schema.decodeUnknownSync(PaymentRefundableItemsBasisSchema);

    expect(() => decode({ _tag: 'REFUNDABLE_ITEMS', items: [] })).toThrow();
    expect(() =>
      decode({
        _tag: 'REFUNDABLE_ITEMS',
        items: [
          { amountMinor: 1, currency: 'CZK', itemRef: 'A', sourceEvidenceRef: 'e' },
          { amountMinor: 1, currency: 'CZK', itemRef: 'A', sourceEvidenceRef: 'e' },
        ],
      }),
    ).toThrow();
  });

  it('#1150 Two concurrent refunds overlap / Refund response is lost: item availability follows its claim', () => {
    expect(refundItemAvailability([{ active: true, itemRef: 'B', operationOutcome: 'INDETERMINATE' }], 'B')).toBe(
      'RESERVED_BY_PENDING_REFUND',
    );
    expect(refundItemAvailability([{ active: true, itemRef: 'B', operationOutcome: 'CONFLICT' }], 'B')).toBe(
      'RESERVED_BY_PENDING_REFUND',
    );
    expect(refundItemAvailability([{ active: true, itemRef: 'B', operationOutcome: 'EFFECT_CONFIRMED' }], 'B')).toBe(
      'REFUNDED',
    );
    expect(
      refundItemAvailability([{ active: false, itemRef: 'B', operationOutcome: 'NOT_EFFECTED_CONFIRMED' }], 'B'),
    ).toBe('AVAILABLE');
    expect(refundItemAvailability([{ active: true, itemRef: 'B', operationOutcome: 'PENDING' }], 'A')).toBe(
      'AVAILABLE',
    );
  });
});
