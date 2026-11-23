import { Clock, DateTime, Effect, Layer } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import {
  publicPricingReadHarnessServices,
  startPublicPricingReadHarness,
} from '../support/public-pricing-read-harness.ts';

// Shared prerequisite for the public Current Pricing Read scenarios (#1225, #1242, #1250, #1277). Every owner fact
// below is produced through a supported owner path; the Read under test is the registered production Read.
// Not a #1225/#1242/#1250/#1277 scenario: one smoke case proves the harness and the fail-closed stale-rule control.
it.live(
  'resolves a registered public Current Pricing Read from native Price, Fee and real Catalog facts',
  () =>
    Effect.scoped(
      Effect.gen(function* publicReadHarnessSmoke() {
        const nativeClock = yield* Clock.Clock;
        const context = yield* Layer.build(publicPricingReadHarnessServices);
        yield* Effect.gen(function* scenario() {
          const harness = yield* startPublicPricingReadHarness({ nativeClock });
          yield* harness.produceCommercialFee({ amount: '3', handoff: harness.handoffs.p1 });

          const resolvedRequest = yield* harness.makeRequest({
            lines: [{ handoff: harness.handoffs.p1, occurrenceId: 'P-only' }],
            operationTime: DateTime.formatIso(yield* DateTime.now),
          });
          const resolved = yield* harness.runRegisteredRead(resolvedRequest);
          // Price 100 + persisted fixed-scale Fee 3: a persisted "3.000000000" must not block publication.
          expect(resolved).toMatchObject({
            candidate: { occurrenceIds: ['P-only'] },
            outcome: 'PRICE_RESOLVED',
            result: {
              currencyCode: 'CZK',
              lines: [{ occurrenceId: 'P-only', publishedPreTaxAmount: { amount: '103', currencyCode: 'CZK' } }],
              total: { amount: '103', currencyCode: 'CZK' },
            },
            retryable: false,
          });
          expect(harness.wholeAttempts.map(({ kind }) => kind)).toEqual(['READY_FOR_FINAL_PUBLICATION']);
          // Final publication consulted every owner twice (verify, then generation confirm), none failed.
          expect(harness.fenceCalls.every(({ failure }) => failure === undefined)).toBe(true);
          expect(harness.fenceCalls.map(({ owner }) => owner).toSorted()).toEqual(
            ['catalog', 'customer-context', 'market', 'promotion'].flatMap((owner) => [owner, owner]),
          );
          expect(harness.marketRequests.length).toBeGreaterThan(0);

          // Control: a superseded Catalog Unit rule leaves Pricing's Tier bound to the old rule. The Read must fail
          // closed with a customer-safe non-success and must not reach any owner final fence.
          const ruleRevision = yield* harness.reviseFirstUnitRule();
          expect(ruleRevision).toBeGreaterThan(harness.handoffs.p1.quantity.unitRuleRevision);
          const fresh = yield* harness.prepareFreshHandoff(harness.selections.p1);
          expect(fresh.quantity.unitRuleRevision).toBe(ruleRevision);
          const fenceCallsBefore = harness.fenceCalls.length;
          const attemptsBefore = harness.wholeAttempts.length;
          const staleRequest = yield* harness.makeRequest({
            lines: [{ handoff: fresh, occurrenceId: 'P-fresh' }],
            operationTime: DateTime.formatIso(yield* DateTime.now),
          });
          const stale = yield* harness.runRegisteredRead(staleRequest);
          assert(stale.outcome === 'PRICING_INDETERMINATE');
          expect(stale).toMatchObject({ candidate: { occurrenceIds: ['P-fresh'] } });
          // The customer-safe projection hides the cause, so the control reads the owner evaluation's own attempts:
          // they must exist (a vacuous empty `every` would pass) and fail for the Tier/Unit binding, not another reason.
          const staleAttempts = harness.wholeAttempts.slice(attemptsBefore);
          expect(harness.wholeAttempts.length).toBeGreaterThan(1);
          expect(staleAttempts.length).toBeGreaterThan(0);
          expect(staleAttempts.every(({ kind }) => kind === 'INDETERMINATE_OR_UNVERIFIABLE')).toBe(true);
          expect(staleAttempts.map(({ reason }) => reason)).toContain(
            'Unit Price could not bind exact Price, Quantity, and Tier evidence',
          );
          expect(harness.fenceCalls).toHaveLength(fenceCallsBefore);
        }).pipe(Effect.provideContext(context));
      }),
    ),
  600_000,
);
