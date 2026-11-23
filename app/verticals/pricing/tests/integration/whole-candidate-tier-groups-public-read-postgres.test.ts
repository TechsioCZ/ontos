import type { CurrentPricingDecisionResponseSchema } from '@app/pricing-contracts';
import { Clock, DateTime, Effect, Layer } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import {
  publicPricingReadHarnessServices,
  startPublicPricingReadHarness,
} from '../support/public-pricing-read-harness.ts';
import type { HarnessFenceObservation, PublicPricingReadHarness } from '../support/public-pricing-read-harness.ts';

// #1225 / ONT-AUD-0001: whole-candidate completeness is separate from per-Tier equivalence groups, proved through the
// REGISTERED public Current Pricing Read (not the test-local component Read of whole-candidate-tier-groups-postgres).
// The Catalog facts are real Catalog-issued handoffs; Price, Tier, Fee and Discount are produced through Pricing's own
// scoped persistence; Market, purchase context, price-group assignment and Price Group Catalog compatibility are the
// harness's labelled published-contract stand-ins. Independent arithmetic (never copied from an output):
const BASE_PRICE = 100;
// Tier threshold 2 with resulting unit price 75.
const TIER_PRICE = 75;
// One FIXED_PER_LINE recycling Fee per Variant line.
const FEE = 3;
// One fixed Price Group Discount on a Variant line.
const DISCOUNT = 10;
const STALE_CATALOG_REASON = 'Tier input lacks exact Price or normalized Quantity evidence';
const OLD_RULE_REASON = 'Unit Price could not bind exact Price, Quantity, and Tier evidence';

type PublicRead = typeof CurrentPricingDecisionResponseSchema.Type;

const resolved = (result: PublicRead) => {
  assert(result.outcome === 'PRICE_RESOLVED');
  return result;
};

const publishedAmounts = (result: PublicRead) =>
  resolved(result).result.lines.map(({ occurrenceId, publishedPreTaxAmount }) => [
    occurrenceId,
    publishedPreTaxAmount.amount,
  ]);

const catalogMaterialCount = (fences: readonly HarnessFenceObservation[], kind: string): number =>
  fences
    .filter(({ operation, owner }) => owner === 'catalog' && operation === 'verify')
    .flatMap(({ materialKinds }) => materialKinds)
    .filter((materialKind) => materialKind === kind).length;

const catalogEquivalenceGroupSizes = (fences: readonly HarnessFenceObservation[]): readonly number[] =>
  fences
    .filter(({ operation, owner }) => owner === 'catalog' && operation === 'verify')
    .flatMap(({ equivalenceGroupSizes }) => equivalenceGroupSizes)
    .toSorted((left, right) => left - right);

const pricePurchase = (
  harness: PublicPricingReadHarness,
  lines: Parameters<PublicPricingReadHarness['makeRequest']>[0]['lines'],
  subject: NonNullable<Parameters<PublicPricingReadHarness['makeRequest']>[0]['subject']>,
) =>
  Effect.gen(function* pricePurchaseProgram() {
    const operationTime = DateTime.formatIso(yield* DateTime.now);
    const request = yield* harness.makeRequest({ lines, operationTime, subject });
    return yield* harness.runRegisteredRead(request);
  });

const priceProfilePurchase = (
  harness: PublicPricingReadHarness,
  lines: Parameters<PublicPricingReadHarness['makeRequest']>[0]['lines'],
) => pricePurchase(harness, lines, 'PROFILE');

it.live(
  'prices mixed and Tier-non-equivalent purchases through the registered public Read and refuses a stale Catalog proof',
  () =>
    Effect.scoped(
      Effect.gen(function* publicWholeCandidateTierGroups() {
        const nativeClock = yield* Clock.Clock;
        const context = yield* Layer.build(publicPricingReadHarnessServices);
        yield* Effect.gen(function* scenario() {
          const harness = yield* startPublicPricingReadHarness({ nativeClock });
          const { p1, p2, q1 } = harness.handoffs;
          for (const handoff of [p1, p2, q1]) {
            yield* harness.produceCommercialFee({ amount: String(FEE), handoff });
          }
          // One Discount on Q1 and one on P2: each scenario below contains exactly one discounted occurrence.
          yield* harness.produceContractualDiscount({ amount: String(DISCOUNT), handoff: q1 });
          yield* harness.produceContractualDiscount({ amount: String(DISCOUNT), handoff: p2 });

          // Mixed purchase P+Q+P: P-first and P-second are two equal-valued distinct occurrences of one equivalent
          // group (pooled quantity 2 reaches the Tier); Q-first is a different Product and keeps the base Price.
          const attemptsBeforeMixed = harness.wholeAttempts.length;
          const priceGroupReadsBeforeMixed = harness.priceGroupRequests.length;
          const fencesBeforeMixed = harness.fenceCalls.length;
          const mixed = yield* priceProfilePurchase(harness, [
            { handoff: p1, occurrenceId: 'P-first' },
            { handoff: q1, occurrenceId: 'Q-first' },
            { handoff: p1, occurrenceId: 'P-second' },
          ]);
          const mixedTotal = TIER_PRICE + FEE + (BASE_PRICE - DISCOUNT + FEE) + (TIER_PRICE + FEE);
          expect(mixedTotal).toBe(249);
          expect(mixed).toMatchObject({
            candidate: { occurrenceIds: ['P-first', 'Q-first', 'P-second'] },
            outcome: 'PRICE_RESOLVED',
            result: { currencyCode: 'CZK', total: { amount: String(mixedTotal), currencyCode: 'CZK' } },
            retryable: false,
          });
          expect(publishedAmounts(mixed)).toEqual([
            ['P-first', String(TIER_PRICE + FEE)],
            ['Q-first', String(BASE_PRICE - DISCOUNT + FEE)],
            ['P-second', String(TIER_PRICE + FEE)],
          ]);
          expect(harness.wholeAttempts.slice(attemptsBeforeMixed).map(({ kind }) => kind)).toEqual([
            'READY_FOR_FINAL_PUBLICATION',
          ]);
          const mixedFences = harness.fenceCalls.slice(fencesBeforeMixed);
          expect(mixedFences.every(({ failure }) => failure === undefined)).toBe(true);
          expect(harness.priceGroupRequests.length).toBeGreaterThan(priceGroupReadsBeforeMixed);
          expect(
            harness.priceGroupRequests.every(
              ({ profile }) => profile.resourceId === harness.profileSubject.profileRef.resourceId,
            ),
          ).toBe(true);
          // The Catalog owner was handed one line authority per ORIGINAL occurrence, not one merged line.
          expect(catalogMaterialCount(mixedFences, 'CATALOG_LINE_AUTHORITY')).toBe(3);
          // Whole-candidate completeness asks Catalog per ORIGINAL occurrence (one single-member authority each), never
          // one merged group across the purchase; the pooled P pair is a Tier concern proved by the published amounts.
          expect(catalogEquivalenceGroupSizes(mixedFences)).toEqual([1, 1, 1]);

          // One Product, two Tier-non-equivalent Variants: no pooling, so both keep the base Price; whole total sums.
          const fencesBeforeSameProduct = harness.fenceCalls.length;
          const sameProduct = yield* priceProfilePurchase(harness, [
            { handoff: p1, occurrenceId: 'P-variant-first' },
            { handoff: p2, occurrenceId: 'P-variant-second' },
          ]);
          const sameProductTotal = BASE_PRICE + FEE + (BASE_PRICE - DISCOUNT + FEE);
          expect(sameProductTotal).toBe(196);
          expect(sameProduct).toMatchObject({
            candidate: { occurrenceIds: ['P-variant-first', 'P-variant-second'] },
            outcome: 'PRICE_RESOLVED',
            result: { total: { amount: String(sameProductTotal), currencyCode: 'CZK' } },
          });
          expect(
            catalogMaterialCount(harness.fenceCalls.slice(fencesBeforeSameProduct), 'CATALOG_LINE_AUTHORITY'),
          ).toBe(2);
          // Distinct exact Prices form two single-member Tier groups: no pooling and no two-member equivalence group.
          expect(catalogEquivalenceGroupSizes(harness.fenceCalls.slice(fencesBeforeSameProduct))).toEqual([1, 1]);
          expect(publishedAmounts(sameProduct)).toEqual([
            ['P-variant-first', String(BASE_PRICE + FEE)],
            ['P-variant-second', String(BASE_PRICE - DISCOUNT + FEE)],
          ]);

          // N=1: a single line is the same contract.
          const single = yield* priceProfilePurchase(harness, [{ handoff: p1, occurrenceId: 'P-only' }]);
          expect(single).toMatchObject({
            candidate: { occurrenceIds: ['P-only'] },
            outcome: 'PRICE_RESOLVED',
            result: { total: { amount: String(BASE_PRICE + FEE), currencyCode: 'CZK' } },
          });

          // A superseded Catalog proof is refused: after Catalog revises the Unit rule, the old handoff must not price.
          const ruleRevision = yield* harness.reviseFirstUnitRule();
          expect(ruleRevision).toBeGreaterThan(p1.quantity.unitRuleRevision);
          const fencesBeforeStale = harness.fenceCalls.length;
          const attemptsBeforeStale = harness.wholeAttempts.length;
          const stale = yield* priceProfilePurchase(harness, [
            { handoff: p1, occurrenceId: 'P-first' },
            { handoff: q1, occurrenceId: 'Q-first' },
            { handoff: p1, occurrenceId: 'P-second' },
          ]);
          expect(stale.outcome).toBe('PRICING_INDETERMINATE');
          const staleAttempts = harness.wholeAttempts.slice(attemptsBeforeStale);
          expect(staleAttempts.length).toBeGreaterThan(0);
          expect(staleAttempts.every(({ kind }) => kind === 'INDETERMINATE_OR_UNVERIFIABLE')).toBe(true);
          // Catalog no longer vouches for the superseded handoff, so no line quantity can be bound.
          expect(staleAttempts.map(({ reason }) => reason)).toContain(STALE_CATALOG_REASON);
          expect(harness.fenceCalls).toHaveLength(fencesBeforeStale);

          // Fresh Catalog facts alone do not price while Pricing's Tier is still bound to the superseded rule: Pricing
          // fails closed instead of rebinding the Tier.
          const fresh = {
            p1: yield* harness.prepareFreshHandoff(harness.selections.p1),
            p2: yield* harness.prepareFreshHandoff(harness.selections.p2),
            q1: yield* harness.prepareFreshHandoff(harness.selections.q1),
          };
          expect(fresh.p1.quantity.unitRuleRevision).toBe(ruleRevision);
          const attemptsBeforeUnbound = harness.wholeAttempts.length;
          const unbound = yield* priceProfilePurchase(harness, [{ handoff: fresh.p1, occurrenceId: 'P-fresh' }]);
          expect(unbound.outcome).toBe('PRICING_INDETERMINATE');
          expect(harness.wholeAttempts.slice(attemptsBeforeUnbound).map(({ reason }) => reason)).toContain(
            OLD_RULE_REASON,
          );
          expect(harness.fenceCalls).toHaveLength(fencesBeforeStale);

          // Pricing re-produces each Tier whose Quantity Basis the rule revision superseded (supported owner persistence).
          for (const [previous, current] of [
            [p1, fresh.p1],
            [p2, fresh.p2],
            [q1, fresh.q1],
          ] as const) {
            if (current.quantity.unitRuleRevision !== previous.quantity.unitRuleRevision) {
              yield* harness.reproduceTier({ fresh: current, previous });
            }
          }

          // The same purchases, now with fresh Catalog facts, complete publication with the same occurrences and total.
          const attemptsBeforeFresh = harness.wholeAttempts.length;
          const freshMixed = yield* priceProfilePurchase(harness, [
            { handoff: fresh.p1, occurrenceId: 'P-first' },
            { handoff: fresh.q1, occurrenceId: 'Q-first' },
            { handoff: fresh.p1, occurrenceId: 'P-second' },
          ]);
          expect(freshMixed).toMatchObject({
            candidate: { occurrenceIds: ['P-first', 'Q-first', 'P-second'] },
            outcome: 'PRICE_RESOLVED',
            result: { total: { amount: String(mixedTotal), currencyCode: 'CZK' } },
          });
          expect(harness.wholeAttempts.slice(attemptsBeforeFresh).map(({ kind }) => kind)).toEqual([
            'READY_FOR_FINAL_PUBLICATION',
          ]);
        }).pipe(Effect.provideContext(context));
      }),
    ),
  900_000,
);

// F1: every occurrence of one Variant carries the Price Group Discount, and the Tier pools the whole group.
it.live(
  'applies the Price Group Discount to each occurrence of a Tier-pooled equal-Variant group and only to that audience',
  () =>
    Effect.scoped(
      Effect.gen(function* perOccurrenceDiscount() {
        const nativeClock = yield* Clock.Clock;
        const context = yield* Layer.build(publicPricingReadHarnessServices);
        yield* Effect.gen(function* scenario() {
          const harness = yield* startPublicPricingReadHarness({ nativeClock });
          const { p1 } = harness.handoffs;
          yield* harness.produceCommercialFee({ amount: String(FEE), handoff: p1 });
          yield* harness.produceContractualDiscount({ amount: String(DISCOUNT), handoff: p1 });
          const lines = [
            { handoff: p1, occurrenceId: 'P-first' },
            { handoff: p1, occurrenceId: 'P-second' },
          ];

          const attemptsBefore = harness.wholeAttempts.length;
          const discounted = yield* priceProfilePurchase(harness, lines);
          // The owner evaluation's own attempt names a cause that the customer-safe projection hides.
          expect(harness.wholeAttempts.slice(attemptsBefore)).toMatchObject([{ kind: 'READY_FOR_FINAL_PUBLICATION' }]);
          const perOccurrence = TIER_PRICE - DISCOUNT + FEE;
          expect(perOccurrence * 2).toBe(136);
          expect(discounted).toMatchObject({
            candidate: { occurrenceIds: ['P-first', 'P-second'] },
            outcome: 'PRICE_RESOLVED',
            result: { total: { amount: String(perOccurrence * 2), currencyCode: 'CZK' } },
          });
          expect(publishedAmounts(discounted)).toEqual([
            ['P-first', String(perOccurrence)],
            ['P-second', String(perOccurrence)],
          ]);

          // Audience controls: the same purchase for a Guest and for a Profile in another Price Group gets no Discount.
          const withoutDiscount = TIER_PRICE + FEE;
          for (const subject of ['GUEST', 'OTHER_GROUP_PROFILE'] as const) {
            const control = yield* pricePurchase(harness, lines, subject);
            expect(control).toMatchObject({
              candidate: { occurrenceIds: ['P-first', 'P-second'] },
              outcome: 'PRICE_RESOLVED',
              result: { total: { amount: String(withoutDiscount * 2), currencyCode: 'CZK' } },
            });
          }
          expect(
            harness.priceGroupRequests.some(
              ({ profile }) => profile.resourceId === harness.otherGroupProfileSubject.profileRef.resourceId,
            ),
          ).toBe(true);
        }).pipe(Effect.provideContext(context));
      }),
    ),
  900_000,
);
