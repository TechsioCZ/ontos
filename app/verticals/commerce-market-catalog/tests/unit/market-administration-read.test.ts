import type { ContextAccessResult, OperationalScope } from '@app/core-runtime';
import {
  ContextAccess,
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { MarketAdministrationRequestSchema } from '../../shared/apis/market-administration.ts';
import { handleMarketAdministration, marketAdministrationGrants } from '../../src/api/market-administration.read.ts';
import { MarketAdministrationStateRowSchema } from '../../src/persistence/market-administration-state-persistence.ts';
import type {
  MarketAdministrationStatePersistence,
  MarketAdministrationStateRow,
} from '../../src/persistence/market-administration-state-persistence.ts';
import { MarketCatalogReadPersistenceUnavailable } from '../../src/persistence/market-history-routine.ts';
import { MarketRetirementIntentSnapshotSchema } from '../../src/persistence/market-retirement-intent-persistence.ts';
import type { MarketRetirementIntentSnapshot } from '../../src/persistence/market-retirement-intent-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '22222222-2222-4222-8222-222222222222';
const sellerId = '33333333-3333-4333-8333-333333333333';
const principalId = '44444444-4444-4444-8444-444444444444';
const marketId = '55555555-5555-4555-8555-555555555555';
const definitionRevisionId = '66666666-6666-4666-8666-666666666666';
const intentId = '77777777-7777-4777-8777-777777777777';

const scope: OperationalScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    authContextRef: 'session:market-administration',
    authMethod: 'session',
    legalEntityId: sellerId,
    principalId,
    tenantId,
  }),
  correlationId: 'market-administration-test',
};

const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: marketId,
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;
const rootKey = `commerce.market-catalog:commerce.market-catalog.market-catalog-root:${sellerId}`;
const marketKey = `commerce.market-catalog:commerce.market-catalog.market:${marketId}`;

const withMarket = Schema.decodeUnknownSync(MarketAdministrationRequestSchema)({ marketRef });
const withoutMarket = Schema.decodeUnknownSync(MarketAdministrationRequestSchema)({});

const pendingIntent = {
  actingPrincipalId: principalId,
  actionInvocationId: '88888888-8888-4888-8888-888888888888',
  effectiveAt: '2030-01-01T00:00:00.000Z',
  expectedDefinitionRevisionId: definitionRevisionId,
  expectedRevision: 3,
  intentId,
  legalEntityId: sellerId,
  marketId,
  reason: 'Ukončení prodeje na trhu.',
  stage: 'RESERVATION_REQUESTED',
  tenantId,
};

const decodeIntent = Schema.decodeUnknownSync(MarketRetirementIntentSnapshotSchema);
const encodeIntent = Schema.encodeSync(MarketRetirementIntentSnapshotSchema);
const decodeRow = Schema.decodeUnknownSync(MarketAdministrationStateRowSchema);
const baseRow = { currentDefinitionRevisionId: definitionRevisionId, marketId, revision: 3 };

const stateRow = (): MarketAdministrationStateRow => decodeRow(baseRow);
const stateRowWith = (retirementIntent: MarketRetirementIntentSnapshot): MarketAdministrationStateRow =>
  decodeRow({ ...baseRow, retirementIntent: encodeIntent(retirementIntent) });

const persistence = (
  state: Option.Option<MarketAdministrationStateRow> | 'unavailable',
): MarketAdministrationStatePersistence => ({
  state: () =>
    state === 'unavailable'
      ? Effect.fail(
          new MarketCatalogReadPersistenceUnavailable({
            code: 'market_catalog_read_persistence_unavailable',
            reason: 'unavailable',
          }),
        )
      : Effect.succeed(state),
});

const allGrants = { canAdminister: true, canCreateMarket: true };

const context = (
  state: Option.Option<MarketAdministrationStateRow> | 'unavailable',
  grants: { readonly canAdminister: boolean; readonly canCreateMarket: boolean },
) => ({
  prepared: grants,
  readKey: 'commerce.market-catalog.api.market-administration',
  scope,
  services: persistence(state),
});

/** Decides every requested resource with `decide`; the other context checks are never used by this read. */
const contextAccess = (decide: (key: string) => ContextAccessResult['decision']) =>
  ContextAccess.of({
    legalEntities: () => Effect.succeed([]),
    modules: () => Effect.succeed([]),
    resources: ({ resources }) =>
      Effect.succeed(
        resources.map((resource) => {
          const key = `${resource.moduleId}:${resource.resourceType}:${resource.resourceId}`;
          return { decision: decide(key), key };
        }),
      ),
    tenants: () => Effect.succeed([]),
  });

describe('Market administration read', () => {
  it.effect('reports the aggregate revision, current definition and the newest retirement without its intent id', () =>
    Effect.gen(function* pendingRetirement() {
      const { result } = yield* handleMarketAdministration(
        withMarket,
        context(Option.some(stateRowWith(decodeIntent(pendingIntent))), {
          canAdminister: true,
          canCreateMarket: false,
        }),
      );
      expect(result).toEqual({
        canCreateMarket: false,
        market: {
          canAdminister: true,
          currentDefinitionRevisionRef: {
            moduleId: 'commerce.market-catalog',
            resourceId: definitionRevisionId,
            resourceType: 'commerce.market-catalog.market-definition-revision',
            tenantId,
          },
          marketRef,
          retirement: {
            marketRef,
            outcome: 'pending',
            retirementIntentId: intentId,
            stage: 'RESERVATION_REQUESTED',
          },
          revision: 3,
        },
      });
    }),
  );

  it.effect('reports a failed retirement with its typed reason and omits a retirement never requested', () =>
    Effect.gen(function* retirementOutcomes() {
      const failed = yield* handleMarketAdministration(
        withMarket,
        context(
          Option.some(
            stateRowWith(
              decodeIntent({ ...pendingIntent, failureReason: 'replacement_impact_unresolved', stage: 'FAILED' }),
            ),
          ),
          allGrants,
        ),
      );
      expect(failed.result.market?.retirement).toEqual({
        marketRef,
        outcome: 'failed',
        reason: 'replacement_impact_unresolved',
        retirementIntentId: intentId,
      });
      const never = yield* handleMarketAdministration(withMarket, context(Option.some(stateRow()), allGrants));
      expect(never.result.market).not.toHaveProperty('retirement');
    }),
  );

  it.effect('answers only the creation grant without a Market and hides foreign or unknown Markets', () =>
    Effect.gen(function* scopeRules() {
      const overview = yield* handleMarketAdministration(withoutMarket, context(Option.none(), allGrants));
      expect(overview.result).toEqual({ canCreateMarket: true });
      const foreign = Schema.decodeUnknownSync(MarketAdministrationRequestSchema)({
        marketRef: { ...marketRef, tenantId: foreignTenantId },
      });
      const foreignError = yield* handleMarketAdministration(foreign, context(Option.some(stateRow()), allGrants)).pipe(
        Effect.flip,
      );
      expect(Schema.is(ReadHandlerNotFound)(foreignError)).toBe(true);
      const missing = yield* handleMarketAdministration(withMarket, context(Option.none(), allGrants)).pipe(
        Effect.flip,
      );
      expect(Schema.is(ReadHandlerNotFound)(missing)).toBe(true);
      const unavailable = yield* handleMarketAdministration(withMarket, context('unavailable', allGrants)).pipe(
        Effect.flip,
      );
      expect(Schema.is(ReadHandlerUnavailable)(unavailable)).toBe(true);
    }),
  );

  it.effect('decides the exact write permissions the Market Actions enforce', () =>
    Effect.gen(function* grants() {
      const adminOnly = yield* marketAdministrationGrants(withMarket, scope).pipe(
        Effect.provideService(
          ContextAccess,
          contextAccess((key) => (key === marketKey ? 'allowed' : 'denied')),
        ),
      );
      expect(adminOnly).toEqual({ canAdminister: true, canCreateMarket: false });
      const creator = yield* marketAdministrationGrants(withoutMarket, scope).pipe(
        Effect.provideService(
          ContextAccess,
          contextAccess((key) => (key === rootKey ? 'allowed' : 'denied')),
        ),
      );
      expect(creator).toEqual({ canAdminister: false, canCreateMarket: true });
      const unknown = yield* marketAdministrationGrants(withMarket, scope).pipe(
        Effect.provideService(
          ContextAccess,
          contextAccess(() => 'unavailable'),
        ),
        Effect.flip,
      );
      expect(Schema.is(ReadHandlerUnavailable)(unknown)).toBe(true);
    }),
  );
});
