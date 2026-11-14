import {
  PurchaseApprovalFinalBindingSchema,
  PurchasingApprovalRejected,
} from '../../shared/domain/purchasing-approval.ts';
import type { ConsumePurchaseApprovalInput } from '../../shared/domain/purchasing-approval.ts';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import { extendedObservationSeconds, scenario, services } from './purchase-approval-fresh-proof-postgres.fixture.ts';

it.live(
  'component consumption selects exact P2 once, retains P1 and rejects competing proof and Order claims',
  () =>
    Effect.scoped(
      Effect.gen(function* exactP2NativeConsumptionComponent() {
        const test = yield* scenario('CURRENT', 60_000, true);
        const p1 = yield* test.check(randomUUID());
        yield* test.expire(p1.revalidation.validUntil);
        test.setObservationWindow(extendedObservationSeconds);
        const p2 = yield* test.check(randomUUID());
        const proofs = yield* test.readProofs();
        const before = yield* test.readRequest();
        const beforeEffects = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        const claim = yield* test.componentConsumptionClaim(p2.revalidation.revalidationRef);
        // The buyer alone is not the Order module, so the consumption seam refuses it before any owner work.
        const buyerAlone = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.consumeComponent(claim, false)),
        );
        expect(buyerAlone.code, buyerAlone.reason).toBe('PERMISSION_DENIED');
        const stale = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.consumeComponent({ ...claim, revalidationRef: p1.revalidation.revalidationRef })),
        );
        expect(stale.code, stale.reason).toBe('PERMISSION_DENIED');
        expect(yield* test.readRequest()).toEqual(before);
        expect(yield* test.readProofs()).toEqual(proofs);
        const consumed = yield* test.consumeComponent(claim);
        expect(consumed.outcome).toBe('CONSUMED');
        expect(consumed.request.consumptionProofRef).toEqual(p2.revalidation.revalidationRef);
        expect(consumed.request.requestRevision).toBe(test.approved.request.requestRevision + 1);
        const stored = yield* test.readRequest();
        const replay = yield* test.consumeComponent(claim);
        expect(replay.outcome).toBe('ALREADY_CONSUMED');
        expect(replay.request).toEqual(consumed.request);
        const conflict = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(
            test.consumeComponent({ ...claim, orderRef: { ...claim.orderRef, resourceId: randomUUID() } }),
          ),
        );
        expect(conflict.code).toBe('COMMIT_CONFLICT');
        const competing = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.consumeComponent({ ...claim, revalidationRef: p1.revalidation.revalidationRef })),
        );
        expect(competing.code).toBe('COMMIT_CONFLICT');
        const afterConsumption = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        const consumedEvents = afterConsumption.events.filter(
          (event) => event.eventType === 'commerce.customer-context.purchase-approval-consumed.v1',
        );
        expect(consumedEvents).toHaveLength(1);
        expect(afterConsumption.events).toHaveLength(beforeEffects.events.length + 1);
        expect(afterConsumption.outbox).toHaveLength(beforeEffects.outbox.length + 1);
        const afterConsumed = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.check(randomUUID())),
        );
        expect(afterConsumed.code).toBe('CURRENT_STATE_INDETERMINATE');
        expect(afterConsumed.retryable).toBe(true);
        const afterRefusal = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        expect(afterRefusal.events).toEqual(afterConsumption.events);
        expect(afterRefusal.outbox).toEqual(afterConsumption.outbox);
        expect(yield* test.readRequest()).toEqual(stored);
        expect(yield* test.readProofs()).toEqual(proofs);
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

it.live(
  'rejects fresh proof after the registered hierarchy scheduled end without changing retained P1 or effects',
  () =>
    Effect.scoped(
      Effect.gen(function* hierarchyScheduledEndNativeRejection() {
        const hierarchyTtlMilliseconds = 15_000;
        const test = yield* scenario('CURRENT', 60_000, false, hierarchyTtlMilliseconds);
        const p1 = yield* test.check(randomUUID());
        const proofs = yield* test.readProofs();
        const request = yield* test.readRequest();
        const before = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        assert.isOk(test.chain.hierarchy.effectiveTo !== null);
        const end = DateTime.toEpochMillis(test.chain.hierarchy.effectiveTo);
        const { at } = yield* test.owner.nativeNow();
        const wait = end - DateTime.toEpochMillis(at) + 20;
        expect(wait).toBeLessThanOrEqual(hierarchyTtlMilliseconds);
        if (wait > 0) {
          yield* test.owner.admin.execute(sql`select pg_sleep(${wait / 1000})`, 'objects');
        }
        expect(DateTime.toEpochMillis((yield* test.owner.nativeNow()).at)).toBeGreaterThanOrEqual(end);
        expect(DateTime.toEpochMillis((yield* test.owner.nativeNow()).at)).toBeGreaterThanOrEqual(
          DateTime.toEpochMillis(p1.revalidation.validUntil),
        );
        test.setObservationWindow(extendedObservationSeconds);
        const refused = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
          yield* Effect.flip(test.check(randomUUID())),
        );
        expect(refused.code).toBe('POLICY_ROUTE_INVALID');
        expect(yield* test.readProofs()).toEqual(proofs);
        expect(yield* test.readRequest()).toEqual(request);
        const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        expect(after.events).toEqual(before.events);
        expect(after.outbox).toEqual(before.outbox);
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

it.live(
  'component consumption rejects mismatched evidence without effects and still accepts exact P2',
  () =>
    Effect.scoped(
      Effect.gen(function* consumptionMismatchMatrix() {
        const test = yield* scenario('CURRENT', 60_000, true);
        const p1 = yield* test.check(randomUUID());
        yield* test.expire(p1.revalidation.validUntil);
        test.setObservationWindow(extendedObservationSeconds);
        const p2 = yield* test.check(randomUUID());
        const claim = yield* test.componentConsumptionClaim(p2.revalidation.revalidationRef);
        const proofs = yield* test.readProofs();
        const request = yield* test.readRequest();
        const before = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        const otherBundle = yield* Schema.decodeUnknownEffect(PurchaseApprovalFinalBindingSchema)({
          ...test.binding,
          bundleRef: { ...test.binding.bundleRef, resourceId: randomUUID() },
        });
        const otherAttempt = yield* Schema.decodeUnknownEffect(PurchaseApprovalFinalBindingSchema)({
          ...test.binding,
          attemptRef: { ...test.binding.attemptRef, resourceId: randomUUID() },
        });
        const controls: readonly {
          readonly code: PurchasingApprovalRejected['code'];
          readonly label: string;
          readonly patch: Partial<ConsumePurchaseApprovalInput>;
        }[] = [
          {
            code: 'CURRENT_STATE_INDETERMINATE',
            label: 'request',
            patch: { requestRef: { ...claim.requestRef, resourceId: randomUUID() } },
          },
          {
            code: 'PERMISSION_DENIED',
            label: 'proposal',
            patch: { proposalRevisionRef: { ...claim.proposalRevisionRef, resourceId: randomUUID() } },
          },
          { code: 'PERMISSION_DENIED', label: 'Decision hash', patch: { decisionBundleHash: 'e'.repeat(64) } },
          { code: 'PERMISSION_DENIED', label: 'correlation', patch: { commitmentCorrelationId: randomUUID() } },
          {
            code: 'PERMISSION_DENIED',
            label: 'Bundle',
            patch: {
              finalBinding: otherBundle,
            },
          },
          {
            code: 'PERMISSION_DENIED',
            label: 'Attempt',
            patch: {
              finalBinding: otherAttempt,
            },
          },
          {
            code: 'PERMISSION_DENIED',
            label: 'Bundle hash',
            patch: { finalBinding: { ...test.binding, bundleHash: 'e'.repeat(64) } },
          },
          {
            code: 'PERMISSION_DENIED',
            label: 'unknown proof',
            patch: { revalidationRef: { ...p2.revalidation.revalidationRef, resourceId: randomUUID() } },
          },
          {
            code: 'PERMISSION_DENIED',
            label: 'foreign proof',
            patch: { revalidationRef: { ...p2.revalidation.revalidationRef, tenantId: randomUUID() } },
          },
          {
            code: 'PERMISSION_DENIED',
            label: 'expired P1',
            patch: { revalidationRef: p1.revalidation.revalidationRef },
          },
        ];
        for (const control of controls) {
          const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
            yield* Effect.flip(test.consumeComponent({ ...claim, ...control.patch })),
          );
          expect(failure.code, `${control.label}: ${failure.reason}`).toBe(control.code);
          expect(yield* test.readRequest(), control.label).toEqual(request);
          expect(yield* test.readProofs(), control.label).toEqual(proofs);
          const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
          expect(after.events, control.label).toEqual(before.events);
          expect(after.outbox, control.label).toEqual(before.outbox);
        }
        const consumed = yield* test.consumeComponent(claim);
        expect(consumed.outcome).toBe('CONSUMED');
        expect(consumed.request.consumptionProofRef).toEqual(p2.revalidation.revalidationRef);
        const stored = yield* test.readRequest();
        const committed = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        for (const patch of [
          { idempotencyKey: randomUUID() },
          { commitmentCorrelationId: randomUUID() },
          { committedAt: DateTime.add(claim.committedAt, { milliseconds: 1 }) },
        ]) {
          const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
            yield* Effect.flip(test.consumeComponent({ ...claim, ...patch })),
          );
          expect(failure.code).toBe('COMMIT_CONFLICT');
          expect(yield* test.readRequest()).toEqual(stored);
          expect(yield* test.readProofs()).toEqual(proofs);
          const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
          expect(after.events).toEqual(committed.events);
          expect(after.outbox).toEqual(committed.outbox);
        }
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);

it.live(
  'component reconciliation uses the exclusive stored P2 commitment interval after real expiry',
  () =>
    Effect.scoped(
      Effect.gen(function* exactCommitmentInterval() {
        const test = yield* scenario('CURRENT', 60_000, true);
        const p1 = yield* test.check(randomUUID());
        yield* test.expire(p1.revalidation.validUntil);
        const p2 = yield* test.check(randomUUID());
        const claim = yield* test.componentConsumptionClaim(p2.revalidation.revalidationRef);
        const proofs = yield* test.readProofs();
        const request = yield* test.readRequest();
        const before = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        yield* test.expire(p2.revalidation.validUntil);
        for (const committedAt of [
          p2.revalidation.validUntil,
          DateTime.subtract(p2.revalidation.checkedAt, { milliseconds: 1 }),
        ]) {
          const failure = yield* Schema.decodeUnknownEffect(PurchasingApprovalRejected)(
            yield* Effect.flip(test.consumeComponent({ ...claim, committedAt })),
          );
          expect(failure.code).toBe('PERMISSION_DENIED');
          expect(yield* test.readRequest()).toEqual(request);
          expect(yield* test.readProofs()).toEqual(proofs);
          const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
          expect(after.events).toEqual(before.events);
          expect(after.outbox).toEqual(before.outbox);
        }
        const timelyCommitment = {
          ...claim,
          committedAt: DateTime.subtract(p2.revalidation.validUntil, { milliseconds: 1 }),
        };
        expect(DateTime.isGreaterThan(timelyCommitment.committedAt, p2.revalidation.checkedAt)).toBe(true);
        const consumed = yield* test.consumeComponent(timelyCommitment);
        expect(consumed.outcome).toBe('CONSUMED');
        expect(consumed.request.consumptionProofRef).toEqual(p2.revalidation.revalidationRef);
        const committed = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        const replay = yield* test.consumeComponent(timelyCommitment);
        expect(replay.outcome).toBe('ALREADY_CONSUMED');
        expect(replay.request).toEqual(consumed.request);
        expect(yield* test.readProofs()).toEqual(proofs);
        const after = yield* test.owner.fixture.evidence(test.owner.coreEvidenceExecutor);
        expect(after.events).toEqual(committed.events);
        expect(after.outbox).toEqual(committed.outbox);
        expect(after.events).toHaveLength(before.events.length + 1);
        expect(after.outbox).toHaveLength(before.outbox.length + 1);
      }),
    ).pipe(Effect.provide(services)),
  120_000,
);
