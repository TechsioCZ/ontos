import { randomUUID } from 'node:crypto';

import {
  CreateProductActionAuthenticationProblemSchema,
  CreateProductActionForbiddenProblemSchema,
  CreateProductPayloadSchema,
} from '@app/catalog/api/create-product-action';
import {
  CreateProductRecoveryInvalidProblemSchema,
  CreateProductRecoveryResponseSchema,
} from '@app/catalog/api/create-product-recovery';
import { PriceSourceResultLookupResponseSchema } from '@app/pricing/apis/price-source-result-lookup';
import { PriceDefinitionSchema } from '@app/pricing-contracts/domain/price-definition';
import { ProductActionInvocationIdSchema, ProductSchema } from '@app/catalog/domain/product';
import { ProductRefSchema } from '@app/catalog/resources/product';
import { VariantRefSchema } from '@app/catalog/resources/variant';
import type { OntosModuleDeploymentContract } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { grantTestTenantRoleAccess, liveFixtureSpiceDb } from '@app/core-runtime/testing/tenant-access';
import { bootstrapInternalC14PricingSourceAuthority } from '@app/pricing/testing/c14-source-authority-bootstrap';
import { bootstrapInternalC14PriceInputFacts } from '@app/pricing/testing/c14-price-input-bootstrap';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { SymmyEffectOutcomeSchema, SymmyItemOutcomeSchema } from '@app/shared-contracts/symmy';
import { makeApiKeyGatewayNativeFixture } from '@app/shell-super-app/testing/api-key-gateway-native';
import { SymmyJobStatusResponseSchema } from '@app/symmy-integration/api/symmy-job-status';
import { SymmyInternalExecutionPlanSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { assert, expect, it } from 'effect-rstest';
import {
  Array as EffectArray,
  Config,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Queue,
  Redacted,
  Schema,
} from 'effect';
import { FetchHttpClient, HttpBody, HttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';

import {
  bootstrapInternalC14SupportedProductPriceFacts,
  internalReadyProductSource,
  makeInternalC14ReadyProductPreparation,
  makeInternalC14AcceptedProductPricePlan,
  internalPriceSource,
  makeInternalC14PriceFailurePlan,
} from './support/symmy-c14-product-price-plan.mts';
import { issueSymmyC14RecoveryAssertion } from './support/symmy-c14-product-recovery.mts';
import { internalProductSource, makeSymmyC14ProductPlan } from './support/symmy-c14-product-plan.mts';
import {
  SymmyC14ProductFixtureUnavailable,
  buildProductOwner,
  buildProductWorker,
  encodeProductComposition,
  nativePort,
  productComposition,
  startProductOwner,
  startProductWorker,
} from './support/symmy-c14-product-runtime.mts';

const workerKey = 'integration.symmy.execute-symmy-job';
const catalogImport = 'commerce.catalog.symmy-product-import';
const catalogRead = 'commerce.catalog.symmy-product-read';
const catalogModule = 'commerce.catalog';
const catalogApp = 'catalog';
const catalogSelectionRead = 'commerce.catalog.selection-evidence.read';
const catalogRecoveryProvider = {
  entrypointKey: 'commerce.catalog.api.create-product-recovery',
  moduleId: catalogModule,
};
const priceWrite = 'commerce.pricing.source-write';
const priceRead = 'commerce.pricing.source-read';
const marketRead = 'commerce.market-catalog.source-read';
const pricingModule = 'commerce.pricing';
const marketApp = 'commerce-market-catalog';
const fixturePurpose = 'implementation-1096-registered-workload-gateway';
const priceOperation = {
  entrypointKey: 'commerce.pricing.define-price',
  moduleId: pricingModule,
  schemaVersion: '2',
};
const priceRule = {
  audience: 'pricing',
  declarationKey: 'commerce.pricing.price.define',
  entrypointKey: priceOperation.entrypointKey,
  jobKey: workerKey,
  legalEntityScope: 'required' as const,
  schemaVersion: priceOperation.schemaVersion,
  workerKey,
  workloadKey: priceWrite,
};
const createProductAction = 'commerce.catalog.create-product';
const productEffectKey = 'catalog-product';
const updateOperation = {
  entrypointKey: 'commerce.catalog.update-product',
  moduleId: catalogModule,
  schemaVersion: '1',
};
const variantFactsWorkload = 'commerce.catalog.symmy-variant-localized-facts';
const variantFactsRecoveryWorkload = 'commerce.catalog.symmy-variant-localized-facts-recovery';
const variantFactsOperation = {
  entrypointKey: 'commerce.catalog.set-variant-localized-facts',
  moduleId: catalogModule,
  schemaVersion: '1',
};
const rules = [
  {
    audience: catalogApp,
    declarationKey: 'commerce.catalog.product.create',
    entrypointKey: createProductAction,
    schemaVersion: '2',
    workloadKey: catalogImport,
  },
  {
    audience: catalogApp,
    declarationKey: 'commerce.catalog.variant.create',
    entrypointKey: 'commerce.catalog.create-variant',
    schemaVersion: '2',
    workloadKey: catalogImport,
  },
  {
    audience: catalogApp,
    declarationKey: 'commerce.catalog.product.update',
    entrypointKey: 'commerce.catalog.update-product',
    schemaVersion: '1',
    workloadKey: catalogImport,
  },
  {
    audience: catalogApp,
    declarationKey: 'commerce.catalog.variant-localized-facts.set',
    entrypointKey: variantFactsOperation.entrypointKey,
    schemaVersion: variantFactsOperation.schemaVersion,
    workloadKey: variantFactsWorkload,
  },
  {
    audience: catalogApp,
    declarationKey: 'commerce.catalog.catalog-source-products.read',
    entrypointKey: 'commerce.catalog.api.catalog-source-products',
    schemaVersion: '1',
    workloadKey: catalogRead,
  },
].map((rule) => ({ ...rule, jobKey: workerKey, legalEntityScope: 'forbidden' as const, workerKey }));
const recoveryRules = [
  {
    actionKey: createProductAction,
    declarationKey: 'commerce.catalog.create-product-recovery.read',
    entrypointKey: 'commerce.catalog.api.create-product-recovery',
  },
  {
    actionKey: 'commerce.catalog.create-variant',
    declarationKey: 'commerce.catalog.create-variant-recovery.read',
    entrypointKey: 'commerce.catalog.api.create-variant-recovery',
  },
].map(({ actionKey, ...rule }) => ({
  ...rule,
  audience: catalogApp,
  jobKey: workerKey,
  legalEntityScope: 'forbidden' as const,
  recoveryOf: { actionKey, jobKey: workerKey },
  schemaVersion: '1',
  workerKey,
  workloadKey: catalogRead,
}));

const historicalRecoveryRules = recoveryRules.map((rule) => ({ ...rule, allowHistoricalDeliveryRecovery: true }));
const variantFactsRecoveryRule = {
  audience: catalogApp,
  declarationKey: 'commerce.catalog.set-variant-localized-facts-recovery.read',
  entrypointKey: 'commerce.catalog.api.set-variant-localized-facts-recovery',
  jobKey: workerKey,
  legalEntityScope: 'forbidden' as const,
  recoveryOf: { actionKey: variantFactsOperation.entrypointKey, jobKey: workerKey },
  schemaVersion: '1',
  workerKey,
  workloadKey: variantFactsRecoveryWorkload,
};
const priceRecoveryRule = {
  allowHistoricalDeliveryRecovery: true,
  audience: 'pricing',
  declarationKey: 'commerce.pricing.price-source-result-lookup.read',
  entrypointKey: 'commerce.pricing.api.price-source-result-lookup',
  jobKey: workerKey,
  legalEntityScope: 'required' as const,
  recoveryOf: { actionKey: priceOperation.entrypointKey, jobKey: workerKey },
  schemaVersion: '1',
  workerKey,
  workloadKey: priceRead,
};
const pricingDelegationRules = [
  {
    audience: catalogApp,
    declarationKey: catalogSelectionRead,
    entrypointKey: 'commerce.catalog.api.selection-evidence',
    legalEntityScope: 'forbidden' as const,
    schemaVersion: '1',
    workloadKey: catalogRead,
  },
  {
    audience: marketApp,
    declarationKey: 'commerce.market-catalog.market-catalog.read',
    entrypointKey: 'commerce.market-catalog.api.current-market-catalog',
    legalEntityScope: 'required' as const,
    schemaVersion: '1',
    workloadKey: marketRead,
  },
].map((rule) => ({ ...rule, jobKey: workerKey, sourceWorkloadKey: priceWrite }));

const catalogRecoveryRequirementFor = Effect.fn('InternalC14Product.catalogRecoveryRequirement')(
  function* catalogRecoveryRequirementFor(
    symmy: OntosModuleDeploymentContract,
    provider: { readonly entrypointKey: string; readonly moduleId: string },
  ) {
    const [catalogRecoveryRequirement] = yield* Schema.decodeUnknownEffect(
      Schema.Tuple([Schema.Struct({ key: Schema.String })]),
    )(
      (symmy.manifest.requirements?.operations ?? []).filter(
        (requirement) =>
          requirement.entrypointKey === workerKey &&
          requirement.provider.moduleId === provider.moduleId &&
          requirement.provider.entrypointKey === provider.entrypointKey &&
          requirement.provider.schemaVersion === '1',
      ),
    );
    return catalogRecoveryRequirement.key;
  },
);

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
const receiptSchema = Schema.Struct({
  jobId: SymmyJobStatusResponseSchema.members[0].fields.jobId,
  status: Schema.Literal('admitted'),
});
const publicJobStatusSchema = Schema.Struct({
  items: Schema.optionalKey(Schema.Array(SymmyItemOutcomeSchema)),
  jobId: receiptSchema.fields.jobId,
  status: Schema.Literals([
    'admitted',
    'running',
    'blocked',
    'completed_all',
    'completed_partial',
    'completed_none',
    'indeterminate',
  ]),
});
const compiledShellProblemSchema = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  detail: Schema.String,
  status: Schema.Int,
  type: Schema.String,
});
const productReceiptSchema = Schema.Struct({
  _tag: Schema.Literal('ProductCreated'),
  actionInvocationId: ProductActionInvocationIdSchema,
  initialVariantRef: VariantRefSchema,
  productRef: ProductRefSchema,
});
const ledgerSchema = Schema.Struct({
  effect_key: Schema.String,
  outcome: Schema.OptionFromNullOr(SymmyEffectOutcomeSchema),
  owner_invocation_id: Schema.OptionFromNullOr(Schema.String),
  owner_receipt: Schema.OptionFromNullOr(Schema.Unknown),
  resolved_target: Schema.OptionFromNullOr(ProductRefSchema),
  state: Schema.String,
});
const readProjectionSchema = Schema.Struct({
  contractVersion: Schema.Literal('INTERNAL_C14'),
  products: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isPattern(/^~c14r1\.[a-zA-Z0-9_-]{43}$/u)),
      product: ProductSchema,
      source_record_id: Schema.String,
      variantSources: Schema.Array(
        Schema.Struct({
          id: Schema.String.check(Schema.isPattern(/^~c14r1\.[a-zA-Z0-9_-]{43}$/u)),
          source_record_id: Schema.String,
          variantId: VariantRefSchema.fields.resourceId,
        }),
      ),
    }),
  ),
  projection: Schema.Literal('products'),
  unsupported_fields: Schema.Array(Schema.String),
});

const nativeObservationAttempts = 600;
const nativeObservationIntervalMs = 50;
const observeOwnerResponse = (
  output: Queue.Queue<string>,
  type: 'committed-response-lost' | 'original-response-recovered',
) =>
  Effect.gen(function* actualOwnerResponseTrace() {
    const decode = Schema.decodeUnknownOption(
      Schema.fromJsonString(
        Schema.Struct({
          path: Schema.String,
          status: Schema.Int.check(Schema.isBetween({ maximum: 299, minimum: 200 })),
          type: Schema.Literal(type),
        }),
      ),
    );
    for (;;) {
      const event = decode(yield* Queue.take(output));
      if (Option.isSome(event)) {
        return event.value;
      }
    }
  });

const missingVariantResponse =
  (type: Parameters<typeof observeOwnerResponse>[1]) =>
  ([owner, worker, ledger]: readonly [string, string, unknown]) =>
    Effect.fail(
      new SymmyC14ProductFixtureUnavailable({
        message: `No localized Variant fact ${type} witness; owner: ${owner}; worker: ${worker}; ledger: ${JSON.stringify(ledger)}`,
      }),
    );

const observeUntil = <Value, Failure, Requirements>(
  reason: string,
  observe: Effect.Effect<Value, Failure, Requirements>,
  ready: (value: Value) => boolean,
  maximumAttempts = nativeObservationAttempts,
) =>
  Effect.gen(function* observeNativeState() {
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      const value = yield* observe;
      if (ready(value)) {
        return value;
      }
      yield* Effect.sleep(Duration.millis(nativeObservationIntervalMs));
    }
    return yield* new SymmyC14ProductFixtureUnavailable({ message: reason });
  });

const deliveryCheckpointSchema = Schema.Struct({
  attempts_count: Schema.Int,
  latest_attempt: Schema.String,
  latest_start_ms: Schema.Number,
  next_claim_ms: Schema.Number,
  next_delay_ms: Schema.Int,
  status: Schema.String,
});

const readDeliveryCheckpoint = (admin: PgClient.PgClient, deliveryId: string) =>
  admin`
    select d.status, d.attempts_count,
      extract(epoch from deadline.claim_at)::double precision * 1000 as next_claim_ms,
      greatest(0, ceil(extract(epoch from (deadline.claim_at - clock_timestamp())) * 1000))::integer as next_delay_ms,
      extract(epoch from a.started_at)::double precision * 1000 as latest_start_ms,
      case when a.finished_at is null then 'open'
        when a.error_message = 'Outbox Worker lease expired before completion' then 'lease_expired'
        when a.error_message is not null then coalesce(substring(a.error_message from 'symmy_job_worker_[a-z_]+'), 'failed')
        else 'finished'
      end as latest_attempt
    from core.outbox_deliveries d
    cross join lateral (select coalesce(d.claim_expires_at, d.available_at) as claim_at) deadline
    cross join lateral (
      select started_at, finished_at, error_message from core.outbox_attempts
      where outbox_delivery_id=d.outbox_delivery_id order by started_at desc limit 1
    ) a
    where d.outbox_delivery_id=${deliveryId}
  `.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([deliveryCheckpointSchema]))),
    Effect.map((rows) => rows[0]),
  );

const seedProviderHuman = Effect.fn('SymmyC14Product.seedProviderHuman')(function* seedProviderHuman(
  admin: PgClient.PgClient,
  tenantId: string,
  providerUserId: string,
) {
  const principalId = randomUUID();
  yield* admin`insert into core.principals(principal_id,tenant_id,kind,status,display_name) values(${principalId},${tenantId},'human','active','INTERNAL_C14 actual provider issuer')`;
  yield* admin`insert into core.principal_auth_bindings(principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status)
    values(${randomUUID()},${tenantId},${principalId},${STAFF_AUTHENTICATION_NAMESPACE_ID},'better_auth','user',${providerUserId},'active')`;
  return { principalId, tenantId };
});
const seedMachine = Effect.fn('SymmyC14Product.seedMachine')(function* seedMachine(
  admin: PgClient.PgClient,
  tenantId: string,
  kind: 'integration' | 'service',
) {
  const principalId = randomUUID();
  yield* admin`insert into core.principals(principal_id,tenant_id,kind,status,display_name) values(${principalId},${tenantId},${kind},'active','INTERNAL_C14 enrolled machine target')`;
  return { principalId, tenantId };
});
const bindProviderKey = (
  admin: PgClient.PgClient,
  principal: { readonly principalId: string; readonly tenantId: string },
  providerKeyId: string,
) => admin`insert into core.principal_auth_bindings(principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status)
  values(${randomUUID()},${principal.tenantId},${principal.principalId},${STAFF_AUTHENTICATION_NAMESPACE_ID},'better_auth','api_key',${providerKeyId},'active')`;

it.live(
  'INTERNAL_C14 actual Shell and durable worker create one Catalog Product with two Variants and recover the original committed effect',
  () =>
    Effect.scoped(
      Effect.gen(function* actualProductConformance() {
        const catalogPort = yield* nativePort;
        let symmyPort = yield* nativePort;
        while (symmyPort === catalogPort) {
          symmyPort = yield* nativePort;
        }
        let marketPort = yield* nativePort;
        while (marketPort === catalogPort || marketPort === symmyPort) {
          marketPort = yield* nativePort;
        }
        let pricingPort = yield* nativePort;
        while ([catalogPort, symmyPort, marketPort].includes(pricingPort)) {
          pricingPort = yield* nativePort;
        }
        const { contracts, snapshot } = yield* productComposition({
          catalog: `http://127.0.0.1:${catalogPort}/`,
          'commerce-market-catalog': `http://127.0.0.1:${marketPort}/`,
          pricing: `http://127.0.0.1:${pricingPort}/`,
          'symmy-integration': `http://127.0.0.1:${symmyPort}/`,
        });
        const pricing = contracts.find(({ deployment }) => deployment.appId === 'pricing');
        assert.isOk(pricing);
        const catalog = contracts.find(({ deployment }) => deployment.appId === catalogApp);
        const symmy = contracts.find(({ deployment }) => deployment.appId === 'symmy-integration');
        const market = contracts.find(({ deployment }) => deployment.appId === marketApp);
        assert.isOk(catalog);
        assert.isOk(symmy);
        assert.isOk(market);
        const catalogRecoveryRequirementKey = yield* catalogRecoveryRequirementFor(symmy, catalogRecoveryProvider);
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot: snapshot,
          mode: 'schema-only',
          purpose: fixturePurpose,
        });
        const admin = yield* PgClient.make({ url: Redacted.make(isolated.connections.admin.connectionString) });
        const shell = yield* makeApiKeyGatewayNativeFixture({
          additionalRelaySources: [
            { registeredWorkloads: [], sourceAppId: 'party-registry' },
            { registeredWorkloads: [], sourceAppId: 'commerce-customer-context' },
            { registeredWorkloads: [], sourceAppId: 'privacy' },
            { registeredWorkloads: pricingDelegationRules, sourceAppId: 'pricing' },
          ],
          ownedDatabase: isolated,
          productionGate: true,
          relaySource: {
            registeredWorkloads: [
              ...rules,
              ...historicalRecoveryRules,
              variantFactsRecoveryRule,
              priceRule,
              priceRecoveryRule,
            ],
            sourceAppId: 'symmy-integration',
          },
          snapshotJson: yield* encodeProductComposition(snapshot),
        });
        const tenantId = randomUUID();
        const slug = `internal-c14-${tenantId}`;
        yield* admin`insert into core.tenants(tenant_id,name,slug,status,default_locale) values(${tenantId},'INTERNAL_C14 actual assembled Product fixture',${slug},'active','en')`;
        const issuerHuman = yield* seedProviderHuman(admin, tenantId, shell.providerUserId);
        const integration = yield* seedMachine(admin, tenantId, 'integration');
        assert.isOk(shell.relaySourceProviderUserId);
        const moduleIssuerHuman = yield* seedProviderHuman(admin, tenantId, shell.relaySourceProviderUserId);
        const modulePrincipal = yield* seedMachine(admin, tenantId, 'service');
        const governanceLegalEntityId = randomUUID();
        yield* admin`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status) values(${governanceLegalEntityId},${tenantId},'INTERNAL_C14 Privacy governance fixture','CZ','INTERNAL_C14','active')`;
        const systemId = randomUUID();
        yield* admin`insert into core.principals(principal_id,tenant_id,kind,status,display_name) values(${systemId},${tenantId},'system','active','INTERNAL_C14 actual enrolled system')`;
        for (const module of snapshot.composition.modules) {
          yield* admin`insert into core.tenant_module_states(tenant_id,module_key,state) values(${tenantId},${module.moduleId},'active')`;
        }
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
                'commerce.market-catalog.market.create',
                catalogSelectionRead,
                'commerce.pricing.currency-support.read-current',
                'commerce.pricing.currency-support.set',
              ],
              principalId: issuerHuman.principalId,
            },
          ],
          legalEntityIds: [governanceLegalEntityId],
          spiceDb: yield* liveFixtureSpiceDb(spiceEnvironment),
          tenantId,
        });
        for (const [principalId, workload] of [
          [integration.principalId, 'integration.symmy-admit'],
          [integration.principalId, 'integration.symmy-poll'],
          [integration.principalId, catalogImport],
          [integration.principalId, catalogRead],
          [integration.principalId, variantFactsWorkload],
          [systemId, workerKey],
          [systemId, catalogImport],
          [systemId, catalogRead],
          [systemId, variantFactsWorkload],
          [systemId, variantFactsRecoveryWorkload],
          [systemId, priceWrite],
          [systemId, priceRead],
          [integration.principalId, priceWrite],
          [integration.principalId, priceRead],
          [integration.principalId, marketRead],
          [systemId, marketRead],
        ]) {
          yield* admin`insert into core.access_workload_bindings(binding_id,incarnation,tenant_id,principal_id,workload_key,status) values(${randomUUID()},${randomUUID()},${tenantId},${principalId},${workload},'active')`;
        }
        const key = yield* shell.issueFixtureProviderKey({
          ...integration,
          issuerPrincipalId: issuerHuman.principalId,
        });
        yield* bindProviderKey(admin, integration, key.providerKeyId);
        yield* key.acknowledgeBinding;
        const moduleKey = yield* shell.issueFixtureRelaySourceProviderKey({
          ...modulePrincipal,
          issuerPrincipalId: moduleIssuerHuman.principalId,
        });
        yield* bindProviderKey(admin, modulePrincipal, moduleKey.providerKeyId);
        yield* moduleKey.acknowledgeBinding;
        const deploymentKeys = [moduleKey.secret];
        const relayKeys = new Map<string, Redacted.Redacted>();
        for (const provider of shell.additionalRelaySourceProviderUsers) {
          const human = yield* seedProviderHuman(admin, tenantId, provider.providerUserId);
          const principal = yield* seedMachine(admin, tenantId, 'service');
          const issued = yield* shell.issueFixtureModuleProviderKey({
            ...principal,
            issuerPrincipalId: human.principalId,
            sourceAppId: provider.sourceAppId,
          });
          yield* bindProviderKey(admin, principal, issued.providerKeyId);
          yield* issued.acknowledgeBinding;
          deploymentKeys.push(issued.secret);
          relayKeys.set(provider.sourceAppId, issued.secret);
        }
        const pricingModuleKey = relayKeys.get('pricing');
        assert.isOk(pricingModuleKey);
        const client = yield* HttpClient.HttpClient;
        for (const deploymentKey of deploymentKeys) {
          const refused = yield* client.post(`${shell.baseUrl}/shell-super-app-api/auth/api-key/gateway-context`, {
            body: yield* HttpBody.json({ audience: catalogApp, compositionRevision: snapshot.composition.revision }),
            headers: { 'x-api-key': Redacted.value(deploymentKey) },
          });
          expect(refused.status).toBe(403);
        }
        const sourceRouteId = randomUUID();
        const routeId = randomUUID();
        const plan = yield* makeSymmyC14ProductPlan({
          additionalVariantId: randomUUID(),
          productOccurrenceId: randomUUID(),
          sourceRouteId,
          tenantId,
          variantOccurrenceId: randomUUID(),
        });
        const encodedPlan = Schema.encodeSync(SymmyInternalExecutionPlanSchema)(plan);
        const configuredPlan = {
          ...encodedPlan,
          items: encodedPlan.items.map((item) => ({
            ...item,
            effects: [
              ...item.effects,
              item.itemKey === 'product'
                ? { effectKey: 'catalog-update-authority', operation: updateOperation }
                : { effectKey: 'catalog-variant-facts-authority', operation: variantFactsOperation },
            ],
          })),
          sourceRouteId,
        };
        const mixedConfiguredPlan = {
          ...configuredPlan,
          items: [
            ...configuredPlan.items,
            {
              effects: [{ effectKey: 'price-authority', operation: priceOperation }],
              itemKey: 'price-authority',
              source: {
                entityKind: 'PRICE',
                issuerId: internalProductSource.issuerId,
                sourceNamespace: internalPriceSource.namespace,
                sourceRecordId: internalPriceSource.recordId,
              },
            },
          ],
          pricingSourceSystem: {
            ownerModuleId: internalPriceSource.ownerModuleId,
            sourceSystemRef: internalPriceSource.sourceSystemRef,
          },
          sourceMappingVersion: internalProductSource.mappingVersion,
          sourceRouteRevision: internalProductSource.routeRevision,
        };
        const lifecyclePolicy = { policyId: 'INTERNAL_C14_PRODUCT_RETENTION', revision: 'v1' };
        const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
        const configuredJson = yield* Schema.decodeUnknownEffect(Schema.Json)(configuredPlan);
        yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,principal_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_revision,lifecycle_policy)
    values(${routeId},${tenantId},${integration.principalId},true,array['INTERNAL_C14'],${json(configuredJson)}::jsonb,${internalProductSource.mappingVersion},'productsBatch',${internalProductSource.routeRevision},${json(lifecyclePolicy)}::jsonb)`;
        const readPlan = {
          items: [
            {
              effects: [
                {
                  effectKey: 'catalog-source-read',
                  operation: {
                    entrypointKey: 'commerce.catalog.api.catalog-source-products',
                    moduleId: catalogModule,
                    schemaVersion: '1',
                  },
                },
              ],
              itemKey: 'source-product-read',
              source: {
                entityKind: 'PRODUCT',
                issuerId: internalProductSource.issuerId,
                sourceNamespace: internalProductSource.namespace,
                sourceRecordId: internalProductSource.productRecordId,
              },
            },
          ],
          sourceRouteId,
        };
        yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,principal_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_revision)
    values(${randomUUID()},${tenantId},${integration.principalId},true,array['INTERNAL_C14'],${json(readPlan)}::jsonb,${internalProductSource.mappingVersion},'adminProducts',${internalProductSource.routeRevision})`;
        const policies = json([
          {
            ...lifecyclePolicy,
            governanceLegalEntityId,
            retentionMs: Duration.toMillis(Duration.minutes(1)),
            routeId,
            targetLegalEntityId: null,
            tenantId,
          },
          {
            ...lifecyclePolicy,
            governanceLegalEntityId,
            retentionMs: Duration.toMillis(Duration.minutes(1)),
            routeId,
            targetLegalEntityId: governanceLegalEntityId,
            tenantId,
          },
        ]);
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
        const fs = yield* FileSystem.FileSystem;
        const faultDirectory = yield* fs.makeTempDirectoryScoped({ prefix: 'INTERNAL_C14_PRODUCT_' });
        const faultMarker = `${faultDirectory}/drop-owner-response`;
        yield* fs.writeFileString(faultMarker, 'INTERNAL_C14 transport fault after native owner commit');
        const catalogArtifacts = yield* buildProductOwner(catalog);
        const symmyArtifacts = yield* buildProductOwner(symmy);
        const marketArtifacts = yield* buildProductOwner(market);
        const pricingArtifacts = yield* buildProductOwner(pricing);
        const catalogReceiver = yield* startProductOwner({
          artifacts: catalogArtifacts,
          contract: catalog,
          environment: { ...environment, ONTOS_C14_RESPONSE_LOSS_MARKER: faultMarker },
          port: catalogPort,
          prefix: '/catalog-api',
        });
        const symmyReceiver = yield* startProductOwner({
          artifacts: symmyArtifacts,
          contract: symmy,
          environment,
          port: symmyPort,
          prefix: '/symmy-integration-api',
        });
        const marketReceiver = yield* startProductOwner({
          artifacts: marketArtifacts,
          contract: market,
          environment,
          port: marketPort,
          prefix: '/commerce-market-catalog-api',
        });
        yield* startProductOwner({
          artifacts: pricingArtifacts,
          contract: pricing,
          environment: { ...environment, ONTOS_GATEWAY_MODULE_API_KEY: Redacted.value(pricingModuleKey) },
          port: pricingPort,
          prefix: '/pricing-api',
        });
        const setupActorKey = yield* shell.issueFixtureSetupActorKey();
        yield* bindProviderKey(admin, issuerHuman, setupActorKey.providerKeyId);
        yield* setupActorKey.acknowledgeBinding;
        const unitSetup = yield* shell.issueFixtureSetupGateway({ audience: catalogApp });
        const marketSetup = yield* shell.issueFixtureSetupGateway({
          audience: marketApp,
          legalEntityId: governanceLegalEntityId,
        });
        const proposedUnitId = randomUUID();
        const proposedMarketId = randomUUID();
        const setupFacts = yield* bootstrapInternalC14PriceInputFacts({
          market: {
            authorization: Redacted.make(`Bearer ${marketSetup.token}`),
            options: {
              baseUrl: `http://127.0.0.1:${marketPort}/commerce-market-catalog-api`,
              compositionRevision: snapshot.composition.revision,
              idempotencyKey: 'INTERNAL_C14_NATIVE_MARKET_SETUP',
            },
            payload: {
              channels: ['B2C'],
              effectivePeriod: { startsAt: yield* DateTime.now },
              jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
              lifecycle: 'ACTIVE',
              marketCode: 'INTERNAL_C14_MARKET',
              marketId: proposedMarketId,
              purpose: 'INTERNAL_C14 independent Pricing failure context',
              reason: 'INTERNAL_C14 explicit native fixture Market',
              sellingLegalEntityRef: {
                moduleId: 'core.identity',
                resourceId: governanceLegalEntityId,
                resourceType: 'core.identity.legal-entity',
                tenantId,
              },
              supportedLocales: ['en'],
            },
            requestCorrelation: randomUUID(),
          },
          unit: {
            authorization: Redacted.make(`Bearer ${unitSetup.token}`),
            options: {
              baseUrl: `http://127.0.0.1:${catalogPort}/catalog-api`,
              compositionRevision: snapshot.composition.revision,
              idempotencyKey: 'INTERNAL_C14_NATIVE_UNIT_SETUP',
            },
            payload: {
              code: 'INTERNAL_C14_UNIT',
              evidenceRefs: ['INTERNAL_C14_EXPLICIT_NATIVE_UNIT_SETUP'],
              label: 'Internal fixture whole unit',
              reason: 'INTERNAL_C14 explicit native Unit for independent Pricing failure',
              rule: { rounding: 'HALF_UP', step: '1' },
              unitRef: {
                moduleId: 'commerce.catalog',
                resourceId: proposedUnitId,
                resourceType: 'commerce.catalog.product-unit',
                tenantId,
              },
            },
            requestCorrelation: randomUUID(),
          },
        }).pipe(
          Effect.catchTag('InternalC14PriceInputBootstrapUnavailable', (failure) =>
            Effect.all([catalogReceiver.diagnostic, marketReceiver.diagnostic]).pipe(
              Effect.flatMap((diagnostics) =>
                Effect.fail(
                  new SymmyC14ProductFixtureUnavailable({
                    message: `${failure.reason}; actual owner diagnostics: ${diagnostics.join('\n')}`,
                  }),
                ),
              ),
            ),
          ),
        );
        expect(setupFacts.unit.unit.resourceId).toBe(proposedUnitId);
        expect(setupFacts.market.marketRef.resourceId).toBe(proposedMarketId);
        const headers = { 'x-api-key': Redacted.value(key.secret) };
        const payload = {
          contractVersion: 'INTERNAL_C14',
          plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(plan),
        };
        const submit = (idempotencyKey = 'INTERNAL_C14_PRODUCT_JOB', body = payload) =>
          Effect.gen(function* submitProduct() {
            const response = yield* client.post(`${shell.baseUrl}/api/symmy/v1/products/batch`, {
              body: yield* HttpBody.json(body),
              headers: { ...headers, 'idempotency-key': idempotencyKey },
            });
            if (response.status !== 202) {
              const problem = yield* response.json.pipe(
                Effect.flatMap(
                  Schema.decodeUnknownEffect(
                    Schema.Struct({
                      _tag: Schema.optionalKey(Schema.String),
                      code: Schema.optionalKey(Schema.String),
                      detail: Schema.optionalKey(Schema.String),
                      status: Schema.Int,
                    }),
                  ),
                ),
              );
              const encoded = yield* Schema.encodeEffect(
                Schema.fromJsonString(
                  Schema.Struct({
                    _tag: Schema.optionalKey(Schema.String),
                    code: Schema.optionalKey(Schema.String),
                    detail: Schema.optionalKey(Schema.String),
                    status: Schema.Int,
                  }),
                ),
              )(problem);
              return yield* new SymmyC14ProductFixtureUnavailable({
                message: `Actual admission refused (${idempotencyKey}): ${encoded}; Symmy: ${yield* symmyReceiver.diagnostic}`,
              });
            }
            return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(receiptSchema)));
          });
        const accepted = yield* submit();
        expect(yield* submit()).toEqual(accepted);
        yield* Effect.scoped(
          Effect.gen(function* pollThroughCompiledShell() {
            const assembledPoll = yield* client.get(`${shell.baseUrl}/api/symmy/v1/jobs/${accepted.jobId}`, {
              headers,
            });
            expect(assembledPoll.status).toBe(200);
            const enrolled = yield* assembledPoll.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(publicJobStatusSchema)),
            );
            expect(enrolled.jobId).toBe(accepted.jobId);
            expect(enrolled.status).toBe('admitted');
            const compiled = yield* shell.startCompiledShell();
            expect(compiled.apiPrefix).toBe('/shell-super-app-api');
            const compiledPoll = yield* client.get(`${compiled.origin}/api/symmy/v1/jobs/${accepted.jobId}`, {
              headers,
            });
            if (compiledPoll.status !== 200) {
              const problem = yield* compiledPoll.json.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(compiledShellProblemSchema)),
              );
              return yield* new SymmyC14ProductFixtureUnavailable({
                message: `Compiled Shell poll failed: ${JSON.stringify(problem)}; trace: ${(yield* compiled.diagnostics).join(', ')}`,
              });
            }
            expect(
              yield* compiledPoll.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(publicJobStatusSchema))),
            ).toEqual(enrolled);
            return yield* Effect.logInfo('Compiled Shell returned the enrolled Symmy job', { status: enrolled.status });
          }),
        ).pipe(Effect.when(Config.Boolean('ONTOS_C14_COMPILED_SHELL_SMOKE').pipe(Config.withDefault(false))));
        const workerArtifact = yield* buildProductWorker(symmy);
        const firstWorker = yield* startProductWorker(workerArtifact, {
          ...environment,
          ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_PRODUCT_FIRST_PROCESS',
        });
        const ledgerFor = (jobId: string) =>
          admin`select effect_key,outcome,owner_invocation_id,owner_receipt,resolved_effect #> '{ref,originalTarget}' as resolved_target,state from symmy_integration.job_effects where job_id=${jobId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ledgerSchema))),
          );
        yield* observeUntil(
          'The real Catalog committed response was not recorded as uncertain',
          ledgerFor(accepted.jobId),
          (rows) => rows.some((row) => row.effect_key === productEffectKey && row.state === 'indeterminate'),
        ).pipe(
          Effect.catchTag('SymmyC14ProductFixtureUnavailable', (failure) =>
            firstWorker.diagnostic.pipe(
              Effect.flatMap((diagnostic) =>
                Effect.fail(
                  new SymmyC14ProductFixtureUnavailable({ message: `${failure.message}; worker: ${diagnostic}` }),
                ),
              ),
            ),
          ),
        );
        const committedLoss = yield* observeOwnerResponse(catalogReceiver.output, 'committed-response-lost').pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(30),
            orElse: () =>
              Effect.all([catalogReceiver.diagnostic, firstWorker.diagnostic]).pipe(
                Effect.flatMap((diagnostics) =>
                  Effect.fail(
                    new SymmyC14ProductFixtureUnavailable({
                      message: `No actual owner commit/lost-response witness; ${diagnostics.join('\n')}`,
                    }),
                  ),
                ),
              ),
          }),
        );
        expect(committedLoss.path).toBe('/catalog-api/catalog/actions/create-product');
        yield* firstWorker.child.kill();
        yield* firstWorker.child.exitCode;
        const [countAfterLoss] = yield* admin<{
          products: number;
          variants: number;
        }>`select (select count(*)::integer from catalog.products where tenant_id=${tenantId}) as products,(select count(*)::integer from catalog.product_variants where tenant_id=${tenantId}) as variants`;
        expect(countAfterLoss).toEqual({ products: 1, variants: 1 });
        const deliveryFor = (jobId: string) =>
          admin`
          select d.outbox_delivery_id as delivery_id from core.outbox_deliveries d
          join core.outbox_messages m on m.outbox_message_id=d.outbox_message_id
          join core.domain_events e on e.domain_event_id=m.domain_event_id and e.tenant_id=m.tenant_id
          join symmy_integration.import_jobs j on j.admission_invocation_id=e.action_invocation_id and j.tenant_id=e.tenant_id
          where j.tenant_id=${tenantId} and j.job_id=${jobId} and d.worker_key=${workerKey}
            and d.consumer_module_key='integration.symmy' and m.producer_module_key='integration.symmy'
        `.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Tuple([Schema.Struct({ delivery_id: Schema.String.check(Schema.isUUID()) })]),
              ),
            ),
            Effect.map((rows) => rows[0].delivery_id),
          );
        const originalDeliveryId = yield* deliveryFor(accepted.jobId);
        const beforeRestart = yield* readDeliveryCheckpoint(admin, originalDeliveryId);
        expect(['pending', 'processing']).toContain(beforeRestart.status);
        expect(beforeRestart.next_delay_ms).toBeLessThanOrEqual(30_000);
        yield* fs.remove(faultMarker);
        const restarted = yield* startProductWorker(workerArtifact, {
          ...environment,
          ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_PRODUCT_RESTARTED_PROCESS',
        });
        const completed = yield* observeUntil(
          'The restarted actual worker did not settle the Product dependency graph',
          ledgerFor(accepted.jobId),
          (rows) => rows.length === 2 && rows.every((row) => row.state === 'settled'),
          nativeObservationAttempts + Math.ceil(beforeRestart.next_delay_ms / nativeObservationIntervalMs),
        ).pipe(
          Effect.catchTag('SymmyC14ProductFixtureUnavailable', (failure) =>
            Effect.all([
              restarted.diagnostic,
              readDeliveryCheckpoint(admin, originalDeliveryId),
              ledgerFor(accepted.jobId).pipe(
                Effect.map((rows) => rows.map(({ effect_key, state }) => ({ effect_key, state }))),
              ),
            ]).pipe(
              Effect.flatMap(([diagnostic, delivery, effects]) =>
                Effect.fail(
                  new SymmyC14ProductFixtureUnavailable({
                    message: `${failure.message}; worker: ${diagnostic}; delivery: ${JSON.stringify(delivery)}; effects: ${JSON.stringify(effects)}`,
                  }),
                ),
              ),
            ),
          ),
        );
        const afterRestart = yield* readDeliveryCheckpoint(admin, originalDeliveryId);
        expect(afterRestart.attempts_count).toBeGreaterThan(beforeRestart.attempts_count);
        expect(afterRestart.latest_start_ms).toBeGreaterThanOrEqual(beforeRestart.next_claim_ms);
        const productEffect = completed.find(({ effect_key }) => effect_key === productEffectKey);
        const variantEffect = completed.find(({ effect_key }) => effect_key === 'catalog-additional-variant');
        assert.isOk(productEffect);
        assert.isOk(variantEffect);
        assert.isTrue(Option.isSome(productEffect.owner_receipt));
        const originalReceipt = yield* Schema.decodeUnknownEffect(productReceiptSchema)(
          Option.getOrThrow(productEffect.owner_receipt),
        );
        expect(Option.getOrThrow(variantEffect.resolved_target)).toEqual(originalReceipt.productRef);
        const [countAfterRecovery] = yield* admin<{
          products: number;
          variants: number;
        }>`select (select count(*)::integer from catalog.products where tenant_id=${tenantId}) as products,(select count(*)::integer from catalog.product_variants where tenant_id=${tenantId}) as variants`;
        expect(countAfterRecovery).toEqual({ products: 1, variants: 2 });
        const statusResponse = yield* client.get(`${shell.baseUrl}/api/symmy/v1/jobs/${accepted.jobId}`, { headers });
        expect(statusResponse.status).toBe(200);
        const status = yield* statusResponse.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(publicJobStatusSchema)),
        );
        expect(status.status).toBe('completed_partial');
        const unsupported = (status.items ?? [])
          .flatMap((item) => item.effects)
          .filter((effect) => effect.status === 'unsupported');
        expect(unsupported).toHaveLength(6);
        expect(unsupported.map(({ branchKind }) => branchKind)).toEqual(
          expect.arrayContaining(['CategoryHint', 'AttributeHint', 'MediaHint', 'VariantUpdateHint']),
        );
        const [forbiddenCalls] = yield* admin<{
          count: number;
        }>`select count(*)::integer as count from core.action_invocations where tenant_id=${tenantId} and (action_key like 'tax.%' or action_key like 'commerce.tax.%' or action_key like 'commerce.assortment.%')`;
        expect(forbiddenCalls?.count).toBe(0);
        const exported = yield* client.get(
          `${shell.baseUrl}/api/symmy/v1/admin/products?contractVersion=INTERNAL_C14`,
          { headers },
        );
        expect(exported.status).toBe(200);
        const readback = yield* exported.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(readProjectionSchema)));
        expect(readback.products).toHaveLength(1);
        const product = readback.products.find(
          (item) => item.source_record_id === internalProductSource.productRecordId,
        );
        assert.isOk(product);
        expect(product.id).not.toBe(internalProductSource.productRecordId);
        expect(product.product.productRef).toEqual(originalReceipt.productRef);
        expect(product.product.variants).toHaveLength(2);
        expect(
          EffectArray.sort(
            product.variantSources.map(({ source_record_id }) => source_record_id),
            Order.String,
          ),
        ).toEqual(
          EffectArray.sort(
            [internalProductSource.initialVariantRecordId, internalProductSource.additionalVariantRecordId],
            Order.String,
          ),
        );
        const roundTripPlan = yield* Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
          items: [
            {
              effects: [
                {
                  effectKey: 'catalog-roundtrip-update',
                  intent: {
                    _tag: 'CatalogUpdateProduct',
                    payload: {
                      expectedRevision: product.product.revision,
                      productRef: product.product.productRef,
                      reason: 'INTERNAL_C14 GET source ID reused for the same native Product',
                      targetLifecycle: 'DRAFT',
                    },
                  },
                  operation: updateOperation,
                  originalTarget: product.product.productRef,
                },
              ],
              itemKey: 'roundtrip-product',
              source: {
                entityKind: 'PRODUCT',
                issuerId: internalProductSource.issuerId,
                sourceNamespace: internalProductSource.namespace,
                sourceRecordId: product.source_record_id,
              },
              sourceOccurrenceId: randomUUID(),
            },
          ],
        });
        const roundTrip = yield* submit('INTERNAL_C14_GET_POST_ROUNDTRIP', {
          contractVersion: 'INTERNAL_C14',
          plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(roundTripPlan),
        });
        yield* observeUntil(
          'The GET source ID did not round-trip through the actual Product owner',
          ledgerFor(roundTrip.jobId),
          (rows) => rows.length === 1 && rows.every((row) => row.state === 'settled'),
        );
        const roundTripStatus = yield* client.get(`${shell.baseUrl}/api/symmy/v1/jobs/${roundTrip.jobId}`, { headers });
        expect(roundTripStatus.status).toBe(200);
        expect(
          yield* roundTripStatus.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(publicJobStatusSchema))),
        ).toMatchObject({ status: 'completed_all' });
        yield* Effect.gen(function* proveExistingVariantFacts() {
          const variantSource = product.variantSources.find(
            ({ source_record_id }) => source_record_id === internalProductSource.additionalVariantRecordId,
          );
          assert.isOk(variantSource);
          const sourceVariant = product.product.variants.find(({ variantId }) => variantId === variantSource.variantId);
          assert.isOk(sourceVariant);
          const name = 'INTERNAL_C14 qualified existing Variant name';
          const variantFactsPlan = (variantRef: typeof VariantRefSchema.Type) =>
            Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
              items: [
                {
                  effects: [
                    {
                      effectKey: 'catalog-variant-localized-facts',
                      intent: {
                        _tag: 'CatalogSetVariantLocalizedFacts',
                        payload: {
                          evidenceRefs: ['INTERNAL_C14_SOURCE_LOCALIZED_NAME_ASSERTION'],
                          expectedRevision: 0,
                          facts: { name },
                          locale: 'en',
                          productRef: product.product.productRef,
                          reason: 'Explicit internal source declaration of localized Variant name',
                          variantRef,
                        },
                      },
                      operation: variantFactsOperation,
                      originalTarget: variantRef,
                    },
                  ],
                  itemKey: 'existing-variant',
                  source: {
                    entityKind: 'VARIANT',
                    issuerId: internalProductSource.issuerId,
                    sourceNamespace: internalProductSource.namespace,
                    sourceRecordId: variantSource.source_record_id,
                  },
                  sourceOccurrenceId: randomUUID(),
                },
              ],
            });
          const mismatchedVariant = yield* submit('INTERNAL_C14_MISMATCHED_VARIANT_LOCALIZED_FACTS', {
            contractVersion: 'INTERNAL_C14',
            plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(
              yield* variantFactsPlan(originalReceipt.initialVariantRef),
            ),
          });
          const mismatchedEffects = yield* observeUntil(
            'Mismatched Variant source target did not settle without a Catalog write',
            ledgerFor(mismatchedVariant.jobId),
            (rows) => rows.length === 1 && rows.every((row) => row.state === 'settled'),
          );
          const [mismatchedEffect] = mismatchedEffects;
          assert.isDefined(mismatchedEffect);
          expect(Option.getOrThrow(mismatchedEffect.outcome)).toMatchObject({ status: 'unresolved' });
          const variantFactInvocations = admin`select action_invocation_id as "invocationId",status from core.action_invocations
    where tenant_id=${tenantId} and action_key=${variantFactsOperation.entrypointKey}`;
          expect(yield* variantFactInvocations).toEqual([]);

          yield* catalogReceiver.child.kill();
          yield* catalogReceiver.child.exitCode;
          yield* fs.writeFileString(faultMarker, 'INTERNAL_C14 transport fault after localized Variant fact commit');
          const variantFactsReceiver = yield* startProductOwner({
            artifacts: catalogArtifacts,
            contract: catalog,
            environment: {
              ...environment,
              ONTOS_C14_RESPONSE_LOSS_MARKER: faultMarker,
              ONTOS_C14_RESPONSE_LOSS_OPERATION: 'catalog-set-variant-localized-facts',
            },
            port: catalogPort,
            prefix: '/catalog-api',
          });
          const variantWrite = yield* submit('INTERNAL_C14_EXISTING_VARIANT_LOCALIZED_FACTS', {
            contractVersion: 'INTERNAL_C14',
            plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(
              yield* variantFactsPlan(sourceVariant.variantRef),
            ),
          });
          const observeVariantResponse = (type: Parameters<typeof observeOwnerResponse>[1]) =>
            observeOwnerResponse(variantFactsReceiver.output, type).pipe(
              Effect.timeoutOrElse({
                duration: Duration.seconds(30),
                orElse: () =>
                  Effect.all([
                    variantFactsReceiver.diagnostic,
                    restarted.diagnostic,
                    ledgerFor(variantWrite.jobId),
                  ]).pipe(Effect.flatMap(missingVariantResponse(type))),
              }),
            );
          const variantLostResponse = yield* observeVariantResponse('committed-response-lost');
          expect(variantLostResponse.path).toBe('/catalog-api/catalog/actions/set-variant-localized-facts');
          yield* fs.remove(faultMarker);
          const variantRecoveredResponse = yield* observeVariantResponse('original-response-recovered');
          expect(variantRecoveredResponse.path).toBe('/catalog-api/reads/set-variant-localized-facts-recovery');
          const variantEffects = yield* observeUntil(
            'The original localized Variant fact did not recover after its response was lost',
            ledgerFor(variantWrite.jobId),
            (rows) => rows.length === 1 && rows.every((row) => row.state === 'settled'),
          );
          const [variantFactEffect] = variantEffects;
          assert.isDefined(variantFactEffect);
          expect(Option.getOrThrow(variantFactEffect.outcome)).toMatchObject({ status: 'accepted_change' });
          expect(yield* variantFactInvocations).toEqual([
            { invocationId: Option.getOrThrow(variantFactEffect.owner_invocation_id), status: 'succeeded' },
          ]);
          expect(
            yield* admin`select variant_id as "variantId",locale,current_revision as revision,name
    from catalog.variant_localized_facts where tenant_id=${tenantId}`,
          ).toEqual([{ locale: 'en', name, revision: 1, variantId: sourceVariant.variantId }]);
        });
        expect(yield* submit()).toEqual(accepted);
        const beforeMixedRead = yield* client.get(
          `${shell.baseUrl}/api/symmy/v1/admin/products?contractVersion=INTERNAL_C14`,
          { headers },
        );
        expect(beforeMixedRead.status).toBe(200);
        const beforeMixed = yield* beforeMixedRead.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(readProjectionSchema)),
        );
        const currentProduct = beforeMixed.products.find(
          (item) => item.source_record_id === internalProductSource.productRecordId,
        );
        assert.isOk(currentProduct);
        expect(currentProduct.id).toBe(product.id);
        const priceFailure = yield* makeInternalC14PriceFailurePlan({
          at: DateTime.formatIso(yield* DateTime.now),
          marketId: setupFacts.market.marketRef.resourceId,
          priceId: randomUUID(),
          priceOccurrenceId: randomUUID(),
          product: currentProduct.product,
          productOccurrenceId: randomUUID(),
          sellingLegalEntityId: governanceLegalEntityId,
          sourceAssertionId: randomUUID(),
          unitRef: setupFacts.unit.unit,
          variantRef: originalReceipt.initialVariantRef,
        });
        expect(
          yield* bootstrapInternalC14PricingSourceAuthority({
            grant: priceFailure.grant,
            legalEntityId: governanceLegalEntityId,
            operatorPrincipalId: issuerHuman.principalId,
            operatorProviderUserId: shell.providerUserId,
            ownedDatabase: isolated,
            purpose: fixturePurpose,
            runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
            tenantId,
          }),
        ).toEqual({ outcome: 'STORED' });
        const mixedConfiguration = yield* Schema.decodeUnknownEffect(Schema.Json)(mixedConfiguredPlan);
        yield* admin`update symmy_integration.job_routes set fixture_plan=${json(mixedConfiguration)}::jsonb, legal_entity_id=${governanceLegalEntityId},route_revision='INTERNAL_C14_ROUTE_PRICING_V2' where tenant_id=${tenantId} and route_id=${routeId}`;
        const mixedPayload = {
          contractVersion: 'INTERNAL_C14',
          plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(priceFailure.plan),
        };
        const mixed = yield* submit('INTERNAL_C14_INDEPENDENT_PRICE_FAILURE', mixedPayload);
        yield* observeUntil(
          'The actual mixed Catalog/Price job did not settle independently',
          ledgerFor(mixed.jobId),
          (rows) => rows.length === 2 && rows.every((row) => row.state === 'settled'),
        );
        const mixedStatus = yield* client.get(`${shell.baseUrl}/api/symmy/v1/jobs/${mixed.jobId}`, { headers });
        expect(mixedStatus.status).toBe(200);
        const mixedProjection = yield* mixedStatus.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(publicJobStatusSchema)),
        );
        expect(mixedProjection.status).toBe('completed_partial');
        const catalogSibling = mixedProjection.items?.find((item) =>
          item.effects.some((effect) => effect.owner === catalogModule),
        );
        expect(
          catalogSibling?.effects.some(
            (effect) =>
              effect.owner === catalogModule &&
              Schema.is(Schema.Literals(['accepted_change', 'accepted_no_change']))(effect.status),
          ),
        ).toBe(true);
        expect(
          mixedProjection.items?.flatMap((item) => item.effects).find((effect) => effect.owner === 'commerce.pricing')
            ?.status,
        ).toBe('invalid');
        const [nativePriceRows] = yield* admin<{
          count: number;
        }>`select count(*)::integer as count from pricing.prices where tenant_id=${tenantId} and legal_entity_id=${governanceLegalEntityId} and price_id=${priceFailure.payload.priceRef.resourceId}`;
        expect(nativePriceRows?.count).toBe(0);
        const [nativePriceCalls] = yield* admin<{
          count: number;
        }>`select count(*)::integer as count from core.action_invocations where tenant_id=${tenantId} and legal_entity_id=${governanceLegalEntityId} and action_key=${priceOperation.entrypointKey} and status='succeeded'`;
        expect(nativePriceCalls?.count).toBe(1);
        expect(yield* submit('INTERNAL_C14_INDEPENDENT_PRICE_FAILURE', mixedPayload)).toEqual(mixed);
        const replayPlan = yield* Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
          items: encodedPlan.items
            .filter((item) => item.itemKey === 'product')
            .map((item) => ({
              ...item,
              sourceOccurrenceId: randomUUID(),
              unsupportedBranches: [],
            })),
        });
        const semanticReplay = yield* submit('INTERNAL_C14_NEW_CORE_SAME_PRODUCT', {
          contractVersion: 'INTERNAL_C14',
          plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(replayPlan),
        });
        const replayEffects = yield* observeUntil(
          'A second native Core invocation did not settle the same qualified Product source',
          ledgerFor(semanticReplay.jobId),
          (rows) => rows.length === 1 && rows.every((row) => row.state === 'settled'),
        );
        const replayEffect = replayEffects.find((row) => row.effect_key === productEffectKey);
        assert.isOk(replayEffect);
        const originalInvocationId = Option.getOrThrow(productEffect.owner_invocation_id);
        const replayInvocationId = Option.getOrThrow(replayEffect.owner_invocation_id);
        expect(replayInvocationId).not.toBe(originalInvocationId);
        // A separate completed source-create is explicitly prepared BEFORE the same-item replay/Price job.
        // This case never claims that a newly created DRAFT/WIP Product becomes ready automatically.
        const readyOccurrence = randomUUID();
        const readyPreparation = yield* makeInternalC14ReadyProductPreparation({
          occurrenceId: readyOccurrence,
          sourceRouteId,
        });
        const readyConfiguredPlan = {
          ...mixedConfiguredPlan,
          items: [
            ...mixedConfiguredPlan.items,
            ...Schema.encodeSync(SymmyInternalExecutionPlanSchema)(readyPreparation.plan).items.map((item) => ({
              ...item,
              effects: [...item.effects, { effectKey: 'price-ready-authority', operation: priceOperation }],
            })),
          ],
        };
        const readyConfiguration = yield* Schema.decodeUnknownEffect(Schema.Json)(readyConfiguredPlan);
        yield* admin`update symmy_integration.job_routes set fixture_plan=${json(readyConfiguration)}::jsonb,route_revision='INTERNAL_C14_ROUTE_READY_V3' where tenant_id=${tenantId} and route_id=${routeId}`;
        const readyPreparationJob = yield* submit('INTERNAL_C14_READY_PRODUCT_PREPARATION', {
          contractVersion: 'INTERNAL_C14',
          plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(readyPreparation.plan),
        });
        const [readyCreationEffect] = yield* observeUntil(
          'The actual preparation source Product did not settle',
          ledgerFor(readyPreparationJob.jobId),
          (rows) => rows.length === 1 && rows.every((row) => row.state === 'settled'),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([Schema.toType(ledgerSchema)]))));
        const readyCreated = yield* Schema.decodeUnknownEffect(productReceiptSchema)(
          Option.getOrThrow(readyCreationEffect.owner_receipt),
        );
        const readySourceResponse = yield* client.get(
          `${shell.baseUrl}/api/symmy/v1/admin/products?contractVersion=INTERNAL_C14`,
          { headers },
        );
        expect(readySourceResponse.status).toBe(200);
        const readySourceReadback = yield* readySourceResponse.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(readProjectionSchema)),
        );
        const [readySourceProduct] = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([readProjectionSchema.fields.products.value]),
        )(readySourceReadback.products.filter((item) => item.source_record_id === internalReadyProductSource.recordId));
        expect(readySourceProduct.product.lifecycle).toBe('DRAFT');
        expect(readySourceProduct.product.variants).toHaveLength(1);
        expect(readySourceProduct.product.variants.map((variant) => variant.lifecycle)).toEqual(['WORK_IN_PROGRESS']);
        const readiness = yield* bootstrapInternalC14SupportedProductPriceFacts({
          catalogReadiness: {
            expectedProductRevision: 1,
            expectedUnitRule: setupFacts.unit.ruleRevision,
            expectedVariantRevision: 1,
            fixtureFacts: {
              categoryName: 'INTERNAL_C14 supported Price category',
              divisible: false,
              locale: 'en',
              localizedName: 'INTERNAL_C14 explicitly ready existing source Product',
              structuredAttributesRequired: false,
              variantAxesRequired: false,
            },
            operatorPrincipalId: issuerHuman.principalId,
            operatorProviderUserId: shell.providerUserId,
            originalCreateInvocationId: readyCreated.actionInvocationId,
            ownedDatabase: isolated,
            productRef: readyCreated.productRef,
            purpose: fixturePurpose,
            runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
            tenantId,
            variantRef: readyCreated.initialVariantRef,
          },
          catalogUrl: `http://127.0.0.1:${catalogPort}/catalog-api`,
          compositionRevision: snapshot.composition.revision,
          pricingUrl: `http://127.0.0.1:${pricingPort}/pricing-api`,
          shell,
          tenantId,
        });
        expect(readiness.selection).toEqual({
          productRef: readyCreated.productRef,
          variantRef: readyCreated.initialVariantRef,
        });
        const supportedPrice = yield* makeInternalC14AcceptedProductPricePlan({
          at: DateTime.formatIso(yield* DateTime.now),
          createPayload: readyPreparation.createPayload,
          marketId: setupFacts.market.marketRef.resourceId,
          priceId: randomUUID(),
          priceOccurrenceId: readyOccurrence,
          product: readySourceProduct.product,
          productOccurrenceId: readyOccurrence,
          sellingLegalEntityId: governanceLegalEntityId,
          sourceAssertionId: randomUUID(),
          unitRef: setupFacts.unit.unit,
          variantRef: readyCreated.initialVariantRef,
        });
        expect(
          yield* bootstrapInternalC14PricingSourceAuthority({
            grant: supportedPrice.grant,
            legalEntityId: governanceLegalEntityId,
            operatorPrincipalId: issuerHuman.principalId,
            operatorProviderUserId: shell.providerUserId,
            ownedDatabase: isolated,
            purpose: fixturePurpose,
            runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
            tenantId,
          }),
        ).toEqual({ outcome: 'STORED' });
        const supportedPayload = {
          contractVersion: 'INTERNAL_C14',
          plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(supportedPrice.plan),
        };
        const supportedJob = yield* submit('INTERNAL_C14_READY_SOURCE_AND_PRICE', supportedPayload);
        const supportedEffects = yield* observeUntil(
          'The supported same-item source replay and Price did not settle',
          ledgerFor(supportedJob.jobId),
          (rows) => rows.length === 2 && rows.every((row) => row.state === 'settled'),
        );
        const [supportedCatalogEffect] = yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.toType(ledgerSchema)]))(
          supportedEffects.filter((effect) => effect.effect_key === 'catalog-ready-source'),
        );
        const [supportedPriceEffect] = yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.toType(ledgerSchema)]))(
          supportedEffects.filter((effect) => effect.effect_key === 'price-ready-accepted'),
        );
        const supportedCatalogReceipt = yield* Schema.decodeUnknownEffect(productReceiptSchema)(
          Option.getOrThrow(supportedCatalogEffect.owner_receipt),
        );
        expect(supportedCatalogReceipt.productRef).toEqual(readyCreated.productRef);
        expect(supportedCatalogReceipt.initialVariantRef).toEqual(readyCreated.initialVariantRef);
        const supportedStatusResponse = yield* client.get(`${shell.baseUrl}/api/symmy/v1/jobs/${supportedJob.jobId}`, {
          headers,
        });
        expect(supportedStatusResponse.status).toBe(200);
        const supportedStatus = yield* supportedStatusResponse.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(publicJobStatusSchema)),
        );
        expect(supportedStatus.status).toBe('completed_all');
        expect(supportedStatus.items).toHaveLength(1);
        expect(supportedStatus.items?.flatMap((item) => item.effects)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ originalStatus: 'accepted_change', owner: catalogModule, status: 'duplicate' }),
            expect.objectContaining({ owner: pricingModule, status: 'accepted_change' }),
          ]),
        );
        expect(yield* submit('INTERNAL_C14_READY_SOURCE_AND_PRICE', supportedPayload)).toEqual(supportedJob);
        const [supportedCounts] = yield* admin<{
          prices: number;
          products: number;
          variants: number;
        }>`select (select count(*)::integer from catalog.products where tenant_id=${tenantId} and product_id=${readyCreated.productRef.resourceId}) as products,(select count(*)::integer from catalog.product_variants where tenant_id=${tenantId} and product_id=${readyCreated.productRef.resourceId}) as variants,(select count(*)::integer from pricing.prices where tenant_id=${tenantId} and legal_entity_id=${governanceLegalEntityId} and price_id=${supportedPrice.payload.priceRef.resourceId}) as prices`;
        expect(supportedCounts).toEqual({ prices: 1, products: 1, variants: 1 });
        yield* restarted.child.kill();
        yield* restarted.child.exitCode;
        const [calls] = yield* admin<{
          creates: number;
          updates: number;
          variants: number;
        }>`select count(*) filter(where action_key=${createProductAction} and status='succeeded')::integer as creates,count(*) filter(where action_key='commerce.catalog.create-variant' and status='succeeded')::integer as variants,count(*) filter(where action_key='commerce.catalog.update-product' and status='succeeded')::integer as updates from core.action_invocations where tenant_id=${tenantId}`;
        expect(calls).toEqual({ creates: 4, updates: 2, variants: 1 });
        const tupleSchema = Schema.Struct({
          action_invocation_id: Schema.String.check(Schema.isUUID()),
          idempotency_key: Schema.String,
          principal_id: Schema.String,
          request_hash: Schema.String,
        });
        const invocationTuple = (invocationId: string) =>
          admin`
          select action_invocation_id,idempotency_key,principal_id,request_hash from core.action_invocations
          where tenant_id=${tenantId} and action_invocation_id=${invocationId} and status='succeeded'
        `.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([tupleSchema]))),
            Effect.map((rows) => rows[0]),
          );
        const originalTuple = yield* invocationTuple(originalInvocationId);
        const replayTuple = yield* invocationTuple(replayInvocationId);
        const replayDeliveryId = yield* deliveryFor(semanticReplay.jobId);
        const supportedPriceInvocationId = Option.getOrThrow(supportedPriceEffect.owner_invocation_id);
        const supportedPriceTuple = yield* invocationTuple(supportedPriceInvocationId);
        const supportedDeliveryId = yield* deliveryFor(supportedJob.jobId);
        const supportedPriceRequirement = yield* catalogRecoveryRequirementFor(symmy, {
          entrypointKey: 'commerce.pricing.api.price-source-result-lookup',
          moduleId: pricingModule,
        });
        const supportedPriceAssertion = yield* issueSymmyC14RecoveryAssertion({
          audience: 'pricing',
          compositionRevision: snapshot.composition.revision,
          declarationKey: 'commerce.pricing.price-source-result-lookup.read',
          legalEntityScope: 'subject',
          moduleKey: moduleKey.secret,
          operationRequirementKey: supportedPriceRequirement,
          originalActionKey: priceOperation.entrypointKey,
          originalIdempotencyKey: supportedPriceTuple.idempotency_key,
          originalPrincipalId: supportedPriceTuple.principal_id,
          originalRequestHash: supportedPriceTuple.request_hash,
          readPayload: { actionInvocationId: supportedPriceInvocationId },
          shellGatewayBaseUrl: `${shell.baseUrl}/shell-super-app-api`,
          source: {
            _tag: 'HistoricalDelivery',
            deliveryId: supportedDeliveryId,
            legalEntityId: governanceLegalEntityId,
            tenantId,
            workerKey,
          },
        });
        const supportedReceiptResponse = yield* client.post(
          `${new URL(supportedPriceAssertion.apiBaseUrl, shell.baseUrl)}/reads/price-source-result-lookup`,
          {
            body: yield* HttpBody.json({ actionInvocationId: supportedPriceInvocationId }),
            headers: {
              authorization: `Bearer ${supportedPriceAssertion.token}`,
              'x-correlation-id': randomUUID(),
              'x-ontos-composition-revision': snapshot.composition.revision,
            },
          },
        );
        expect(supportedReceiptResponse.status).toBe(200);
        const supportedReceipt = yield* supportedReceiptResponse.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(PriceSourceResultLookupResponseSchema)),
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({
                outcome: Schema.Literal('PRICE_ACTION_RESULT_FOUND'),
                result: Schema.Struct({ definition: PriceDefinitionSchema, outcome: Schema.Literal('CREATED') }),
              }),
            ),
          ),
        );
        expect(supportedReceipt.result.definition.priceRef).toEqual(supportedPrice.payload.priceRef);
        expect(supportedReceipt.result.definition.identityKey.catalogSelection).toEqual(readiness.selection);
        expect(supportedReceipt.result.definition.identityKey.unitBasis.unitRef).toEqual(setupFacts.unit.unit);
        const recoveryReaderId = randomUUID();
        yield* admin`insert into core.principals(principal_id,tenant_id,kind,status,display_name) values(${recoveryReaderId},${tenantId},'system','active','INTERNAL_C14 separate current recovery reader')`;
        yield* admin`update core.access_workload_bindings set status='revoked',revoked_at=now() where tenant_id=${tenantId} and ((principal_id=${systemId} and workload_key in (${catalogImport},${catalogRead})) or (principal_id=${integration.principalId} and workload_key=${catalogImport}))`;
        yield* admin`insert into core.access_workload_bindings(binding_id,incarnation,tenant_id,principal_id,workload_key,status) values(${randomUUID()},${randomUUID()},${tenantId},${recoveryReaderId},${catalogRead},'active')`;
        const issueRecovery = (tuple: typeof originalTuple, deliveryId: string, invocationId: string) =>
          issueSymmyC14RecoveryAssertion({
            audience: catalogApp,
            compositionRevision: snapshot.composition.revision,
            declarationKey: 'commerce.catalog.create-product-recovery.read',
            moduleKey: moduleKey.secret,
            operationRequirementKey: catalogRecoveryRequirementKey,
            originalActionKey: createProductAction,
            originalIdempotencyKey: tuple.idempotency_key,
            originalPrincipalId: tuple.principal_id,
            originalRequestHash: tuple.request_hash,
            readPayload: { invocationId },
            shellGatewayBaseUrl: `${shell.baseUrl}/shell-super-app-api`,
            source: { _tag: 'HistoricalDelivery', deliveryId, tenantId, workerKey },
          });
        const readRecovery = (assertion: Effect.Success<ReturnType<typeof issueRecovery>>, invocationId: string) =>
          Effect.gen(function* readNativeRecovery() {
            return yield* client.post(`${new URL(assertion.apiBaseUrl, shell.baseUrl)}/reads/create-product-recovery`, {
              body: yield* HttpBody.json({ invocationId }),
              headers: {
                authorization: `Bearer ${assertion.token}`,
                'x-correlation-id': randomUUID(),
                'x-ontos-composition-revision': snapshot.composition.revision,
              },
            });
          });
        const honestWrongInvocation = yield* issueRecovery(originalTuple, originalDeliveryId, replayInvocationId);
        expect((yield* readRecovery(honestWrongInvocation, replayInvocationId)).status).toBe(404);
        const honestReplay = yield* issueRecovery(replayTuple, replayDeliveryId, replayInvocationId);
        expect(honestReplay.machineContext?.principalId).toBe(recoveryReaderId);
        const recoveredReplay = yield* readRecovery(honestReplay, replayInvocationId);
        expect(recoveredReplay.status).toBe(200);
        const immutableReplay = yield* recoveredReplay.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CreateProductRecoveryResponseSchema)),
        );
        expect(immutableReplay.businessOriginalCreateInvocationId).toBe(originalInvocationId);
        expect(immutableReplay.product.productRef).toEqual(originalReceipt.productRef);
        expect(immutableReplay.product.variants).toHaveLength(1);
        expect(immutableReplay.product.revision).toBe(1);
        expect(immutableReplay.variantId).toBe(originalReceipt.initialVariantRef.resourceId);
        const recoveryWriteKey = 'INTERNAL_C14_RECOVERY_CANNOT_CREATE';
        const originalPayload = yield* admin`
          select effect #> '{intent,payload}' as payload from symmy_integration.job_effects
          where tenant_id=${tenantId} and job_id=${accepted.jobId} and effect_key=${productEffectKey}
        `.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ payload: CreateProductPayloadSchema })])),
          ),
          Effect.map((rows) => rows[0].payload),
        );
        const freshReadOnlyAssertion = yield* issueRecovery(replayTuple, replayDeliveryId, replayInvocationId);
        const refusedWrite = yield* client.post(
          `${new URL(freshReadOnlyAssertion.apiBaseUrl, shell.baseUrl)}/catalog/actions/create-product`,
          {
            body: yield* HttpBody.json(Schema.encodeSync(CreateProductPayloadSchema)(originalPayload)),
            headers: {
              authorization: `Bearer ${freshReadOnlyAssertion.token}`,
              'idempotency-key': recoveryWriteKey,
              'x-correlation-id': randomUUID(),
              'x-ontos-composition-revision': snapshot.composition.revision,
            },
          },
        );
        const refusal = yield* refusedWrite.json.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Union([CreateProductActionAuthenticationProblemSchema, CreateProductActionForbiddenProblemSchema]),
            ),
          ),
        );
        expect(refusedWrite.status).toBe(refusal.status);
        const [refusedInvocation] = yield* admin<{
          count: number;
        }>`select count(*)::integer as count from core.action_invocations where tenant_id=${tenantId} and idempotency_key=${recoveryWriteKey}`;
        expect(refusedInvocation?.count).toBe(0);
        const honestWrongHash = yield* issueRecovery(replayTuple, replayDeliveryId, originalInvocationId);
        const refusedHash = yield* readRecovery(honestWrongHash, replayInvocationId);
        expect(refusedHash.status).toBe(400);
        yield* refusedHash.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CreateProductRecoveryInvalidProblemSchema)),
        );
        const [finalCounts] = yield* admin<{
          products: number;
          variants: number;
        }>`select (select count(*)::integer from catalog.products where tenant_id=${tenantId} and product_id=${originalReceipt.productRef.resourceId}) as products,(select count(*)::integer from catalog.product_variants where tenant_id=${tenantId} and product_id=${originalReceipt.productRef.resourceId}) as variants`;
        expect(finalCounts).toEqual({ products: 1, variants: 2 });
      }),
    ).pipe(Effect.provide(services)),
  360_000,
);
