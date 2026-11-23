import type { CurrentPricingDecisionResponseSchema } from '@app/pricing-contracts';
import { Clock, DateTime, Duration, Effect, Layer, Option } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import {
  publicPricingReadHarnessServices,
  startPublicPricingReadHarness,
} from '../support/public-pricing-read-harness.ts';
import type {
  HarnessFeeSetObservation,
  HarnessWholeAttemptObservation,
  PublicPricingReadHarness,
} from '../support/public-pricing-read-harness.ts';

// #1242 / ONT-AUD-0020: a Commercial Fee set the owner OBSERVED after the requested as-of instant (O > T, ordinary
// latency) must price, with the original times preserved, through the REGISTERED public Current Pricing Read. The
// Fee, Discount, Price, Tier and Currency facts are produced through Pricing's own scoped persistence; Market, purchase
// context, price-group assignment and Price Group Catalog compatibility are the harness's labelled published-contract
// stand-ins (see public-pricing-read-harness.ts). Independent arithmetic, never copied from an output:
const BASE_PRICE = 100;
const FEE = 3;
// One fixed Price Group Discount on a Variant line.
const DISCOUNT = 10;
// The requested instant T is this far in the past, so the owner observation O is later by at least this much.
const REQUESTED_LAG_MS = 2000;
// The owner's own Fee-schedule start for a Fee that is not yet effective at T: the set is owner-proven EMPTY at T.
const FUTURE_FEE_START = '2099-01-01T00:00:00.000Z';
// Pause that keeps T strictly after the facts the harness produced at its start.
const SETTLE_MS = 50;
// The attempt reason of a Fee set the owner cannot verify as of T because its applicability boundary was crossed.
const UNVERIFIABLE_FEE_SET_REASON = 'COMMERCIAL_FEE_SET_UNVERIFIABLE';
const CUSTOMER_PROJECTION = 'CURRENT_PRICING_DECISION_CUSTOMER_V1';

type PublicRead = typeof CurrentPricingDecisionResponseSchema.Type;
type RequestLines = Parameters<PublicPricingReadHarness['makeRequest']>[0]['lines'];
type RequestSubject = NonNullable<Parameters<PublicPricingReadHarness['makeRequest']>[0]['subject']>;

const resolved = (result: PublicRead) => {
  assert(result.outcome === 'PRICE_RESOLVED');
  return result;
};

/** The exact customer-safe wire shape of a resolved price: nothing beyond the published pre-Tax values. */
const money = (amount: number) => ({ amount: String(amount), currencyCode: 'CZK' });
const customerResolved = (lines: readonly (readonly [string, number])[]) => ({
  candidate: { occurrenceIds: lines.map(([occurrenceId]) => occurrenceId) },
  outcome: 'PRICE_RESOLVED',
  projectionVersion: CUSTOMER_PROJECTION,
  result: {
    currencyCode: 'CZK',
    lines: lines.map(([occurrenceId, amount]) => ({ occurrenceId, publishedPreTaxAmount: money(amount) })),
    monetaryBoundary: 'PRE_TAX',
    total: money(lines.reduce((sum, [, amount]) => sum + amount, 0)),
    totalMethod: 'EXACT_SUM_OF_ROUNDED_LINES',
  },
  retryable: false,
});

/** The exact customer-safe wire shape of a non-success: no result, so no partial publication. */
const customerNonSuccess = (outcome: string, occurrenceIds: readonly string[], retryable: boolean) => ({
  candidate: { occurrenceIds },
  outcome,
  projectionVersion: CUSTOMER_PROJECTION,
  retryable,
});

/** The requested as-of instant T: REQUESTED_LAG_MS before now and after every fact the harness produced. */
const requestedInstant = (harness: PublicPricingReadHarness) =>
  Effect.gen(function* requestedInstantProgram() {
    const earliest = DateTime.add(DateTime.makeUnsafe(harness.operationTime), { milliseconds: SETTLE_MS });
    const lagged = DateTime.subtract(yield* DateTime.now, { milliseconds: REQUESTED_LAG_MS });
    if (DateTime.isLessThanOrEqualTo(lagged, earliest)) {
      // Every produced fact is effective from the harness start; T must follow all of them.
      yield* Effect.sleep(
        Duration.millis(DateTime.toEpochMillis(earliest) - DateTime.toEpochMillis(lagged) + SETTLE_MS),
      );
    }
    const requested = DateTime.subtract(yield* DateTime.now, { milliseconds: REQUESTED_LAG_MS });
    expect(DateTime.isGreaterThan(requested, DateTime.makeUnsafe(harness.operationTime))).toBe(true);
    return requested;
  });

const price = (
  harness: PublicPricingReadHarness,
  input: { readonly lines: RequestLines; readonly operationTime: DateTime.Utc; readonly subject: RequestSubject },
) =>
  Effect.gen(function* priceProgram() {
    const request = yield* harness.makeRequest({ ...input, operationTime: DateTime.formatIso(input.operationTime) });
    return yield* harness.runRegisteredRead(request);
  });

/** Every Fee set the given whole attempts retained for their owner final fence, with the requested instant. */
const retainedFeeSets = (attempts: readonly HarnessWholeAttemptObservation[]) =>
  attempts.flatMap(({ effectiveAt, feeSets }) => feeSets.map((feeSet) => ({ effectiveAt, feeSet })));

const epoch = DateTime.toEpochMillis;
const text = DateTime.formatIso;
const optionalText = (instant: Option.Option<DateTime.Utc>) =>
  Option.match(instant, { onNone: () => null, onSome: (value) => text(value) });

/** The Fee set as the owner observed it: later than T, one consistent instant, and not rewritten to T. */
const expectObservedAfterRequested = (
  observed: { readonly effectiveAt: Option.Option<DateTime.Utc>; readonly feeSet: HarnessFeeSetObservation },
  requested: DateTime.Utc,
) => {
  const { effectiveAt, feeSet } = observed;
  // The Read handed the owner the requested instant itself, not the observation.
  assert(Option.isSome(effectiveAt));
  expect(text(effectiveAt.value)).toBe(text(requested));
  expect(DateTime.isGreaterThan(feeSet.observedAt, requested)).toBe(true);
  expect(epoch(feeSet.observedAt) - epoch(requested)).toBeGreaterThanOrEqual(REQUESTED_LAG_MS / 2);
  // The set, its completeness and currentness evidence and the owner receipt keep the one original observation.
  for (const instant of [feeSet.completenessObservedAt, feeSet.currentnessObservedAt, feeSet.ownerReceiptObservedAt]) {
    expect(text(instant)).toBe(text(feeSet.observedAt));
  }
  expect(DateTime.isGreaterThanOrEqualTo(feeSet.currentnessRevalidatedAt, feeSet.observedAt)).toBe(true);
};

const feePeriodsText = (feeSet: HarnessFeeSetObservation) =>
  feeSet.feeEffectivePeriods.map(({ effectiveFrom, effectiveTo }) => [text(effectiveFrom), optionalText(effectiveTo)]);

it.live(
  'prices a Fee observed after its requested instant for an empty and a non-empty Fee set with an empty and a non-empty Discount set',
  () =>
    Effect.scoped(
      Effect.gen(function* publicFeeObservedAfterRequested() {
        const nativeClock = yield* Clock.Clock;
        const context = yield* Layer.build(publicPricingReadHarnessServices);
        yield* Effect.gen(function* scenario() {
          const harness = yield* startPublicPricingReadHarness({ nativeClock });
          const { p1, p2, q1 } = harness.handoffs;
          // P1: Fee 3 and a Price Group Discount 10. P2 (a second Variant of P1's Product): no Fee at all, so the Fee
          // set the Price admission initialised is owner-proven EMPTY; it carries a Discount 10. Q1: a Fee that only
          // starts in 2099, so its set is also owner-proven EMPTY at T (with the 2099 next boundary); no Discount.
          yield* harness.produceCommercialFee({ amount: String(FEE), handoff: p1 });
          yield* harness.produceContractualDiscount({ amount: String(DISCOUNT), handoff: p1 });
          yield* harness.produceContractualDiscount({ amount: String(DISCOUNT), handoff: p2 });
          yield* harness.produceCommercialFee({ amount: String(FEE), effectiveFrom: FUTURE_FEE_START, handoff: q1 });

          const cases = [
            {
              discount: 'non-empty',
              feeCount: 1,
              lines: [{ handoff: p1, occurrenceId: 'P-fee-discount' }],
              nextBoundary: null,
              subject: 'PROFILE',
              total: BASE_PRICE - DISCOUNT + FEE,
            },
            {
              discount: 'empty (Guest has no Discount audience)',
              feeCount: 1,
              lines: [{ handoff: p1, occurrenceId: 'P-fee-guest' }],
              nextBoundary: null,
              subject: 'GUEST',
              total: BASE_PRICE + FEE,
            },
            {
              discount: 'empty (no Discount exists for the Variant)',
              feeCount: 0,
              lines: [{ handoff: q1, occurrenceId: 'Q-futurefee-nodiscount' }],
              nextBoundary: FUTURE_FEE_START,
              subject: 'PROFILE',
              total: BASE_PRICE,
            },
            {
              discount: 'non-empty',
              feeCount: 0,
              lines: [{ handoff: p2, occurrenceId: 'R-emptyfee-discount' }],
              nextBoundary: null,
              subject: 'PROFILE',
              total: BASE_PRICE - DISCOUNT,
            },
            {
              discount: 'empty (Guest has no Discount audience)',
              feeCount: 0,
              lines: [{ handoff: p2, occurrenceId: 'R-emptyfee-guest' }],
              nextBoundary: null,
              subject: 'GUEST',
              total: BASE_PRICE,
            },
          ] as const;
          expect(cases.map(({ total }) => total)).toEqual([93, 103, 100, 90, 100]);

          for (const { discount, feeCount, lines, nextBoundary, subject, total } of cases) {
            const requested = yield* requestedInstant(harness);
            const attemptsBefore = harness.wholeAttempts.length;
            const fencesBefore = harness.fenceCalls.length;
            const result = yield* price(harness, { lines, operationTime: requested, subject });
            const [{ occurrenceId }] = lines;
            expect(result).toEqual(customerResolved([[occurrenceId, total]]));
            // One whole attempt, no retry: ordinary latency alone is neither stale nor indeterminate.
            const attempts = harness.wholeAttempts.slice(attemptsBefore);
            expect(attempts.map(({ kind }) => kind)).toEqual(['READY_FOR_FINAL_PUBLICATION']);
            expect(harness.fenceCalls.slice(fencesBefore).every(({ failure }) => failure === undefined)).toBe(true);
            const [observed, ...rest] = retainedFeeSets(attempts);
            assert(observed !== undefined);
            expect(rest).toEqual([]);
            expectObservedAfterRequested(observed, requested);
            expect(observed.feeSet.feeEffectivePeriods).toHaveLength(feeCount);
            expect(optionalText(observed.feeSet.nextApplicabilityBoundary)).toBe(nextBoundary);
            if (feeCount === 1) {
              // The Fee's own effective-from is the original owner fact, unchanged by the later observation.
              expect(feePeriodsText(observed.feeSet)).toEqual([[harness.operationTime, null]]);
            }
            yield* Effect.logInfo(
              `#1242 line ${occurrenceId}: ${subject} Fee set ${feeCount === 0 ? 'EMPTY' : 'NON-EMPTY'}, Discount ${discount}; ` +
                `requested ${text(requested)}, Fee observed ${text(observed.feeSet.observedAt)}; line and whole total ${total} CZK`,
            );
          }

          // One whole purchase over all three Variants: the whole total is the exact sum of the published lines.
          const requested = yield* requestedInstant(harness);
          const attemptsBefore = harness.wholeAttempts.length;
          const whole = yield* price(harness, {
            lines: [
              { handoff: p1, occurrenceId: 'W-P' },
              { handoff: p2, occurrenceId: 'W-R' },
              { handoff: q1, occurrenceId: 'W-Q' },
            ],
            operationTime: requested,
            subject: 'PROFILE',
          });
          const lines = [
            ['W-P', BASE_PRICE - DISCOUNT + FEE],
            ['W-R', BASE_PRICE - DISCOUNT],
            ['W-Q', BASE_PRICE],
          ] as const;
          expect(whole).toEqual(customerResolved(lines));
          expect(resolved(whole).result.total.amount).toBe('283');
          const wholeFeeSets = retainedFeeSets(harness.wholeAttempts.slice(attemptsBefore));
          // The non-empty set and both empty sets are each observed after T in the same publication.
          expect(
            wholeFeeSets.map(({ feeSet }) => feeSet.feeEffectivePeriods.length).toSorted((left, right) => left - right),
          ).toEqual([0, 0, 1]);
          for (const observed of wholeFeeSets) {
            expectObservedAfterRequested(observed, requested);
          }
          yield* Effect.logInfo(
            `#1242 whole purchase: lines 93/90/100, whole total 283 CZK, requested ${text(requested)}`,
          );
        }).pipe(Effect.provideContext(context));
      }),
    ),
  900_000,
);

it.live(
  'retries a Fee set that changes between a whole attempt and its final fence at most once and publishes no partial result',
  () =>
    Effect.scoped(
      Effect.gen(function* publicFeeRevisionChanged() {
        const nativeClock = yield* Clock.Clock;
        const context = yield* Layer.build(publicPricingReadHarnessServices);
        yield* Effect.gen(function* scenario() {
          const harness = yield* startPublicPricingReadHarness({ nativeClock });
          const { p1, p2 } = harness.handoffs;
          yield* harness.produceCommercialFee({ amount: String(FEE), handoff: p1 });
          yield* harness.produceCommercialFee({ amount: String(FEE), handoff: p2 });

          // One material insertion lands after attempt 1 read its Fee set and before the owner final fence: the fence
          // refuses attempt 1, and the single bounded fresh retry prices the changed set.
          const insertedFee = 2;
          yield* harness.afterWholeAttempt((ordinal) =>
            ordinal === 1
              ? harness.produceCommercialFee({ amount: String(insertedFee), family: 'COPYRIGHT_FEE', handoff: p1 })
              : Effect.void,
          );
          const requestedOnce = yield* requestedInstant(harness);
          const attemptsBeforeOnce = harness.wholeAttempts.length;
          const retried = yield* price(harness, {
            lines: [{ handoff: p1, occurrenceId: 'P-retry' }],
            operationTime: requestedOnce,
            subject: 'GUEST',
          });
          expect(retried).toEqual(customerResolved([['P-retry', BASE_PRICE + FEE + insertedFee]]));
          const onceAttempts = harness.wholeAttempts.slice(attemptsBeforeOnce);
          expect(onceAttempts.map(({ kind }) => kind)).toEqual([
            'READY_FOR_FINAL_PUBLICATION',
            'READY_FOR_FINAL_PUBLICATION',
          ]);
          // Attempt 1 read the set before the insertion (one Fee); the retry read the CHANGED set (two Fees), observed
          // later still, and every observation is later than T and kept as the owner issued it.
          const onceFeeSets = retainedFeeSets(onceAttempts);
          expect(onceFeeSets.map(({ feeSet }) => feeSet.feeEffectivePeriods.length)).toEqual([1, 2]);
          for (const observed of onceFeeSets) {
            expectObservedAfterRequested(observed, requestedOnce);
          }
          const [first, second] = onceFeeSets;
          assert(first !== undefined && second !== undefined);
          expect(DateTime.isGreaterThan(second.feeSet.observedAt, first.feeSet.observedAt)).toBe(true);
          yield* Effect.logInfo(
            `#1242 one changed revision: 2 attempts (Fee sets of ${onceFeeSets.map(({ feeSet }) => feeSet.feeEffectivePeriods.length).join(' then ')} Fees), ` +
              `final line and whole total ${BASE_PRICE + FEE + insertedFee} CZK`,
          );

          // A Fee revision that changes in EVERY attempt exhausts the bound: exactly two attempts, a typed retryable
          // PRICING_INDETERMINATE and no published result.
          const revisedAmounts = ['4', '5'] as const;
          yield* harness.afterWholeAttempt((ordinal) =>
            harness.reviseCommercialFee({ amount: revisedAmounts[ordinal - 1] ?? '6', handoff: p2 }),
          );
          const requestedAlways = yield* requestedInstant(harness);
          const attemptsBeforeAlways = harness.wholeAttempts.length;
          const exhausted = yield* price(harness, {
            lines: [{ handoff: p2, occurrenceId: 'R-exhausted' }],
            operationTime: requestedAlways,
            subject: 'GUEST',
          });
          expect(exhausted).toEqual(customerNonSuccess('PRICING_INDETERMINATE', ['R-exhausted'], true));
          const alwaysAttempts = harness.wholeAttempts.slice(attemptsBeforeAlways);
          expect(alwaysAttempts.map(({ kind }) => kind)).toEqual([
            'READY_FOR_FINAL_PUBLICATION',
            'READY_FOR_FINAL_PUBLICATION',
          ]);
          yield* Effect.logInfo(
            `#1242 revision changed on every attempt: ${alwaysAttempts.length} attempts, typed PRICING_INDETERMINATE retryable, no result`,
          );

          // The persisted revision is intact: once the interference stops, a fresh read prices the latest Fee.
          yield* harness.clearAfterWholeAttempt();
          const requestedAfter = yield* requestedInstant(harness);
          const settled = yield* price(harness, {
            lines: [{ handoff: p2, occurrenceId: 'R-settled' }],
            operationTime: requestedAfter,
            subject: 'GUEST',
          });
          expect(settled).toEqual(customerResolved([['R-settled', BASE_PRICE + 5]]));
        }).pipe(Effect.provideContext(context));
      }),
    ),
  900_000,
);

it.live(
  'returns a typed non-success for an exceeded Fee boundary and still prices an uncrossed boundary',
  () =>
    Effect.scoped(
      Effect.gen(function* publicFeeBoundary() {
        const nativeClock = yield* Clock.Clock;
        const context = yield* Layer.build(publicPricingReadHarnessServices);
        yield* Effect.gen(function* scenario() {
          const harness = yield* startPublicPricingReadHarness({ nativeClock });
          const { p1, p2 } = harness.handoffs;
          const requested = yield* requestedInstant(harness);
          const crossedBoundary = text(DateTime.add(requested, { milliseconds: 1 }));
          const uncrossedBoundary = text(DateTime.add(requested, { hours: 1 }));
          // P1: the Fee ends 1 ms after T, so the owner's observation (>= 1 s later) has crossed the next applicability
          // boundary and the owner can no longer prove the set Current as of T. P2: the same Fee ends an hour after T.
          yield* harness.produceCommercialFee({ amount: String(FEE), effectiveTo: crossedBoundary, handoff: p1 });
          yield* harness.produceCommercialFee({ amount: String(FEE), effectiveTo: uncrossedBoundary, handoff: p2 });

          const attemptsBeforeCrossed = harness.wholeAttempts.length;
          const fencesBeforeCrossed = harness.fenceCalls.length;
          const refused = yield* price(harness, {
            lines: [{ handoff: p1, occurrenceId: 'P-crossed' }],
            operationTime: requested,
            subject: 'GUEST',
          });
          // Customer-safe typed non-success: retryable, no result and so no partial publication.
          expect(refused).toEqual(customerNonSuccess('PRICING_INDETERMINATE', ['P-crossed'], true));
          // Bounded: exactly the two attempts, both unverifiable for the Fee owner's own reason, and no owner final fence
          // was ever reached.
          const crossedAttempts = harness.wholeAttempts.slice(attemptsBeforeCrossed);
          expect(crossedAttempts.map(({ kind, reason }) => [kind, reason])).toEqual([
            ['INDETERMINATE_OR_UNVERIFIABLE', UNVERIFIABLE_FEE_SET_REASON],
            ['INDETERMINATE_OR_UNVERIFIABLE', UNVERIFIABLE_FEE_SET_REASON],
          ]);
          expect(retainedFeeSets(crossedAttempts)).toEqual([]);
          expect(harness.fenceCalls).toHaveLength(fencesBeforeCrossed);
          yield* Effect.logInfo(
            `#1242 P-crossed: typed PRICING_INDETERMINATE retryable after ${crossedAttempts.length} attempts, reason ${UNVERIFIABLE_FEE_SET_REASON}, no result`,
          );

          // Control: the uncrossed boundary prices, and the owner reports that boundary unchanged.
          const attemptsBeforeControl = harness.wholeAttempts.length;
          const control = yield* price(harness, {
            lines: [{ handoff: p2, occurrenceId: 'R-uncrossed' }],
            operationTime: requested,
            subject: 'GUEST',
          });
          expect(control).toEqual(customerResolved([['R-uncrossed', BASE_PRICE + FEE]]));
          const [uncrossed] = retainedFeeSets(harness.wholeAttempts.slice(attemptsBeforeControl));
          assert(uncrossed !== undefined);
          expectObservedAfterRequested(uncrossed, requested);
          expect(optionalText(uncrossed.feeSet.nextApplicabilityBoundary)).toBe(uncrossedBoundary);
          expect(DateTime.isLessThan(uncrossed.feeSet.observedAt, DateTime.makeUnsafe(uncrossedBoundary))).toBe(true);
        }).pipe(Effect.provideContext(context));
      }),
    ),
  900_000,
);
