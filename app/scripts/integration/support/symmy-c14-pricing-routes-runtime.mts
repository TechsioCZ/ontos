import { randomUUID } from 'node:crypto';

import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { grantTestTenantRoleAccess, liveFixtureSpiceDb } from '@app/core-runtime/testing/tenant-access';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import {
  makeApiKeyGatewayNativeFixture,
  SymmyPriceReadProjectionConfigurationSchema,
} from '@app/shell-super-app/testing/api-key-gateway-native';
import {
  SymmyRouteExecutionConfigurationSchema,
  SymmyJobRetentionPolicySchema,
  SymmyJobLifecyclePolicyRefSchema,
} from '@app/symmy-integration/symmy-internal-contracts';
import { PgClient } from '@effect/sql-pg';
import { Config, DateTime, Duration, Effect, Redacted, Schema } from 'effect';
import { assert } from 'effect-rstest';

import { installInternalC14PriceDispatchBarrier } from './symmy-c14-pricing-routes-barrier.mts';

import {
  bindCustomerFixtureProviderKey,
  seedCustomerFixtureProviderPrincipal,
} from './symmy-c14-customer-native-authority.mts';
import {
  buildProductOwner,
  buildProductWorker,
  encodeProductComposition,
  nativePortList,
  productComposition,
  startProductOwner,
  startProductWorker,
} from './symmy-c14-product-runtime.mts';
import {
  internalPricingRouteSource,
  internalPricingNativeSourceSystem,
  internalPricingPriceSource,
} from './symmy-c14-pricing-routes-plan.mts';

const workerKey = 'integration.symmy.execute-symmy-job';
const groupWrite = 'pricing.price-group-catalog.source-write';
const groupRead = 'pricing.price-group-catalog.source-read';
const priceWrite = 'commerce.pricing.source-write';
const priceRead = 'commerce.pricing.source-read';
const catalogRead = 'commerce.catalog.symmy-product-read';
const marketRead = 'commerce.market-catalog.source-read';
const groupModuleId = 'pricing.price-group-catalog';
const groupAudience = 'price-group-catalog';
const groupAssociationsRead = 'pricing.price-group-catalog.api.price-group-source-associations';
const groupCreateAction = 'pricing.price-group-catalog.create-price-group';
const groupRevisionAction = 'pricing.price-group-catalog.create-price-group-definition-revision';
const pricingModule = 'commerce.pricing';
const pricingAudience = 'pricing';
const definePriceOperation = 'commerce.pricing.define-price';
const revisePriceOperation = 'commerce.pricing.revise-price';
const rules = [
  ...[groupCreateAction, groupRevisionAction].map((actionKey) => ({
    audience: groupAudience,
    declarationKey: 'pricing.price-group-catalog.price-group-result-lookup.read',
    entrypointKey: 'pricing.price-group-catalog.api.price-group-result-lookup',
    legalEntityScope: 'forbidden' as const,
    recoveryOf: { actionKey, jobKey: workerKey },
    schemaVersion: '1',
    workloadKey: groupRead,
  })),
  ...[definePriceOperation, revisePriceOperation].map((actionKey) => {
    const rule = {
      audience: pricingAudience,
      declarationKey: 'commerce.pricing.price-source-result-lookup.read',
      entrypointKey: 'commerce.pricing.api.price-source-result-lookup',
      legalEntityScope: 'required' as const,
      recoveryOf: { actionKey, jobKey: workerKey },
      schemaVersion: '1',
      workloadKey: priceRead,
    };
    return actionKey === definePriceOperation ? { ...rule, allowHistoricalDeliveryRecovery: true } : rule;
  }),
  {
    audience: pricingAudience,
    declarationKey: 'commerce.pricing.price.read-definition',
    entrypointKey: 'commerce.pricing.api.price-definition',
    legalEntityScope: 'required' as const,
    schemaVersion: '1',
    workloadKey: priceRead,
  },
  {
    audience: groupAudience,
    declarationKey: 'pricing.price-group-catalog.price-group-source-associations.read',
    entrypointKey: groupAssociationsRead,
    legalEntityScope: 'forbidden' as const,
    schemaVersion: '1',
    workloadKey: groupRead,
  },
  {
    audience: groupAudience,
    declarationKey: 'pricing.price-group-catalog.price-group-catalog-head.read',
    entrypointKey: 'pricing.price-group-catalog.api.price-group-catalog-head',
    legalEntityScope: 'forbidden' as const,
    schemaVersion: '1',
    workloadKey: groupRead,
  },
  {
    audience: groupAudience,
    declarationKey: 'pricing.price-group-catalog.price-group.create',
    entrypointKey: groupCreateAction,
    legalEntityScope: 'forbidden' as const,
    schemaVersion: '1',
    workloadKey: groupWrite,
  },
  {
    audience: groupAudience,
    declarationKey: 'pricing.price-group-catalog.price-group-definition-revision.create',
    entrypointKey: groupRevisionAction,
    legalEntityScope: 'forbidden' as const,
    schemaVersion: '1',
    workloadKey: groupWrite,
  },
  {
    audience: pricingAudience,
    declarationKey: 'commerce.pricing.price.define',
    entrypointKey: definePriceOperation,
    legalEntityScope: 'required' as const,
    schemaVersion: '2',
    workloadKey: priceWrite,
  },
  {
    audience: pricingAudience,
    declarationKey: 'commerce.pricing.price.revise',
    entrypointKey: revisePriceOperation,
    legalEntityScope: 'required' as const,
    schemaVersion: '2',
    workloadKey: priceWrite,
  },
].map((rule) => ({ ...rule, jobKey: workerKey, workerKey }));
// These exact nested Reads are independent from the upstream Symmy worker enrollment.
const pricingDelegationRules = [
  {
    audience: 'catalog',
    declarationKey: 'commerce.catalog.selection-evidence.read',
    entrypointKey: 'commerce.catalog.api.selection-evidence',
    legalEntityScope: 'forbidden' as const,
    schemaVersion: '1',
    workloadKey: catalogRead,
  },
  {
    audience: 'commerce-market-catalog',
    declarationKey: 'commerce.market-catalog.market-catalog.read',
    entrypointKey: 'commerce.market-catalog.api.current-market-catalog',
    legalEntityScope: 'required' as const,
    schemaVersion: '1',
    workloadKey: marketRead,
  },
].map((rule) => ({ ...rule, jobKey: workerKey, sourceWorkloadKey: priceWrite }));
/** One authority-only enrollment: an owner operation the route may use, never an intent. */
const enrolled = (
  entityKind: 'PRICE' | 'PRICE_GROUP',
  itemKey: string,
  sourceRecordId: string,
  operations: Readonly<Record<string, { entrypointKey: string; moduleId: string; schemaVersion: string }>>,
) => ({
  effects: Object.entries(operations).map(([effectKey, operation]) => ({ effectKey, operation })),
  itemKey,
  source: {
    entityKind,
    issuerId: internalPricingRouteSource.issuerId,
    sourceNamespace: internalPricingRouteSource.namespace,
    sourceRecordId,
  },
});
const encodeRoute = Schema.encodeEffect(Schema.fromJsonString(SymmyRouteExecutionConfigurationSchema));
const encodePolicy = Schema.encodeEffect(Schema.fromJsonString(SymmyJobLifecyclePolicyRefSchema));
const encodePolicies = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(SymmyJobRetentionPolicySchema)));

/** Starts genuine owner HTTP runtimes and separate actual credentials; no owner business rows are seeded. */
export const makeInternalC14PricingRouteFixture = Effect.fn('InternalC14PricingRoutes.fixture')(
  function* makeFixture() {
    const [symmyPort, groupPort, catalogPort, pricingPort, pricingTransportPort, marketPort] = yield* nativePortList(6);
    assert.isDefined(symmyPort);
    assert.isDefined(groupPort);
    assert.isDefined(catalogPort);
    assert.isDefined(pricingPort);
    assert.isDefined(pricingTransportPort);
    assert.isDefined(marketPort);
    const priceBarrier = yield* installInternalC14PriceDispatchBarrier({
      port: pricingTransportPort,
      targetOrigin: `http://127.0.0.1:${pricingPort}`,
    });
    const { contracts, snapshot } = yield* productComposition({
      catalog: `http://127.0.0.1:${catalogPort}/`,
      'commerce-market-catalog': `http://127.0.0.1:${marketPort}/`,
      'price-group-catalog': `http://127.0.0.1:${groupPort}/`,
      pricing: `http://127.0.0.1:${pricingTransportPort}/`,
      'symmy-integration': `http://127.0.0.1:${symmyPort}/`,
    });
    const symmy = contracts.find(({ deployment }) => deployment.appId === 'symmy-integration');
    const group = contracts.find(({ deployment }) => deployment.appId === 'price-group-catalog');
    const catalog = contracts.find(({ deployment }) => deployment.appId === 'catalog');
    const pricing = contracts.find(({ deployment }) => deployment.appId === 'pricing');
    const market = contracts.find(({ deployment }) => deployment.appId === 'commerce-market-catalog');
    assert.isOk(catalog);
    assert.isOk(pricing);
    assert.isOk(market);
    assert.isOk(symmy);
    assert.isOk(group);
    const isolated = yield* makeIsolatedNativeDatabaseFixture({
      compositionSnapshot: snapshot,
      mode: 'schema-only',
      purpose: 'implementation-1096-registered-workload-gateway',
    });
    const admin = yield* PgClient.make({ url: Redacted.make(isolated.connections.admin.connectionString) });
    const tenantId = randomUUID();
    const legalEntityId = randomUUID();
    const routeId = randomUUID();
    const readRouteId = randomUUID();
    const selectedRouteId = randomUUID();
    const sourceRouteId = randomUUID();
    const priceReadSources = yield* Schema.decodeUnknownEffect(SymmyPriceReadProjectionConfigurationSchema)({
      routes: [
        {
          issuerId: internalPricingRouteSource.issuerId,
          legalEntityId,
          routeId: readRouteId,
          sourceNamespace: internalPricingRouteSource.namespace,
          sourceSystem: internalPricingNativeSourceSystem,
          tenantId,
        },
      ],
      schemaVersion: 1,
    });
    const shell = yield* makeApiKeyGatewayNativeFixture({
      additionalRelaySources: [{ registeredWorkloads: pricingDelegationRules, sourceAppId: 'pricing' }],
      ownedDatabase: isolated,
      priceReadProjectionJson: yield* Schema.encodeEffect(
        Schema.fromJsonString(SymmyPriceReadProjectionConfigurationSchema),
      )(priceReadSources),
      productionGate: true,
      relaySource: { registeredWorkloads: rules, sourceAppId: 'symmy-integration' },
      snapshotJson: yield* encodeProductComposition(snapshot),
    });
    const tenantSlug = `internal-c14-pricing-${tenantId}`;
    yield* admin`insert into core.tenants(tenant_id,name,slug,status,default_locale)
      values(${tenantId},'INTERNAL_C14 Pricing route conformance',${tenantSlug},'active','en')`;
    yield* admin`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status)
      values(${legalEntityId},${tenantId},'INTERNAL_C14 Pricing explicit fixture entity','CZ','INTERNAL_C14','active')`;
    const integration = yield* seedCustomerFixtureProviderPrincipal(
      admin,
      tenantId,
      'integration',
      shell.providerUserId,
    );
    assert.isOk(shell.relaySourceProviderUserId);
    const modulePrincipal = yield* seedCustomerFixtureProviderPrincipal(
      admin,
      tenantId,
      'service',
      shell.relaySourceProviderUserId,
    );
    const systemId = randomUUID();
    yield* admin`insert into core.principals(principal_id,tenant_id,kind,status,display_name)
      values(${systemId},${tenantId},'system','active','INTERNAL_C14 actual Pricing route worker')`;
    for (const module of snapshot.composition.modules) {
      yield* admin`insert into core.tenant_module_states(tenant_id,module_key,state)
        values(${tenantId},${module.moduleId},'active')`;
    }
    const workloads = [
      'integration.symmy-admit',
      'integration.symmy-poll',
      groupWrite,
      groupRead,
      priceWrite,
      priceRead,
      catalogRead,
      marketRead,
    ];
    for (const principalId of [integration.principalId, systemId]) {
      for (const workload of principalId === systemId ? [workerKey, ...workloads] : workloads) {
        yield* admin`insert into core.access_workload_bindings(binding_id,incarnation,tenant_id,principal_id,workload_key,status)
          values(${randomUUID()},${randomUUID()},${tenantId},${principalId},${workload},'active')`;
      }
    }
    const key = yield* shell.issueFixtureProviderKey({
      ...integration,
      issuerPrincipalId: integration.issuerPrincipalId,
    });
    yield* bindCustomerFixtureProviderKey(admin, integration, key.providerKeyId);
    yield* key.acknowledgeBinding;
    const setupActorKey = yield* shell.issueFixtureSetupActorKey();
    const setupActor = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        principalId: TrustedPrincipalContextSchema.fields.principalId,
        tenantId: TrustedPrincipalContextSchema.fields.tenantId,
      }),
    )({ principalId: integration.issuerPrincipalId, tenantId });
    yield* bindCustomerFixtureProviderKey(admin, setupActor, setupActorKey.providerKeyId);
    yield* setupActorKey.acknowledgeBinding;
    const moduleKey = yield* shell.issueFixtureRelaySourceProviderKey({
      ...modulePrincipal,
      issuerPrincipalId: modulePrincipal.issuerPrincipalId,
    });
    yield* bindCustomerFixtureProviderKey(admin, modulePrincipal, moduleKey.providerKeyId);
    yield* moduleKey.acknowledgeBinding;
    const pricingProvider = shell.additionalRelaySourceProviderUsers.find(
      ({ sourceAppId }) => sourceAppId === 'pricing',
    );
    assert.isOk(pricingProvider);
    const pricingPrincipal = yield* seedCustomerFixtureProviderPrincipal(
      admin,
      tenantId,
      'service',
      pricingProvider.providerUserId,
    );
    const pricingKey = yield* shell.issueFixtureModuleProviderKey({
      ...pricingPrincipal,
      issuerPrincipalId: pricingPrincipal.issuerPrincipalId,
      sourceAppId: 'pricing',
    });
    yield* bindCustomerFixtureProviderKey(admin, pricingPrincipal, pricingKey.providerKeyId);
    yield* pricingKey.acknowledgeBinding;
    const spiceEnvironment = yield* Config.all({
      SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
      SPICEDB_ENDPOINT: Config.String('SPICEDB_ENDPOINT'),
      SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
    });
    yield* grantTestTenantRoleAccess({
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      holders: [
        {
          capabilityKeys: [
            'commerce.catalog.product-unit.create',
            'commerce.catalog.product.create',
            'commerce.catalog.selection-evidence.read',
            'commerce.pricing.currency-support.read-current',
            'commerce.market-catalog.market.create',
            'commerce.pricing.currency-support.set',
          ],
          principalId: integration.issuerPrincipalId,
        },
      ],
      legalEntityIds: [legalEntityId],
      spiceDb: yield* liveFixtureSpiceDb(spiceEnvironment),
      tenantId,
    });
    const [groupArtifacts, symmyArtifacts, workerArtifact, catalogArtifacts, pricingArtifacts, marketArtifacts] =
      yield* Effect.all(
        [
          buildProductOwner(group),
          buildProductOwner(symmy),
          buildProductWorker(symmy),
          buildProductOwner(catalog),
          buildProductOwner(pricing),
          buildProductOwner(market),
        ],
        { concurrency: 3 },
      );
    // A public price list code is 1 to 80 characters of letters, digits, dot, underscore and hyphen.
    const firstRecordId = 'CZ-wholesale_A.1';
    const secondRecordId = `CZ-wholesale_${'B'.repeat(60)}`;
    const lifecyclePolicy = yield* Schema.decodeUnknownEffect(SymmyJobLifecyclePolicyRefSchema)({
      policyId: 'INTERNAL_C14_PRICING_RETENTION',
      revision: '1',
    });
    const readPlan = {
      items: [
        {
          effects: [
            {
              effectKey: 'price-source-read',
              operation: {
                entrypointKey: 'commerce.pricing.api.price-group-source-prices',
                moduleId: pricingModule,
                schemaVersion: '1',
              },
            },
            {
              effectKey: 'price-schedule-read',
              operation: {
                entrypointKey: 'commerce.pricing.api.price-schedule',
                moduleId: pricingModule,
                schemaVersion: '1',
              },
            },
            {
              effectKey: 'group-source-read',
              operation: {
                entrypointKey: groupAssociationsRead,
                moduleId: groupModuleId,
                schemaVersion: '1',
              },
            },
            {
              effectKey: 'group-definition-read',
              operation: {
                entrypointKey: 'pricing.price-group-catalog.api.price-group-definition',
                moduleId: groupModuleId,
                schemaVersion: '1',
              },
            },
          ],
          itemKey: 'group-read',
          source: {
            entityKind: 'PRICE_GROUP',
            issuerId: internalPricingRouteSource.issuerId,
            sourceNamespace: internalPricingRouteSource.namespace,
            sourceRecordId: firstRecordId,
          },
        },
      ],
      sourceRouteId,
    };
    yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,legal_entity_id,principal_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_revision)
      values(${readRouteId},${tenantId},${legalEntityId},${integration.principalId},true,array['INTERNAL_C14'],${yield* encodeRoute(yield* Schema.decodeUnknownEffect(SymmyRouteExecutionConfigurationSchema)(readPlan))}::jsonb,${internalPricingRouteSource.mappingVersion},'priceLists',${internalPricingRouteSource.routeRevision})`;
    const policies = yield* encodePolicies(
      yield* Schema.decodeUnknownEffect(Schema.Array(SymmyJobRetentionPolicySchema))([
        {
          ...lifecyclePolicy,
          governanceLegalEntityId: legalEntityId,
          retentionMs: Duration.toMillis(Duration.minutes(1)),
          routeId,
          targetLegalEntityId: legalEntityId,
          tenantId,
        },
        {
          ...lifecyclePolicy,
          governanceLegalEntityId: legalEntityId,
          retentionMs: Duration.toMillis(Duration.minutes(1)),
          routeId: selectedRouteId,
          targetLegalEntityId: legalEntityId,
          tenantId,
        },
      ]),
    );
    const environment = {
      APP_ENV_PATH: '/dev/null',
      DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
      DATABASE_URL: isolated.connections.runtime.connectionString,
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: shell.compositionSourceUrl,
      ONTOS_C14_TRACE_PROBLEMS: 'true',
      ONTOS_GATEWAY_ISSUER: shell.issuer,
      ONTOS_GATEWAY_MODULE_API_KEY: Redacted.value(moduleKey.secret),
      ONTOS_GATEWAY_PUBLIC_JWKS: shell.publicJwks,
      ONTOS_SHELL_GATEWAY_BASE_URL: `${shell.baseUrl}/shell-super-app-api`,
      ONTOS_SYMMY_JOB_RETENTION_POLICIES: policies,
    };
    const groupOwner = yield* startProductOwner({
      artifacts: groupArtifacts,
      contract: group,
      environment,
      port: groupPort,
      prefix: '/price-group-catalog-api',
    });
    const symmyOwner = yield* startProductOwner({
      artifacts: symmyArtifacts,
      contract: symmy,
      environment,
      port: symmyPort,
      prefix: '/symmy-integration-api',
    });
    yield* startProductOwner({
      artifacts: catalogArtifacts,
      contract: catalog,
      environment,
      port: catalogPort,
      prefix: '/catalog-api',
    });
    yield* startProductOwner({
      artifacts: marketArtifacts,
      contract: market,
      environment,
      port: marketPort,
      prefix: '/commerce-market-catalog-api',
    });
    const pricingOwner = yield* startProductOwner({
      artifacts: pricingArtifacts,
      contract: pricing,
      environment: { ...environment, ONTOS_GATEWAY_MODULE_API_KEY: Redacted.value(pricingKey.secret) },
      port: pricingPort,
      prefix: '/pricing-api',
    });
    const worker = yield* startProductWorker(workerArtifact, {
      ...environment,
      ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_PRICING_ROUTES',
    });
    const at = DateTime.formatIso(DateTime.add(yield* DateTime.now, { seconds: 30 }));
    // The route enrolls operations and grant refs, never a list or a price: the admission builds the plan.
    const configuredPlan = yield* Schema.decodeUnknownEffect(SymmyRouteExecutionConfigurationSchema)({
      items: [
        enrolled('PRICE_GROUP', 'price-list-enrollment', 'INTERNAL_C14_PRICE_LIST_ENROLLMENT', {
          'catalog-head-read': {
            entrypointKey: 'pricing.price-group-catalog.api.price-group-catalog-head',
            moduleId: groupModuleId,
            schemaVersion: '1',
          },
          'group-create': { entrypointKey: groupCreateAction, moduleId: groupModuleId, schemaVersion: '1' },
        }),
        enrolled('PRICE', 'price-enrollment', 'INTERNAL_C14_PRICE_ALLOWLIST', {
          'price-define-authority': {
            entrypointKey: definePriceOperation,
            moduleId: pricingModule,
            schemaVersion: '2',
          },
        }),
      ],
      priceSource: internalPricingPriceSource,
      pricingSourceSystem: internalPricingNativeSourceSystem,
      sourceRouteId,
    });
    yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,legal_entity_id,principal_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_revision,lifecycle_policy)
      values(${routeId},${tenantId},${legalEntityId},${integration.principalId},true,array['INTERNAL_C14'],${yield* encodeRoute(configuredPlan)}::jsonb,${internalPricingRouteSource.mappingVersion},'priceListsBatchUpsert',${internalPricingRouteSource.routeRevision},${yield* encodePolicy(lifecyclePolicy)}::jsonb)`;
    // The prices route enrolls the owner operations it may write with, the read that authorizes a request and the
    // grant refs of a price assertion. It names no price list: the body does, and the route accepts only lists its
    // own source created. Its REVISE reads use the scope of the price list read route above.
    const pricesPlan = yield* Schema.decodeUnknownEffect(SymmyRouteExecutionConfigurationSchema)({
      items: [
        enrolled('PRICE', 'price-enrollment', 'INTERNAL_C14_PRICE_ALLOWLIST', {
          'group-source-associations-read': {
            entrypointKey: groupAssociationsRead,
            moduleId: groupModuleId,
            schemaVersion: '1',
          },
          'price-define-authority': {
            entrypointKey: definePriceOperation,
            moduleId: pricingModule,
            schemaVersion: '2',
          },
          'price-revise-authority': {
            entrypointKey: revisePriceOperation,
            moduleId: pricingModule,
            schemaVersion: '2',
          },
        }),
      ],
      priceSource: internalPricingPriceSource,
      pricingSourceSystem: internalPricingNativeSourceSystem,
      sourceRouteId,
    });
    yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,legal_entity_id,principal_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_revision,lifecycle_policy)
      values(${selectedRouteId},${tenantId},${legalEntityId},${integration.principalId},true,array['INTERNAL_C14'],${yield* encodeRoute(pricesPlan)}::jsonb,${internalPricingRouteSource.mappingVersion},'priceListPricesBatch',${internalPricingRouteSource.routeRevision},${yield* encodePolicy(lifecyclePolicy)}::jsonb)`;
    return {
      admin,
      at,
      catalogPort,
      environment,
      firstRecordId,
      groupOwner,
      integration,
      isolated,
      key,
      legalEntityId,
      lifecyclePolicy,
      marketPort,
      moduleKey,
      priceBarrier,
      pricingOwner,
      pricingPort,
      readRouteId,
      routeId,
      secondRecordId,
      selectedRouteId,
      shell,
      snapshot,
      sourceRouteId,
      symmyContract: symmy,
      symmyOwner,
      systemId,
      tenantId,
      worker,
      workerArtifact,
    };
  },
);
