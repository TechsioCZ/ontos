import { PurchaseProposalRevisionSchema, PurchasingApprovalRejected } from '../../shared/domain/purchasing-approval.ts';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { DateTime, Deferred, Effect, Fiber, Result, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import {
  assertNoOpenActionTransaction,
  awaitPausedAuthority,
  extendedObservationSeconds,
  holdGenuineTenant,
  scenario,
  services,
  waitForExactBlock,
} from './purchase-approval-fresh-proof-postgres.fixture.ts';

it.live(
  'rejects fresh intent at actual request expiry without replacing P1 or extending the request',
  () =>
    Effect.scoped(
      Effect.gen(function* actualRequestExpiryCutoff() {
        const requestTtlMilliseconds = 15_000;
        const test = yield* scenario('CURRENT', requestTtlMilliseconds);
        const first = yield* test.check(randomUUID());
        const original = yield* test.readProofs();
        const request = yield* test.readRequest();
        const expiry = test.approved.request.expiresAt;
        expect(DateTime.isLessThan(first.revalidation.validUntil, expiry)).toBe(true);
        yield* test.expire(first.revalidation.validUntil);
        test.setObservationWindow(extendedObservationSeconds);
        const second = yield* test.check(randomUUID());
        expect(second.revalidation.revalidationRef).not.toEqual(first.revalidation.revalidationRef);
        // Authority observation outlives the remaining request TTL. The native LEAST bound
        // must clip P2 exactly to the real Submit expiry, without manipulating either clock.
        const observation = second.revalidation.evidence.finalBindingEvidence;
        assert.isOk(observation !== undefined);
        expect(DateTime.isGreaterThan(observation.validUntil, expiry)).toBe(true);
        expect(second.revalidation.validUntil).toEqual(expiry);
        const boundedProofs = yield* test.readProofs();
        const stored = boundedProofs.find(
          (proof) => proof.revalidationResourceId === second.revalidation.revalidationRef.resourceId,
        );
        assert.isOk(stored !== undefined);
        expect(stored.validUntil.getTime()).toBe(DateTime.toEpochMillis(expiry));
        expect(
          boundedProofs.find((proof) => proof.revalidationResourceId === original[0]?.revalidationResourceId),
        ).toEqual(original[0]);
        // Wait against the real request expiry written by Submit, never UPDATE its timestamp/status.
        const remaining = DateTime.toEpochMillis(expiry) - DateTime.toEpochMillis((yield* test.owner.nativeNow()).at);
        expect(remaining).toBeGreaterThan(0);
        expect(remaining).toBeLessThanOrEqual(requestTtlMilliseconds);
        yield* test.owner.admin.execute(sql`select pg_sleep(${(remaining + 20) / 1000})`, 'objects');
        expect(DateTime.isGreaterThanOrEqualTo((yield* test.owner.nativeNow()).at, expiry)).toBe(true);
        const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.check(randomUUID())),
        );
        // Current resolution clips the owner confirmation to request expiry. At this
        // boundary the writer therefore rejects that expired confirmation first.
        expect(failure.code).toBe('OWNER_CONFIRMATION_EXPIRED');
        expect(failure.reason).toBe('The owner revalidation evidence is outside the trusted validity window');
        expect(yield* test.readProofs()).toEqual(boundedProofs);
        expect(yield* test.readRequest()).toEqual(request);
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

it.live(
  'component competing proofs and Order claims consume once under concurrent registered Actions',
  () =>
    Effect.scoped(
      Effect.gen(function* competingConsumption() {
        const test = yield* scenario('CURRENT', 60_000, true);
        const p1 = yield* test.check(randomUUID());
        yield* test.expire(p1.revalidation.validUntil);
        test.setObservationWindow(extendedObservationSeconds);
        const p2 = yield* test.check(randomUUID());
        const p3 = yield* test.check(randomUUID());
        expect(p2.revalidation.revalidationRef).not.toEqual(p3.revalidation.revalidationRef);
        const first = yield* test.componentConsumptionClaim(p2.revalidation.revalidationRef);
        const second = yield* test.componentConsumptionClaim(p3.revalidation.revalidationRef);
        const claims = [
          first,
          { ...second, orderRef: { ...second.orderRef, resourceId: 'TEST_COMPONENT_COMPETING_ORDER' } },
        ];
        const proofs = yield* test.readProofs();
        const before = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        const request = yield* test.readRequest();
        const pauseA = yield* test.pauseAuthority();
        const entries = test.authorityEntries();
        const actionA = yield* test.consumeComponent(first).pipe(Effect.result, Effect.forkScoped);
        yield* awaitPausedAuthority(pauseA, actionA);
        yield* assertNoOpenActionTransaction(test);
        const [, competingClaim] = claims;
        assert.isOk(competingClaim !== undefined);
        const pauseB = yield* test.pauseAuthority();
        const actionB = yield* test.consumeComponent(competingClaim).pipe(Effect.result, Effect.forkScoped);
        yield* awaitPausedAuthority(pauseB, actionB);
        expect(test.authorityEntries()).toBe(entries + 2);
        yield* assertNoOpenActionTransaction(test);
        const held = yield* holdGenuineTenant(test);
        yield* Deferred.succeed(pauseA.release, true);
        yield* waitForExactBlock(test, held.blocker, 'TENANT');
        expect(yield* test.readProofs()).toEqual(proofs);
        expect(yield* test.readRequest()).toEqual(request);
        yield* Deferred.succeed(held.release, true);
        yield* Fiber.join(held.holder);
        const resultA = yield* Fiber.join(actionA);
        yield* assertNoOpenActionTransaction(test);
        yield* Deferred.succeed(pauseB.release, true);
        const results = [resultA, yield* Fiber.join(actionB)];
        expect(test.authorityEntries()).toBe(entries + 2);
        const winners = results.filter(Result.isSuccess);
        const losers = results.filter(Result.isFailure);
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        const [winner] = winners;
        const [loser] = losers;
        assert.isOk(winner !== undefined && loser !== undefined);
        expect(winner.success.outcome).toBe('CONSUMED');
        expect(winner.success.request.consumptionProofRef).toEqual(p2.revalidation.revalidationRef);
        expect(winner.success.request.committedOrderRef).toEqual(first.orderRef);
        const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(loser.failure);
        expect(failure.code).toBe('COMMIT_CONFLICT');
        const selected = claims.find(
          (claim) => claim.revalidationRef?.resourceId === winner.success.request.consumptionProofRef?.resourceId,
        );
        assert.isOk(selected !== undefined);
        expect(winner.success.request.committedOrderRef).toEqual(selected.orderRef);
        expect(winner.success.request.requestRevision).toBe(test.approved.request.requestRevision + 1);
        const stored = yield* test.readRequest();
        const committed = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        expect(committed.events).toHaveLength(before.events.length + 1);
        expect(committed.outbox).toHaveLength(before.outbox.length + 1);
        const replay = yield* test.consumeComponent(selected);
        expect(replay.outcome).toBe('ALREADY_CONSUMED');
        expect(replay.request).toEqual(winner.success.request);
        expect(yield* test.readRequest()).toEqual(stored);
        expect(yield* test.readProofs()).toEqual(proofs);
        const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        expect(after.events).toEqual(committed.events);
        expect(after.outbox).toEqual(committed.outbox);
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

it.live(
  'rejects fresh I2 after Current source or material-value drift and preserves immutable P1',
  () =>
    Effect.scoped(
      Effect.gen(function* changedCurrentEvidenceRefusal() {
        const test = yield* scenario();
        const p1 = yield* test.check(randomUUID());
        yield* test.expire(p1.revalidation.validUntil);
        const proofs = yield* test.readProofs();
        const request = yield* test.readRequest();
        const before = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        const entries = test.authorityEntries();
        const currentSourceRevisions = test.chain.sourceRevisions.filter(
          ({ source }) => source !== 'counterparty-policy' && source !== 'principal-override',
        );
        for (const source of [
          'purchase-proposal',
          'customer-commerce-policy',
          'storefront-context',
          'purchasing-profile',
        ] as const) {
          yield* test.chain.changeCurrentFacts({
            currentSourceRevisions: currentSourceRevisions.map((revision) =>
              revision.source === source ? { ...revision, revision: '2' } : revision,
            ),
            purchaseValue: test.chain.proposal.purchaseValue,
          });
          const refused = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
            yield* Effect.flip(test.check(randomUUID())),
          );
          expect(refused.code, source).toBe('CURRENT_STATE_INDETERMINATE');
          expect(yield* test.readProofs(), source).toEqual(proofs);
          expect(yield* test.readRequest(), source).toEqual(request);
          expect(test.authorityEntries(), source).toBe(entries);
          const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
          expect(after.events, source).toEqual(before.events);
          expect(after.outbox, source).toEqual(before.outbox);
        }
        yield* test.chain.changeCurrentFacts({
          currentSourceRevisions,
          purchaseValue: yield* Schema.decodeUnknownEffect(
            Schema.toType(PurchaseProposalRevisionSchema.fields.purchaseValue),
          )({
            ...test.chain.proposal.purchaseValue,
            monetaryAmount: { ...test.chain.proposal.purchaseValue.monetaryAmount, amount: '121' },
          }),
        });
        const material = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.check(randomUUID())),
        );
        expect(material.code).toBe('CURRENT_STATE_INDETERMINATE');
        expect(yield* test.readProofs()).toEqual(proofs);
        expect(yield* test.readRequest()).toEqual(request);
        expect(test.authorityEntries()).toBe(entries);
        const refused = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        expect(refused.events).toEqual(before.events);
        expect(refused.outbox).toEqual(before.outbox);
        yield* test.chain.changeCurrentFacts({
          currentSourceRevisions,
          purchaseValue: test.chain.proposal.purchaseValue,
        });
        test.setObservationWindow(extendedObservationSeconds);
        const p2 = yield* test.check(randomUUID());
        expect(p2.outcome).toBe('APPROVAL_VALID');
        expect(p2.revalidation.revalidationRef).not.toEqual(p1.revalidation.revalidationRef);
        expect(yield* test.readRequest()).toEqual(request);
        const after = yield* test.readProofs();
        expect(after).toHaveLength(2);
        for (const original of proofs) {
          expect(after.find((proof) => proof.revalidationResourceId === original.revalidationResourceId)).toEqual(
            original,
          );
        }
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

it.live(
  'refuses terminal decision rewrites of an approved proof-bearing request without superseding P1',
  () =>
    Effect.scoped(
      Effect.gen(function* approvedLifecycleRejection() {
        const test = yield* scenario();
        const p1 = yield* test.check(randomUUID());
        yield* test.expire(p1.revalidation.validUntil);
        const proofs = yield* test.readProofs();
        const request = yield* test.readRequest();
        const before = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        for (const decision of ['RETURN', 'REJECT'] as const) {
          const refused = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
            yield* Effect.flip(
              test.chain.decide({
                decision,
                expectedRequestRevision: test.approved.request.requestRevision,
                idempotencyKey: randomUUID(),
                reason: 'TEST refuses rewriting an already approved request and proposal',
              }),
            ),
          );
          // The native Decision routine combines state/revision checks in pa_request_cas.
          expect(refused.code).toBe('COMMIT_CONFLICT');
          expect(refused.retryable).toBe(true);
          expect(yield* test.readProofs()).toEqual(proofs);
          expect(yield* test.readRequest()).toEqual(request);
          const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
          expect(after.events).toEqual(before.events);
          expect(after.outbox).toEqual(before.outbox);
        }
        test.setObservationWindow(extendedObservationSeconds);
        const p2 = yield* test.check(randomUUID());
        expect(p2.outcome).toBe('APPROVAL_VALID');
        expect(p2.revalidation.revalidationRef).not.toEqual(p1.revalidation.revalidationRef);
        expect(yield* test.readRequest()).toEqual(request);
        const after = yield* test.readProofs();
        expect(after).toHaveLength(2);
        for (const original of proofs) {
          expect(after.find((proof) => proof.revalidationResourceId === original.revalidationResourceId)).toEqual(
            original,
          );
        }
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);
