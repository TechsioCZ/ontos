import { randomUUID } from 'node:crypto';

import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { writeTestTenantScopes } from '@app/core-runtime/testing/tenant-access';
import { SYMMY_ROUTES } from '@app/shared-contracts/symmy';
import { makeApiKeyGatewayNativeFixture } from '@app/shell-super-app/testing/api-key-gateway-native';
import { SymmyJobStatusResponseSchema } from '@app/symmy-integration/api/symmy-job-status';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { assert } from 'effect-rstest';
import { Duration, Effect, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpBody, HttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';

import {
  SymmyC14ProductFixtureUnavailable,
  encodeProductComposition,
  nativePort,
  productComposition,
} from './symmy-c14-product-runtime.mts';
import type { C14PolicyFixtureOwner } from './symmy-c14-product-runtime.mts';

const assortmentCurrentnessWorkload = 'commerce.assortment.symmy-fixture-currentness';
/** The Assortment fixture's owners that call other modules, each holding its own platform-provisioned key. */
const assortmentCallingOwners = [
  'assortment',
  'catalog',
  'commerce-customer-context',
  'commerce-market-catalog',
] as const;
const assortmentCurrentnessAudiences = [
  'catalog',
  'commerce-customer-context',
  'commerce-market-catalog',
  'storefront-registry',
] as const;
const workerKey = 'integration.symmy.execute-symmy-job';
const symmyApp = 'symmy-integration';

const admissionReceipt = Schema.Struct({
  jobId: SymmyJobStatusResponseSchema.members[0].fields.jobId,
  status: Schema.Literal('admitted'),
});
const polledJob = Schema.Struct({
  items: Schema.optionalKey(Schema.Array(Schema.Struct({ outcome: Schema.String }))),
  jobId: admissionReceipt.fields.jobId,
  status: Schema.String,
});
export const policyFixtureServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
export const encodePolicyFixtureJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const addPrincipal = Effect.fn('SymmyC14Policy.addPrincipal')(function* addPrincipal(
  admin: PgClient.PgClient,
  tenantId: string,
  kind: 'human' | 'integration' | 'system',
) {
  const principalId = randomUUID();
  yield* admin`insert into core.principals(principal_id,tenant_id,kind,status,display_name)
    values(${principalId},${tenantId},${kind},'active','INTERNAL_C14 policy actor')`;
  return { principalId, tenantId };
});

const bindPrincipal = (
  admin: PgClient.PgClient,
  principal: { readonly principalId: string; readonly tenantId: string },
  subjectType: 'user' | 'api_key',
  subjectId: string,
) => admin`insert into core.principal_auth_bindings(principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status)
  values(${randomUUID()},${principal.tenantId},${principal.principalId},${STAFF_AUTHENTICATION_NAMESPACE_ID},'better_auth',${subjectType},${subjectId},'active')`;

interface FixtureScope {
  readonly admin: PgClient.PgClient;
  readonly principalId: string;
  readonly sellerId: string;
  readonly tenantId: string;
}

export const initializePolicyFixtureScopes = ({ principalId, sellerId, tenantId }: FixtureScope) =>
  testCoreDatabase.pipe(
    Effect.flatMap((core) => writeTestTenantScopes(core, { legalEntityIds: [sellerId], principalId, tenantId })),
  );

export const makeSymmyC14PolicyFixture = Effect.fn('SymmyC14Policy.makeFixture')(function* makeFixture<
  Failure,
  Requirements,
>({
  initializeScopes,
  lifecyclePolicy,
  owner,
  workloadKey,
}: {
  readonly initializeScopes: (scope: FixtureScope) => Effect.Effect<void, Failure, Requirements>;
  readonly lifecyclePolicy: { readonly policyId: string; readonly revision: string };
  readonly owner: C14PolicyFixtureOwner;
  readonly workloadKey: string;
}) {
  const ownerPort = yield* nativePort;
  const currentnessReceivers =
    owner === 'assortment'
      ? yield* Effect.forEach(
          assortmentCurrentnessAudiences,
          Effect.fn('SymmyC14Policy.currentnessPort')(function* currentnessPort(
            audience: (typeof assortmentCurrentnessAudiences)[number],
          ) {
            return { audience, port: yield* nativePort };
          }),
          { concurrency: 1 },
        )
      : [];
  let symmyPort = yield* nativePort;
  while (symmyPort === ownerPort) {
    symmyPort = yield* nativePort;
  }
  const { contracts, snapshot } = yield* productComposition(
    {
      ...Object.fromEntries(currentnessReceivers.map(({ audience, port }) => [audience, `http://127.0.0.1:${port}/`])),
      [owner]: `http://127.0.0.1:${ownerPort}/`,
      [symmyApp]: `http://127.0.0.1:${symmyPort}/`,
    },
    [owner],
  );
  const ownerContract = contracts.find(({ deployment }) => deployment.appId === owner);
  const symmy = contracts.find(({ deployment }) => deployment.appId === symmyApp);
  assert.isOk(ownerContract);
  assert.isOk(symmy);

  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'implementation-1096-registered-workload-gateway',
  });
  const admin = yield* PgClient.make({ url: Redacted.make(isolated.connections.admin.connectionString) });
  const shell = yield* makeApiKeyGatewayNativeFixture({
    ...(owner === 'assortment' && {
      additionalRelaySources: assortmentCallingOwners.map((sourceAppId) => ({ sourceAppId })),
    }),
    ownedDatabase: isolated,
    productionGate: true,
    relaySource: { sourceAppId: symmyApp },
    snapshotJson: yield* encodeProductComposition(snapshot),
  });

  const tenantId = randomUUID();
  const sellerId = randomUUID();
  const routeId = randomUUID();
  const slug = `internal-c14-${tenantId}`;
  yield* admin`insert into core.tenants(tenant_id,name,slug,status,default_locale)
    values(${tenantId},'INTERNAL_C14 native policy fixture',${slug},'active','en')`;
  yield* admin`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status)
    values(${sellerId},${tenantId},'INTERNAL_C14 policy seller','CZ','INTERNAL_C14','active')`;
  for (const module of snapshot.composition.modules) {
    yield* admin`insert into core.tenant_module_states(tenant_id,module_key,state) values(${tenantId},${module.moduleId},'active')`;
  }
  const issuer = yield* addPrincipal(admin, tenantId, 'human');
  const integration = yield* addPrincipal(admin, tenantId, 'integration');
  const system = yield* addPrincipal(admin, tenantId, 'system');
  yield* initializeScopes({ admin, principalId: issuer.principalId, sellerId, tenantId });
  yield* bindPrincipal(admin, issuer, 'user', shell.providerUserId);
  for (const [principalId, workload] of [
    [integration.principalId, 'integration.symmy-admit'],
    [integration.principalId, 'integration.symmy-poll'],
    [integration.principalId, workloadKey],
    [system.principalId, workerKey],
    [system.principalId, workloadKey],
    ...(owner === 'assortment'
      ? [
          [system.principalId, assortmentCurrentnessWorkload],
          [integration.principalId, assortmentCurrentnessWorkload],
        ]
      : []),
  ]) {
    yield* admin`insert into core.access_workload_bindings(binding_id,incarnation,tenant_id,principal_id,workload_key,status)
      values(${randomUUID()},${randomUUID()},${tenantId},${principalId},${workload},'active')`;
  }
  const key = yield* shell.issueFixtureProviderKey({ ...integration, issuerPrincipalId: issuer.principalId });
  yield* bindPrincipal(admin, integration, 'api_key', key.providerKeyId);
  yield* key.acknowledgeBinding;
  // Each calling owner's own module key, provisioned by the platform for its module principal as on every environment.
  const symmyModuleKey = (yield* shell.provisionRelaySource()).secret;
  const moduleKeys = new Map<string, Redacted.Redacted>([[symmyApp, symmyModuleKey]]);
  if (owner === 'assortment') {
    for (const appId of assortmentCallingOwners) {
      moduleKeys.set(appId, (yield* shell.provisionModuleSource(appId)).secret);
    }
  }

  const environment = {
    APP_ENV_PATH: '/dev/null',
    DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
    DATABASE_URL: isolated.connections.runtime.connectionString,
    ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: shell.compositionSourceUrl,
    ONTOS_C14_TRACE_PROBLEMS: 'true',
    ONTOS_GATEWAY_ISSUER: shell.issuer,
    ONTOS_GATEWAY_PUBLIC_JWKS: shell.publicJwks,
    ONTOS_SHELL_GATEWAY_BASE_URL: `${shell.baseUrl}/shell-super-app-api`,
    ONTOS_SYMMY_JOB_RETENTION_POLICIES: yield* encodePolicyFixtureJson([
      {
        ...lifecyclePolicy,
        governanceLegalEntityId: sellerId,
        retentionMs: Duration.toMillis(Duration.minutes(10)),
        routeId,
        targetLegalEntityId: sellerId,
        tenantId,
      },
    ]),
  };
  return {
    admin,
    apiKey: key.secret,
    currentnessReceivers: currentnessReceivers.flatMap((receiver) => {
      const contract = contracts.find(({ deployment }) => deployment.appId === receiver.audience);
      return contract === undefined ? [] : [{ ...receiver, contract, moduleKey: moduleKeys.get(receiver.audience) }];
    }),
    environment,
    integration,
    ownerContract,
    ownerModuleKey: moduleKeys.get(owner),
    ownerPort,
    routeId,
    sellerId,
    shell,
    symmy,
    symmyModuleKey,
    symmyPort,
    system,
    tenantId,
  };
});

export const makeSymmyC14PolicyClient = Effect.fn('SymmyC14Policy.makeClient')(function* makeClient(
  { apiKey, shell }: Effect.Success<ReturnType<typeof makeSymmyC14PolicyFixture>>,
  symmyPath: string,
  fixtureId: string,
  diagnostic: Effect.Effect<string>,
) {
  const client = yield* HttpClient.HttpClient;
  const headers = { 'x-api-key': Redacted.value(apiKey) };
  const post = Effect.fn('SymmyC14Policy.postFixture')(function* postFixture(
    idempotencyKey: string,
    payload: Schema.Json,
    credential: Redacted.Redacted = apiKey,
  ) {
    return yield* client.post(`${shell.baseUrl}${symmyPath}`, {
      body: yield* HttpBody.json(payload),
      headers: { 'idempotency-key': idempotencyKey, 'x-api-key': Redacted.value(credential) },
    });
  });
  const submit = Effect.fn('SymmyC14Policy.submitFixture')(function* submitFixture(idempotencyKey: string) {
    const response = yield* post(idempotencyKey, { fixtureId });
    if (response.status !== 202) {
      const issuerTrace = yield* shell.issuerDiagnostics();
      const release = yield* shell.releaseDiagnostics();
      return yield* new SymmyC14ProductFixtureUnavailable({
        message: `Actual policy fixture admission returned ${response.status}; issuer: ${yield* encodePolicyFixtureJson(issuerTrace)}; release: ${yield* encodePolicyFixtureJson(release)}; Symmy: ${yield* diagnostic}`,
      });
    }
    return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(admissionReceipt)));
  });
  const poll = (jobId: string) =>
    client.get(`${shell.baseUrl}${SYMMY_ROUTES.job.path.replace('{id}', jobId)}`, { headers }).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(polledJob)),
    );
  return { poll, post, submit };
});

export const observePolicyFixtureUntil = <Value, Failure, Requirements>(
  observe: Effect.Effect<Value, Failure, Requirements>,
  ready: (value: Value) => boolean,
  onTimeout: Effect.Effect<never, SymmyC14ProductFixtureUnavailable>,
) =>
  Effect.gen(function* observeNativeState() {
    for (let attempt = 0; attempt < 450; attempt += 1) {
      const value = yield* observe;
      if (ready(value)) {
        return value;
      }
      yield* Effect.sleep(Duration.millis(100));
    }
    return yield* onTimeout;
  });
