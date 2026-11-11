// @rstest-environment happy-dom
// The market catalogue, administration, history and e-shop stores reload on a live change only when the apps they show
// changed: this vertical, and for the e-shop list also the storefront registry.
import { executeStorefrontApplications } from '@app/storefront-registry/api/storefront-applications-client';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { Effect, Fiber } from 'effect';
import { expect, it, rstest } from 'effect-rstest';

import { executeCurrentMarketCatalog } from '../../src/api/current-market-catalog-client.ts';
import { executeMarketAdministration } from '../../src/api/market-administration-client.ts';
import { executeMarketHistory } from '../../src/api/market-history-client.ts';
import {
  administrationData,
  creationGrantData,
  marketCatalogData,
  marketHistoryData,
  storefrontsData,
} from '../../src/market-admin/page-data.ts';

rstest.mock('@app/storefront-registry/api/storefront-applications-client');
rstest.mock('../../src/api/current-market-catalog-client.ts');
rstest.mock('../../src/api/market-administration-client.ts');
rstest.mock('../../src/api/market-history-client.ts');

const legalEntityId = '33333333-3333-4333-8333-333333333333';
const market = {
  legalEntityId,
  marketId: '44444444-4444-4444-8444-444444444444',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

const change = (apps: readonly string[]) =>
  globalThis.dispatchEvent(new CustomEvent(moduleChangeEvent, { detail: { apps } }));

const calls = () =>
  [executeCurrentMarketCatalog, executeMarketAdministration, executeMarketHistory, executeStorefrontApplications].map(
    (client) => rstest.mocked(client).mock.calls.length,
  );

it.live('each market-admin store reloads only for the apps it shows', () =>
  Effect.gen(function* scopedReloads() {
    // Each read stays in flight: a change that concerns a store restarts its load, any other change leaves it alone.
    rstest.mocked(executeCurrentMarketCatalog).mockReturnValue(Effect.never);
    rstest.mocked(executeMarketAdministration).mockReturnValue(Effect.never);
    rstest.mocked(executeMarketHistory).mockReturnValue(Effect.never);
    rstest.mocked(executeStorefrontApplications).mockReturnValue(Effect.never);
    const loads = yield* Effect.forEach(
      [
        marketCatalogData.preload(legalEntityId),
        storefrontsData.preload(legalEntityId),
        administrationData.preload(market),
        creationGrantData.preload(legalEntityId),
        marketHistoryData.preload(market),
      ],
      (load) => Effect.forkChild(load),
    );
    yield* Effect.sleep('10 millis');
    const unsubscribe = [
      marketCatalogData.subscribe(() => {
        marketCatalogData.snapshot(legalEntityId);
      }, legalEntityId),
      storefrontsData.subscribe(() => {
        storefrontsData.snapshot(legalEntityId);
      }, legalEntityId),
      administrationData.subscribe(() => {
        administrationData.snapshot(market);
      }, market),
      creationGrantData.subscribe(() => {
        creationGrantData.snapshot(legalEntityId);
      }, legalEntityId),
      marketHistoryData.subscribe(() => {
        marketHistoryData.snapshot(market);
      }, market),
    ];
    // catalogue, administration (two stores), history, e-shops
    expect(calls()).toEqual([1, 2, 1, 1]);
    change(['merchandise', 'party-registry']);
    yield* Effect.sleep('10 millis');
    expect(calls()).toEqual([1, 2, 1, 1]);
    change(['storefront-registry']);
    yield* Effect.sleep('10 millis');
    expect(calls()).toEqual([1, 2, 1, 2]);
    change(['commerce-market-catalog']);
    yield* Effect.sleep('10 millis');
    expect(calls()).toEqual([2, 4, 2, 3]);
    for (const stop of unsubscribe) {
      stop();
    }
    yield* Fiber.interruptAll(loads);
  }),
);
