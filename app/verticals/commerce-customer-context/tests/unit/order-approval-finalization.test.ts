import { PurchaseLimitCounterpartyRefSchema } from '../../shared/domain/purchase-limit-policy.ts';
import { PurchaseLimitSourceRevisionVectorSchema } from '../../shared/domain/purchase-limit-evaluation.ts';
import { TestClock } from 'effect/testing';
import { PurchaseLimitEvaluationCurrentFactsSchema } from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { insideDatabaseTransaction } from '../../../../packages/core-runtime/src/db/transaction-io-guard.ts';
import {
  verifyOrderFinalizationSnapshot,
  preparedOrderCurrentness,
} from '../../src/services/order-approval-finalization.service.ts';
import { orderFinalizationSnapshotFixture } from './order-finalization-fixtures.ts';

const before = orderFinalizationSnapshotFixture;
const now = DateTime.toEpochMillis(before.request.submittedAt);
const validUntil = now + 30_000;

describe('Order finalization snapshot fence', () => {
  it.effect('accepts unchanged retained owner facts under the SQL guard without refreshing evidence', () =>
    verifyOrderFinalizationSnapshot(before, before, validUntil, now).pipe(
      insideDatabaseTransaction('commerce.customer-context.revalidate-order-purchase-approval'),
    ),
  );

  it.effect('rejects request, approval route, decision and source changes during remote calls', () =>
    Effect.gen(function* changedOwnerFacts() {
      const revisions = [
        { ...before, request: { ...before.request, requestRevision: before.request.requestRevision + 1 } },
        { ...before, request: { ...before.request, status: 'CANCELLED' as const } },
        { ...before, request: { ...before.request, decisionBundleHash: 'c'.repeat(64) } },
        { ...before, request: { ...before.request, route: { ...before.request.route, hierarchyRevision: 2 } } },
        {
          ...before,
          sourceRevisions: before.sourceRevisions.map((source) => ({ ...source, revision: 'changed-owner-revision' })),
        },
      ];
      for (const current of revisions) {
        const failure = yield* verifyOrderFinalizationSnapshot(before, current, validUntil, now).pipe(Effect.flip);
        expect(failure.code).toBe('CURRENT_STATE_INDETERMINATE');
      }
    }),
  );

  it.effect('rejects the exact expiry boundary and cannot renew a prepared window', () =>
    Effect.gen(function* expiredEvidence() {
      yield* verifyOrderFinalizationSnapshot(before, before, validUntil, validUntil - 1);
      for (const instant of [validUntil, validUntil + 1]) {
        expect(
          (yield* verifyOrderFinalizationSnapshot(before, before, validUntil, instant).pipe(Effect.flip)).code,
        ).toBe('CURRENT_STATE_INDETERMINATE');
      }
      expect((yield* verifyOrderFinalizationSnapshot(before, before, Number.NaN, now).pipe(Effect.flip)).code).toBe(
        'CURRENT_STATE_INDETERMINATE',
      );
    }),
  );
});

it.effect(
  'prepared currentness keeps actual owner revisions and rejects selector changes and expiry under the SQL guard',
  () =>
    Effect.gen(function* preparedCurrentnessBinding() {
      const observedAt = yield* DateTime.now;
      const { request } = before;
      const { proposal } = request;
      const scope = {
        authMethod: 'api_key' as const,
        correlationId: 'order-preflight-test',
        legalEntityId: proposal.context.sellingLegalEntityId,
        principalId: '10000000-0000-4000-8000-000000000009',
        tenantId: proposal.context.tenantId,
      };
      const facts = Schema.decodeUnknownSync(PurchaseLimitEvaluationCurrentFactsSchema)({
        channelId: proposal.context.channelId,
        contextRevision: 'actual-owner-context:7',
        currentSourceRevisions: before.sourceRevisions.filter(
          ({ source }) => source !== 'counterparty-policy' && source !== 'principal-override',
        ),
        marketId: proposal.context.marketId,
        purchaseValue: proposal.purchaseValue,
      });
      const currentness = preparedOrderCurrentness({
        bundlePurchaseValue: proposal.purchaseValue,
        facts,
        observedAt,
        request,
        scope,
        validUntil: DateTime.toEpochMillis(observedAt) + 1000,
      });
      const input = {
        claimedPurchaseValue: proposal.purchaseValue,
        counterpartyRef: Schema.decodeUnknownSync(PurchaseLimitCounterpartyRefSchema)(
          proposal.identity.counterpartyRef,
        ),
        expectedSourceRevisions: Schema.decodeUnknownSync(PurchaseLimitSourceRevisionVectorSchema)(
          before.sourceRevisions.map((source) => ({ ...source, revision: 'caller-expected' })),
        ),
        observedAt,
        scope: {
          legalEntityId: scope.legalEntityId,
          principalId: proposal.identity.buyer.principalId,
          storefrontId: proposal.context.storefrontId,
          tenantId: scope.tenantId,
        },
      };
      expect(yield* currentness.resolveCurrent(input).pipe(insideDatabaseTransaction('order-proof-commit'))).toEqual(
        facts,
      );
      const mismatch = yield* currentness
        .resolveCurrent({ ...input, scope: { ...input.scope, storefrontId: 'other-storefront' } })
        .pipe(Effect.flip);
      expect(mismatch.code).toBe('purchase_limit_dependency_unavailable');
      const wrongBuyer = yield* currentness
        .resolveCurrent({ ...input, scope: { ...input.scope, principalId: scope.principalId } })
        .pipe(Effect.flip);
      expect(wrongBuyer.code).toBe('purchase_limit_dependency_unavailable');
      yield* TestClock.adjust('1 second');
      expect((yield* currentness.resolveCurrent(input).pipe(Effect.flip)).code).toBe(
        'purchase_limit_dependency_unavailable',
      );
    }),
);
