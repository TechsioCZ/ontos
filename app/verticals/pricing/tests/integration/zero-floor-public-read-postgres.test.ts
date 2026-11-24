import { ReadEvidencePersistenceError } from '@app/core-runtime';
import { Cause, Clock, DateTime, Duration, Effect, Exit, Layer, Option, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import {
  publicPricingReadHarnessServices,
  startPublicPricingReadHarness,
} from '../support/public-pricing-read-harness.ts';
import type { HarnessCommittedEvidence, PublicPricingReadHarness } from '../support/public-pricing-read-harness.ts';

// #1277 / ONT-AUD-0055: the ordinary Current ZERO_FLOOR reader must be reached with the owner's exact predicate
// fingerprint through the REGISTERED public Current Pricing Read. Real: the production default floor reader and the
// production Read, Pricing's own native ZERO_FLOOR routines, receipts and head, PostgreSQL. The Price, Discount, Fee,
// Tier, Currency and ZERO_FLOOR approval facts are produced through Pricing's own scoped persistence. Declared
// stand-ins (labelled in public-pricing-read-harness.ts): Market, purchase context, price-group assignment and
// compatibility, Core access gate, Shell-fixture delegated context, Promotion "not installed". The one test-only fault
// is the labelled SQL trigger of `harness.sqlFault`. Independent arithmetic, never copied from an output:
const BASE_PRICE = 100;
const DISCOUNT_POSITIVE = 10;
// A Discount equal to the Price leaves a raw line value of exactly zero: no floor is needed.
const DISCOUNT_TO_ZERO = 100;
// A Discount above the Price leaves a raw line value below zero: only an approved ZERO_FLOOR may lift it to zero.
const DISCOUNT_NEGATIVE = 130;
const RAW_NEGATIVE = BASE_PRICE - DISCOUNT_NEGATIVE;
const REQUESTED_LAG_MS = 2000;
const SETTLE_MS = 50;
const CUSTOMER_PROJECTION = 'CURRENT_PRICING_DECISION_CUSTOMER_V1';
const NATIVE_PREDICATE_PREFIX = 'pricing-zero-floor-current-set:v1:';

type RequestLines = Parameters<PublicPricingReadHarness['makeRequest']>[0]['lines'];
type RequestSubject = NonNullable<Parameters<PublicPricingReadHarness['makeRequest']>[0]['subject']>;
type Handoff = PublicPricingReadHarness['handoffs']['p1'];

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

const requestedInstant = (harness: PublicPricingReadHarness) =>
  Effect.gen(function* requestedInstantProgram() {
    const earliest = DateTime.add(DateTime.makeUnsafe(harness.operationTime), { milliseconds: SETTLE_MS });
    const lagged = DateTime.subtract(yield* DateTime.now, { milliseconds: REQUESTED_LAG_MS });
    if (DateTime.isLessThanOrEqualTo(lagged, earliest)) {
      yield* Effect.sleep(
        Duration.millis(DateTime.toEpochMillis(earliest) - DateTime.toEpochMillis(lagged) + SETTLE_MS),
      );
    }
    return DateTime.subtract(yield* DateTime.now, { milliseconds: REQUESTED_LAG_MS });
  });

const requestFor = (
  harness: PublicPricingReadHarness,
  input: { readonly lines: RequestLines; readonly operationTime: DateTime.Utc; readonly subject: RequestSubject },
) => harness.makeRequest({ ...input, operationTime: DateTime.formatIso(input.operationTime) });

const price = (
  harness: PublicPricingReadHarness,
  input: { readonly lines: RequestLines; readonly operationTime: DateTime.Utc; readonly subject: RequestSubject },
) =>
  Effect.gen(function* priceProgram() {
    return yield* harness.runRegisteredRead(yield* requestFor(harness, input));
  });

const sorted = (values: readonly string[]) => values.toSorted();

/** What the top level of a Read call was, for the log: a response outcome or the Read's own failure. */
const describeTopLevel = (exit: Exit.Exit<{ readonly outcome: string }, unknown>) =>
  Exit.isSuccess(exit) ? `response ${exit.value.outcome}` : `Read failure ${Cause.pretty(exit.cause).slice(0, 300)}`;

const describeAttempts = (attempts: readonly { readonly kind: string }[]) => attempts.map(({ kind }) => kind).join(',');

/** Receipts committed since `before`, so one scenario can run several reads on one harness. */
const newFloorReceipts = (before: HarnessCommittedEvidence, after: HarnessCommittedEvidence) =>
  after.zeroFloorReceipts.slice(before.zeroFloorReceipts.length);

/** The committed receipt is the owner's native fingerprint of the exact query the default reader sent. */
const expectNativeFingerprint = (receipt: HarnessCommittedEvidence['zeroFloorReceipts'][number]) => {
  expect(receipt.queryPredicateRef.startsWith(NATIVE_PREDICATE_PREFIX)).toBe(true);
  // PostgreSQL recomputed the fingerprint over the stored query: the reader sent it, it is not an occurrence label.
  expect(receipt.nativePredicateRef).toBe(receipt.queryPredicateRef);
  expect(receipt.predicateRef).toBe(receipt.queryPredicateRef);
};

const produceNegativeLine = (harness: PublicPricingReadHarness, handoff: Handoff) =>
  harness.produceContractualDiscount({ amount: String(DISCOUNT_NEGATIVE), handoff });

const priceRevisionOf = (harness: PublicPricingReadHarness, handoff: Handoff) => {
  const component = harness.priceComponents.find(
    ({ handoff: candidate }) => candidate.selection.variantRef.resourceId === handoff.selection.variantRef.resourceId,
  );
  assert(component !== undefined);
  return component.priceRevisionId;
};

it.live(
  'accepts the valid EMPTY ZERO_FLOOR authority for a positive and a zero line through the registered public Read',
  () =>
    Effect.scoped(
      Effect.gen(function* publicPositiveAndZero() {
        const nativeClock = yield* Clock.Clock;
        const context = yield* Layer.build(publicPricingReadHarnessServices);
        yield* Effect.gen(function* scenario() {
          const harness = yield* startPublicPricingReadHarness({ nativeClock });
          const { p1, p2 } = harness.handoffs;
          const positiveDiscount = yield* harness.produceContractualDiscount({
            amount: String(DISCOUNT_POSITIVE),
            handoff: p1,
          });
          const zeroDiscount = yield* harness.produceContractualDiscount({
            amount: String(DISCOUNT_TO_ZERO),
            handoff: p2,
          });

          const cases = [
            {
              discountRevision: null,
              expected: BASE_PRICE,
              handoff: p1,
              label: 'positive, no Discount (Guest)',
              subject: 'GUEST',
            },
            {
              discountRevision: positiveDiscount.revisionId,
              expected: BASE_PRICE - DISCOUNT_POSITIVE,
              handoff: p1,
              label: 'positive, Discount 10 (Profile)',
              subject: 'PROFILE',
            },
            {
              discountRevision: zeroDiscount.revisionId,
              expected: BASE_PRICE - DISCOUNT_TO_ZERO,
              handoff: p2,
              label: 'zero, Discount equal to the Price (Profile)',
              subject: 'PROFILE',
            },
          ] as const;
          expect(cases.map(({ expected }) => expected)).toEqual([100, 90, 0]);

          for (const { discountRevision, expected, handoff, label, subject } of cases) {
            const before = yield* harness.committedEvidence();
            const requested = yield* requestedInstant(harness);
            const attemptsBefore = harness.wholeAttempts.length;
            const occurrenceId = `FLOOR-${label}`;
            const result = yield* price(harness, {
              lines: [{ handoff, occurrenceId }],
              operationTime: requested,
              subject,
            });
            // The published price: the customer-safe wire object, nothing partial.
            expect(result).toEqual(customerResolved([[occurrenceId, expected]]));
            const attempts = harness.wholeAttempts.slice(attemptsBefore);
            expect(attempts.map(({ kind }) => kind)).toEqual(['READY_FOR_FINAL_PUBLICATION']);
            // No floor is applied to a raw value that is not negative, so no floor evidence is retained for the fence.
            expect(attempts.flatMap(({ zeroFloorReads }) => zeroFloorReads)).toEqual([]);
            expect(harness.fenceCalls.every(({ failure }) => failure === undefined)).toBe(true);

            // The default floor reader WAS reached: the owner committed exactly one receipt for this read, an EMPTY
            // authority set at the owner's generation, whose fingerprint is the native one.
            const after = yield* harness.committedEvidence();
            const receipts = newFloorReceipts(before, after);
            expect(receipts).toHaveLength(1);
            const [receipt] = receipts;
            assert(receipt !== undefined);
            expectNativeFingerprint(receipt);
            expect(receipt.factCount).toBe(0);
            expect(receipt.generation).toBe(1);
            expect(Option.getOrUndefined(after.zeroFloorHeadGeneration)).toBe(1);
            expect(DateTime.formatIso(receipt.effectiveAt)).toBe(DateTime.formatIso(requested));
            // The query binds the exact material revisions the line was priced from.
            expect(sorted(receipt.materialRevisionRefs)).toEqual(
              sorted([priceRevisionOf(harness, handoff), ...(discountRevision === null ? [] : [discountRevision])]),
            );
            expect(after.coreReadEvents.length).toBeGreaterThan(before.coreReadEvents.length);
            yield* Effect.logInfo(
              `#1277 ${label}: published ${expected} CZK; floor receipt predicate ${receipt.predicateRef}, generation ${receipt.generation}, authorizations ${receipt.factCount}`,
            );
          }
        }).pipe(Effect.provideContext(context));
      }),
    ),
  900_000,
);

it.live(
  'requires the exact valid approval for a negative line and publishes the floored amount only with it',
  () =>
    Effect.scoped(
      Effect.gen(function* publicNegativeApproval() {
        const nativeClock = yield* Clock.Clock;
        const context = yield* Layer.build(publicPricingReadHarnessServices);
        yield* Effect.gen(function* scenario() {
          const harness = yield* startPublicPricingReadHarness({ nativeClock });
          const { p1, p2 } = harness.handoffs;
          const negative = yield* produceNegativeLine(harness, p1);
          const tight = yield* produceNegativeLine(harness, p2);
          const exactRefs = [priceRevisionOf(harness, p1), negative.revisionId];

          const readNegative = Effect.fn('test.readNegative')(function* readNegative(
            handoff: Handoff,
            occurrenceId: string,
          ) {
            const requested = yield* requestedInstant(harness);
            const attemptsBefore = harness.wholeAttempts.length;
            const result = yield* price(harness, {
              lines: [{ handoff, occurrenceId }],
              operationTime: requested,
              subject: 'PROFILE',
            });
            return { attempts: harness.wholeAttempts.slice(attemptsBefore), requested, result };
          });
          const expectRefused = (read: Effect.Success<ReturnType<typeof readNegative>>, occurrenceId: string) => {
            // A typed, customer-safe non-success: no result, no partial publication; no attempt reached publication.
            expect(read.result).toEqual(customerNonSuccess('PRICING_INDETERMINATE', [occurrenceId], true));
            expect('result' in read.result).toBe(false);
            expect(read.attempts.some(({ kind }) => kind === 'READY_FOR_FINAL_PUBLICATION')).toBe(false);
          };

          // 1. No approval at all: the proven-empty Current set refuses the negative line.
          const beforeNoApproval = yield* harness.committedEvidence();
          const noApproval = yield* readNegative(p1, 'NEG-no-approval');
          // The refusal comes from the floor: the default reader asked the native owner, which proved an EMPTY set.
          const noApprovalReceipts = newFloorReceipts(beforeNoApproval, yield* harness.committedEvidence());
          expect(noApprovalReceipts.length).toBeGreaterThan(0);
          for (const receipt of noApprovalReceipts) {
            expectNativeFingerprint(receipt);
            expect(receipt.factCount).toBe(0);
          }
          expectRefused(noApproval, 'NEG-no-approval');
          yield* Effect.logInfo(
            `#1277 negative line without approval: typed non-success after ${noApproval.attempts.length} attempt(s): ${noApproval.attempts.map(({ reason }) => reason).join(' | ')}`,
          );

          yield* Effect.logInfo('#1277 step 2');
          // 2. An approval that does not cover the exact material revisions (the Discount revision is missing).
          yield* harness.produceZeroFloorAuthorization({
            authorizationRef: 'TEST:1277:wrong-material',
            handoff: p1,
            materialRevisionRefs: [priceRevisionOf(harness, p1)],
            maximumFloorAdjustment: '50',
            minimumRawAmount: '-50',
            subject: 'PROFILE',
          });
          const wrongMaterial = yield* readNegative(p1, 'NEG-wrong-material');
          expectRefused(wrongMaterial, 'NEG-wrong-material');

          yield* Effect.logInfo('#1277 step 3');
          // 3. An approval whose economic coverage is smaller than the shortfall (on the other Variant).
          yield* harness.produceZeroFloorAuthorization({
            authorizationRef: 'TEST:1277:too-small',
            handoff: p2,
            materialRevisionRefs: [priceRevisionOf(harness, p2), tight.revisionId],
            maximumFloorAdjustment: '10',
            minimumRawAmount: '-10',
            subject: 'PROFILE',
          });
          const tooSmall = yield* readNegative(p2, 'NEG-too-small');
          expectRefused(tooSmall, 'NEG-too-small');

          yield* Effect.logInfo('#1277 step 4');
          // 4. A recorded approval that was never redeemed into a Current Authorization does not authorize either.
          yield* harness.produceZeroFloorAuthorization({
            approvalRevision: 'TEST:1277:approval-only',
            authorizationRef: 'TEST:1277:not-redeemed',
            handoff: p1,
            materialRevisionRefs: exactRefs,
            maximumFloorAdjustment: '50',
            minimumRawAmount: '-50',
            redeem: false,
            subject: 'PROFILE',
          });
          const notRedeemed = yield* readNegative(p1, 'NEG-not-redeemed');
          expectRefused(notRedeemed, 'NEG-not-redeemed');

          yield* Effect.logInfo('#1277 step 5');
          // 5. The exact valid approval, redeemed: the line floors to zero and is published.
          const beforeExact = yield* harness.committedEvidence();
          yield* harness.produceZeroFloorAuthorization({
            authorizationRef: 'TEST:1277:exact',
            handoff: p1,
            materialRevisionRefs: exactRefs,
            maximumFloorAdjustment: '50',
            minimumRawAmount: '-50',
            subject: 'PROFILE',
          });
          const generationAtApproval = Option.getOrUndefined(
            (yield* harness.committedEvidence()).zeroFloorHeadGeneration,
          );
          assert(generationAtApproval !== undefined);
          const exact = yield* readNegative(p1, 'NEG-exact');
          expect(exact.result).toEqual(customerResolved([['NEG-exact', 0]]));
          expect(exact.attempts.map(({ kind }) => kind)).toEqual(['READY_FOR_FINAL_PUBLICATION']);
          const [applied] = exact.attempts.flatMap(({ zeroFloorReads }) => zeroFloorReads);
          assert(applied !== undefined);
          // The retained owner evidence is the exact Authorization, at the generation the head holds, under the native
          // fingerprint, for the exact material revisions.
          expect(applied.authorizationRefs).toEqual(['TEST:1277:exact']);
          expect(applied.generation).toBe(generationAtApproval);
          expect(applied.predicateRef.startsWith(NATIVE_PREDICATE_PREFIX)).toBe(true);
          expect(applied.queryPredicateRef).toBe(applied.predicateRef);
          expect(sorted(applied.materialRevisionRefs)).toEqual(sorted(exactRefs));
          const afterExact = yield* harness.committedEvidence();
          const [floorReceipt] = newFloorReceipts(beforeExact, afterExact).slice(-1);
          assert(floorReceipt !== undefined);
          expectNativeFingerprint(floorReceipt);
          expect(floorReceipt.predicateRef).toBe(applied.predicateRef);
          expect(floorReceipt.generation).toBe(generationAtApproval);
          expect(floorReceipt.factCount).toBe(1);
          yield* Effect.logInfo(
            `#1277 negative line ${RAW_NEGATIVE} CZK with the exact approval: published 0; floor predicate ${applied.predicateRef}, generation ${applied.generation}`,
          );
        }).pipe(Effect.provideContext(context));
      }),
    ),
  900_000,
);

it.live(
  'does not publish success when the floor generation or predicate changes between the read and the owner fence',
  () =>
    Effect.scoped(
      Effect.gen(function* publicFloorChanged() {
        const nativeClock = yield* Clock.Clock;
        const context = yield* Layer.build(publicPricingReadHarnessServices);
        yield* Effect.gen(function* scenario() {
          const harness = yield* startPublicPricingReadHarness({ nativeClock });
          const { p1 } = harness.handoffs;
          const negative = yield* produceNegativeLine(harness, p1);
          const exactRefs = [priceRevisionOf(harness, p1), negative.revisionId];
          yield* harness.produceZeroFloorAuthorization({
            authorizationRef: 'TEST:1277:exact',
            handoff: p1,
            materialRevisionRefs: exactRefs,
            maximumFloorAdjustment: '50',
            minimumRawAmount: '-50',
            subject: 'PROFILE',
          });
          // Each read below reads at a fresh instant, after every produced fact.
          const readOnce = Effect.fn('test.readOnce')(function* readOnce(occurrenceId: string) {
            const requested = yield* requestedInstant(harness);
            const attemptsBefore = harness.wholeAttempts.length;
            const result = yield* price(harness, {
              lines: [{ handoff: p1, occurrenceId }],
              operationTime: requested,
              subject: 'PROFILE',
            });
            return { attempts: harness.wholeAttempts.slice(attemptsBefore), result };
          });
          const advanceGeneration = (revision: string) =>
            harness.produceZeroFloorAuthorization({
              approvalRevision: revision,
              authorizationRef: 'TEST:1277:exact',
              handoff: p1,
              materialRevisionRefs: exactRefs,
              maximumFloorAdjustment: '50',
              minimumRawAmount: '-50',
              redeem: false,
              subject: 'PROFILE',
            });

          // A. The generation advances ONCE after attempt 1 read the set: the fence refuses attempt 1, the bounded
          // fresh retry reads the new generation and publishes; exactly two attempts, never a success on stale evidence.
          yield* harness.afterWholeAttempt((ordinal) =>
            ordinal === 1 ? advanceGeneration('TEST:1277:approval:once') : Effect.void,
          );
          const once = yield* readOnce('GEN-once');
          expect(once.result).toEqual(customerResolved([['GEN-once', 0]]));
          expect(once.attempts.map(({ kind }) => kind)).toEqual([
            'READY_FOR_FINAL_PUBLICATION',
            'READY_FOR_FINAL_PUBLICATION',
          ]);
          const onceReads = once.attempts.flatMap(({ zeroFloorReads }) => zeroFloorReads);
          expect(onceReads).toHaveLength(2);
          const [firstRead, retryRead] = onceReads;
          assert(firstRead !== undefined && retryRead !== undefined);
          expect(retryRead.generation).toBeGreaterThan(firstRead.generation);
          // The predicate is the same exact query: only the generation moved.
          expect(retryRead.predicateRef).toBe(firstRead.predicateRef);

          // B. The generation advances after EVERY attempt: the bound (two attempts) is exhausted, the customer gets
          // the typed retryable non-success without a result, and nothing is published.
          yield* harness.afterWholeAttempt((ordinal) => advanceGeneration(`TEST:1277:approval:always:${ordinal}`));
          const always = yield* readOnce('GEN-always');
          expect(always.result).toEqual(customerNonSuccess('PRICING_INDETERMINATE', ['GEN-always'], true));
          expect(always.attempts.map(({ kind }) => kind)).toEqual([
            'READY_FOR_FINAL_PUBLICATION',
            'READY_FOR_FINAL_PUBLICATION',
          ]);

          // The persisted state is intact: once the interference stops a fresh read publishes again.
          yield* harness.clearAfterWholeAttempt();
          const settled = yield* readOnce('GEN-settled');
          expect(settled.result).toEqual(customerResolved([['GEN-settled', 0]]));

          // C. The PREDICATE changes between read and fence: a Commercial Fee (a new material revision of the line)
          // appears after attempt 1. The retry asks the owner a DIFFERENT predicate that the approval does not cover,
          // so the line is not floored and no success is published.
          const beforePredicate = yield* harness.committedEvidence();
          yield* harness.afterWholeAttempt((ordinal) =>
            ordinal === 1 ? harness.produceCommercialFee({ amount: '3', handoff: p1 }) : Effect.void,
          );
          const changed = yield* readOnce('PRED-changed');
          expect(changed.result).toEqual(customerNonSuccess('PRICING_INDETERMINATE', ['PRED-changed'], true));
          expect('result' in changed.result).toBe(false);
          expect(changed.attempts.some(({ outcome }) => outcome === 'READY_FOR_FINAL_PUBLICATION')).toBe(false);
          expect(changed.attempts.length).toBe(2);
          yield* harness.clearAfterWholeAttempt();
          const afterPredicate = yield* harness.committedEvidence();
          const predicates = newFloorReceipts(beforePredicate, afterPredicate).map(({ predicateRef }) => predicateRef);
          // The two attempts asked two different native predicates (the second includes the Fee revision).
          expect(new Set(predicates).size).toBe(2);
          yield* Effect.logInfo(
            `#1277 changed predicate: ${changed.attempts.length} attempts, typed non-success, floor predicates asked: ${predicates.join(', ')}`,
          );
        }).pipe(Effect.provideContext(context));
      }),
    ),
  900_000,
);

it.live(
  'publishes nothing and commits no evidence when the native ZERO_FLOOR routine fails in SQL, and recovers once cleared',
  () =>
    Effect.scoped(
      Effect.gen(function* publicSqlFailure() {
        const nativeClock = yield* Clock.Clock;
        const context = yield* Layer.build(publicPricingReadHarnessServices);
        yield* Effect.gen(function* scenario() {
          const harness = yield* startPublicPricingReadHarness({ nativeClock });
          const { p1, p2 } = harness.handoffs;
          yield* harness.produceContractualDiscount({ amount: String(DISCOUNT_POSITIVE), handoff: p1 });
          const negative = yield* produceNegativeLine(harness, p2);

          const attemptRead = Effect.fn('test.attemptRead')(function* attemptRead(
            handoff: Handoff,
            occurrenceId: string,
          ) {
            const requested = yield* requestedInstant(harness);
            const attemptsBefore = harness.wholeAttempts.length;
            const exit = yield* harness.runRegisteredReadExit(
              yield* requestFor(harness, {
                lines: [{ handoff, occurrenceId }],
                operationTime: requested,
                subject: 'PROFILE',
              }),
            );
            return { attempts: harness.wholeAttempts.slice(attemptsBefore), exit };
          });
          /**
           * The REAL top-level result of a SQL abort inside the native routine: the Read itself FAILS with Core's
           * evidence-persistence error (the aborted transaction cannot persist the read evidence). It is not a customer
           * response, so no price and no `result` exists, and the owner evaluation never reached publication.
           */
          const expectReadFailedWithoutResult = (read: Effect.Success<ReturnType<typeof attemptRead>>) => {
            assert(Exit.isFailure(read.exit));
            const failure = Cause.findErrorOption(read.exit.cause);
            assert(Option.isSome(failure));
            expect(Schema.is(ReadEvidencePersistenceError)(failure.value)).toBe(true);
            expect(read.attempts.some(({ kind }) => kind === 'READY_FOR_FINAL_PUBLICATION')).toBe(false);
          };

          expect(yield* harness.sqlFault.installed()).toBe(false);
          const baseline = yield* harness.committedEvidence();
          expect(baseline.zeroFloorReceipts).toEqual([]);
          expect(Option.isNone(baseline.zeroFloorHeadGeneration)).toBe(true);

          // POSITIVE line, SQL abort inside the native routine's receipt write.
          yield* harness.sqlFault.failZeroFloorProofReceiptWrite();
          expect(yield* harness.sqlFault.installed()).toBe(true);
          const failedPositive = yield* attemptRead(p1, 'SQL-positive');
          expectReadFailedWithoutResult(failedPositive);
          yield* Effect.logInfo(
            `#1277 SQL failure, positive line: top-level ${describeTopLevel(failedPositive.exit)}; attempts ${describeAttempts(failedPositive.attempts)}`,
          );
          yield* Effect.logInfo(
            `#1277 new Core events after the failed read: ${(yield* harness.committedEvidence()).coreReadEvents
              .slice(baseline.coreReadEvents.length)
              .map(({ outcome, outcomeCode }) => `${outcome}/${outcomeCode}`)
              .join(' ; ')}`,
          );
          const afterPositive = yield* harness.committedEvidence();
          // No partial publication: nothing of the failed read is committed, not even the lazily initialised head.
          expect({ ...afterPositive, coreReadEvents: [] }).toEqual({ ...baseline, coreReadEvents: [] });
          // The only Core evidence is the access ALLOW decision recorded before the handler ran, never a result.
          expect(afterPositive.coreReadEvents.slice(baseline.coreReadEvents.length)).toEqual([
            { outcome: 'allowed', outcomeCode: 'read_allowed' },
          ]);

          // NEGATIVE line with the exact approval: the same SQL abort, with the approval already committed.
          yield* harness.sqlFault.clear();
          yield* harness.produceZeroFloorAuthorization({
            authorizationRef: 'TEST:1277:exact',
            handoff: p2,
            materialRevisionRefs: [priceRevisionOf(harness, p2), negative.revisionId],
            maximumFloorAdjustment: '50',
            minimumRawAmount: '-50',
            subject: 'PROFILE',
          });
          const approved = yield* harness.committedEvidence();
          yield* harness.sqlFault.failZeroFloorProofReceiptWrite();
          const failedNegative = yield* attemptRead(p2, 'SQL-negative');
          expectReadFailedWithoutResult(failedNegative);
          yield* Effect.logInfo(
            `#1277 SQL failure, negative line: top-level ${describeTopLevel(failedNegative.exit)}; attempts ${describeAttempts(failedNegative.attempts)}`,
          );
          const afterNegative = yield* harness.committedEvidence();
          expect({ ...afterNegative, coreReadEvents: [] }).toEqual({ ...approved, coreReadEvents: [] });
          expect(afterNegative.coreReadEvents.slice(approved.coreReadEvents.length)).toEqual([
            { outcome: 'allowed', outcomeCode: 'read_allowed' },
          ]);

          // The fault is removed (observed in the catalog) and fresh reads succeed with the committed evidence.
          yield* harness.sqlFault.clear();
          expect(yield* harness.sqlFault.installed()).toBe(false);
          const recoveredNegative = yield* price(harness, {
            lines: [{ handoff: p2, occurrenceId: 'SQL-recovered-negative' }],
            operationTime: yield* requestedInstant(harness),
            subject: 'PROFILE',
          });
          expect(recoveredNegative).toEqual(customerResolved([['SQL-recovered-negative', 0]]));
          const recoveredPositive = yield* price(harness, {
            lines: [{ handoff: p1, occurrenceId: 'SQL-recovered-positive' }],
            operationTime: yield* requestedInstant(harness),
            subject: 'PROFILE',
          });
          expect(recoveredPositive).toEqual(
            customerResolved([['SQL-recovered-positive', BASE_PRICE - DISCOUNT_POSITIVE]]),
          );
          const recovered = yield* harness.committedEvidence();
          // Each recovered read committed its owner receipt(s) (the owner fence re-reads the set), all native.
          expect(recovered.zeroFloorReceipts.length).toBeGreaterThanOrEqual(approved.zeroFloorReceipts.length + 2);
          for (const receipt of newFloorReceipts(approved, recovered)) {
            expectNativeFingerprint(receipt);
          }
        }).pipe(Effect.provideContext(context));
      }),
    ),
  900_000,
);
