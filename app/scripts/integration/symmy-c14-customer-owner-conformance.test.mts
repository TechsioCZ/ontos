import { CustomerProfileSourceItemSchema } from '@app/commerce-customer-context/api/customer-profile-source';
import {
  EnsureRetailCustomerProfileActionAuthenticationProblemSchema,
  EnsureRetailCustomerProfileActionForbiddenProblemSchema,
} from '@app/commerce-customer-context/api/ensure-retail-customer-profile-action';
import { executeEnsureRetailCustomerProfileWithAuthorization } from '@app/commerce-customer-context/api/ensure-retail-customer-profile-action/client';
import { RetailCustomerProfileRefSchema } from '@app/commerce-customer-context/resources/retail-customer-profile';
import { enrollCustomerProfileSourceReaderNativeFixture } from '@app/commerce-customer-context/testing/customer-profile-source-reader';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { SourceProfileExportResponseSchema } from '@app/party-registry/apis/source-profile-export';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { SourceProcessingContextSchema } from '@app/privacy/api';
import {
  seedCommittedProfileSourceProcessingNativeFixture,
  seedSourceProcessingNativeFixture,
} from '@app/privacy/testing/source-processing-native';
import { makeApiKeyGatewayNativeFixture } from '@app/shell-super-app/testing/api-key-gateway-native';
import { SymmyEffectIdSchema } from '@app/shared-contracts/symmy';
import { SymmyJobStatusResponseSchema } from '@app/symmy-integration/api/symmy-job-status';
import {
  SymmyInternalExecutionPlanSchema,
  SymmyRouteExecutionConfigurationSchema,
} from '@app/symmy-integration/symmy-internal-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { assert, expect, it } from 'effect-rstest';
import { Config, DateTime, Duration, Effect, FileSystem, Layer, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpBody, HttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';

import {
  bindCustomerFixtureProviderKey as bindProviderKey,
  customerFixtureUuid as uuid,
  seedCustomerFixtureProviderPrincipal as seedPrincipal,
} from './support/symmy-c14-customer-native-authority.mts';
import { internalCustomerSource, makeSymmyC14CustomerPlan } from './support/symmy-c14-customer-plan.mts';
import {
  CustomerNativeProfileInvocationSchema,
  issueCustomerProfileFixtureRecovery,
} from './support/symmy-c14-customer-recovery.mts';
import { customerContexts, readbackContexts } from './support/symmy-c14-customer-contexts.mts';
import { customerItemSource, customerOccurrenceId, customersBody } from './support/symmy-c14-customer-public.mts';
import {
  customerFixtureWorkloads,
  customerIntakeContext,
  customerWorkerKey,
} from './support/symmy-c14-customer-rules.mts';
import {
  SymmyC14ProductFixtureUnavailable,
  buildProductOwner,
  buildProductWorker,
  encodeProductComposition,
  nativePorts,
  productComposition,
  startProductOwner,
  startProductWorker,
} from './support/symmy-c14-product-runtime.mts';

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
const receiptSchema = Schema.Struct({
  jobId: SymmyJobStatusResponseSchema.members[0].fields.jobId,
  status: Schema.Literal('queued'),
});
const nativeInvocationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('NativeActionInvocationId'),
  Schema.decodeTo(Schema.String),
);
const effectSchema = Schema.Struct({
  effect_id: Schema.toEncoded(SymmyEffectIdSchema),
  effect_key: Schema.String,
  owner_invocation_id: Schema.OptionFromNullOr(nativeInvocationIdSchema),
  owner_receipt: Schema.Unknown,
  state: Schema.String,
});
const partyReceiptSchema = Schema.Struct({ _tag: Schema.Literal('PartyCreated'), partyRef: PartyRefSchema });
const profileReceiptSchema = Schema.Struct({
  _tag: Schema.Literal('RetailProfileEnsured'),
  partyRef: PartyRefSchema,
  profileRef: RetailCustomerProfileRefSchema,
});
const sourceRecordIdSchema = Schema.String.pipe(Schema.brand('SourceRecordId'));
const customerReadbackSchema = Schema.Struct({
  count: Schema.Int,
  customers: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isPattern(/^~c14r1\.[a-zA-Z0-9_-]{43}$/u)),
      party: Schema.optionalKey(SourceProfileExportResponseSchema.members[1]),
      partyRef: PartyRefSchema,
      profile: CustomerProfileSourceItemSchema.fields.profile,
      sourceRecordId: sourceRecordIdSchema,
    }),
  ),
  limit: Schema.Int,
  offset: Schema.Int,
});
const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const customerItemKey = 'customer-0';
const privacyApiPrefix = '/privacy-api';
const partyCreateEffectKey = 'party-create';
const symmyAppId = 'symmy-integration';
const commerceModuleId = 'commerce.customer-context';
const partyModuleId = 'party.registry';
const customerController = 'internal:customer-conformance';
const unavailable = (message: string) => new SymmyC14ProductFixtureUnavailable({ message });

const observeUntil = <Value, Failure, Requirements>(
  observe: Effect.Effect<Value, Failure, Requirements>,
  ready: (value: Value) => boolean,
  attempts = 600,
) =>
  Effect.gen(function* observeCustomerJob() {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const value = yield* observe;
      if (ready(value)) {
        return value;
      }
      yield* Effect.sleep(Duration.millis(50));
    }
    return yield* unavailable('The actual customer owner dependency graph did not settle');
  });

interface OwnerRuntime {
  readonly artifacts: Effect.Success<ReturnType<typeof buildProductOwner>>;
  readonly contract: Effect.Success<ReturnType<typeof productComposition>>['contracts'][number];
  readonly moduleKey: string;
  readonly port: number;
  readonly receiver: Effect.Success<ReturnType<typeof startProductOwner>>;
}
type OwnerPrefix = Parameters<typeof startProductOwner>[0]['prefix'];
interface StartOwnerInput {
  readonly appId: string;
  readonly contracts: Effect.Success<ReturnType<typeof productComposition>>['contracts'];
  readonly environment: Readonly<Record<string, string>>;
  readonly moduleKeys: ReadonlyMap<string, string>;
  readonly ownerDiagnostics: Map<string, Effect.Effect<string>>;
  readonly ownerRuntimes: Map<string, OwnerRuntime>;
  readonly ports: ReadonlyMap<string, number>;
  readonly prefixes: Readonly<Record<string, OwnerPrefix>>;
}

/** Builds and starts one actual owner receiver with its own independent module credential. */
const startOwner = Effect.fn('SymmyC14Customer.startOwner')(function* startOwner(input: StartOwnerInput) {
  const { appId, contracts, environment, moduleKeys, ownerDiagnostics, ownerRuntimes, ports, prefixes } = input;
  const contract = contracts.find(({ deployment }) => deployment.appId === appId);
  const port = ports.get(appId);
  const moduleKey = moduleKeys.get(appId);
  const prefix = prefixes[appId];
  if (contract === undefined || port === undefined || prefix === undefined) {
    return yield* unavailable('The bounded receiver contract, port or prefix is missing');
  }
  if (moduleKey === undefined) {
    return yield* unavailable('The actual independent module credential is missing');
  }
  const artifacts = yield* buildProductOwner(contract);
  const receiver = yield* startProductOwner({
    artifacts,
    contract,
    environment: { ...environment, ONTOS_GATEWAY_MODULE_API_KEY: moduleKey },
    port,
    prefix,
  });
  ownerDiagnostics.set(appId, receiver.diagnostic);
  ownerRuntimes.set(appId, { artifacts, contract, moduleKey, port, receiver });
  return yield* Effect.void;
});

interface ReadbackInput {
  readonly admin: PgClient.PgClient;
  readonly client: HttpClient.HttpClient;
  readonly headers: Readonly<Record<string, string>>;
  readonly ownerDiagnostics: ReadonlyMap<string, Effect.Effect<string>>;
  readonly partyRef: typeof PartyRefSchema.Type;
  readonly profileResourceId: string;
  readonly readRoute: typeof SymmyRouteExecutionConfigurationSchema.Type;
  readonly readRouteId: string;
  readonly recordId: string;
  readonly shell: Effect.Success<ReturnType<typeof makeApiKeyGatewayNativeFixture>>;
  readonly tenantId: string;
}

/** The customers GET exports the current owners under the reader authority, and refuses every wrong enrollment. */
const readCustomers = Effect.fn('SymmyC14Customer.readCustomers')(function* readCustomers(input: ReadbackInput) {
  const { admin, client, headers, ownerDiagnostics, partyRef, profileResourceId, readRoute, readRouteId } = input;
  const { recordId, shell, tenantId } = input;
  const readbackUrl = `${shell.baseUrl}/api/symmy/v1/admin/customers`;
  const customerReadbackResponse = yield* client
    .get(readbackUrl, { headers })
    .pipe(
      Effect.tap((response) =>
        response.status === 200
          ? Effect.void
          : Effect.all([
              shell.gatewayDiagnostics().pipe(Effect.flatMap(Effect.logError)),
              shell.issuerDiagnostics().pipe(Effect.flatMap(Effect.logError)),
              ...[...ownerDiagnostics].map(([appId, diagnostic]) =>
                diagnostic.pipe(Effect.flatMap((message) => Effect.logError({ appId, message }))),
              ),
            ]),
      ),
    );
  expect(customerReadbackResponse.status).toBe(200);
  const readback = yield* customerReadbackResponse.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(customerReadbackSchema)),
  );
  expect(readback).toMatchObject({ count: 1, limit: 50, offset: 0 });
  expect(readback.customers).toHaveLength(1);
  const exportedCustomer = readback.customers.at(0);
  assert.isOk(exportedCustomer);
  expect(exportedCustomer.sourceRecordId).toBe(recordId);
  expect(exportedCustomer.id).not.toBe(recordId);
  expect(exportedCustomer.partyRef).toEqual(partyRef);
  expect(exportedCustomer.profile.profileRef.resourceId).toBe(profileResourceId);
  assert.isOk(exportedCustomer.party);
  expect(exportedCustomer.party.firstName).toBe('Internal');
  expect(exportedCustomer.party.lastName).toBe('Customer');
  const readPage = (query: string) =>
    client.get(`${readbackUrl}${query}`, { headers }).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(customerReadbackSchema)),
    );
  // The owner pages by offset and counts its customers: past the last one the page is empty, the count is not.
  expect(yield* readPage('?limit=1&offset=0')).toMatchObject({ count: 1, limit: 1, offset: 0 });
  expect(yield* readPage('?offset=1')).toMatchObject({ count: 1, customers: [], offset: 1 });
  // An unselected part is not read: no Party export, so no `party`.
  const withoutParty = yield* readPage('?fields=partyRef');
  expect(withoutParty.customers.map(({ sourceRecordId }) => sourceRecordId)).toEqual([recordId]);
  expect(withoutParty.customers[0]).not.toHaveProperty('party');
  for (const rejectedQuery of [
    `?afterRecordId=${recordId}`,
    `?code=${recordId}`,
    '?contractVersion=INTERNAL_C14',
    '?fields=bogus',
  ]) {
    expect((yield* client.get(`${readbackUrl}${rejectedQuery}`, { headers })).status, rejectedQuery).toBe(400);
  }
  yield* Effect.logInfo('INTERNAL_C14 customer GET exported current protected owners under explicit reader authority');
  const wrongReadRoutes = yield* Effect.forEach(
    [
      { ...readRoute, sourceRouteId: yield* uuid },
      {
        ...readRoute,
        items: readRoute.items.map((item) => ({
          ...item,
          source: { ...item.source, issuerId: 'INTERNAL_C14_UNENROLLED_ISSUER' },
        })),
      },
      {
        ...readRoute,
        items: readRoute.items.map((item) => ({
          ...item,
          source: { ...item.source, sourceNamespace: 'INTERNAL_C14_UNENROLLED_NAMESPACE' },
        })),
      },
    ],
    (wrongRoute) => Schema.decodeUnknownEffect(SymmyRouteExecutionConfigurationSchema)(wrongRoute),
  );
  yield* Effect.forEach(
    wrongReadRoutes,
    (wrongRoute) =>
      Effect.gen(function* rejectWrongCustomerProjectionAuthority() {
        yield* admin`update symmy_integration.job_routes set fixture_plan=${yield* Schema.encodeEffect(Schema.fromJsonString(SymmyRouteExecutionConfigurationSchema))(wrongRoute)}::jsonb
          where tenant_id=${tenantId} and route_id=${readRouteId}`;
        const rejected = yield* client.get(readbackUrl, { headers });
        expect(rejected.status).toBe(403);
        const rejectedBody = yield* rejected.text;
        expect(rejectedBody.includes('Internal')).toBe(false);
        expect(rejectedBody.includes('"Customer"')).toBe(false);
      }),
    { discard: true },
  );
  yield* admin`update symmy_integration.job_routes set fixture_plan=${yield* Schema.encodeEffect(Schema.fromJsonString(SymmyRouteExecutionConfigurationSchema))(readRoute)}::jsonb
    where tenant_id=${tenantId} and route_id=${readRouteId}`;
  return { party: exportedCustomer.party, sourceRecordId: exportedCustomer.sourceRecordId };
});

interface SearchInput {
  readonly client: HttpClient.HttpClient;
  readonly headers: Readonly<Record<string, string>>;
  readonly recordId: string;
  readonly secondRecordId: string;
  readonly shell: Effect.Success<ReturnType<typeof makeApiKeyGatewayNativeFixture>>;
}
type CustomerReadback = typeof customerReadbackSchema.Type;

const readCustomerPage = Effect.fn('SymmyC14Customer.readCustomerPage')(function* readCustomerPage(
  input: SearchInput,
  query: string,
) {
  const response = yield* input.client.get(`${input.shell.baseUrl}/api/symmy/v1/admin/customers${query}`, {
    headers: input.headers,
  });
  if (response.status !== 200) {
    const problem = yield* response.text;
    yield* input.shell.gatewayDiagnostics().pipe(Effect.flatMap(Effect.logError));
    return yield* Effect.fail(unavailable(`The customers read answered ${response.status} for ${query}: ${problem}`));
  }
  const body: CustomerReadback = yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(customerReadbackSchema)),
  );
  return body;
});
const sourceKeysOf = (page: CustomerReadback) => page.customers.map(({ sourceRecordId }) => sourceRecordId);

/** Paging and search over two customers: the filter runs before count, offset and limit, in source record order. */
const searchTwoCustomers = Effect.fn('SymmyC14Customer.searchTwoCustomers')(function* searchTwoCustomers(
  input: SearchInput,
) {
  const { client, headers, recordId, secondRecordId, shell } = input;
  // These reads assert keys and counts only, so they ask for the key alone: the Party, name and IČO owner reads per
  // customer would add several owner calls to each request and push a loaded runner past the fixture's deadline.
  const read = (query: string) => readCustomerPage(input, `${query}${query === '' ? '?' : '&'}fields=sourceRecordId`);
  const all = yield* read('');
  expect(all).toMatchObject({ count: 2, limit: 50, offset: 0 });
  expect(sourceKeysOf(all)).toEqual([recordId, secondRecordId]);
  const second = yield* read('?limit=1&offset=1');
  expect(second).toMatchObject({ count: 2, limit: 1, offset: 1 });
  expect(sourceKeysOf(second)).toEqual([secondRecordId]);
  expect(yield* read('?offset=2')).toMatchObject({ count: 2, customers: [], offset: 2 });
  // The search matches the customer key and the Party names and contacts, case-insensitively, term by term.
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ['hopper', [secondRecordId]],
    ['GRACE%20hopper', [secondRecordId]],
    ['Internal%20Customer', [recordId]],
    ['second_person', [secondRecordId]],
    ['internal', [recordId, secondRecordId]],
    ['internal%20hopper', [secondRecordId]],
    ['hopper%20customer', []],
    ['grace.hopper@example', [secondRecordId]],
    ['EXAMPLE.test', [secondRecordId]],
    ['_', [recordId, secondRecordId]],
    ['%25', []],
    ['a%25a', []],
    ['nothing-like-this', []],
  ];
  for (const [q, expected] of cases) {
    const found = yield* read(`?q=${q}`);
    expect(sourceKeysOf(found), q).toEqual(expected);
    expect(found.count, q).toBe(expected.length);
  }
  const pagedMatches = yield* read('?q=internal&limit=1&offset=1');
  expect(pagedMatches).toMatchObject({ count: 2, limit: 1, offset: 1 });
  expect(sourceKeysOf(pagedMatches)).toEqual([secondRecordId]);
  expect(yield* read('?q=internal&offset=2')).toMatchObject({ count: 2, customers: [] });
  const onlyParty = yield* readCustomerPage(input, '?q=hopper&fields=partyRef');
  expect(onlyParty.customers[0]).not.toHaveProperty('party');
  // A search with more terms than the owners take is refused whole, never searched partly.
  const manyTerms = Array.from({ length: 11 }, (_unused, index) => `t${index}`).join('%20');
  const tooMany = yield* client.get(`${shell.baseUrl}/api/symmy/v1/admin/customers?q=${manyTerms}`, { headers });
  expect(tooMany.status).toBe(422);
  expect(yield* tooMany.json).toMatchObject({ reason: 'search_too_broad' });
});

it.live(
  'INTERNAL_C14 actual public customers create, match and read back their native targets under current Privacy',
  () =>
    Effect.scoped(
      Effect.gen(function* actualCustomerConformance() {
        const ownerAppIds = ['party-registry', 'commerce-customer-context', 'privacy'] as const;
        const appIds = [...ownerAppIds, symmyAppId] as const;
        const ports = yield* nativePorts(appIds);
        const { contracts, snapshot } = yield* productComposition(
          Object.fromEntries([...ports].map(([appId, port]) => [appId, `http://127.0.0.1:${port}/`])),
        );
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot: snapshot,
          mode: 'schema-only',
          purpose: 'implementation-1096-registered-workload-gateway',
        });
        const admin = yield* PgClient.make({ url: Redacted.make(isolated.connections.admin.connectionString) });
        const shell = yield* makeApiKeyGatewayNativeFixture({
          additionalRelaySources: ownerAppIds.map((sourceAppId) => ({ sourceAppId })),
          ownedDatabase: isolated,
          productionGate: true,
          relaySource: { sourceAppId: symmyAppId },
          // A search composes three owner reads, each behind its own gateway assertion.
          requestDeadlineSeconds: 60,
          snapshotJson: yield* encodeProductComposition(snapshot),
        });
        const tenantId = yield* uuid;
        const tenantSlug = `internal-c14-${tenantId}`;
        const legalEntityId = yield* uuid;
        yield* admin`insert into core.tenants(tenant_id,name,slug,status,default_locale)
          values(${tenantId},'INTERNAL_C14 actual customer fixture',${tenantSlug},'active','en')`;
        yield* admin`insert into core.legal_entities(legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status)
          values(${legalEntityId},${tenantId},'INTERNAL_C14 selling legal entity','CZ','INTERNAL_C14_ONLY','active')`;
        const integration = yield* seedPrincipal(admin, tenantId, 'integration', shell.providerUserId);
        assert.isOk(shell.relaySourceProviderUserId);
        const symmyPrincipal = yield* seedPrincipal(admin, tenantId, 'service', shell.relaySourceProviderUserId);
        const systemId = yield* uuid;
        const governancePrincipalId = yield* uuid;
        yield* admin`insert into core.principals(principal_id,tenant_id,kind,status,display_name)
          values(${systemId},${tenantId},'system','active','INTERNAL_C14 enrolled customer worker'),
          (${governancePrincipalId},${tenantId},'human','active','INTERNAL_C14 explicit fixture governance')`;
        for (const module of snapshot.composition.modules) {
          yield* admin`insert into core.tenant_module_states(tenant_id,module_key,state) values(${tenantId},${module.moduleId},'active')`;
        }
        const accessScope = yield* uuid;
        yield* admin`insert into core.access_scopes(scope_id,tenant_id,tenant_context_id) values(${accessScope},${tenantId},${tenantId})`;
        yield* admin`insert into core.access_scope_fences(scope_id,tenant_id,state,revision) values(${accessScope},${tenantId},'Ready',1)`;
        const companyScope = yield* uuid;
        yield* admin`insert into core.access_scopes(scope_id,tenant_id,legal_entity_id) values(${companyScope},${tenantId},${legalEntityId})`;
        yield* admin`insert into core.access_scope_fences(scope_id,tenant_id,state,revision) values(${companyScope},${tenantId},'Ready',1)`;
        for (const principalId of [integration.principalId, systemId]) {
          for (const workload of [...customerFixtureWorkloads, customerWorkerKey]) {
            const bindingId = yield* uuid;
            const incarnation = yield* uuid;
            yield* admin`insert into core.access_workload_bindings(binding_id,incarnation,tenant_id,principal_id,workload_key,status)
              values(${bindingId},${incarnation},${tenantId},${principalId},${workload},'active')`;
          }
        }
        const key = yield* shell.issueFixtureProviderKey(integration);
        yield* bindProviderKey(admin, integration, key.providerKeyId);
        yield* key.acknowledgeBinding;
        const symmyKey = yield* shell.issueFixtureRelaySourceProviderKey(symmyPrincipal);
        yield* bindProviderKey(admin, symmyPrincipal, symmyKey.providerKeyId);
        yield* symmyKey.acknowledgeBinding;
        const moduleKeys = new Map<string, string>([[symmyAppId, Redacted.value(symmyKey.secret)]]);
        for (const provider of shell.additionalRelaySourceProviderUsers) {
          const principal = yield* seedPrincipal(admin, tenantId, 'service', provider.providerUserId);
          const moduleKey = yield* shell.issueFixtureModuleProviderKey({
            ...principal,
            sourceAppId: provider.sourceAppId,
          });
          yield* bindProviderKey(admin, principal, moduleKey.providerKeyId);
          yield* moduleKey.acknowledgeBinding;
          moduleKeys.set(provider.sourceAppId, Redacted.value(moduleKey.secret));
        }

        const sourceRouteId = yield* uuid;
        const routeId = yield* uuid;
        // The owner derives the occurrence of a request from its Idempotency-Key, so Privacy is seeded for that one.
        const occurrenceId = customerOccurrenceId('INTERNAL_C14_CUSTOMER_JOB', customerItemKey);
        const recordId = 'INTERNAL_C14_NAMED_PERSON';
        const observedAt = yield* DateTime.now;
        const plan = yield* makeSymmyC14CustomerPlan({
          legalEntityId,
          observedAt,
          occurrenceId,
          recordId,
          sourceRouteId,
          tenantId,
        });
        const sourceIdentity = {
          issuer: internalCustomerSource.issuerId,
          namespace: internalCustomerSource.namespace,
          recordType: internalCustomerSource.recordType,
          routeRef: sourceRouteId,
        };
        const flatSource = { ...sourceIdentity, occurrenceId, recordId };
        const privacy = yield* seedSourceProcessingNativeFixture({
          connections: isolated.connections,
          contexts: [
            customerIntakeContext(integration.principalId, flatSource, null),
            ...(['CREATE', 'EVIDENCE_READ'] as const).map(
              (operation) =>
                ({
                  authMethod: 'system',
                  principalId: systemId,
                  request: { consumerModuleId: partyModuleId, operation, source: flatSource, target: null },
                }) satisfies Parameters<typeof seedSourceProcessingNativeFixture>[0]['contexts'][number],
            ),
            {
              authMethod: 'api_key',
              principalId: integration.principalId,
              request: {
                consumerModuleId: partyModuleId,
                operation: 'EVIDENCE_READ',
                source: flatSource,
                target: null,
              },
            },
            {
              authMethod: 'system',
              principalId: systemId,
              request: {
                consumerModuleId: commerceModuleId,
                operation: 'PROFILE_CREATE',
                partySourceReference: { occurrenceId, recordId, source: sourceIdentity },
                source: flatSource,
                target: null,
              },
              targetAdmission: 'CURRENT_SOURCE_PERSON',
            },
          ],
          contractEvidenceRef: 'INTERNAL_C14_EXPLICIT_CONTRACT_FIXTURE',
          controllerRef: customerController,
          dataCategoryRefs: ['INTERNAL_C14_CUSTOMER_RECORD'],
          governancePrincipalId,
          legalEntityId,
          meaning:
            'Explicit internal fixture authorizes named source Party creation, evidence read, and Retail profile creation separately',
          tenantId,
        });
        yield* admin`insert into commerce_customer_context.customer_profile_source_routes(tenant_id,legal_entity_id,route_id,route_revision,principal_id,issuer,namespace,record_type,mapping_revision,active)
          values(${tenantId},${legalEntityId},${sourceRouteId},${internalCustomerSource.routeRevision},${systemId},${sourceIdentity.issuer},${sourceIdentity.namespace},${sourceIdentity.recordType},${internalCustomerSource.mappingVersion},true)`;
        const readerEnrollment = {
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          authority: {
            issuer: sourceIdentity.issuer,
            mappingRevision: internalCustomerSource.mappingVersion,
            namespace: sourceIdentity.namespace,
            recordType: sourceIdentity.recordType,
            route: { id: sourceRouteId, revision: internalCustomerSource.routeRevision },
          },
          legalEntityId,
          operatorPrincipalId: integration.issuerPrincipalId,
          operatorProviderUserId: shell.providerUserId,
          ownedDatabase: isolated,
          readerPrincipalId: integration.principalId,
          tenantId,
        } satisfies Parameters<typeof enrollCustomerProfileSourceReaderNativeFixture>[0];
        const enrolledReader = yield* enrollCustomerProfileSourceReaderNativeFixture(readerEnrollment);
        expect(yield* enrollCustomerProfileSourceReaderNativeFixture(readerEnrollment)).toEqual(enrolledReader);
        yield* Effect.forEach(
          [
            { ...readerEnrollment, ownedDatabase: { ...isolated } },
            { ...readerEnrollment, readerPrincipalId: systemId },
            {
              ...readerEnrollment,
              authority: { ...readerEnrollment.authority, issuer: 'INTERNAL_C14_UNENROLLED_ISSUER' },
            },
            {
              ...readerEnrollment,
              authority: { ...readerEnrollment.authority, namespace: 'INTERNAL_C14_UNENROLLED_NAMESPACE' },
            },
            {
              ...readerEnrollment,
              authority: {
                ...readerEnrollment.authority,
                route: { ...readerEnrollment.authority.route, revision: 'INTERNAL_C14_UNENROLLED_ROUTE_REVISION' },
              },
            },
          ],
          (invalidEnrollment) =>
            enrollCustomerProfileSourceReaderNativeFixture(invalidEnrollment).pipe(
              Effect.flip,
              Effect.tap((failure) =>
                Effect.sync(() =>
                  expect(
                    Schema.is(Schema.Struct({ _tag: Schema.Literal('CustomerContextOwnedFixtureUnavailable') }))(
                      failure,
                    ),
                  ).toBe(true),
                ),
              ),
            ),
          { discard: true },
        );
        const sourceEnrollment =
          yield* admin`select principal_id,source_reader_principal_ids from commerce_customer_context.customer_profile_source_routes
          where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and route_id=${sourceRouteId}`;
        expect(sourceEnrollment).toEqual([
          { principal_id: systemId, source_reader_principal_ids: [integration.principalId] },
        ]);
        const encodedPlan = yield* Schema.encodeEffect(SymmyInternalExecutionPlanSchema)(plan);
        const configuredPlan = yield* Schema.decodeUnknownEffect(SymmyRouteExecutionConfigurationSchema)({
          ...encodedPlan,
          items: encodedPlan.items.map((item) => ({
            ...item,
            effects: [
              ...item.effects,
              {
                effectKey: 'permitted-customer-revision',
                operation: {
                  entrypointKey: 'party.registry.update-party',
                  moduleId: partyModuleId,
                  schemaVersion: '1',
                },
              },
            ],
          })),
          sourceRouteId,
        });
        const lifecyclePolicy = { policyId: 'INTERNAL_C14_CUSTOMER_RETENTION', revision: 'v1' };
        yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,legal_entity_id,principal_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_revision,lifecycle_policy)
          values(${routeId},${tenantId},${legalEntityId},${integration.principalId},true,array['INTERNAL_C14'],${yield* Schema.encodeEffect(Schema.fromJsonString(SymmyRouteExecutionConfigurationSchema))(configuredPlan)}::jsonb,${internalCustomerSource.mappingVersion},'customersBatch',${internalCustomerSource.routeRevision},${yield* json(lifecyclePolicy)}::jsonb)`;
        const readRoute = yield* Schema.decodeUnknownEffect(SymmyRouteExecutionConfigurationSchema)({
          items: [
            {
              effects: [
                {
                  effectKey: 'customer-source-read',
                  operation: {
                    entrypointKey: 'commerce.customer-context.api.customer-profile-source-page',
                    moduleId: commerceModuleId,
                    schemaVersion: '1',
                  },
                },
                {
                  effectKey: 'customer-source-parties',
                  operation: {
                    entrypointKey: 'commerce.customer-context.api.customer-profile-source-parties',
                    moduleId: commerceModuleId,
                    schemaVersion: '1',
                  },
                },
                {
                  effectKey: 'customer-party-search',
                  operation: {
                    entrypointKey: 'party.registry.api.source-party-search',
                    moduleId: partyModuleId,
                    schemaVersion: '1',
                  },
                },
                {
                  effectKey: 'customer-party-export',
                  operation: {
                    entrypointKey: 'party.registry.api.source-profile-export',
                    moduleId: partyModuleId,
                    schemaVersion: '1',
                  },
                },
              ],
              itemKey: 'customer-source-read',
              source: {
                entityKind: sourceIdentity.recordType,
                issuerId: sourceIdentity.issuer,
                sourceNamespace: sourceIdentity.namespace,
                sourceRecordId: recordId,
              },
            },
          ],
          sourceRouteId,
        });
        const readRouteId = yield* uuid;
        yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,legal_entity_id,principal_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_revision)
          values(${readRouteId},${tenantId},${legalEntityId},${integration.principalId},true,array['INTERNAL_C14'],${yield* Schema.encodeEffect(Schema.fromJsonString(SymmyRouteExecutionConfigurationSchema))(readRoute)}::jsonb,${internalCustomerSource.mappingVersion},'adminCustomers',${internalCustomerSource.routeRevision})`;
        const partyUrl = new URL(Redacted.value(yield* Config.Redacted('PARTY_REGISTRY_DATABASE_URL')));
        partyUrl.pathname = `/${isolated.connections.runtime.database}`;
        partyUrl.hostname = isolated.connections.runtime.host;
        partyUrl.port = String(isolated.connections.runtime.port);
        const partyWorkerUrl = new URL(Redacted.value(yield* Config.Redacted('PARTY_REGISTRY_WORKER_DATABASE_URL')));
        partyWorkerUrl.pathname = `/${isolated.connections.runtime.database}`;
        partyWorkerUrl.hostname = isolated.connections.runtime.host;
        partyWorkerUrl.port = String(isolated.connections.runtime.port);
        const environment = {
          APP_ENV_PATH: '/dev/null',
          DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
          DATABASE_URL: isolated.connections.runtime.connectionString,
          ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: shell.compositionSourceUrl,
          ONTOS_C14_TRACE_PROBLEMS: 'true',
          ONTOS_GATEWAY_ISSUER: shell.issuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: shell.publicJwks,
          ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: yield* json([
            { ...sourceIdentity, authMethod: 'system', principalId: systemId, tenantId },
            { ...sourceIdentity, authMethod: 'api_key', principalId: integration.principalId, tenantId },
          ]),
          ONTOS_PRIVACY_SOURCE_PROCESSING_CONTEXTS: yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Array(SourceProcessingContextSchema)),
          )(privacy.contexts),
          ONTOS_SHELL_GATEWAY_BASE_URL: `${shell.baseUrl}/shell-super-app-api`,
          ONTOS_SYMMY_JOB_RETENTION_POLICIES: yield* json([
            {
              ...lifecyclePolicy,
              governanceLegalEntityId: legalEntityId,
              retentionMs: Duration.toMillis(Duration.minutes(1)),
              routeId,
              targetLegalEntityId: legalEntityId,
              tenantId,
            },
          ]),
          PARTY_REGISTRY_DATABASE_URL: partyUrl.href,
          PARTY_REGISTRY_WORKER_DATABASE_URL: partyWorkerUrl.href,
        };
        const prefixes = {
          'commerce-customer-context': '/commerce-customer-context-api',
          'party-registry': '/party-registry-api',
          privacy: privacyApiPrefix,
          'symmy-integration': '/symmy-integration-api',
        } as const;
        const ownerDiagnostics = new Map<string, Effect.Effect<string>>();
        const ownerRuntimes = new Map<string, OwnerRuntime>();
        const symmy = contracts.find(({ deployment }) => deployment.appId === symmyAppId);
        const moduleKey = moduleKeys.get(symmyAppId);
        assert.isOk(symmy);
        if (moduleKey === undefined) {
          return yield* unavailable('The actual independent module credential is missing');
        }
        // The Party owner commits the first job's create-party and loses its response; while the marker exists its
        // receipt read is down too, so the worker can only recover the original effect once the marker is gone.
        const fs = yield* FileSystem.FileSystem;
        const faultMarker = `${yield* fs.makeTempDirectoryScoped({ prefix: 'INTERNAL_C14_CUSTOMER_' })}/drop-party-response`;
        yield* fs.writeFileString(faultMarker, 'INTERNAL_C14 transport fault after native Party commit');
        const partyFault = {
          ONTOS_C14_RESPONSE_LOSS_MARKER: faultMarker,
          ONTOS_C14_RESPONSE_LOSS_OPERATION: 'party-create',
        };
        // Each receiver owns a distinct map key, port and artifact; readiness makes no peer requests.
        const [, workerArtifact] = yield* Effect.all(
          [
            Effect.forEach(
              appIds,
              (appId) =>
                startOwner({
                  appId,
                  contracts,
                  environment: appId === 'party-registry' ? { ...environment, ...partyFault } : environment,
                  moduleKeys,
                  ownerDiagnostics,
                  ownerRuntimes,
                  ports,
                  prefixes,
                }),
              { concurrency: 3, discard: true },
            ),
            buildProductWorker(symmy),
          ],
          { concurrency: 2 },
        );
        const client = yield* HttpClient.HttpClient;
        yield* Effect.logInfo({ phase: 'customer-fixture-ready' });
        const headers = { 'idempotency-key': 'INTERNAL_C14_CUSTOMER_JOB', 'x-api-key': Redacted.value(key.secret) };
        const customerBody = customersBody({
          customerId: recordId,
          firstName: 'Internal',
          kind: 'PERSON',
          lastName: 'Customer',
        });
        const submitFor = (idempotencyKey: string, body: ReturnType<typeof customersBody> = customerBody) =>
          Effect.gen(function* submitCustomer() {
            const response = yield* client.post(`${shell.baseUrl}/api/symmy/v1/customers/batch`, {
              body: yield* HttpBody.json(body),
              headers: { ...headers, 'idempotency-key': idempotencyKey },
            });
            if (response.status !== 202) {
              return yield* unavailable(
                `Actual customer admission returned ${response.status}: ${yield* response.text}`,
              );
            }
            return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(receiptSchema)));
          });
        const submit = submitFor('INTERNAL_C14_CUSTOMER_JOB');
        const accepted = yield* submit;
        expect(yield* submit).toEqual(accepted);
        // Admission replay is checked before dispatch; the worker stops before owners at scope exit.
        const worker = yield* startProductWorker(workerArtifact, {
          ...environment,
          ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_CUSTOMER_NATIVE_WORKER',
          ONTOS_GATEWAY_MODULE_API_KEY: moduleKey,
        });
        const ledger =
          admin`select effect_id,effect_key,owner_invocation_id,owner_receipt,state from symmy_integration.job_effects where job_id=${accepted.jobId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(effectSchema))),
          );
        const diagnoseWorker = Effect.all([
          worker.diagnostic.pipe(Effect.flatMap(Effect.logError)),
          shell.gatewayDiagnostics().pipe(Effect.flatMap(Effect.logError)),
          ...[...ownerDiagnostics].map(([appId, diagnostic]) =>
            diagnostic.pipe(Effect.flatMap((message) => Effect.logError({ appId, message }))),
          ),
        ]);
        // Only the faulted create-party may become uncertain; any other uncertain effect fails the proof at once.
        const onlyPartyCreateUncertain = ledger.pipe(
          Effect.flatMap((rows) =>
            rows.some(({ effect_key, state }) => effect_key !== partyCreateEffectKey && state === 'indeterminate')
              ? Effect.fail(unavailable('An unfaulted customer owner response was uncertain during the proof'))
              : Effect.succeed(rows),
          ),
        );
        yield* observeUntil(onlyPartyCreateUncertain, (rows) =>
          rows.some(({ effect_key, state }) => effect_key === partyCreateEffectKey && state === 'indeterminate'),
        ).pipe(Effect.tapError(() => diagnoseWorker));
        yield* fs.remove(faultMarker);
        // The worker retries the uncertain effect after its delivery backoff, at most 30 seconds.
        const completed = yield* observeUntil(
          onlyPartyCreateUncertain,
          (rows) => rows.length === 2 && rows.every(({ state }) => state === 'settled'),
          1800,
        ).pipe(
          Effect.tapError(() =>
            Effect.all([
              worker.diagnostic.pipe(Effect.flatMap(Effect.logError)),
              shell.gatewayDiagnostics().pipe(Effect.flatMap(Effect.logError)),
              shell.issuerDiagnostics().pipe(Effect.flatMap(Effect.logError)),
              ...[...ownerDiagnostics].map(([appId, diagnostic]) =>
                diagnostic.pipe(Effect.flatMap((message) => Effect.logError({ appId, message }))),
              ),
              admin`select effect_key,state,outcome->>'status' as outcome_status from symmy_integration.job_effects where job_id=${accepted.jobId}`.pipe(
                Effect.flatMap(Effect.logError),
              ),
              admin`select
                (select count(*)::integer from party.parties where tenant_id=${tenantId}) as parties,
                (select count(*)::integer from commerce_customer_context.customer_profiles where tenant_id=${tenantId}) as profiles`.pipe(
                Effect.flatMap(Effect.logError),
              ),
              admin`select action_key,status,count(*)::integer as count from core.action_invocations
                where tenant_id=${tenantId} and action_key in ('party.registry.create-party','commerce.customer-context.ensure-retail-customer-profile')
                group by action_key,status`.pipe(Effect.flatMap(Effect.logError)),
            ]),
          ),
        );
        expect(completed.map(({ effect_key }) => effect_key)).toContain(partyCreateEffectKey);
        const partyEffect = completed.find(({ effect_key }) => effect_key === partyCreateEffectKey);
        const profileEffect = completed.find(({ effect_key }) => effect_key === 'retail-profile');
        assert.isOk(partyEffect);
        assert.isOk(profileEffect);
        const partyReceipt = yield* Schema.decodeUnknownEffect(partyReceiptSchema)(partyEffect.owner_receipt);
        const profileReceipt = yield* Schema.decodeUnknownEffect(profileReceiptSchema)(profileEffect.owner_receipt);
        expect(profileReceipt.partyRef).toEqual(partyReceipt.partyRef);
        expect(profileReceipt.profileRef.tenantId).toBe(tenantId);
        const partyInvocationId = Option.getOrUndefined(partyEffect.owner_invocation_id);
        const profileInvocationId = Option.getOrUndefined(profileEffect.owner_invocation_id);
        if (partyInvocationId === undefined || profileInvocationId === undefined) {
          return yield* unavailable(
            'Settled customer effects must retain their actual Core native invocation identities',
          );
        }
        const [nativeExecutions] = yield* admin<{
          count: number;
        }>`select count(*)::integer as count from core.action_invocations
          where tenant_id=${tenantId} and principal_id=${systemId} and legal_entity_id=${legalEntityId} and status='succeeded'
          and ((action_invocation_id=${partyInvocationId} and action_key='party.registry.create-party')
            or (action_invocation_id=${profileInvocationId} and action_key='commerce.customer-context.ensure-retail-customer-profile'))`;
        expect(nativeExecutions?.count).toBe(2);
        const [counts] = yield* admin<{ linked: number; parties: number; profiles: number }>`select
          (select count(*)::integer from party.parties where tenant_id=${tenantId}) as parties,
          (select count(*)::integer from commerce_customer_context.customer_profiles where tenant_id=${tenantId}) as profiles,
          (select count(*)::integer from commerce_customer_context.retail_customer_profiles p join party.parties a on a.party_id::text=p.party_resource_id and a.tenant_id=p.tenant_id where p.tenant_id=${tenantId} and a.current_type='PERSON' and a.first_name='Internal' and a.last_name='Customer') as linked`;
        expect(counts).toEqual({ linked: 1, parties: 1, profiles: 1 });
        expect(yield* submit).toEqual(accepted);
        const [writes] = yield* admin<{ party: number; profile: number }>`select
          count(*) filter(where action_key='party.registry.create-party' and status='succeeded')::integer as party,
          count(*) filter(where action_key='commerce.customer-context.ensure-retail-customer-profile' and status='succeeded')::integer as profile
          from core.action_invocations where tenant_id=${tenantId}`;
        expect(writes).toEqual({ party: 1, profile: 1 });
        yield* Effect.logInfo(
          'INTERNAL_C14 actual named Party and dependent Retail profile settled with exact native Core identities',
        );
        const nativeProfileRows =
          yield* admin`select a.action_invocation_id as "actionInvocationId",a.action_key as "actionKey",
          a.auth_context_ref as "authContextRef",a.idempotency_key as "idempotencyKey",a.principal_id as "principalId",a.request_hash as "requestHash"
          from core.action_invocations a join symmy_integration.job_effects e on e.tenant_id=a.tenant_id
          and e.owner_invocation_id=a.action_invocation_id and e.owner_executor_principal_id=a.principal_id
          and e.owner_auth_context_ref=a.auth_context_ref and e.owner_request_hash=a.request_hash and e.effect_id::text=a.idempotency_key
          where a.tenant_id=${tenantId} and e.effect_id=${profileEffect.effect_id} and a.legal_entity_id=${legalEntityId} and a.status='succeeded'`;
        expect(nativeProfileRows).toHaveLength(1);
        const nativeProfile = yield* Schema.decodeUnknownEffect(CustomerNativeProfileInvocationSchema)(
          nativeProfileRows.at(0),
        );
        const runPrefix = `job:${customerWorkerKey}:run:`;
        if (!nativeProfile.authContextRef.startsWith(runPrefix)) {
          return yield* unavailable('The native Profile invocation must identify its actual original worker delivery');
        }
        const deliveryId = yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isUUID()))(
          nativeProfile.authContextRef.slice(runPrefix.length),
        );
        yield* observeUntil(
          admin<{ status: string }>`select status from core.outbox_deliveries where outbox_delivery_id=${deliveryId}`,
          (rows) => rows.some(({ status }) => status === 'done'),
        );
        yield* worker.child.kill();
        yield* worker.child.exitCode;
        const [profileRecoveryRequirement] = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.Struct({ key: Schema.String })]),
        )(
          (symmy.manifest.requirements?.operations ?? []).filter(
            (requirement) =>
              requirement.entrypointKey === customerWorkerKey &&
              requirement.provider.moduleId === commerceModuleId &&
              requirement.provider.entrypointKey === 'commerce.customer-context.api.customer-profile-source' &&
              requirement.provider.schemaVersion === '1',
          ),
        );
        const acquireReceiptTransport = () =>
          issueCustomerProfileFixtureRecovery({
            compositionRevision: snapshot.composition.revision,
            deliveryId,
            expectedReadPrincipalId: systemId,
            legalEntityId,
            moduleApiKey: Redacted.make(moduleKey),
            nativeAction: nativeProfile,
            operationRequirementKey: profileRecoveryRequirement.key,
            request: {
              effectId: profileEffect.effect_id,
              issuer: sourceIdentity.issuer,
              mappingRevision: internalCustomerSource.mappingVersion,
              mode: 'MINIMAL_RECEIPT',
              namespace: sourceIdentity.namespace,
              recordType: sourceIdentity.recordType,
              route: { id: sourceRouteId, revision: internalCustomerSource.routeRevision },
            },
            shellGatewayBaseUrl: environment.ONTOS_SHELL_GATEWAY_BASE_URL,
            tenantId,
          });
        const proofTransport = yield* acquireReceiptTransport();
        const roundTripKey = 'INTERNAL_C14_CUSTOMER_GET_POST';
        const beforeDisableKey = 'INTERNAL_C14_CUSTOMER_BEFORE_DISABLE';
        const roundTripSource = customerItemSource(sourceIdentity, roundTripKey, customerItemKey, recordId);
        const scope = {
          integrationPrincipalId: integration.principalId,
          partyId: partyReceipt.partyRef.resourceId,
          profileId: profileReceipt.profileRef.resourceId,
          source: sourceIdentity,
          systemId,
        };
        // The same customer sent again (its GET source id is its customerId), and a request admitted before the
        // integration principal is disabled: both name their own occurrences.
        const roundTripContexts = [
          ...customerContexts(scope, roundTripKey, [{ kind: 'existing', recordId }]),
          ...customerContexts(scope, beforeDisableKey, [{ kind: 'existing', recordId }]),
        ];
        const readContexts = readbackContexts(scope, flatSource);
        // A source assertion names no owner target; what is aimed at the existing Party or profile is a DATA use.
        const sourceReadback = yield* seedSourceProcessingNativeFixture({
          connections: isolated.connections,
          contexts: roundTripContexts.filter(({ request }) => request.target === null),
          contractEvidenceRef: 'INTERNAL_C14_EXPLICIT_PUBLIC_CUSTOMER_INTAKE',
          controllerRef: customerController,
          dataCategoryRefs: ['INTERNAL_C14_CUSTOMER_RECORD'],
          governancePrincipalId,
          legalEntityId,
          meaning: 'Independent current internal policy permits the same public customer to be named and matched again',
          tenantId,
        });
        const dataPrivacy = yield* seedCommittedProfileSourceProcessingNativeFixture({
          connections: isolated.connections,
          contexts: [...roundTripContexts.filter(({ request }) => request.target !== null), ...readContexts],
          contractEvidenceRef: 'INTERNAL_C14_EXPLICIT_CUSTOMER_MATCH_AND_READ_CONTRACT',
          controllerRef: customerController,
          dataCategoryRefs: ['INTERNAL_C14_CUSTOMER_RECORD'],
          governancePrincipalId,
          legalEntityId,
          meaning:
            'Independent current internal policy permits matching and reading only the original Party and Retail profile for this qualified source record',
          profileReceipt: proofTransport,
          tenantId,
        }).pipe(
          Effect.tapError(() =>
            Effect.all([
              shell.gatewayDiagnostics().pipe(Effect.flatMap(Effect.logError)),
              shell.issuerDiagnostics().pipe(Effect.flatMap(Effect.logError)),
              ...[...ownerDiagnostics].map(([appId, diagnostic]) =>
                diagnostic.pipe(Effect.flatMap((message) => Effect.logError({ appId, message }))),
              ),
            ]),
          ),
        );
        expect(dataPrivacy.personAdmission.partyRef).toEqual(partyReceipt.partyRef);
        expect(dataPrivacy.profileReceipt.result.profileRef).toEqual(profileReceipt.profileRef);
        const readOnlyTransport = yield* acquireReceiptTransport();
        const readOnlyWriteKey = 'INTERNAL_C14_READ_RECOVERY_CANNOT_WRITE';
        const deniedRecoveryWrite = yield* executeEnsureRetailCustomerProfileWithAuthorization(
          dataPrivacy.profileReceipt.intent,
          Redacted.value(readOnlyTransport.authorization),
          yield* uuid,
          {
            baseUrl: readOnlyTransport.baseUrl,
            compositionRevision: readOnlyTransport.compositionRevision,
            idempotencyKey: readOnlyWriteKey,
          },
        ).pipe(Effect.flip);
        expect(
          Schema.is(
            Schema.Union([
              EnsureRetailCustomerProfileActionAuthenticationProblemSchema,
              EnsureRetailCustomerProfileActionForbiddenProblemSchema,
            ]),
          )(deniedRecoveryWrite),
        ).toBe(true);
        const [readOnlyWrites] = yield* admin<{
          count: number;
        }>`select count(*)::integer as count from core.action_invocations
          where tenant_id=${tenantId} and idempotency_key=${readOnlyWriteKey}`;
        expect(readOnlyWrites).toEqual({ count: 0 });
        const privacyRuntime = ownerRuntimes.get('privacy');
        if (privacyRuntime === undefined) {
          return yield* unavailable('The actual Privacy receiver is required for the independent DATA policy phase');
        }
        yield* privacyRuntime.receiver.child.kill();
        yield* privacyRuntime.receiver.child.exitCode;
        const restartedPrivacy = yield* startProductOwner({
          artifacts: privacyRuntime.artifacts,
          contract: privacyRuntime.contract,
          environment: {
            ...environment,
            ONTOS_GATEWAY_MODULE_API_KEY: privacyRuntime.moduleKey,
            ONTOS_PRIVACY_SOURCE_PROCESSING_CONTEXTS: yield* Schema.encodeEffect(
              Schema.fromJsonString(Schema.Array(SourceProcessingContextSchema)),
            )([...privacy.contexts, ...sourceReadback.contexts, ...dataPrivacy.contexts]),
          },
          port: privacyRuntime.port,
          prefix: privacyApiPrefix,
        });
        ownerDiagnostics.set('privacy', restartedPrivacy.diagnostic);
        ownerRuntimes.set('privacy', { ...privacyRuntime, receiver: restartedPrivacy });
        yield* Effect.logInfo(
          'INTERNAL_C14 historical native receipt admitted separate DATA policies between independent jobs',
        );
        const exportedCustomer = yield* readCustomers({
          admin,
          client,
          headers,
          ownerDiagnostics,
          partyRef: partyReceipt.partyRef,
          profileResourceId: profileReceipt.profileRef.resourceId,
          readRoute,
          readRouteId,
          recordId,
          shell,
          tenantId,
        });
        // The GET source id is the public customerId: sent back to POST it matches the same Party and profile.
        const roundTripJob = yield* submitFor(
          roundTripKey,
          customersBody({
            customerId: exportedCustomer.sourceRecordId,
            firstName: exportedCustomer.party.firstName ?? '',
            kind: 'PERSON',
            lastName: exportedCustomer.party.lastName ?? '',
          }),
        );
        yield* Effect.logInfo({ phase: 'customer-readback-controls-accepted' });
        const roundTripWorker = yield* startProductWorker(workerArtifact, {
          ...environment,
          ONTOS_C14_WORKER_CLAIM_OWNER: roundTripKey,
          ONTOS_GATEWAY_MODULE_API_KEY: moduleKey,
        });
        const roundTripEffects = yield* observeUntil(
          admin`select effect_id,effect_key,owner_invocation_id,owner_receipt,state from symmy_integration.job_effects where job_id=${roundTripJob.jobId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(effectSchema))),
          ),
          (rows) => rows.length === 2 && rows.every(({ state }) => state === 'settled'),
        ).pipe(
          Effect.tapError(() =>
            Effect.all([
              roundTripWorker.diagnostic.pipe(Effect.flatMap(Effect.logError)),
              shell.gatewayDiagnostics().pipe(Effect.flatMap(Effect.logError)),
              shell.issuerDiagnostics().pipe(Effect.flatMap(Effect.logError)),
              ...[...ownerDiagnostics].map(([appId, diagnostic]) =>
                diagnostic.pipe(Effect.flatMap((message) => Effect.logError({ appId, message }))),
              ),
            ]),
          ),
        );
        expect(roundTripEffects.every(({ owner_invocation_id }) => Option.isSome(owner_invocation_id))).toBe(true);
        const roundTripStatusResponse = yield* client.get(`${shell.baseUrl}/api/symmy/v1/jobs/${roundTripJob.jobId}`, {
          headers,
        });
        expect(roundTripStatusResponse.status).toBe(200);
        expect(yield* roundTripStatusResponse.json).toMatchObject({ status: 'completed_all' });
        const [matched] = yield* admin<{ parties: number; profiles: number }>`select
          (select count(*)::integer from party.parties where tenant_id=${tenantId}) as parties,
          (select count(*)::integer from commerce_customer_context.customer_profiles where tenant_id=${tenantId}) as profiles`;
        // The same customer sent again matched its Party and profile: nothing was created a second time.
        expect(matched).toEqual({ parties: 1, profiles: 1 });
        const retainedNativeIds = [...completed, ...roundTripEffects].map((effect) =>
          Option.getOrThrow(effect.owner_invocation_id),
        );
        expect(new Set(retainedNativeIds).size).toBe(4);
        const [allWrites] = yield* admin<{ party: number; profile: number }>`select
          count(*) filter(where action_key='party.registry.create-party' and status='succeeded')::integer as party,
          count(*) filter(where action_key='commerce.customer-context.ensure-retail-customer-profile' and status='succeeded')::integer as profile
          from core.action_invocations where tenant_id=${tenantId}`;
        expect(allWrites).toEqual({ party: 2, profile: 2 });
        const [binding] = yield* admin<{
          source_occurrence_id: string;
          source_order: number;
        }>`select source_occurrence_id,source_order
          from commerce_customer_context.customer_profile_source_bindings
          where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and issuer=${sourceIdentity.issuer}
          and namespace=${sourceIdentity.namespace} and record_type=${sourceIdentity.recordType} and record_id=${recordId}`;
        // The source binding of the record moved to the newest observation, with a later order.
        expect(binding?.source_occurrence_id).toBe(roundTripSource.occurrenceId);
        expect(binding?.source_order).toBeGreaterThan(0);
        yield* roundTripWorker.child.kill();
        yield* roundTripWorker.child.exitCode;
        // A second customer, so that paging and search are exercised over more than one customer.
        const secondRecordId = 'INTERNAL_C14_SECOND_PERSON';
        const secondKey = 'INTERNAL_C14_CUSTOMER_SECOND';
        const secondFlatSource = {
          ...sourceIdentity,
          occurrenceId: customerOccurrenceId(secondKey, customerItemKey),
          recordId: secondRecordId,
        };
        const secondCreation = yield* seedSourceProcessingNativeFixture({
          connections: isolated.connections,
          contexts: customerContexts(scope, secondKey, [{ kind: 'created', recordId: secondRecordId }]),
          contractEvidenceRef: 'INTERNAL_C14_EXPLICIT_SECOND_CUSTOMER_CONTRACT',
          controllerRef: customerController,
          dataCategoryRefs: ['INTERNAL_C14_CUSTOMER_RECORD'],
          governancePrincipalId,
          legalEntityId,
          meaning:
            'Independent current internal policy permits creating the second named person and its Retail profile',
          tenantId,
        });
        const restartPrivacy = (contexts: readonly (typeof privacy.contexts)[number][]) =>
          Effect.gen(function* restartPrivacyWith() {
            const current = ownerRuntimes.get('privacy');
            if (current === undefined) {
              return yield* unavailable('The actual Privacy receiver is required for the second customer');
            }
            yield* current.receiver.child.kill();
            yield* current.receiver.child.exitCode;
            const restarted = yield* startProductOwner({
              artifacts: current.artifacts,
              contract: current.contract,
              environment: {
                ...environment,
                ONTOS_GATEWAY_MODULE_API_KEY: current.moduleKey,
                ONTOS_PRIVACY_SOURCE_PROCESSING_CONTEXTS: yield* Schema.encodeEffect(
                  Schema.fromJsonString(Schema.Array(SourceProcessingContextSchema)),
                )(contexts),
              },
              port: current.port,
              prefix: privacyApiPrefix,
            });
            ownerDiagnostics.set('privacy', restarted.diagnostic);
            ownerRuntimes.set('privacy', { ...current, receiver: restarted });
            return yield* Effect.void;
          });
        // The first customer's binding moved to its newest observation, which the profile read now names.
        const roundTripReadback = yield* seedCommittedProfileSourceProcessingNativeFixture({
          connections: isolated.connections,
          contexts: readbackContexts(scope, roundTripSource).filter(
            ({ request }) => request.operation === 'customer-profile-source.read',
          ),
          contractEvidenceRef: 'INTERNAL_C14_EXPLICIT_ROUND_TRIP_READ_CONTRACT',
          controllerRef: customerController,
          dataCategoryRefs: ['INTERNAL_C14_CUSTOMER_RECORD'],
          governancePrincipalId,
          legalEntityId,
          meaning:
            'Independent current internal policy permits reading the first Retail profile at its newest observation',
          profileReceipt: yield* acquireReceiptTransport(),
          tenantId,
        });
        const priorPrivacy = [
          ...privacy.contexts,
          ...sourceReadback.contexts,
          ...dataPrivacy.contexts,
          ...roundTripReadback.contexts,
        ];
        yield* restartPrivacy([...priorPrivacy, ...secondCreation.contexts]);
        const secondAccepted = yield* submitFor(
          secondKey,
          customersBody({ customerId: secondRecordId, firstName: 'Grace', kind: 'PERSON', lastName: 'Hopper' }),
        );
        const secondWorker = yield* startProductWorker(workerArtifact, {
          ...environment,
          ONTOS_C14_WORKER_CLAIM_OWNER: secondKey,
          ONTOS_GATEWAY_MODULE_API_KEY: moduleKey,
        });
        const secondEffects = yield* observeUntil(
          admin`select effect_id,effect_key,owner_invocation_id,owner_receipt,state from symmy_integration.job_effects where job_id=${secondAccepted.jobId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(effectSchema))),
          ),
          (rows) => rows.length === 2 && rows.every(({ state }) => state === 'settled'),
        ).pipe(
          Effect.tapError(() =>
            Effect.all([
              secondWorker.diagnostic.pipe(Effect.flatMap(Effect.logError)),
              shell.gatewayDiagnostics().pipe(Effect.flatMap(Effect.logError)),
              ...[...ownerDiagnostics].map(([appId, diagnostic]) =>
                diagnostic.pipe(Effect.flatMap((message) => Effect.logError({ appId, message }))),
              ),
            ]),
          ),
        );
        const secondPartyEffect = secondEffects.find(({ effect_key }) => effect_key === partyCreateEffectKey);
        const secondProfileEffect = secondEffects.find(({ effect_key }) => effect_key === 'retail-profile');
        assert.isOk(secondPartyEffect);
        assert.isOk(secondProfileEffect);
        const secondParty = yield* Schema.decodeUnknownEffect(partyReceiptSchema)(secondPartyEffect.owner_receipt);
        const secondProfile = yield* Schema.decodeUnknownEffect(profileReceiptSchema)(
          secondProfileEffect.owner_receipt,
        );
        expect(secondParty.partyRef.resourceId).not.toBe(partyReceipt.partyRef.resourceId);
        const secondProfileRows =
          yield* admin`select a.action_invocation_id as "actionInvocationId",a.action_key as "actionKey",
          a.auth_context_ref as "authContextRef",a.idempotency_key as "idempotencyKey",a.principal_id as "principalId",a.request_hash as "requestHash"
          from core.action_invocations a join symmy_integration.job_effects e on e.tenant_id=a.tenant_id
          and e.owner_invocation_id=a.action_invocation_id and e.owner_executor_principal_id=a.principal_id
          and e.owner_auth_context_ref=a.auth_context_ref and e.owner_request_hash=a.request_hash and e.effect_id::text=a.idempotency_key
          where a.tenant_id=${tenantId} and e.effect_id=${secondProfileEffect.effect_id} and a.legal_entity_id=${legalEntityId} and a.status='succeeded'`;
        const secondNative = yield* Schema.decodeUnknownEffect(CustomerNativeProfileInvocationSchema)(
          secondProfileRows.at(0),
        );
        const secondDeliveryId = yield* Schema.decodeUnknownEffect(Schema.String.check(Schema.isUUID()))(
          secondNative.authContextRef.slice(`job:${customerWorkerKey}:run:`.length),
        );
        yield* observeUntil(
          admin<{
            status: string;
          }>`select status from core.outbox_deliveries where outbox_delivery_id=${secondDeliveryId}`,
          (rows) => rows.some(({ status }) => status === 'done'),
        );
        yield* secondWorker.child.kill();
        yield* secondWorker.child.exitCode;
        const secondTransport = yield* issueCustomerProfileFixtureRecovery({
          compositionRevision: snapshot.composition.revision,
          deliveryId: secondDeliveryId,
          expectedReadPrincipalId: systemId,
          legalEntityId,
          moduleApiKey: Redacted.make(moduleKey),
          nativeAction: secondNative,
          operationRequirementKey: profileRecoveryRequirement.key,
          request: {
            effectId: secondProfileEffect.effect_id,
            issuer: sourceIdentity.issuer,
            mappingRevision: internalCustomerSource.mappingVersion,
            mode: 'MINIMAL_RECEIPT',
            namespace: sourceIdentity.namespace,
            recordType: sourceIdentity.recordType,
            route: { id: sourceRouteId, revision: internalCustomerSource.routeRevision },
          },
          shellGatewayBaseUrl: environment.ONTOS_SHELL_GATEWAY_BASE_URL,
          tenantId,
        });
        const secondReadback = yield* seedCommittedProfileSourceProcessingNativeFixture({
          connections: isolated.connections,
          contexts: readbackContexts(
            { ...scope, partyId: secondParty.partyRef.resourceId, profileId: secondProfile.profileRef.resourceId },
            secondFlatSource,
          ),
          contractEvidenceRef: 'INTERNAL_C14_EXPLICIT_SECOND_CUSTOMER_READ_CONTRACT',
          controllerRef: customerController,
          dataCategoryRefs: ['INTERNAL_C14_CUSTOMER_RECORD'],
          governancePrincipalId,
          legalEntityId,
          meaning: 'Independent current internal policy permits reading only the second Party and Retail profile',
          profileReceipt: secondTransport,
          tenantId,
        });
        yield* restartPrivacy([...priorPrivacy, ...secondCreation.contexts, ...secondReadback.contexts]);
        // The Party owner holds the contact of the second customer; the search reaches it through the same Privacy export.
        yield* admin`insert into party.party_contact_points(tenant_id,party_id,contact_point_type,display_value,normalized_value,normalization_version,privacy_classification,valid_from,provenance_source,provenance_method,accepted_by_action_invocation_id,accepted_by_principal_id,policy_version)
          values(${tenantId},${secondParty.partyRef.resourceId},'EMAIL','Grace.Hopper@Example.test','grace.hopper@example.test','email.v1','PERSONAL','2020-01-01T00:00:00Z','internal-fixture','DECLARATION',${Option.getOrThrow(secondPartyEffect.owner_invocation_id)},${systemId},'fixture')`;
        yield* searchTwoCustomers({ client, headers, recordId, secondRecordId, shell });
        yield* Effect.logInfo({ phase: 'customer-roundtrip-and-search-accepted' });
        const admittedBeforeDisable = yield* submitFor(beforeDisableKey);
        expect(admittedBeforeDisable.jobId).not.toBe(accepted.jobId);
        yield* admin`update core.principals set status='disabled',disabled_at=current_timestamp where principal_id=${integration.principalId} and tenant_id=${tenantId}`;
        const disabledWorker = yield* startProductWorker(workerArtifact, {
          ...environment,
          ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_CUSTOMER_DISABLED_ORIGIN',
          ONTOS_GATEWAY_MODULE_API_KEY: moduleKey,
        });
        yield* observeUntil(
          admin`select effect_id,effect_key,owner_invocation_id,owner_receipt,state from symmy_integration.job_effects where job_id=${admittedBeforeDisable.jobId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(effectSchema))),
          ),
          (rows) => rows.some(({ state }) => state === 'blocked'),
        );
        const [afterDisable] = yield* admin<{ parties: number; profiles: number }>`select
          (select count(*)::integer from party.parties where tenant_id=${tenantId}) as parties,
          (select count(*)::integer from commerce_customer_context.customer_profiles where tenant_id=${tenantId}) as profiles`;
        expect(afterDisable).toEqual({ parties: 2, profiles: 2 });
        const [afterDisableWrites] = yield* admin<{
          count: number;
        }>`select count(*)::integer as count from core.action_invocations
          where tenant_id=${tenantId} and status='succeeded' and action_key in ('party.registry.create-party','commerce.customer-context.ensure-retail-customer-profile')`;
        expect(afterDisableWrites?.count).toBe(6);
        yield* disabledWorker.child.kill();
        yield* disabledWorker.child.exitCode;
        yield* Effect.logInfo({ phase: 'customer-scenario-complete' });
        return yield* Effect.void;
      }),
    ).pipe(
      Effect.tap(() => Effect.logInfo({ phase: 'customer-teardown-complete' })),
      Effect.provide(services),
    ),
  480_000,
);
