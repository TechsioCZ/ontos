import { DateTime, Effect, Option, Redacted } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import { executeCreateMarketWithAuthorization } from '../../src/api/create-market-action-client.ts';
import { executeCurrentMarketCatalogWithAuthorization } from '../../src/api/current-market-catalog-client.ts';
import { executeRetireMarketWithAuthorization } from '../../src/api/retire-market-action-client.ts';
import { makeMarketRevisionNativeFixture, marketRevisionNativeServices } from '../fixtures/market-revision-native.ts';

// Genuine issuer, registered owner clients and real Core/Market/CCC persistence replace the old
// scripted gateway and direct-runtime fixture, which bypassed required retirement preparation.
it.layer(marketRevisionNativeServices, { excludeTestServices: true })((suite) =>
  suite.effect('joins real CCC reservation and settlement audits to original-actor retirement persistence', () =>
    Effect.gen(function* verifyPublishedReservationSettlement() {
      const owner = yield* makeMarketRevisionNativeFixture();
      expect(owner.relaySourcePrincipalId).not.toBe(owner.principal.principalId);
      const admit = Effect.fn('MarketRetirementAudit.admit')(function* admit(requestCorrelation: string) {
        const admitted = yield* owner.issue({
          audience: 'commerce-market-catalog',
          compositionRevision: owner.compositionRevision,
          legalEntityId: owner.legalEntityId,
          requestCorrelation,
        });
        return {
          authorization: Redacted.value(admitted.credential),
          options: {
            baseUrl: admitted.baseUrl,
            compositionRevision: owner.compositionRevision,
            idempotencyKey: requestCorrelation,
          },
          requestCorrelation,
        };
      });
      const creation = yield* admit('reservation-audit-create');
      const created = yield* executeCreateMarketWithAuthorization(
        {
          channels: ['B2C'],
          effectivePeriod: { startsAt: DateTime.subtract(owner.now, { hours: 1 }) },
          jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
          lifecycle: 'ACTIVE',
          marketCode: 'RESERVATION_AUDIT',
          marketId: owner.marketRef.resourceId,
          purpose: 'Verify real original-actor reservation settlement',
          reason: 'Create the Market through its public Action',
          sellingLegalEntityRef: owner.sellerRef,
          supportedLocales: ['cs-CZ'],
        },
        creation.authorization,
        creation.requestCorrelation,
        creation.options,
      );
      const effectiveAt = DateTime.makeUnsafe(DateTime.toEpochMillis(owner.now) + 1);
      const retirement = yield* admit('reservation-audit-retire');
      const retired = yield* executeRetireMarketWithAuthorization(
        {
          effectiveAt,
          expectedCurrentDefinitionRevisionRef: created.definitionRevisionRef,
          expectedRevision: created.revision,
          marketRef: owner.marketRef,
          reason: 'Require actual CCC reservation and committed settlement',
        },
        retirement.authorization,
        retirement.requestCorrelation,
        retirement.options,
      );
      expect(retired).toMatchObject({ changed: true, lifecycle: 'RETIRED', marketRef: owner.marketRef });
      const readback = yield* admit('reservation-audit-current');
      const current = yield* executeCurrentMarketCatalogWithAuthorization(
        { at: DateTime.makeUnsafe(DateTime.toEpochMillis(effectiveAt) + 1) },
        readback.authorization,
        readback.requestCorrelation,
        readback.options,
      );
      expect(
        current.markets.find((market) => market.marketRef.resourceId === owner.marketRef.resourceId),
      ).toMatchObject({
        lifecycle: 'RETIRED',
        marketRef: owner.marketRef,
      });
      const evidence = yield* owner.evidence();
      expect(evidence.admissions).toEqual([{ status: 'COMMITTED' }]);
      const invocations = evidence.invocations.filter(
        (invocation) =>
          invocation.actionKey === 'commerce.customer-context.reserve-market-retirement' &&
          invocation.status === 'succeeded',
      );
      expect(invocations).toHaveLength(2);
      expect(new Set(invocations.map((invocation) => invocation.actionInvocationId)).size).toBe(2);
      const settlements = [];
      for (const invocation of invocations) {
        expect(invocation.principalId).toEqual(Option.some(owner.principal.principalId));
        const joined = evidence.audits.filter(
          (audit) =>
            Option.contains(audit.actionInvocationId, invocation.actionInvocationId) &&
            audit.outcome === 'succeeded' &&
            audit.outcomeStage === 'execution' &&
            audit.outcomeCode === 'action_executed',
        );
        expect(joined).toHaveLength(1);
        const [audit] = joined;
        assert(audit !== undefined);
        expect(audit.principalId).toEqual(Option.some(owner.principal.principalId));
        assert(Option.isSome(audit.retirementReservation));
        settlements.push(audit.retirementReservation.value);
      }
      expect(settlements).toEqual(
        expect.arrayContaining([
          { lifecycle: 'RESERVED', reservationVersion: 1 },
          { lifecycle: 'COMMITTED', reservationVersion: 2 },
        ]),
      );
    }).pipe(Effect.scoped),
  ),
);
