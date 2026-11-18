// @rstest-environment happy-dom
import { assertPageDataAppList } from '@app/shared-contracts/testing/page-data-app-list';
import { browserNetwork, serveApi, shellGatewayIssuer } from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { it } from 'effect-rstest';
import { StorefrontApplicationsApi } from '../../../storefront-registry/shared/apis/storefront-applications.ts';
import {
  CurrentMarketCatalogApi,
  CurrentMarketCatalogResponseSchema,
} from '../../shared/apis/current-market-catalog.ts';
import { MarketAdministrationApi } from '../../shared/apis/market-administration.ts';
import { MarketHistoryApi, MarketHistoryResponseSchema } from '../../shared/apis/market-history.ts';
import {
  administrationData,
  creationGrantData,
  marketCatalogData,
  marketHistoryData,
  storefrontsData,
} from '../../src/market-admin/page-data.ts';

const legalEntityId = '33333333-3333-4333-8333-333333333333';
const tenantId = '11111111-1111-4111-8111-111111111111';
const marketId = '44444444-4444-4444-8444-444444444444';
const market = { legalEntityId, marketId, tenantId };
const instant = '2030-01-01T00:00:00.000Z';
const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: marketId,
  resourceType: 'commerce.market-catalog.market',
  tenantId,
};
const definition = {
  channels: ['B2C'],
  definitionRevisionRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'commerce.market-catalog.market-definition-revision',
    tenantId,
  },
  effectivePeriod: { startsAt: instant },
  jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
  lifecycle: 'ACTIVE',
  marketCode: 'CZ_MAIN',
  marketRef,
  purpose: 'Czech commerce',
  revision: 1,
  sellingLegalEntityRef: {
    moduleId: 'core.identity',
    resourceId: legalEntityId,
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  supportedLocales: ['cs-CZ'],
};
const catalog = Schema.decodeUnknownSync(CurrentMarketCatalogResponseSchema)({
  associations: [],
  completenessEvidence: {
    observedAt: instant,
    ownerRevision: 'commerce.market-catalog.current:v1:generation:1',
    scope: { kind: 'EXACT_PREDICATE', predicateRef: 'commerce.market-catalog.current:v1:test' },
  },
  markets: [definition],
  observedAt: instant,
});
const history = Schema.decodeUnknownSync(MarketHistoryResponseSchema)({
  associations: [],
  definitions: [definition],
  marketRef,
});
const catalogReads: unknown[] = [];
const administrationReads: unknown[] = [];
const historyReads: unknown[] = [];
const storefrontReads: unknown[] = [];
const CatalogApi = CurrentMarketCatalogApi.prefix('/commerce-market-catalog-api');
const AdministrationApi = MarketAdministrationApi.prefix('/commerce-market-catalog-api');
const HistoryApi = MarketHistoryApi.prefix('/commerce-market-catalog-api');
const StorefrontsApi = StorefrontApplicationsApi.prefix('/storefront-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'commerce-market-catalog': '/commerce-market-catalog-api',
    'storefront-registry': '/storefront-registry-api',
  }).application,
  serveApi(
    CatalogApi,
    HttpApiBuilder.group(CatalogApi, 'currentMarketCatalog', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          catalogReads.push(payload);
          return catalog;
        }),
      ),
    ),
  ),
  serveApi(
    AdministrationApi,
    HttpApiBuilder.group(AdministrationApi, 'marketAdministration', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          administrationReads.push(payload);
          return { canCreateMarket: true };
        }),
      ),
    ),
  ),
  serveApi(
    HistoryApi,
    HttpApiBuilder.group(HistoryApi, 'marketHistory', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          historyReads.push(payload);
          return history;
        }),
      ),
    ),
  ),
  serveApi(
    StorefrontsApi,
    HttpApiBuilder.group(StorefrontsApi, 'storefrontApplications', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          storefrontReads.push(payload);
          return { applications: [], observedAt: instant };
        }),
      ),
    ),
  ),
);

it.layer(network, { excludeTestServices: true })('store app contract', (suite) => {
  suite.effect('marketCatalogData reloads only for its app list', () =>
    assertPageDataAppList({
      expectedApps: ['commerce-market-catalog'],
      input: legalEntityId,
      reads: () => catalogReads.length,
      store: marketCatalogData,
    }),
  );

  suite.effect('storefrontsData reloads only for its app list', () =>
    assertPageDataAppList({
      expectedApps: ['commerce-market-catalog', 'storefront-registry'],
      input: legalEntityId,
      reads: () => storefrontReads.length,
      store: storefrontsData,
    }),
  );

  suite.effect('administrationData reloads only for its app list', () =>
    assertPageDataAppList({
      expectedApps: ['commerce-market-catalog'],
      input: market,
      reads: () => administrationReads.length,
      store: administrationData,
    }),
  );

  suite.effect('creationGrantData reloads only for its app list', () =>
    assertPageDataAppList({
      expectedApps: ['commerce-market-catalog'],
      input: legalEntityId,
      reads: () => administrationReads.length,
      store: creationGrantData,
    }),
  );

  suite.effect('marketHistoryData reloads only for its app list', () =>
    assertPageDataAppList({
      expectedApps: ['commerce-market-catalog'],
      input: market,
      reads: () => historyReads.length,
      store: marketHistoryData,
    }),
  );
});
