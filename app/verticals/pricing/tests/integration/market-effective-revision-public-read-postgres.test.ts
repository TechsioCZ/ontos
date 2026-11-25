import type { CurrentPricingDecisionResponseSchema } from '@app/pricing-contracts';
import { Clock, DateTime, Duration, Effect, Layer, Option } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import { declaredMarketFactRevisionRef } from '../support/declared-market-timeline.ts';
import type { DeclaredMarketRevision } from '../support/declared-market-timeline.ts';
import {
  publicPricingReadHarnessServices,
  startPublicPricingReadHarness,
} from '../support/public-pricing-read-harness.ts';
import type { PublicPricingReadHarness } from '../support/public-pricing-read-harness.ts';

// #1250 / ONT-AUD-0028: ONE Market identity is revised (R1 -> cosmetic R2) and Pricing must use R1 before the
// boundary, R2 from it, and must not bring R1 back once R2 ended. Proven through the REGISTERED public Current Pricing
// Read on native PostgreSQL. The Commerce Market owner is the harness's DECLARED, parameterizable stand-in
// (declared-market-timeline.ts), which mirrors the real owner's selection rule; the real owner's own selection is proven
// by the Market owner's native tests and the November-named Pricing test (see execution/issues/1250.md). The
// Catalog, Price, Fee, Discount and Currency facts are the real producers named in public-pricing-read-harness.ts.
// Independent arithmetic, never copied from an output:
const BASE_PRICE = 100;
const FEE = 3;
const DISCOUNT = 10;
// The first Market revision starts long before everything else; R2 starts this long after the harness start.
const R1_STARTS_BEFORE_HARNESS_MS = 3_600_000;
const BOUNDARY_AFTER_HARNESS_MS = 3000;
// R2 stays effective this long, then ends (the "R2 ended" scenario).
const R2_LIFETIME_MS = 1500;
// Every requested instant is at least this far in the past when it is read, so the owners observe later.
const REQUESTED_LAG_MS = 2000;
const CUSTOMER_PROJECTION = 'CURRENT_PRICING_DECISION_CUSTOMER_V1';
const FOREIGN_SELLER = '99999999-9999-4999-8999-999999999999';

type PublicRead = typeof CurrentPricingDecisionResponseSchema.Type;
type RequestSubject = NonNullable<Parameters<PublicPricingReadHarness['makeRequest']>[0]['subject']>;
type Handoff = PublicPricingReadHarness['handoffs']['p1'];

const epoch = DateTime.toEpochMillis;
const at = (millis: number) => DateTime.makeUnsafe(millis);
const text = (millis: number) => DateTime.formatIso(at(millis));

/** The exact customer-safe wire shape of a resolved price: nothing beyond the published pre-Tax values. */
const money = (amount: number) => ({ amount: String(amount), currencyCode: 'CZK' });
const customerResolved = (occurrenceId: string, amount: number) => ({
  candidate: { occurrenceIds: [occurrenceId] },
  outcome: 'PRICE_RESOLVED',
  projectionVersion: CUSTOMER_PROJECTION,
  result: {
    currencyCode: 'CZK',
    lines: [{ occurrenceId, publishedPreTaxAmount: money(amount) }],
    monetaryBoundary: 'PRE_TAX',
    total: money(amount),
    totalMethod: 'EXACT_SUM_OF_ROUNDED_LINES',
  },
  retryable: false,
});

/** The exact customer-safe wire shape of a non-success: no result, so no partial publication. */
const customerNonSuccess = (occurrenceId: string) => ({
  candidate: { occurrenceIds: [occurrenceId] },
  outcome: 'PRICING_INDETERMINATE',
  projectionVersion: CUSTOMER_PROJECTION,
  retryable: true,
});

/** One registered public Read of one line as of `instant`, read once the instant is `REQUESTED_LAG_MS` in the past. */
const priceAt = (
  harness: PublicPricingReadHarness,
  input: {
    readonly handoff: Handoff;
    readonly instant: number;
    readonly occurrenceId: string;
    readonly subject: RequestSubject;
  },
) =>
  Effect.gen(function* priceProgram() {
    const wait = input.instant + REQUESTED_LAG_MS - epoch(yield* DateTime.now);
    if (wait > 0) {
      yield* Effect.sleep(Duration.millis(wait));
    }
    const request = yield* harness.makeRequest({
      lines: [{ handoff: input.handoff, occurrenceId: input.occurrenceId }],
      operationTime: text(input.instant),
      subject: input.subject,
    });
    return yield* harness.runRegisteredRead(request);
  });

const resolvedOf = (result: PublicRead) => {
  assert(result.outcome === 'PRICE_RESOLVED');
  return result;
};

/** The Market evidence each attempt retained, as [fact revision, owner generation] pairs, one list per attempt. */
const retainedMarketEvidence = (attempts: PublicPricingReadHarness['wholeAttempts']) =>
  attempts.map(({ marketFacts }) =>
    marketFacts.map(({ factRevisionRef, generation }) => [factRevisionRef, generation]),
  );

const marketFenceCalls = (harness: PublicPricingReadHarness, from: number) =>
  harness.fenceCalls.slice(from).filter(({ owner }) => owner === 'market');

/** The timeline of the harness's Market: R1 starts long before the harness, R2 at the boundary. */
const timelineOf = (harness: PublicPricingReadHarness) => {
  const harnessStart = epoch(DateTime.makeUnsafe(harness.operationTime));
  const boundary = harnessStart + BOUNDARY_AFTER_HARNESS_MS;
  const r1 = (channels: DeclaredMarketRevision['channels'] = ['B2C']): DeclaredMarketRevision => ({
    channels,
    effectiveFrom: at(harnessStart - R1_STARTS_BEFORE_HARNESS_MS),
    effectiveTo: null,
    revision: 1,
  });
  const r2 = (
    options: { readonly channels?: DeclaredMarketRevision['channels']; readonly lifetimeMs?: number } = {},
  ): DeclaredMarketRevision => ({
    channels: options.channels ?? ['B2C'],
    effectiveFrom: at(boundary),
    effectiveTo: options.lifetimeMs === undefined ? null : at(boundary + options.lifetimeMs),
    revision: 2,
  });
  return { boundary, harnessStart, r1, r2 };
};

/** What one successful read retained as its Market evidence: exactly one fact, of the expected revision. */
const expectMarketRevision = (
  harness: PublicPricingReadHarness,
  attemptsBefore: number,
  expected: { readonly effectiveFrom: number; readonly effectiveTo: number | null; readonly revision: number },
) => {
  const attempts = harness.wholeAttempts.slice(attemptsBefore);
  expect(attempts.map(({ kind }) => kind)).toEqual(['READY_FOR_FINAL_PUBLICATION']);
  const facts = attempts.flatMap(({ marketFacts }) => marketFacts);
  expect(facts).toHaveLength(1);
  const [fact] = facts;
  assert(fact !== undefined);
  expect(fact.factRef).toBe(harness.marketScope.marketId);
  expect(fact.factRevisionRef).toBe(declaredMarketFactRevisionRef(expected.revision));
  expect(text(epoch(fact.effectiveFrom))).toBe(text(expected.effectiveFrom));
  expect(Option.match(fact.effectiveTo, { onNone: () => null, onSome: (end) => DateTime.formatIso(end) })).toBe(
    expected.effectiveTo === null ? null : text(expected.effectiveTo),
  );
  return fact;
};

/**
 * One read that must fail closed: the typed customer-safe non-success, no result, exactly the two bounded attempts, each
 * asking the Market owner once, and no owner final fence reached. Returns the attempt reasons.
 */
const expectClosedRead = (
  harness: PublicPricingReadHarness,
  input: { readonly handoff: Handoff; readonly instant: number; readonly occurrenceId: string },
) =>
  Effect.gen(function* closedRead() {
    const attemptsBefore = harness.wholeAttempts.length;
    const fencesBefore = harness.fenceCalls.length;
    const requestsBefore = harness.marketRequests.length;
    const result = yield* priceAt(harness, { ...input, subject: 'GUEST' });
    expect(result).toEqual(customerNonSuccess(input.occurrenceId));
    const attempts = harness.wholeAttempts.slice(attemptsBefore);
    expect(attempts.map(({ kind }) => kind)).toEqual([
      'INDETERMINATE_OR_UNVERIFIABLE',
      'INDETERMINATE_OR_UNVERIFIABLE',
    ]);
    expect(attempts.flatMap(({ marketFacts }) => marketFacts)).toEqual([]);
    expect(harness.marketRequests.length - requestsBefore).toBe(2);
    expect(harness.fenceCalls).toHaveLength(fencesBefore);
    return attempts.map(({ reason }) => reason);
  });

it.live(
  'uses R1 before the boundary and R2 from it for one Market identity, with the revision in the published evidence',
  () =>
    Effect.scoped(
      Effect.gen(function* publicMarketRevisionBoundary() {
        const nativeClock = yield* Clock.Clock;
        const context = yield* Layer.build(publicPricingReadHarnessServices);
        yield* Effect.gen(function* scenario() {
          const harness = yield* startPublicPricingReadHarness({ nativeClock });
          const { p1 } = harness.handoffs;
          yield* harness.produceCommercialFee({ amount: String(FEE), handoff: p1 });
          yield* harness.produceContractualDiscount({ amount: String(DISCOUNT), handoff: p1 });
          const { boundary, harnessStart, r1, r2 } = timelineOf(harness);
          // R1 is published, then the cosmetic R2 of the SAME identity: two owner writes, two generations.
          yield* harness.market.declare({ revisions: [r1()] });
          yield* harness.market.declare({ revisions: [r1(), r2()] });
          expect(harness.market.generation()).toBe(2);
          const r1Start = harnessStart - R1_STARTS_BEFORE_HARNESS_MS;

          const profilePrice = BASE_PRICE - DISCOUNT + FEE;
          const cases = [
            { instant: boundary - 1, label: '1 ms before the boundary', revision: 1, start: r1Start },
            { instant: boundary, label: 'exactly at the boundary', revision: 2, start: boundary },
            { instant: boundary + 1000, label: '1 s after the boundary', revision: 2, start: boundary },
          ] as const;
          for (const { instant, label, revision, start } of cases) {
            const attemptsBefore = harness.wholeAttempts.length;
            const fencesBefore = harness.fenceCalls.length;
            const answersBefore = harness.market.answers.length;
            const requestsBefore = harness.marketRequests.length;
            const occurrenceId = `P-${label}`;
            const result = yield* priceAt(harness, { handoff: p1, instant, occurrenceId, subject: 'PROFILE' });
            // Customer-safe: the exact published shape, a Profile's Fee 3 and Discount 10 included, no Market detail.
            expect(result).toEqual(customerResolved(occurrenceId, profilePrice));
            expect(resolvedOf(result).result.total.amount).toBe(String(profilePrice));
            const fact = expectMarketRevision(harness, attemptsBefore, {
              effectiveFrom: start,
              effectiveTo: null,
              revision,
            });
            // The Read handed the owner exactly the requested instant, and the owner selected that revision.
            const requests = harness.marketRequests.slice(requestsBefore);
            expect(requests.every(({ effectiveAt }) => epoch(effectiveAt) === instant)).toBe(true);
            const answers = harness.market.answers.slice(answersBefore);
            expect(answers.map(({ outcome }) => outcome)).toEqual(
              Array.from({ length: answers.length }, () => 'PRICING_MARKET_SOURCE_PRESENT'),
            );
            expect(answers.map((answer) => [answer.revision, epoch(answer.effectiveAt)])).toEqual(
              Array.from({ length: answers.length }, () => [revision, instant]),
            );
            // Evidence of the owner final fence: the Market was verified and confirmed against the very same revision.
            const fences = marketFenceCalls(harness, fencesBefore);
            expect(fences.map(({ operation }) => operation).toSorted()).toEqual(['confirm', 'verify']);
            expect(fences.every(({ failure }) => failure === undefined)).toBe(true);
            yield* Effect.logInfo(
              `#1250 ${label}: requested ${text(instant)}, owner selected R${revision} (${fact.factRevisionRef}, generation ${fact.generation}), line and whole total ${profilePrice} CZK`,
            );
          }

          // A cosmetic revision changes no price: the same purchase as a Guest (no Discount audience) is 103 at the boundary.
          const guest = yield* priceAt(harness, {
            handoff: p1,
            instant: boundary,
            occurrenceId: 'P-guest-boundary',
            subject: 'GUEST',
          });
          expect(guest).toEqual(customerResolved('P-guest-boundary', BASE_PRICE + FEE));
        }).pipe(Effect.provideContext(context));
      }),
    ),
  900_000,
);

it.live(
  'does not restore R1 after R2 ended and fails closed on a lifecycle conflict, a closed channel and a foreign identity',
  () =>
    Effect.scoped(
      Effect.gen(function* publicMarketRevisionEnded() {
        const nativeClock = yield* Clock.Clock;
        const context = yield* Layer.build(publicPricingReadHarnessServices);
        yield* Effect.gen(function* scenario() {
          const harness = yield* startPublicPricingReadHarness({ nativeClock });
          const { p1 } = harness.handoffs;
          yield* harness.produceCommercialFee({ amount: String(FEE), handoff: p1 });
          const { boundary, harnessStart, r1, r2 } = timelineOf(harness);
          const price = BASE_PRICE + FEE;
          const closed = (occurrenceId: string, instant: number) =>
            expectClosedRead(harness, { handoff: p1, instant, occurrenceId });

          // R2 ends 1.5 s after the boundary while R1 stays open and immutable: the Market has NO Current definition.
          yield* harness.market.declare({ revisions: [r1()] });
          yield* harness.market.declare({ revisions: [r1(), r2({ lifetimeMs: R2_LIFETIME_MS })] });
          const end = boundary + R2_LIFETIME_MS;
          const lastR2 = harness.wholeAttempts.length;
          const insideR2 = yield* priceAt(harness, {
            handoff: p1,
            instant: end - 1,
            occurrenceId: 'P-last-ms-of-r2',
            subject: 'GUEST',
          });
          expect(insideR2).toEqual(customerResolved('P-last-ms-of-r2', price));
          expectMarketRevision(harness, lastR2, { effectiveFrom: boundary, effectiveTo: end, revision: 2 });
          const answersBeforeEnd = harness.market.answers.length;
          const endedReasons = [yield* closed('P-r2-ended', end), yield* closed('P-after-r2-ended', end + 500)];
          // The owner itself answered MISSING (never PRESENT with R1) for both instants, replays included.
          expect(
            harness.market.answers.slice(answersBeforeEnd).map(({ outcome, revision }) => [outcome, revision]),
          ).toEqual(Array.from({ length: 4 }, () => ['PRICING_MARKET_SOURCE_MISSING', null]));
          // Control: R1 itself was selected before R2 and is untouched, so the same Read at 1 ms before the boundary prices.
          const beforeR2 = harness.wholeAttempts.length;
          const r1Read = yield* priceAt(harness, {
            handoff: p1,
            instant: boundary - 1,
            occurrenceId: 'P-r1-control',
            subject: 'GUEST',
          });
          expect(r1Read).toEqual(customerResolved('P-r1-control', price));
          expectMarketRevision(harness, beforeR2, {
            effectiveFrom: harnessStart - R1_STARTS_BEFORE_HARNESS_MS,
            effectiveTo: null,
            revision: 1,
          });
          yield* Effect.logInfo(
            `#1250 R2 ended at ${text(end)}: typed non-success, attempt reasons ${endedReasons.flat().join(' | ')}`,
          );

          // Real conflicts and scope/identity failures fail closed, whatever the revision.
          // (a) Two Current lifecycle facts for the same Market: the owner's CONFLICT.
          yield* harness.market.declare({
            lifecycles: [
              {
                effectiveFrom: at(harnessStart - R1_STARTS_BEFORE_HARNESS_MS),
                effectiveTo: null,
                lifecycle: 'ACTIVE',
              },
              {
                effectiveFrom: at(harnessStart - R1_STARTS_BEFORE_HARNESS_MS),
                effectiveTo: null,
                lifecycle: 'ACTIVE',
              },
            ],
            revisions: [r1(), r2()],
          });
          const answersBeforeConflict = harness.market.answers.length;
          yield* closed('P-lifecycle-conflict', boundary);
          expect(harness.market.answers.slice(answersBeforeConflict).map(({ outcome }) => outcome)).toContain(
            'PRICING_MARKET_SOURCE_CONFLICT',
          );
          // (b) R2 no longer offers the requested channel: the owner's ABSENT, while R1 still offered it.
          yield* harness.market.declare({ revisions: [r1(), r2({ channels: ['B2B'] })] });
          const answersBeforeChannel = harness.market.answers.length;
          yield* closed('P-channel-closed', boundary);
          expect(harness.market.answers.slice(answersBeforeChannel).map(({ outcome }) => outcome)).toContain(
            'PRICING_MARKET_SOURCE_ABSENT',
          );
          // (c) The Market belongs to ANOTHER Selling Legal Entity: the owner's ABSENT for this seller.
          yield* harness.market.declare({ revisions: [r1(), r2()], sellingLegalEntityId: FOREIGN_SELLER });
          const answersBeforeSeller = harness.market.answers.length;
          yield* closed('P-foreign-seller', boundary);
          expect(harness.market.answers.slice(answersBeforeSeller).map(({ outcome }) => outcome)).toContain(
            'PRICING_MARKET_SOURCE_ABSENT',
          );
          // (d) The owner answers PRESENT for ANOTHER Market identity: the published contract refuses the body.
          yield* harness.market.declare({ revisions: [r1(), r2()] });
          yield* harness.market.answerForeignMarket(true);
          yield* closed('P-foreign-market', boundary);
          yield* harness.market.answerForeignMarket(false);
          // The owner is intact once the interference stops: a fresh read prices R2 again.
          const attemptsBeforeFresh = harness.wholeAttempts.length;
          const settled = yield* priceAt(harness, {
            handoff: p1,
            instant: boundary,
            occurrenceId: 'P-settled',
            subject: 'GUEST',
          });
          expect(settled).toEqual(customerResolved('P-settled', price));
          expectMarketRevision(harness, attemptsBeforeFresh, {
            effectiveFrom: boundary,
            effectiveTo: null,
            revision: 2,
          });
        }).pipe(Effect.provideContext(context));
      }),
    ),
  900_000,
);

it.live(
  'retries an owner rejection at most once: a revision published between read and fence, a refused read, a changing generation',
  () =>
    Effect.scoped(
      Effect.gen(function* publicMarketRevisionRetry() {
        const nativeClock = yield* Clock.Clock;
        const context = yield* Layer.build(publicPricingReadHarnessServices);
        yield* Effect.gen(function* scenario() {
          const harness = yield* startPublicPricingReadHarness({ nativeClock });
          const { p1 } = harness.handoffs;
          yield* harness.produceCommercialFee({ amount: String(FEE), handoff: p1 });
          const { boundary, r1, r2 } = timelineOf(harness);
          const price = BASE_PRICE + FEE;
          yield* harness.market.declare({ revisions: [r1()] });

          // 1. The cosmetic R2 (effective from the boundary) is PUBLISHED after attempt 1 read the Market as of the
          // boundary and before the owner final fence: the fence refuses attempt 1's R1 evidence, and the single bounded
          // fresh retry prices on R2.
          yield* harness.afterWholeAttempt((ordinal) =>
            ordinal === 1 ? harness.market.declare({ revisions: [r1(), r2()] }) : Effect.void,
          );
          const attemptsBeforeOnce = harness.wholeAttempts.length;
          const fencesBeforeOnce = harness.fenceCalls.length;
          const retried = yield* priceAt(harness, {
            handoff: p1,
            instant: boundary,
            occurrenceId: 'P-r2-published-between',
            subject: 'GUEST',
          });
          expect(retried).toEqual(customerResolved('P-r2-published-between', price));
          const onceAttempts = harness.wholeAttempts.slice(attemptsBeforeOnce);
          expect(onceAttempts.map(({ kind }) => kind)).toEqual([
            'READY_FOR_FINAL_PUBLICATION',
            'READY_FOR_FINAL_PUBLICATION',
          ]);
          // Attempt 1 retained R1 (generation 1); the retry retained R2 (generation 2), the revision actually used.
          expect(
            onceAttempts.map(({ marketFacts }) =>
              marketFacts.map(({ factRevisionRef, generation }) => [factRevisionRef, generation]),
            ),
          ).toEqual([[[declaredMarketFactRevisionRef(1), 1]], [[declaredMarketFactRevisionRef(2), 2]]]);
          // The owner rejected the retained R1 receipt at its final fence (CHANGED) and the typed failure is observable.
          const onceFences = marketFenceCalls(harness, fencesBeforeOnce);
          expect(onceFences.some(({ failure }) => failure !== undefined)).toBe(true);
          expect(harness.market.answers.map(({ outcome }) => outcome)).toContain('PRICING_MARKET_SOURCE_CHANGED');
          yield* Effect.logInfo(
            `#1250 R2 published between read and fence: 2 attempts, evidence ${retainedMarketEvidence(onceAttempts)
              .flat()
              .map(([revision, generation]) => `${revision}@g${generation}`)
              .join(' then ')}, total ${price} CZK`,
          );
          yield* harness.clearAfterWholeAttempt();

          // 2. The owner refuses the FIRST read only: attempt 1 is unverifiable, the single retry resolves on R1/R2 as of T.
          yield* harness.market.refuse(1);
          const attemptsBeforeRefused = harness.wholeAttempts.length;
          const refusedOnce = yield* priceAt(harness, {
            handoff: p1,
            instant: boundary - 1,
            occurrenceId: 'P-refused-once',
            subject: 'GUEST',
          });
          expect(refusedOnce).toEqual(customerResolved('P-refused-once', price));
          const refusedAttempts = harness.wholeAttempts.slice(attemptsBeforeRefused);
          expect(refusedAttempts.map(({ kind }) => kind)).toEqual([
            'INDETERMINATE_OR_UNVERIFIABLE',
            'READY_FOR_FINAL_PUBLICATION',
          ]);
          expect(
            refusedAttempts.flatMap(({ marketFacts }) => marketFacts.map(({ factRevisionRef }) => factRevisionRef)),
          ).toEqual([declaredMarketFactRevisionRef(1)]);

          // 3. The owner refuses EVERY read: exactly two attempts, a typed retryable PRICING_INDETERMINATE, no result.
          yield* harness.market.refuse(Number.POSITIVE_INFINITY);
          const attemptsBeforeAlways = harness.wholeAttempts.length;
          const requestsBeforeAlways = harness.marketRequests.length;
          const refusedAlways = yield* priceAt(harness, {
            handoff: p1,
            instant: boundary,
            occurrenceId: 'P-refused-always',
            subject: 'GUEST',
          });
          expect(refusedAlways).toEqual(customerNonSuccess('P-refused-always'));
          const alwaysAttempts = harness.wholeAttempts.slice(attemptsBeforeAlways);
          expect(alwaysAttempts.map(({ kind }) => kind)).toEqual([
            'INDETERMINATE_OR_UNVERIFIABLE',
            'INDETERMINATE_OR_UNVERIFIABLE',
          ]);
          expect(harness.marketRequests.length - requestsBeforeAlways).toBe(2);
          yield* harness.market.refuse(0);

          // 4. The owner's generation changes on EVERY attempt: exactly two attempts, a typed retryable non-success.
          yield* harness.afterWholeAttempt(() => harness.market.republish());
          const attemptsBeforeChanging = harness.wholeAttempts.length;
          const changing = yield* priceAt(harness, {
            handoff: p1,
            instant: boundary,
            occurrenceId: 'P-generation-changing',
            subject: 'GUEST',
          });
          expect(changing).toEqual(customerNonSuccess('P-generation-changing'));
          const changingAttempts = harness.wholeAttempts.slice(attemptsBeforeChanging);
          expect(changingAttempts.map(({ kind }) => kind)).toEqual([
            'READY_FOR_FINAL_PUBLICATION',
            'READY_FOR_FINAL_PUBLICATION',
          ]);
          expect(
            changingAttempts.flatMap(({ marketFacts }) => marketFacts).map(({ generation }) => generation),
          ).toHaveLength(2);
          yield* harness.clearAfterWholeAttempt();

          // The persisted Market truth is intact: once the interference stops, a fresh read prices R2 at the boundary.
          const attemptsBeforeSettled = harness.wholeAttempts.length;
          const settled = yield* priceAt(harness, {
            handoff: p1,
            instant: boundary,
            occurrenceId: 'P-settled-after-retries',
            subject: 'GUEST',
          });
          expect(settled).toEqual(customerResolved('P-settled-after-retries', price));
          expectMarketRevision(harness, attemptsBeforeSettled, {
            effectiveFrom: boundary,
            effectiveTo: null,
            revision: 2,
          });
        }).pipe(Effect.provideContext(context));
      }),
    ),
  900_000,
);
