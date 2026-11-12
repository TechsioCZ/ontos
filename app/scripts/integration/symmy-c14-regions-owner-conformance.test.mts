import { executeCreateMarketWithAuthorization } from '@app/commerce-market-catalog/api/client';
import { MarketRefSchema } from '@app/commerce-market-catalog/resources/market';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { grantTestTenantRoleAccess, liveFixtureSpiceDb } from '@app/core-runtime/testing/tenant-access';
import { executeSetSupportedCurrenciesWithAuthorization } from '@app/pricing/api/client';
import { SetSupportedCurrenciesV2PayloadSchema } from '@app/pricing-contracts/domain/currency-support';
import { CurrentSupportedCurrenciesRequestSchema } from '@app/pricing-contracts/current-supported-currencies';
import { executeCurrentSupportedCurrenciesWithAuthorization } from '@app/pricing-contracts/current-supported-currencies/client';
import { makeApiKeyGatewayNativeFixture } from '@app/shell-super-app/testing/api-key-gateway-native';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { assert, expect, it } from 'effect-rstest';
import { Config, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';

import {
  bindCustomerFixtureProviderKey as bindProviderKey,
  customerFixtureUuid as uuid,
  seedCustomerFixtureProviderPrincipal as seedPrincipal,
} from './support/symmy-c14-customer-native-authority.mts';
import {
  buildProductOwner,
  encodeProductComposition,
  nativePort,
  productComposition,
  startProductOwner,
} from './support/symmy-c14-product-runtime.mts';

const marketApp = 'commerce-market-catalog';
const symmyApp = 'symmy-integration';
const currencyRead = 'commerce.pricing.source-read';
const marketRead = 'commerce.market-catalog.source-read';
const ownerConfigs = [
  { appId: symmyApp, prefix: '/symmy-integration-api' },
  { appId: marketApp, prefix: '/commerce-market-catalog-api' },
  { appId: 'pricing', prefix: '/pricing-api' },
] as const;
const fixtureStageMessage = 'INTERNAL_C14 Regions fixture stage';
const sourceIssuer = 'INTERNAL_C14_REGIONS_OPERATOR';
const sourceNamespace = 'explicit-region-fixtures';
const sourceRegionIds = ['CZ fixture / alpha', 'CZ fixture / beta'];
const unsupportedFields = ['name', 'tax_rate', 'tax_included', 'payment_providers'];
const regionSchema = Schema.Struct({
  country_codes: Schema.Tuple([Schema.Literal('CZ')]),
  currency_code: Schema.Literal('CZK'),
  id: Schema.String.check(Schema.isPattern(/^~c14r1\.[a-zA-Z0-9_-]{43}$/u)),
  market_code: Schema.Literal('INTERNAL_C14_CZ_REGION_MARKET'),
  marketRef: MarketRefSchema,
  source_record_id: Schema.String,
});
const projectionSchema = Schema.Struct({
  contractVersion: Schema.Literal('INTERNAL_C14'),
  count: Schema.Int,
  limit: Schema.Int,
  offset: Schema.Int,
  projection: Schema.Literal('regions'),
  regions: Schema.Array(regionSchema),
  unsupported_fields: Schema.Array(Schema.String),
});
const problemSchema = Schema.Struct({ status: Schema.Int, title: Schema.String, type: Schema.String });
const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

it.live(
  'INTERNAL_C14 actual Shell Regions joins real CZ Market and Current Currency authority with bounded source paging and refusal controls',
  () =>
    Effect.scoped(
      Effect.gen(function* actualRegionsConformance() {
        const ports = new Map<string, number>();
        for (const { appId } of ownerConfigs) {
          let port = yield* nativePort;
          while ([...ports.values()].includes(port)) {
            port = yield* nativePort;
          }
          ports.set(appId, port);
        }
        const { contracts, snapshot } = yield* productComposition(
          Object.fromEntries([...ports].map(([appId, port]) => [appId, `http://127.0.0.1:${port}/`])),
        );
        yield* Effect.logInfo(fixtureStageMessage, { stage: 'published composition ready' });
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot: snapshot,
          mode: 'schema-only',
          purpose: 'implementation-1096-registered-workload-gateway',
        });
        yield* Effect.logInfo(fixtureStageMessage, { stage: 'owned database ready' });
        const admin = yield* PgClient.make({ url: Redacted.make(isolated.connections.admin.connectionString) });
        const tenantId = yield* uuid;
        const legalEntityId = yield* uuid;
        const routeId = yield* uuid;
        const marketId = yield* uuid;
        const marketRef = yield* Schema.decodeUnknownEffect(MarketRefSchema)({
          moduleId: 'commerce.market-catalog',
          resourceId: marketId,
          resourceType: 'commerce.market-catalog.market',
          tenantId,
        });
        const regionsProjectionJson = yield* json({
          routes: [
            {
              issuerId: sourceIssuer,
              legalEntityId,
              regions: sourceRegionIds.map((sourceRegionId) => ({ currencyCode: 'CZK', marketRef, sourceRegionId })),
              route: { integrationRouteId: routeId, tenantId },
              sourceNamespace,
            },
          ],
          schemaVersion: 1,
        });
        const shell = yield* makeApiKeyGatewayNativeFixture({
          ownedDatabase: isolated,
          productionGate: true,
          regionsProjectionJson,
          snapshotJson: yield* encodeProductComposition(snapshot),
        });
        yield* Effect.logInfo(fixtureStageMessage, { stage: 'production Shell fixture ready' });
        const slug = `internal-c14-regions-${tenantId}`;
        yield* admin`insert into core.tenants(tenant_id,name,slug,status,default_locale)
          values(${tenantId},'INTERNAL_C14 real Regions proof',${slug},'active','en')`;
        yield* admin`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status)
          values(${legalEntityId},${tenantId},'INTERNAL_C14 explicit CZ selling legal entity','CZ','INTERNAL_C14_REGIONS','active')`;
        const integration = yield* seedPrincipal(admin, tenantId, 'integration', shell.providerUserId);
        for (const module of snapshot.composition.modules) {
          yield* admin`insert into core.tenant_module_states(tenant_id,module_key,state) values(${tenantId},${module.moduleId},'active')`;
        }
        yield* Effect.logInfo(fixtureStageMessage, {
          stage: 'native tenant and provider principals enrolled',
        });
        const spiceEnvironment = yield* Config.all({
          SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
          SPICEDB_ENDPOINT: Config.String('SPICEDB_ENDPOINT'),
          SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
        });
        yield* grantTestTenantRoleAccess({
          holders: [
            {
              capabilityKeys: [
                'commerce.market-catalog.market.create',
                'commerce.pricing.currency-support.set',
                'commerce.pricing.currency-support.read-current',
              ],
              principalId: integration.issuerPrincipalId,
            },
          ],
          legalEntityIds: [legalEntityId],
          spiceDb: yield* liveFixtureSpiceDb(spiceEnvironment),
          tenantId,
          writerConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
        });
        yield* Effect.logInfo(fixtureStageMessage, { stage: 'current human setup rights granted' });
        for (const workload of ['integration.symmy-admit', 'integration.symmy-poll', marketRead, currencyRead]) {
          yield* admin`insert into core.access_workload_bindings(binding_id,incarnation,tenant_id,principal_id,workload_key,status)
            values(${yield* uuid},${yield* uuid},${tenantId},${integration.principalId},${workload},'active')`;
        }
        const key = yield* shell.issueFixtureProviderKey(integration);
        yield* bindProviderKey(admin, integration, key.providerKeyId);
        yield* key.acknowledgeBinding;
        const setupActorKey = yield* shell.issueFixtureSetupActorKey();
        const setupActor = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            principalId: TrustedPrincipalContextSchema.fields.principalId,
            tenantId: TrustedPrincipalContextSchema.fields.tenantId,
          }),
        )({ principalId: integration.issuerPrincipalId, tenantId });
        yield* bindProviderKey(admin, setupActor, setupActorKey.providerKeyId);
        yield* setupActorKey.acknowledgeBinding;

        yield* Effect.logInfo(fixtureStageMessage, { stage: 'actual API key bound' });
        const configuredPlan = {
          items: [
            {
              effects: [
                {
                  effectKey: 'actual-market-read',
                  operation: {
                    entrypointKey: 'commerce.market-catalog.api.current-market-catalog',
                    moduleId: 'commerce.market-catalog',
                    schemaVersion: '1',
                  },
                },
                {
                  effectKey: 'actual-currency-read',
                  operation: {
                    entrypointKey: 'commerce.pricing.api.current-supported-currencies',
                    moduleId: 'commerce.pricing',
                    schemaVersion: '1',
                  },
                },
              ],
              itemKey: 'source-region-read',
              source: {
                entityKind: 'REGION',
                issuerId: sourceIssuer,
                sourceNamespace,
                sourceRecordId: sourceRegionIds[0],
              },
            },
          ],
        };
        const routePlanJson = yield* json(configuredPlan);
        yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,principal_id,legal_entity_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_revision)
          values(${routeId},${tenantId},${integration.principalId},${legalEntityId},true,array['INTERNAL_C14'],${routePlanJson}::jsonb,'INTERNAL_C14_REGION_MAP_V1','adminRegions','INTERNAL_C14_REGION_ROUTE_V1')`;
        yield* Effect.logInfo(fixtureStageMessage, { stage: 'operator read route configured' });
        const environment = {
          APP_ENV_PATH: '/dev/null',
          DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
          DATABASE_URL: isolated.connections.runtime.connectionString,
          ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: shell.compositionSourceUrl,
          ONTOS_C14_TRACE_PROBLEMS: 'true',
          ONTOS_GATEWAY_ISSUER: shell.issuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: shell.publicJwks,
          ONTOS_SHELL_GATEWAY_BASE_URL: `${shell.baseUrl}/shell-super-app-api`,
        };
        const owners = new Map<string, Effect.Success<ReturnType<typeof startProductOwner>>>();
        for (const { appId, prefix } of ownerConfigs) {
          const contract = contracts.find(({ deployment }) => deployment.appId === appId);
          const port = yield* Effect.fromNullishOr(ports.get(appId));
          assert.isOk(contract);
          const owner = yield* startProductOwner({
            artifacts: yield* buildProductOwner(contract),
            contract,
            environment,
            port,
            prefix,
          });
          owners.set(appId, owner);
        }
        yield* Effect.logInfo(fixtureStageMessage, { stage: 'actual owner receivers ready' });
        const marketSetup = yield* shell.issueFixtureSetupGateway({ audience: marketApp, legalEntityId });
        const marketPort = yield* Effect.fromNullishOr(ports.get(marketApp));
        const pricingPort = yield* Effect.fromNullishOr(ports.get('pricing'));
        const created = yield* executeCreateMarketWithAuthorization(
          {
            channels: ['B2C'],
            effectivePeriod: { startsAt: yield* DateTime.now },
            jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
            lifecycle: 'ACTIVE',
            marketCode: 'INTERNAL_C14_CZ_REGION_MARKET',
            marketId,
            purpose: 'INTERNAL_C14 explicit CZ Regions projection',
            reason: 'INTERNAL_C14 native acceptance fixture',
            sellingLegalEntityRef: {
              moduleId: 'core.identity',
              resourceId: legalEntityId,
              resourceType: 'core.identity.legal-entity',
              tenantId,
            },
            supportedLocales: ['en'],
          },
          `Bearer ${marketSetup.token}`,
          yield* uuid,
          {
            baseUrl: `http://127.0.0.1:${marketPort}/commerce-market-catalog-api`,
            compositionRevision: snapshot.composition.revision,
            idempotencyKey: 'INTERNAL_C14_REGIONS_MARKET_SETUP',
          },
        );
        yield* Effect.logInfo(fixtureStageMessage, { stage: 'actual CZ Market created' });
        expect('marketRef' in created ? created.marketRef : created).toEqual(marketRef);
        const currencySetup = yield* shell.issueFixtureSetupGateway({ audience: 'pricing' });
        const currencyOptions = {
          baseUrl: `http://127.0.0.1:${pricingPort}/pricing-api`,
          compositionRevision: snapshot.composition.revision,
        };
        const now = yield* DateTime.now;
        const currencyRequest = yield* Schema.decodeUnknownEffect(CurrentSupportedCurrenciesRequestSchema)({
          effectiveAt: DateTime.formatIso(now),
          tenantId,
        });
        const absent = yield* executeCurrentSupportedCurrenciesWithAuthorization(
          currencyRequest,
          `Bearer ${currencySetup.token}`,
          yield* uuid,
          currencyOptions,
        );
        expect(absent).toMatchObject({
          code: 'pricing_currency_support_not_initialized',
          outcome: 'SUPPORTED_CURRENCIES_UNAVAILABLE',
        });
        const client = yield* HttpClient.HttpClient;
        const get = (query: string) =>
          client.get(`${shell.baseUrl}/api/symmy/v1/admin/regions?contractVersion=INTERNAL_C14&${query}`, {
            headers: { 'x-api-key': Redacted.value(key.secret) },
          });
        const noCurrency = yield* get('limit=1');
        expect(noCurrency.status).toBe(503);
        expect((yield* noCurrency.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(problemSchema)))).status).toBe(
          503,
        );
        const currencyPayload = yield* Schema.decodeUnknownEffect(SetSupportedCurrenciesV2PayloadSchema)({
          expectedState: { state: 'ABSENT' },
          intendedEffectivePeriod: { effectiveFrom: DateTime.formatIso(now), effectiveTo: null },
          intent: 'ESTABLISH_CURRENT',
          reason: 'INTERNAL_C14 explicitly configured CZK, no business default',
          schemaVersion: '2',
          supportedCurrencies: ['CZK'],
        });
        const currencyWriteSetup = yield* shell.issueFixtureSetupGateway({ audience: 'pricing' });
        yield* executeSetSupportedCurrenciesWithAuthorization(
          currencyPayload,
          `Bearer ${currencyWriteSetup.token}`,
          yield* uuid,
          { ...currencyOptions, idempotencyKey: 'INTERNAL_C14_REGIONS_CURRENCY_SETUP' },
        );
        yield* Effect.logInfo(fixtureStageMessage, { stage: 'actual Current CZK configured' });
        const firstResponse = yield* get('limit=1&offset=0');
        expect(firstResponse.status).toBe(200);
        const first = yield* firstResponse.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(projectionSchema, { onExcessProperty: 'error' })),
        );
        expect(first).toMatchObject({ count: 2, limit: 1, offset: 0, unsupported_fields: unsupportedFields });
        expect(first.regions).toMatchObject([
          {
            country_codes: ['CZ'],
            currency_code: 'CZK',
            market_code: 'INTERNAL_C14_CZ_REGION_MARKET',
            marketRef,
            source_record_id: sourceRegionIds[0],
          },
        ]);
        const second = yield* (yield* get('limit=1&offset=1')).json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(projectionSchema, { onExcessProperty: 'error' })),
        );
        expect(second.count).toBe(2);
        expect(second.regions[0]?.source_record_id).toBe(sourceRegionIds[1]);
        expect(second.regions[0]?.id).not.toBe(first.regions[0]?.id);
        const end = yield* (yield* get('limit=1&offset=2')).json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(projectionSchema, { onExcessProperty: 'error' })),
        );
        expect(end.count).toBe(2);
        expect(end.regions).toEqual([]);
        const invalid = yield* get('limit=101');
        expect(invalid.status).toBe(400);
        yield* admin`update core.access_workload_bindings set status='revoked',revoked_at=now() where tenant_id=${tenantId} and principal_id=${integration.principalId} and workload_key=${currencyRead}`;
        const denied = yield* get('limit=1');
        expect(denied.status).toBe(403);
        expect((yield* denied.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(problemSchema)))).status).toBe(403);
        yield* admin`insert into core.access_workload_bindings(binding_id,incarnation,tenant_id,principal_id,workload_key,status) values(${yield* uuid},${yield* uuid},${tenantId},${integration.principalId},${currencyRead},'active')`;
        expect((yield* get('limit=1')).status).toBe(200);
        const pricing = owners.get('pricing');
        assert.isOk(pricing);
        yield* pricing.child.kill();
        const outage = yield* get('limit=1');
        expect(outage.status).toBe(503);
        expect((yield* outage.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(problemSchema)))).status).toBe(503);
      }),
    ).pipe(Effect.provide(services)),
  180_000,
);
