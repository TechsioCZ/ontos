import { ContextAccess, ReadPermissionDenied, toBusinessPermissionAccessKey } from '@app/core-runtime';
import type { ContextAccessService } from '@app/core-runtime';
import { makePositionSetAuthorization } from '../../src/api/current-relevant-stock-position-set.read.ts';
import { PricingPurchaseContextVerificationResponseSchema } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import { DateTime, Effect, Exit, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import {
  RelevantStockPositionSetRequestSchema,
  RelevantStockPositionSetUnavailable,
} from '../../shared/domain/current-relevant-stock-position-set.ts';
import {
  PositionSetCommerceVerifier,
  currentRelevantStockPositionSetService,
  evaluateRelevantStockPositionSet,
} from '../../src/services/current-relevant-stock-position-set.service.ts';
import { scope, request, observation, position, sharing } from '../support/current-relevant-stock-position-set.ts';

const unusedPermissionChecks = () => Effect.succeed([]);

describe('Inventory owner Position-set completeness', () => {
  it.effect('produces complete empty separately from unproven owner scope', () =>
    Effect.gen(function* positionSetScenario1() {
      const empty = yield* evaluateRelevantStockPositionSet(
        request,
        { ...observation, positions: [], sharing: [] },
        scope,
      );
      expect(empty.outcome).toBe('COMPLETE');
      if (empty.outcome === 'COMPLETE') {
        expect(empty.positionRefs).toEqual([]);
      }
      const missing = yield* evaluateRelevantStockPositionSet(request, { ...observation, items: [] }, scope);
      expect(missing.outcome).toBe('UNPROVEN');
    }),
  );
  it.effect('invalidates a retained proof after previously unknown Position insertion', () =>
    Effect.gen(function* positionSetScenario2() {
      const first = yield* evaluateRelevantStockPositionSet(request, observation, scope);
      expect(first.outcome).toBe('COMPLETE');
      if (first.outcome !== 'COMPLETE') {
        return;
      }
      const newId = '99999999-9999-4999-8999-999999999999';
      const inserted = {
        ...observation,
        positions: [position, { ...position, stockPositionId: newId }],
        sharing: [sharing, { ...sharing, eligibilityId: newId, stockPositionId: newId }],
      };
      const next = yield* evaluateRelevantStockPositionSet(
        { ...request, previousCompleteness: first.completeness },
        inserted,
        scope,
      );
      expect(next.outcome).toBe('COMPLETE');
      if (next.outcome === 'COMPLETE') {
        expect(next.positionRefs).toHaveLength(2);
        expect(next.previousProof).toBe('INVALIDATED');
      }
    }),
  );
  it.effect('invalidates sharing and lifecycle changes and verifies unchanged evidence', () =>
    Effect.gen(function* positionSetScenario3() {
      const first = yield* evaluateRelevantStockPositionSet(request, observation, scope);
      if (first.outcome !== 'COMPLETE') {
        return;
      }
      const revalidate = { ...request, previousCompleteness: first.completeness };
      const unchanged = yield* evaluateRelevantStockPositionSet(revalidate, observation, scope);
      if (unchanged.outcome === 'COMPLETE') {
        expect(unchanged.previousProof).toBe('CURRENT');
      }
      for (const changed of [
        { ...observation, sharing: [{ ...sharing, channel: 'B2B', currentRevision: 2 }] },
        { ...observation, positions: [{ ...position, lifecycleState: 'HISTORICAL', revision: 2 }] },
      ]) {
        const result = yield* evaluateRelevantStockPositionSet(revalidate, changed, scope);
        expect(result.outcome).toBe('COMPLETE');
        if (result.outcome === 'COMPLETE') {
          expect(result.previousProof).toBe('INVALIDATED');
          expect(result.positionRefs).toEqual([]);
        }
      }
    }),
  );
  it.effect('issues a safe broader candidate proof without client Commerce evidence', () =>
    Effect.gen(function* positionSetScenario4() {
      let authorizedCount = 0;
      const broad = Schema.decodeUnknownSync(RelevantStockPositionSetRequestSchema)({
        mode: 'POTENTIALLY_RELEVANT_POSITIONS',
        scope: request.scope,
      });
      const result = yield* currentRelevantStockPositionSetService({
        authorizePositions: (refs) =>
          Effect.sync(() => {
            authorizedCount = refs.length;
          }),
        observe: () => Effect.succeed({ ...observation, sharing: [] }),
        scope,
      }).read(broad);
      expect(result.outcome).toBe('COMPLETE');
      if (result.outcome === 'COMPLETE') {
        expect(result.positionRefs).toHaveLength(1);
        expect(result.sharingEligibility).toBe('NOT_EVALUATED');
        expect(result.completeness.scope.kind).toBe('SAFELY_BROADER_SCOPE');
      }
      expect(authorizedCount).toBe(1);
    }),
  );
  it.effect('effective sharing boundary invalidates old proof even when rows do not change', () =>
    Effect.gen(function* positionSetScenario5() {
      const future = { ...observation, sharing: [{ ...sharing, effectiveFrom: new Date('2026-10-05T13:00:00Z') }] };
      const first = yield* evaluateRelevantStockPositionSet(request, future, scope);
      if (first.outcome !== 'COMPLETE') {
        return;
      }
      expect(first.positionRefs).toEqual([]);
      expect(first.completeness.nextApplicabilityBoundary).toBeDefined();
      const next = yield* evaluateRelevantStockPositionSet(
        { ...request, previousCompleteness: first.completeness },
        { ...future, observedAt: new Date('2026-10-05T13:00:00Z') },
        scope,
      );
      if (next.outcome === 'COMPLETE') {
        expect(next.previousProof).toBe('INVALIDATED');
        expect(next.positionRefs).toHaveLength(1);
      }
    }),
  );
  it.effect('rejects wrong Unit/backend and invalidates removal/binding changes', () =>
    Effect.gen(function* positionSetScenario6() {
      const first = yield* evaluateRelevantStockPositionSet(request, observation, scope);
      if (first.outcome !== 'COMPLETE') {
        return;
      }
      const previous = { ...request, previousCompleteness: first.completeness };
      for (const changed of [
        { ...observation, positions: [] },
        { ...observation, bindings: [{ ...observation.bindings[0], currentRevision: 2 }] },
      ]) {
        const result = yield* evaluateRelevantStockPositionSet(previous, changed, scope);
        if (result.outcome === 'COMPLETE') {
          expect(result.previousProof).toBe('INVALIDATED');
        }
      }
      for (const resourceId of ['99999999-9999-4999-8999-999999999999']) {
        const wrongUnit = Schema.decodeUnknownSync(RelevantStockPositionSetRequestSchema)({
          ...request,
          scope: { ...request.scope, unitRef: { ...request.scope.unitRef, resourceId } },
        });
        const wrongBackend = Schema.decodeUnknownSync(RelevantStockPositionSetRequestSchema)({
          ...request,
          scope: { ...request.scope, ownerConfigurationRef: { ...request.scope.ownerConfigurationRef, resourceId } },
        });
        expect((yield* evaluateRelevantStockPositionSet(wrongUnit, observation, scope)).outcome).toBe('UNPROVEN');
        expect((yield* evaluateRelevantStockPositionSet(wrongBackend, observation, scope)).outcome).toBe('UNPROVEN');
      }
    }),
  );
  it.effect('never converts database failure or forbidden member into complete empty', () =>
    Effect.gen(function* positionSetScenario7() {
      const broad = Schema.decodeUnknownSync(RelevantStockPositionSetRequestSchema)({
        mode: 'POTENTIALLY_RELEVANT_POSITIONS',
        scope: request.scope,
      });
      const unavailable = new RelevantStockPositionSetUnavailable({
        code: 'relevant_stock_position_set_unavailable',
        reason: 'Inventory Position-set observation is unavailable',
        retryable: true,
      });
      const failed = yield* Effect.exit(
        currentRelevantStockPositionSetService({
          authorizePositions: () => Effect.void,
          observe: () => Effect.fail(unavailable),
          scope,
        }).read(broad),
      );
      expect(Exit.isFailure(failed)).toBe(true);
      const denied = yield* Effect.exit(
        currentRelevantStockPositionSetService({
          authorizePositions: () =>
            Effect.fail(new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'Forbidden Position' })),
          observe: () => Effect.succeed(observation),
          scope,
        }).read(broad),
      );
      expect(Exit.isFailure(denied)).toBe(true);
    }),
  );
  it.effect('future observation and a forged scope never validate retained proof', () =>
    Effect.gen(function* positionSetScenario8() {
      const first = yield* evaluateRelevantStockPositionSet(request, observation, scope);
      if (first.outcome !== 'COMPLETE') {
        return;
      }
      const result = yield* evaluateRelevantStockPositionSet(
        {
          ...request,
          previousCompleteness: { ...first.completeness, observedAt: DateTime.makeUnsafe('2027-01-01T00:00:00Z') },
        },
        observation,
        scope,
      );
      if (result.outcome === 'COMPLETE') {
        expect(result.previousProof).toBe('INVALIDATED');
      }
    }),
  );
  it.effect('actual generated read authorization rejects any denied or malformed returned Position', () =>
    Effect.gen(function* checkReturnedPositionAuthorization() {
      const refs = [position.stockPositionId, '99999999-9999-4999-8999-999999999999'].map((resourceId) => ({
        moduleId: 'commerce.inventory' as const,
        resourceId,
        resourceType: 'commerce.inventory.stock-position',
        tenantId: scope.tenantId,
      }));
      const access: ContextAccessService = {
        businessPermissions: ({ targets }) =>
          Effect.succeed(
            targets.map((target, index) => ({
              decision: index === 1 ? ('denied' as const) : ('allowed' as const),
              key: toBusinessPermissionAccessKey(target),
            })),
          ),
        legalEntities: unusedPermissionChecks,
        modules: unusedPermissionChecks,
        resources: unusedPermissionChecks,
        tenants: unusedPermissionChecks,
      };
      const authorize = yield* makePositionSetAuthorization(scope).pipe(Effect.provideService(ContextAccess, access));
      const outcome = yield* authorize(refs).pipe(
        Effect.as('ALLOWED'),
        Effect.catchTag('ReadPermissionDenied', () => Effect.succeed('DENIED')),
      );
      expect(outcome).toBe('DENIED');
      const malformed = yield* makePositionSetAuthorization(scope).pipe(
        Effect.provideService(ContextAccess, {
          ...access,
          businessPermissions: () => Effect.succeed([{ decision: 'allowed' as const, key: 'forged-key' }]),
        }),
      );
      const malformedOutcome = yield* malformed(refs).pipe(
        Effect.as('ALLOWED'),
        Effect.catchTag('ReadPermissionUnavailable', () => Effect.succeed('UNAVAILABLE')),
      );
      expect(malformedOutcome).toBe('UNAVAILABLE');
    }),
  );
  it.effect('query observation advances without invalidating unchanged material revision', () =>
    Effect.gen(function* revalidateLaterObservation() {
      const first = yield* evaluateRelevantStockPositionSet(request, observation, scope);
      if (first.outcome !== 'COMPLETE') {
        return;
      }
      const advanced = new Date('2026-10-05T12:00:20.000Z');
      const next = yield* evaluateRelevantStockPositionSet(
        { ...request, previousCompleteness: first.completeness },
        { ...observation, observedAt: advanced },
        scope,
      );
      expect(next.outcome).toBe('COMPLETE');
      if (next.outcome === 'COMPLETE') {
        expect(next.previousProof).toBe('CURRENT');
        expect(next.completeness.ownerRevision).toBe(first.completeness.ownerRevision);
        expect(DateTime.toEpochMillis(next.completeness.observedAt)).toBe(advanced.getTime());
      }
    }),
  );
  it.effect('Commerce effective interval must contain SQL snapshot despite application clock skew', () =>
    Effect.gen(function* enforceSnapshotCommerceInterval() {
      const cases = [
        {
          applicationTime: '2026-10-05T12:00:10.000Z',
          expected: 'UNPROVEN',
          validFrom: '2026-10-05T12:00:05.000Z',
          validTo: null,
        },
        {
          applicationTime: '2026-10-05T11:59:50.000Z',
          expected: 'UNPROVEN',
          validFrom: '2026-10-05T11:59:00.000Z',
          validTo: '2026-10-05T12:00:00.000Z',
        },
        {
          applicationTime: '2026-10-05T12:00:10.000Z',
          expected: 'COMPLETE',
          validFrom: '2026-10-05T11:59:00.000Z',
          validTo: '2026-10-05T12:01:00.000Z',
        },
      ];
      for (const interval of cases) {
        yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(interval.applicationTime)));
        const result = yield* currentRelevantStockPositionSetService({
          authorizePositions: () => Effect.void,
          observe: () => Effect.succeed(observation),
          scope,
        })
          .read(request)
          .pipe(
            Effect.provideService(PositionSetCommerceVerifier, {
              verify: (ownerRequest) =>
                Effect.succeed(
                  Schema.decodeUnknownSync(PricingPurchaseContextVerificationResponseSchema)({
                    evidence: {
                      currentness: {
                        evaluatedAt: ownerRequest.operationTime,
                        observedAt: ownerRequest.operationTime,
                        validFrom: interval.validFrom,
                        validTo: interval.validTo,
                      },
                      ownerRef: ownerRequest.purchasingContext.contextRef,
                      ownerRevisionRef: ownerRequest.purchasingContext.contextRevision,
                      subjectAuthority: {
                        actorPrincipalId: scope.principalId,
                        kind: 'PROFILE',
                        partyAuthorityRef: 'party-owner',
                        partyAuthorityRevisionRef: 'party-revision',
                        subject: ownerRequest.subject,
                        subjectAuthorityRef: 'profile-owner',
                        subjectAuthorityRevisionRef: 'profile-revision',
                      },
                      verificationRef: 'owner-verification',
                      verifiedScope: {
                        channelId: ownerRequest.purchasingContext.channelId,
                        legalEntityId: ownerRequest.purchasingContext.sellingLegalEntityId,
                        marketId: ownerRequest.purchasingContext.marketId,
                        tenantId: ownerRequest.tenantId,
                      },
                    },
                    outcome: 'PURCHASE_CONTEXT_VERIFIED',
                    request: ownerRequest,
                  }),
                ),
            }),
          );
        expect(result.outcome).toBe(interval.expected);
        if (result.outcome === 'COMPLETE') {
          expect(DateTime.toEpochMillis(result.completeness.observedAt)).toBe(observation.observedAt.getTime());
        }
      }
    }),
  );
  it.effect('does not observe owner data without a server Commerce verifier', () =>
    Effect.gen(function* positionSetScenario9() {
      let observed = false;
      const result = yield* currentRelevantStockPositionSetService({
        authorizePositions: () => Effect.void,
        observe: () => {
          observed = true;
          return Effect.succeed(observation);
        },
        scope,
      }).read(request);
      expect(result.outcome).toBe('UNPROVEN');
      expect(observed).toBe(false);
    }),
  );
});
