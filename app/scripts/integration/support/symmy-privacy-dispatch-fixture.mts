import { randomUUID } from 'node:crypto';

import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { loadSpiceDbConfig } from '@app/core-runtime/access/spicedb-config';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { grantTestTenantRoleAccess } from '@app/core-runtime/testing/tenant-access';
import { makeApiKeyGatewayNativeFixture } from '@app/shell-super-app/testing/api-key-gateway-native';
import { SymmyJobStatusResponseSchema } from '@app/symmy-integration/api/symmy-job-status';
import { SymmyInternalExecutionPlanSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { PgClient } from '@effect/sql-pg';
import { Duration, Effect, Redacted, Schema } from 'effect';
import { HttpBody, HttpClient } from 'effect/http';

import {
  buildProductOwner,
  buildProductWorker,
  encodeProductComposition,
  nativePort,
  productComposition,
  startProductOwner,
  startProductWorker,
} from './symmy-c14-product-runtime.mts';

const marketApp = 'commerce-market-catalog';
const symmyApp = 'symmy-integration';
const workerKey = 'integration.symmy.execute-symmy-job';
const importWorkload = 'commerce.catalog.symmy-product-import';
const sourceIssuer = 'INTERNAL_PRIVACY_DISPATCH_ISSUER';
const sourceNamespace = 'INTERNAL_PRIVACY_DISPATCH_PRODUCTS';
export const privateIntentMarker = 'INTERNAL_PRIVACY_DISPATCH_PRIVATE_INTENT';
export const retentionCapability = 'integration.symmy.symmy-retention.execute';
const receiptCapability = 'integration.symmy.privacy-measure.read-receipt';
const humanCapabilities = [
  'privacy.core.privacy-measure.dispatch',
  'privacy.core.measure-execution-eligibility.read',
  'privacy.core.owner-execution-outcome.record',
];
const relayRules = [
  {
    audience: 'catalog',
    declarationKey: 'commerce.catalog.product.create',
    entrypointKey: 'commerce.catalog.create-product',
    jobKey: workerKey,
    legalEntityScope: 'forbidden' as const,
    schemaVersion: '2',
    workerKey,
    workloadKey: importWorkload,
  },
];
const receiptSchema = Schema.Struct({
  jobId: SymmyJobStatusResponseSchema.members[0].fields.jobId,
  status: Schema.Literal('admitted'),
});
const json = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json));

export class PrivacyDispatchNativeFailure extends Schema.TaggedError<PrivacyDispatchNativeFailure>()(
  'PrivacyDispatchNativeFailure',
  { cause: Schema.optionalKey(Schema.Redacted(Schema.Defect())), reason: Schema.String },
) {}
export const observePrivacyDispatchUntil = <A, E, R>(
  reason: string,
  observation: Effect.Effect<A, E, R>,
  completed: (value: A) => boolean,
) =>
  Effect.gen(function* observePrivacyDispatch() {
    for (;;) {
      const observed = yield* observation;
      if (completed(observed)) {
        return observed;
      }
      yield* Effect.sleep(Duration.millis(50));
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(70),
      orElse: () => new PrivacyDispatchNativeFailure({ reason }),
    }),
  );

const seedPrincipal = Effect.fn('PrivacyDispatchNative.principal')(function* seedPrincipal(
  admin: PgClient.PgClient,
  tenantId: string,
  kind: 'human' | 'integration' | 'service' | 'system',
  providerUserId?: string,
) {
  const principalId = randomUUID();
  yield* admin`insert into core.principals(principal_id,tenant_id,kind,status,display_name)
    values(${principalId},${tenantId},${kind},'active','INTERNAL Privacy dispatch fixture')`;
  if (providerUserId !== undefined) {
    yield* admin`insert into core.principal_auth_bindings(principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status)
      values(${randomUUID()},${tenantId},${principalId},${STAFF_AUTHENTICATION_NAMESPACE_ID},'better_auth','user',${providerUserId},'active')`;
  }
  return { principalId, tenantId };
});
const assignmentCountsSchema = Schema.Tuple([Schema.Struct({ companies: Schema.Int, tenants: Schema.Int })]);
const fixtureAssignmentCounts = (
  admin: PgClient.PgClient,
  tenantId: string,
  principalId: string,
  legalEntityId: string,
) =>
  admin`select count(*) filter(where s.legal_entity_id=${legalEntityId})::integer as companies,
    count(*) filter(where s.tenant_context_id=a.tenant_id)::integer as tenants
    from core.access_assignments a join core.access_scopes s on s.tenant_id=a.tenant_id and s.scope_id=a.scope_id
    where a.tenant_id=${tenantId} and a.principal_id=${principalId} and a.status='active'`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(assignmentCountsSchema)),
  );
const bindKey = (
  admin: PgClient.PgClient,
  principal: { readonly principalId: string; readonly tenantId: string },
  keyId: string,
) =>
  admin`insert into core.principal_auth_bindings(principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status)
    values(${randomUUID()},${principal.tenantId},${principal.principalId},${STAFF_AUTHENTICATION_NAMESPACE_ID},'better_auth','api_key',${keyId},'active')`;

export const makePrivacyDispatchNativeFixture = Effect.fn('PrivacyDispatchNative.fixture')(function* fixture() {
  const ports = new Map<string, number>();
  for (const appId of ['catalog', symmyApp, 'privacy', marketApp]) {
    let port = yield* nativePort;
    while ([...ports.values()].includes(port)) {
      port = yield* nativePort;
    }
    ports.set(appId, port);
  }
  const backends = Object.fromEntries([...ports].map(([appId, port]) => [appId, `http://127.0.0.1:${port}/`]));
  const { contracts, snapshot } = yield* productComposition(backends);
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'implementation-1096-registered-workload-gateway',
  });
  const admin = yield* PgClient.make({ url: Redacted.make(isolated.connections.admin.connectionString) });
  const shell = yield* makeApiKeyGatewayNativeFixture({
    additionalRelaySources: [
      { registeredWorkloads: [], sourceAppId: 'privacy' },
      { registeredWorkloads: [], sourceAppId: 'catalog' },
      { registeredWorkloads: [], sourceAppId: marketApp },
    ],
    ownedDatabase: isolated,
    productionGate: true,
    relaySource: { registeredWorkloads: relayRules, sourceAppId: symmyApp },
    snapshotJson: yield* encodeProductComposition(snapshot),
  });
  const tenantId = randomUUID();
  const legalEntityId = randomUUID();
  const tenantSlug = `privacy-dispatch-${tenantId}`;
  yield* admin`insert into core.tenants(tenant_id,name,slug,status,default_locale)
    values(${tenantId},'INTERNAL Privacy dispatch fixture',${tenantSlug},'active','en')`;
  yield* admin`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status)
    values(${legalEntityId},${tenantId},'INTERNAL Privacy governance','CZ','INTERNAL_ONLY','active')`;
  const human = yield* seedPrincipal(admin, tenantId, 'human', shell.providerUserId);
  const integration = yield* seedPrincipal(admin, tenantId, 'integration');
  const system = yield* seedPrincipal(admin, tenantId, 'system');
  for (const module of snapshot.composition.modules) {
    yield* admin`insert into core.tenant_module_states(tenant_id,module_key,state) values(${tenantId},${module.moduleId},'active')`;
  }
  const spiceDb = yield* loadSpiceDbConfig({ envPath: '/dev/null' });
  const grantHuman = (includeRetention: boolean) =>
    grantTestTenantRoleAccess({
      holders: [
        {
          capabilityKeys: includeRetention ? [receiptCapability, retentionCapability] : [receiptCapability],
          principalId: human.principalId,
        },
      ],
      legalEntityIds: [legalEntityId],
      spiceDb,
      tenantId,
      writerConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    });
  yield* grantTestTenantRoleAccess({
    assignmentScope: 'companies',
    holders: [{ capabilityKeys: [...humanCapabilities, retentionCapability], principalId: human.principalId }],
    legalEntityIds: [legalEntityId],
    spiceDb,
    tenantId,
    writerConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
  });
  const [companyOnlyAssignments] = yield* fixtureAssignmentCounts(admin, tenantId, human.principalId, legalEntityId);
  yield* grantHuman(false);
  for (const [principalId, workload] of [
    [integration.principalId, 'integration.symmy-admit'],
    [integration.principalId, 'integration.symmy-poll'],
    [integration.principalId, importWorkload],
    [system.principalId, workerKey],
    [system.principalId, importWorkload],
  ]) {
    yield* admin`insert into core.access_workload_bindings(binding_id,incarnation,tenant_id,principal_id,workload_key,status)
      values(${randomUUID()},${randomUUID()},${tenantId},${principalId},${workload},'active')`;
  }
  const sourceKey = yield* shell.issueFixtureProviderKey({ ...integration, issuerPrincipalId: human.principalId });
  yield* bindKey(admin, integration, sourceKey.providerKeyId);
  yield* sourceKey.acknowledgeBinding;
  if (shell.relaySourceProviderUserId === undefined) {
    return yield* new PrivacyDispatchNativeFailure({ reason: 'The real Symmy module issuer was not provisioned' });
  }
  const symmyIssuer = yield* seedPrincipal(admin, tenantId, 'human', shell.relaySourceProviderUserId);
  const symmyPrincipal = yield* seedPrincipal(admin, tenantId, 'service');
  const symmyKey = yield* shell.issueFixtureRelaySourceProviderKey({
    ...symmyPrincipal,
    issuerPrincipalId: symmyIssuer.principalId,
  });
  yield* bindKey(admin, symmyPrincipal, symmyKey.providerKeyId);
  yield* symmyKey.acknowledgeBinding;
  const keys = new Map<string, string>([[symmyApp, Redacted.value(symmyKey.secret)]]);
  for (const provider of shell.additionalRelaySourceProviderUsers) {
    const issuer = yield* seedPrincipal(admin, tenantId, 'human', provider.providerUserId);
    const principal = yield* seedPrincipal(admin, tenantId, 'service');
    const key = yield* shell.issueFixtureModuleProviderKey({
      ...principal,
      issuerPrincipalId: issuer.principalId,
      sourceAppId: provider.sourceAppId,
    });
    yield* bindKey(admin, principal, key.providerKeyId);
    yield* key.acknowledgeBinding;
    keys.set(provider.sourceAppId, Redacted.value(key.secret));
  }
  const routeId = randomUUID();
  const sourceRouteId = randomUUID();
  const policy = { policyId: 'INTERNAL_PRIVACY_DISPATCH_RETENTION', revision: 'v1' };
  const planFor = (recordId: string) =>
    Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
      items: [
        {
          effects: [
            {
              effectKey: 'catalog-product',
              intent: {
                _tag: 'CatalogCreateProduct',
                payload: {
                  name: privateIntentMarker,
                  sourceCorrelation: {
                    initialVariantRecordId: `variant-${recordId}`,
                    issuerId: sourceIssuer,
                    mappingRevision: 'v1',
                    recordId,
                    recordNamespace: sourceNamespace,
                    routeScope: sourceRouteId,
                  },
                },
              },
              operation: {
                entrypointKey: 'commerce.catalog.create-product',
                moduleId: 'commerce.catalog',
                schemaVersion: '2',
              },
            },
          ],
          itemKey: 'source-private-intent',
          source: { entityKind: 'PRODUCT', issuerId: sourceIssuer, sourceNamespace, sourceRecordId: recordId },
          sourceOccurrenceId: randomUUID(),
        },
      ],
    });
  const template = yield* Schema.encodeEffect(SymmyInternalExecutionPlanSchema)(yield* planFor('INTERNAL_TEMPLATE'));
  yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,principal_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_revision,lifecycle_policy)
    values(${routeId},${tenantId},${integration.principalId},true,array['INTERNAL_C14'],${yield* json({ ...template, sourceRouteId })}::jsonb,'v1','productsBatch','v1',${yield* json(policy)}::jsonb)`;
  const environment = {
    APP_ENV_PATH: '/dev/null',
    DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
    DATABASE_URL: isolated.connections.runtime.connectionString,
    ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: shell.compositionSourceUrl,
    ONTOS_C14_TRACE_PROBLEMS: 'true',
    ONTOS_GATEWAY_ISSUER: shell.issuer,
    ONTOS_GATEWAY_PUBLIC_JWKS: shell.publicJwks,
    ONTOS_SHELL_GATEWAY_BASE_URL: `${shell.baseUrl}/shell-super-app-api`,
    ONTOS_SYMMY_JOB_RETENTION_POLICIES: yield* json([
      {
        ...policy,
        governanceLegalEntityId: legalEntityId,
        retentionMs: 1,
        routeId,
        targetLegalEntityId: null,
        tenantId,
      },
    ]),
  };
  const prefixes = {
    catalog: '/catalog-api',
    [marketApp]: '/commerce-market-catalog-api',
    privacy: '/privacy-api',
    [symmyApp]: '/symmy-integration-api',
  } as const;
  const diagnostics = new Map<string, Effect.Effect<string>>();
  for (const appId of ['catalog', 'privacy', symmyApp, marketApp] as const) {
    const contract = contracts.find(({ deployment }) => deployment.appId === appId);
    const port = ports.get(appId);
    if (contract === undefined || port === undefined) {
      return yield* new PrivacyDispatchNativeFailure({ reason: 'An actual owner deployment is missing' });
    }
    const moduleKey = keys.get(appId);
    if (moduleKey === undefined) {
      return yield* new PrivacyDispatchNativeFailure({ reason: 'The actual owner module credential is missing' });
    }
    const receiver = yield* startProductOwner({
      artifacts: yield* buildProductOwner(contract),
      contract,
      environment: { ...environment, ONTOS_GATEWAY_MODULE_API_KEY: moduleKey },
      port,
      prefix: prefixes[appId],
    });
    diagnostics.set(appId, receiver.diagnostic);
  }
  const symmyContract = contracts.find(({ deployment }) => deployment.appId === symmyApp);
  if (symmyContract === undefined) {
    return yield* new PrivacyDispatchNativeFailure({ reason: 'The actual Symmy worker deployment is missing' });
  }
  const worker = yield* startProductWorker(yield* buildProductWorker(symmyContract), {
    ...environment,
    ONTOS_C14_WORKER_CLAIM_OWNER: `INTERNAL_PRIVACY_DISPATCH_${randomUUID()}`,
    ONTOS_GATEWAY_MODULE_API_KEY: Redacted.value(symmyKey.secret),
  });
  const client = yield* HttpClient.HttpClient;
  const submit = Effect.fn('PrivacyDispatchNative.submit')(function* submit(key: string) {
    const plan = yield* planFor(key);
    const payload = {
      contractVersion: 'INTERNAL_C14',
      plan: yield* Schema.encodeEffect(SymmyInternalExecutionPlanSchema)(plan),
    };
    const response = yield* client.post(`${shell.baseUrl}/api/symmy/v1/products/batch`, {
      body: yield* HttpBody.json(payload),
      headers: { 'idempotency-key': key, 'x-api-key': Redacted.value(sourceKey.secret) },
    });
    if (response.status !== 202) {
      return yield* new PrivacyDispatchNativeFailure({
        reason: `Actual source admission refused with ${response.status}`,
      });
    }
    return { payload, receipt: yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(receiptSchema))) };
  });
  return {
    admin,
    client,
    companyOnlyAssignments,
    diagnostics,
    environment,
    grantHuman,
    human,
    isolated,
    keys,
    legalEntityId,
    ports,
    shell,
    snapshot,
    sourceKey,
    submit,
    tenantId,
    worker,
  };
});
