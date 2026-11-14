import { CustomerProfileSourceItemSchema } from '@app/commerce-customer-context/api/customer-profile-source';
import { executeCustomerProfileSourceWithAuthorization } from '@app/commerce-customer-context/api/customer-profile-source/client';
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
import { Config, DateTime, Duration, Effect, Layer, Match, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpBody, HttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';

import {
  collectFixtureDiagnostics,
  describeFixtureDiagnostics,
  encodeFixtureOwnerDiagnostics,
  fixtureDiagnosticTail,
} from './support/fixture-diagnostics.mts';
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
import { makeSymmyC14CustomerRevisionPlan } from './support/symmy-c14-customer-revision-plan.mts';
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
  nativePort,
  productComposition,
  startProductOwner,
  startProductWorker,
} from './support/symmy-c14-product-runtime.mts';
import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../../database/identity-enrollment.ts';

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
const customerReadbackSchema = Schema.Struct({
  contractVersion: Schema.Literal('INTERNAL_C14'),
  customers: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isPattern(/^~c14r1\.[a-zA-Z0-9_-]{43}$/u)),
      party: Schema.optionalKey(SourceProfileExportResponseSchema.members[1]),
      partyRef: PartyRefSchema,
      profile: CustomerProfileSourceItemSchema.fields.profile,
      source_record_id: Schema.String,
    }),
  ),
  projection: Schema.Literal('customers'),
});
const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const symmyAppId = 'symmy-integration';
const commerceModuleId = 'commerce.customer-context';
const partyModuleId = 'party.registry';
const unavailable = (message: string) => new SymmyC14ProductFixtureUnavailable({ message });

const observeUntil = <Value, Failure, Requirements>(
  observe: Effect.Effect<Value, Failure, Requirements>,
  ready: (value: Value) => boolean,
) =>
  Effect.gen(function* observeCustomerJob() {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const value = yield* observe;
      if (ready(value)) {
        return value;
      }
      yield* Effect.sleep(Duration.millis(50));
    }
    return yield* unavailable('The actual customer owner dependency graph did not settle');
  });

it.live(
  'INTERNAL_C14 actual customer revisions and GET round-trip retain native targets under current Privacy',
  () =>
    Effect.scoped(
      Effect.gen(function* actualCustomerConformance() {
        const ownerAppIds = ['party-registry', 'commerce-customer-context', 'privacy'] as const;
        const appIds = [...ownerAppIds, symmyAppId] as const;
        const ports = new Map<string, number>();
        for (const appId of appIds) {
          let port = yield* nativePort;
          while ([...ports.values()].includes(port)) {
            port = yield* nativePort;
          }
          ports.set(appId, port);
        }
        const { contracts, snapshot } = yield* productComposition(
          Object.fromEntries([...ports].map(([appId, port]) => [appId, `http://127.0.0.1:${port}/`])),
        );
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot: snapshot,
          databaseIdentities: APP_DATABASE_IDENTITY_ENROLLMENT,
          mode: 'schema-only',
          purpose: 'implementation-1096-registered-workload-gateway',
        });
        const admin = yield* PgClient.make({ url: Redacted.make(isolated.connections.admin.connectionString) });
        const shell = yield* makeApiKeyGatewayNativeFixture({
          additionalRelaySources: ownerAppIds.map((sourceAppId) => ({ sourceAppId })),
          ownedDatabase: isolated,
          productionGate: true,
          relaySource: { sourceAppId: symmyAppId },
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
            yield* admin`insert into core.access_workload_company_bindings(company_binding_id,incarnation,tenant_id,workload_binding_id,legal_entity_id,status)
              values(${yield* uuid},${yield* uuid},${tenantId},${bindingId},${legalEntityId},'active')`;
          }
        }
        const key = yield* shell.issueFixtureProviderKey(integration);
        yield* bindProviderKey(admin, integration, key.providerKeyId);
        yield* key.acknowledgeBinding;
        // Each owner's own module key, provisioned by the platform for its module principal as on every environment.
        const moduleKeys = new Map<string, Redacted.Redacted>([
          [symmyAppId, (yield* shell.provisionRelaySource()).secret],
        ]);
        for (const appId of ownerAppIds) {
          moduleKeys.set(appId, (yield* shell.provisionModuleSource(appId)).secret);
        }

        const sourceRouteId = yield* uuid;
        const routeId = yield* uuid;
        const occurrenceId = yield* uuid;
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
          controllerRef: 'internal:customer-conformance',
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
                    entrypointKey: 'commerce.customer-context.api.customer-profile-source',
                    moduleId: commerceModuleId,
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
          privacy: '/privacy-api',
          'symmy-integration': '/symmy-integration-api',
        } as const;
        const ownerDiagnostics = new Map<string, Effect.Effect<string>>();
        const ownerRuntimes = new Map<
          string,
          {
            artifacts: Effect.Success<ReturnType<typeof buildProductOwner>>;
            contract: (typeof contracts)[number];
            moduleKey: Redacted.Redacted;
            port: number;
            receiver: Effect.Success<ReturnType<typeof startProductOwner>>;
          }
        >();
        for (const appId of appIds) {
          const contract = contracts.find(({ deployment }) => deployment.appId === appId);
          const port = ports.get(appId);
          const moduleKey = moduleKeys.get(appId);
          assert.isOk(contract);
          assert.isTrue(port !== undefined);
          if (port === undefined) {
            return yield* unavailable('The bounded receiver port is missing');
          }
          if (moduleKey === undefined) {
            return yield* unavailable('The actual independent module credential is missing');
          }
          const artifacts = yield* buildProductOwner(contract);
          const receiver = yield* startProductOwner({
            artifacts,
            contract,
            environment,
            moduleKey,
            port,
            prefix: prefixes[appId],
          });
          ownerDiagnostics.set(appId, receiver.diagnostic);
          ownerRuntimes.set(appId, { artifacts, contract, moduleKey, port, receiver });
        }
        const client = yield* HttpClient.HttpClient;
        const headers = { 'idempotency-key': 'INTERNAL_C14_CUSTOMER_JOB', 'x-api-key': Redacted.value(key.secret) };
        const submitFor = (idempotencyKey: string, submittedPlan = plan) =>
          Effect.gen(function* submitCustomer() {
            const response = yield* client.post(`${shell.baseUrl}/api/symmy/v1/customers/batch`, {
              body: yield* HttpBody.json({
                contractVersion: 'INTERNAL_C14',
                plan: yield* Schema.encodeEffect(SymmyInternalExecutionPlanSchema)(submittedPlan),
              }),
              headers: { ...headers, 'idempotency-key': idempotencyKey },
            });
            if (response.status !== 202) {
              const problem = fixtureDiagnosticTail(yield* response.text);
              const owners = yield* collectFixtureDiagnostics(ownerDiagnostics).pipe(
                Effect.flatMap(encodeFixtureOwnerDiagnostics),
              );
              const gateway = yield* describeFixtureDiagnostics(shell.gatewayDiagnostics());
              return yield* unavailable(
                `Actual customer admission returned ${response.status}: ${problem}; owners: ${owners}; gateway: ${gateway}`,
              );
            }
            return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(receiptSchema)));
          });
        const submit = submitFor('INTERNAL_C14_CUSTOMER_JOB');
        const accepted = yield* submit;
        expect(yield* submit).toEqual(accepted);
        const symmy = contracts.find(({ deployment }) => deployment.appId === symmyAppId);
        const moduleKey = moduleKeys.get(symmyAppId);
        assert.isOk(symmy);
        if (moduleKey === undefined) {
          return yield* unavailable('The actual independent module credential is missing');
        }
        const workerArtifact = yield* buildProductWorker(symmy);
        const worker = yield* startProductWorker(
          workerArtifact,
          {
            ...environment,
            ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_CUSTOMER_NATIVE_WORKER',
          },
          moduleKey,
        );
        const ledger =
          admin`select effect_id,effect_key,owner_invocation_id,owner_receipt,state from symmy_integration.job_effects where job_id=${accepted.jobId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(effectSchema))),
          );
        const completed = yield* observeUntil(
          ledger.pipe(
            Effect.flatMap((rows) =>
              rows.some(({ state }) => state === 'indeterminate')
                ? Effect.fail(unavailable('An actual customer owner response was uncertain during the positive proof'))
                : Effect.succeed(rows),
            ),
          ),
          (rows) => rows.length === 2 && rows.every(({ state }) => state === 'settled'),
        ).pipe(
          Effect.tapError(() =>
            Effect.all(
              [
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
              ],
              { concurrency: 1 },
            ),
          ),
        );
        expect(completed.map(({ effect_key }) => effect_key)).toContain('party-create');
        const partyEffect = completed.find(({ effect_key }) => effect_key === 'party-create');
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
            moduleApiKey: moduleKey,
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
        const revisionOccurrenceId = yield* uuid;
        const revisedSource = { ...flatSource, occurrenceId: revisionOccurrenceId };
        const readbackOccurrenceId = yield* uuid;
        const readbackSource = { ...flatSource, occurrenceId: readbackOccurrenceId };
        const partySourceReference = { occurrenceId, recordId, source: sourceIdentity };
        const dataPrivacy = yield* seedCommittedProfileSourceProcessingNativeFixture({
          connections: isolated.connections,
          contexts: [
            ...[revisedSource, readbackSource].flatMap((source) => {
              const target = { kind: 'PARTY' as const, resourceId: partyReceipt.partyRef.resourceId };
              return [
                customerIntakeContext(integration.principalId, source, target),
                customerIntakeContext(integration.principalId, source, target, partySourceReference),
              ];
            }),
            {
              authMethod: 'api_key',
              principalId: integration.principalId,
              request: {
                consumerModuleId: partyModuleId,
                operation: 'PROFILE_EXPORT',
                source: flatSource,
                target: { kind: 'PARTY', resourceId: partyReceipt.partyRef.resourceId },
              },
            },
            {
              authMethod: 'api_key',
              principalId: integration.principalId,
              request: {
                consumerModuleId: commerceModuleId,
                operation: 'customer-profile-source.read',
                source: revisedSource,
                target: { kind: 'RETAIL_CUSTOMER_PROFILE', resourceId: profileReceipt.profileRef.resourceId },
              },
            },
            {
              authMethod: 'system',
              principalId: systemId,
              request: {
                consumerModuleId: partyModuleId,
                operation: 'UPDATE',
                source: readbackSource,
                target: { kind: 'PARTY', resourceId: partyReceipt.partyRef.resourceId },
              },
            },
            {
              authMethod: 'system',
              principalId: systemId,
              request: {
                consumerModuleId: commerceModuleId,
                operation: 'PROFILE_CREATE',
                partySourceReference,
                source: readbackSource,
                target: { kind: 'PARTY', resourceId: partyReceipt.partyRef.resourceId },
              },
            },
            {
              authMethod: 'system',
              principalId: systemId,
              request: {
                consumerModuleId: commerceModuleId,
                operation: 'customer-profile-source.write',
                source: readbackSource,
                target: { kind: 'RETAIL_CUSTOMER_PROFILE', resourceId: profileReceipt.profileRef.resourceId },
              },
            },
            {
              authMethod: 'system',
              principalId: systemId,
              request: {
                consumerModuleId: partyModuleId,
                operation: 'UPDATE',
                source: revisedSource,
                target: { kind: 'PARTY', resourceId: partyReceipt.partyRef.resourceId },
              },
            },
            {
              authMethod: 'system',
              principalId: systemId,
              request: {
                consumerModuleId: commerceModuleId,
                operation: 'PROFILE_CREATE',
                partySourceReference,
                source: revisedSource,
                target: { kind: 'PARTY', resourceId: partyReceipt.partyRef.resourceId },
              },
            },
            {
              authMethod: 'system',
              principalId: systemId,
              request: {
                consumerModuleId: commerceModuleId,
                operation: 'customer-profile-source.write',
                source: revisedSource,
                target: { kind: 'RETAIL_CUSTOMER_PROFILE', resourceId: profileReceipt.profileRef.resourceId },
              },
            },
            {
              authMethod: 'system',
              principalId: systemId,
              request: {
                consumerModuleId: partyModuleId,
                operation: 'PROFILE_EXPORT',
                source: flatSource,
                target: { kind: 'PARTY', resourceId: partyReceipt.partyRef.resourceId },
              },
            },
            {
              authMethod: 'system',
              principalId: systemId,
              request: {
                consumerModuleId: commerceModuleId,
                operation: 'customer-profile-source.read',
                source: flatSource,
                target: { kind: 'RETAIL_CUSTOMER_PROFILE', resourceId: profileReceipt.profileRef.resourceId },
              },
            },
          ],
          contractEvidenceRef: 'INTERNAL_C14_EXPLICIT_CUSTOMER_REVISION_AND_READ_CONTRACT',
          controllerRef: 'internal:customer-conformance',
          dataCategoryRefs: ['INTERNAL_C14_CUSTOMER_RECORD'],
          governancePrincipalId,
          legalEntityId,
          meaning:
            'Independent current internal policy permits revising and reading only the original Party and Retail profile for this qualified source record',
          profileReceipt: proofTransport,
          tenantId,
        }).pipe(
          Effect.tapError(() =>
            Effect.all(
              [
                shell.gatewayDiagnostics().pipe(Effect.flatMap(Effect.logError)),
                shell.issuerDiagnostics().pipe(Effect.flatMap(Effect.logError)),
                ...[...ownerDiagnostics].map(([appId, diagnostic]) =>
                  diagnostic.pipe(Effect.flatMap((message) => Effect.logError({ appId, message }))),
                ),
              ],
              { concurrency: 1 },
            ),
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
            ONTOS_PRIVACY_SOURCE_PROCESSING_CONTEXTS: yield* Schema.encodeEffect(
              Schema.fromJsonString(Schema.Array(SourceProcessingContextSchema)),
            )([...privacy.contexts, ...dataPrivacy.contexts]),
          },
          moduleKey: privacyRuntime.moduleKey,
          port: privacyRuntime.port,
          prefix: '/privacy-api',
        });
        ownerDiagnostics.set('privacy', restartedPrivacy.diagnostic);
        ownerRuntimes.set('privacy', { ...privacyRuntime, receiver: restartedPrivacy });
        yield* Effect.logInfo(
          'INTERNAL_C14 historical native receipt admitted separate DATA policies between independent jobs',
        );
        const revisionPlan = yield* makeSymmyC14CustomerRevisionPlan({
          admission: dataPrivacy.personAdmission,
          legalEntityId,
          observedAt: yield* DateTime.now,
          occurrenceId: revisionOccurrenceId,
          partySourceReference: dataPrivacy.profileReceipt.intent.partySourceReference ?? partySourceReference,
          recordId,
          revision: 2,
          sourceRouteId,
          tenantId,
        });
        const revisionJob = yield* submitFor('INTERNAL_C14_CUSTOMER_REVISION_2', revisionPlan);
        const revisionWorker = yield* startProductWorker(
          workerArtifact,
          {
            ...environment,
            ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_CUSTOMER_REVISION_2',
          },
          moduleKey,
        );
        const revisionEffects = yield* observeUntil(
          admin`select effect_id,effect_key,owner_invocation_id,owner_receipt,state from symmy_integration.job_effects where job_id=${revisionJob.jobId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(effectSchema))),
          ),
          (rows) => rows.length === 2 && rows.every(({ state }) => state === 'settled'),
        ).pipe(
          Effect.tapError(() =>
            Effect.all(
              [
                revisionWorker.diagnostic.pipe(Effect.flatMap(Effect.logError)),
                shell.gatewayDiagnostics().pipe(Effect.flatMap(Effect.logError)),
                shell.issuerDiagnostics().pipe(Effect.flatMap(Effect.logError)),
                ...[...ownerDiagnostics].map(([appId, diagnostic]) =>
                  diagnostic.pipe(Effect.flatMap((message) => Effect.logError({ appId, message }))),
                ),
              ],
              { concurrency: 1 },
            ),
          ),
        );
        expect(revisionEffects.every(({ owner_invocation_id }) => Option.isSome(owner_invocation_id))).toBe(true);
        const revisedProfiles =
          yield* admin`select p.party_id,cp.retail_customer_profile_id as customer_profile_id from party.parties p
          join commerce_customer_context.retail_customer_profiles cp on cp.party_resource_id=p.party_id::text and cp.tenant_id=p.tenant_id
          where p.tenant_id=${tenantId} and p.first_name='RevisedInternal'`;
        expect(revisedProfiles).toEqual([
          { customer_profile_id: profileReceipt.profileRef.resourceId, party_id: partyReceipt.partyRef.resourceId },
        ]);
        const revisedBindings =
          yield* admin`select customer_profile_id,party_resource_id,source_occurrence_id,source_order,source_revision,
          source_intent->'partySourceReference' as party_source_reference
          from commerce_customer_context.customer_profile_source_bindings
          where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and issuer=${sourceIdentity.issuer}
          and namespace=${sourceIdentity.namespace} and record_type=${sourceIdentity.recordType} and record_id=${recordId}`;
        expect(revisedBindings).toEqual([
          {
            customer_profile_id: profileReceipt.profileRef.resourceId,
            party_resource_id: partyReceipt.partyRef.resourceId,
            party_source_reference: partySourceReference,
            source_occurrence_id: revisionOccurrenceId,
            source_order: 2,
            source_revision: 'INTERNAL_C14_RECORD_REVISION_2',
          },
        ]);
        const revisionWrites = yield* admin`select action_invocation_id from core.action_invocations
          where tenant_id=${tenantId} and status='succeeded'
          and action_key in ('party.registry.create-party','party.registry.update-party','commerce.customer-context.ensure-retail-customer-profile')`;
        expect(revisionWrites).toHaveLength(4);
        const revisionStatusResponse = yield* client.get(`${shell.baseUrl}/api/symmy/v1/jobs/${revisionJob.jobId}`, {
          headers,
        });
        expect(revisionStatusResponse.status).toBe(200);
        const revisionStatus = yield* revisionStatusResponse.json.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({ jobId: receiptSchema.fields.jobId, status: Schema.Literal('completed_all') }),
            ),
          ),
        );
        expect(revisionStatus.jobId).toBe(revisionJob.jobId);
        yield* revisionWorker.child.kill();
        yield* revisionWorker.child.exitCode;
        const customerReadbackResponse = yield* client
          .get(`${shell.baseUrl}/api/symmy/v1/admin/customers?contractVersion=INTERNAL_C14`, { headers })
          .pipe(
            Effect.tap((response) =>
              response.status === 200
                ? Effect.void
                : Effect.all(
                    [
                      shell.gatewayDiagnostics().pipe(Effect.flatMap(Effect.logError)),
                      shell.issuerDiagnostics().pipe(Effect.flatMap(Effect.logError)),
                      ...[...ownerDiagnostics].map(([appId, diagnostic]) =>
                        diagnostic.pipe(Effect.flatMap((message) => Effect.logError({ appId, message }))),
                      ),
                    ],
                    { concurrency: 1 },
                  ),
            ),
          );
        expect(customerReadbackResponse.status).toBe(200);
        const readback = yield* customerReadbackResponse.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(customerReadbackSchema)),
        );
        expect(readback.customers).toHaveLength(1);
        const exportedCustomer = readback.customers.at(0);
        assert.isOk(exportedCustomer);
        expect(exportedCustomer.source_record_id).toBe(recordId);
        expect(exportedCustomer.id).not.toBe(recordId);
        expect(exportedCustomer.partyRef).toEqual(partyReceipt.partyRef);
        expect(exportedCustomer.profile.profileRef.resourceId).toBe(profileReceipt.profileRef.resourceId);
        assert.isOk(exportedCustomer.party);
        expect(exportedCustomer.party.firstName).toBe('RevisedInternal');
        expect(exportedCustomer.party.lastName).toBe('Customer');
        yield* Effect.logInfo(
          'INTERNAL_C14 customer GET exported current protected owners under explicit reader authority',
        );
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
          { concurrency: 1 },
        );
        yield* Effect.forEach(
          wrongReadRoutes,
          (wrongRoute) =>
            Effect.gen(function* rejectWrongCustomerProjectionAuthority() {
              yield* admin`update symmy_integration.job_routes set fixture_plan=${yield* Schema.encodeEffect(Schema.fromJsonString(SymmyRouteExecutionConfigurationSchema))(wrongRoute)}::jsonb
                where tenant_id=${tenantId} and route_id=${readRouteId}`;
              const rejected = yield* client.get(
                `${shell.baseUrl}/api/symmy/v1/admin/customers?contractVersion=INTERNAL_C14`,
                { headers },
              );
              expect(rejected.status).toBe(403);
              const rejectedBody = yield* rejected.text;
              expect(rejectedBody.includes('RevisedInternal')).toBe(false);
              expect(rejectedBody.includes('"Customer"')).toBe(false);
            }),
          { discard: true },
        );
        yield* admin`update symmy_integration.job_routes set fixture_plan=${yield* Schema.encodeEffect(Schema.fromJsonString(SymmyRouteExecutionConfigurationSchema))(readRoute)}::jsonb
          where tenant_id=${tenantId} and route_id=${readRouteId}`;
        const currentTransport = yield* acquireReceiptTransport();
        const currentReceipt = yield* executeCustomerProfileSourceWithAuthorization(
          currentTransport.request,
          Redacted.value(currentTransport.authorization),
          currentTransport.requestCorrelation,
          { baseUrl: currentTransport.baseUrl, compositionRevision: currentTransport.compositionRevision },
        ).pipe(
          Effect.flatMap((result) =>
            Match.value(result).pipe(
              Match.tag('MINIMAL_RECEIPT', (value) => Effect.succeed(value)),
              Match.orElse(() =>
                Effect.fail(unavailable('A fresh current Party admission is required for the readback update')),
              ),
            ),
          ),
        );
        const roundTripPlan = yield* makeSymmyC14CustomerRevisionPlan({
          admission: currentReceipt.currentAdmission,
          legalEntityId,
          observedAt: yield* DateTime.now,
          occurrenceId: readbackOccurrenceId,
          partySourceReference: currentReceipt.currentAdmission.sourceReference,
          recordId: exportedCustomer.source_record_id,
          revision: 3,
          sourceRouteId,
          tenantId,
        });
        const roundTripJob = yield* submitFor('INTERNAL_C14_CUSTOMER_GET_POST', roundTripPlan);
        const roundTripWorker = yield* startProductWorker(
          workerArtifact,
          {
            ...environment,
            ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_CUSTOMER_GET_POST',
          },
          moduleKey,
        );
        const roundTripEffects = yield* observeUntil(
          admin`select effect_id,effect_key,owner_invocation_id,owner_receipt,state from symmy_integration.job_effects where job_id=${roundTripJob.jobId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(effectSchema))),
          ),
          (rows) => rows.length === 2 && rows.every(({ state }) => state === 'settled'),
        ).pipe(
          Effect.tapError(() =>
            Effect.all(
              [
                roundTripWorker.diagnostic.pipe(Effect.flatMap(Effect.logError)),
                shell.gatewayDiagnostics().pipe(Effect.flatMap(Effect.logError)),
                shell.issuerDiagnostics().pipe(Effect.flatMap(Effect.logError)),
                ...[...ownerDiagnostics].map(([appId, diagnostic]) =>
                  diagnostic.pipe(Effect.flatMap((message) => Effect.logError({ appId, message }))),
                ),
              ],
              { concurrency: 1 },
            ),
          ),
        );
        expect(roundTripEffects.every(({ owner_invocation_id }) => Option.isSome(owner_invocation_id))).toBe(true);
        const retainedNativeIds = [...completed, ...revisionEffects, ...roundTripEffects].map((effect) =>
          Option.getOrThrow(effect.owner_invocation_id),
        );
        expect(new Set(retainedNativeIds).size).toBe(6);
        const [retainedNativeTuples] = yield* admin<{ count: number }>`select count(*)::integer as count
          from core.action_invocations a join symmy_integration.job_effects e on e.tenant_id=a.tenant_id
          and e.owner_invocation_id=a.action_invocation_id and e.owner_executor_principal_id=a.principal_id
          and e.owner_auth_context_ref=a.auth_context_ref and e.owner_request_hash=a.request_hash and e.effect_id::text=a.idempotency_key
          where a.tenant_id=${tenantId} and a.legal_entity_id=${legalEntityId} and a.principal_id=${systemId} and a.status='succeeded'
          and e.job_id in (${accepted.jobId},${revisionJob.jobId},${roundTripJob.jobId})`;
        expect(retainedNativeTuples).toEqual({ count: 6 });
        const readbackBindings =
          yield* admin`select b.customer_profile_id,b.party_resource_id,b.source_order,b.source_revision,b.source_occurrence_id,
          b.source_intent->'partySourceReference' as party_source_reference,p.first_name
          from commerce_customer_context.customer_profile_source_bindings b join party.parties p on p.tenant_id=b.tenant_id and p.party_id::text=b.party_resource_id
          where b.tenant_id=${tenantId} and b.legal_entity_id=${legalEntityId} and b.issuer=${sourceIdentity.issuer}
          and b.namespace=${sourceIdentity.namespace} and b.record_type=${sourceIdentity.recordType} and b.record_id=${exportedCustomer.source_record_id}`;
        expect(readbackBindings).toEqual([
          {
            customer_profile_id: profileReceipt.profileRef.resourceId,
            first_name: 'ReadbackInternal',
            party_resource_id: partyReceipt.partyRef.resourceId,
            party_source_reference: partySourceReference,
            source_occurrence_id: readbackOccurrenceId,
            source_order: 3,
            source_revision: 'INTERNAL_C14_RECORD_REVISION_3',
          },
        ]);
        const beforeDisableWrites = yield* admin`select action_invocation_id from core.action_invocations
          where tenant_id=${tenantId} and status='succeeded'
          and action_key in ('party.registry.create-party','party.registry.update-party','commerce.customer-context.ensure-retail-customer-profile')`;
        expect(beforeDisableWrites).toHaveLength(6);
        yield* roundTripWorker.child.kill();
        yield* roundTripWorker.child.exitCode;
        yield* Effect.logInfo(
          'INTERNAL_C14 customer GET source ID round-tripped through a fresh native source revision',
        );
        const admittedBeforeDisable = yield* submitFor('INTERNAL_C14_CUSTOMER_BEFORE_DISABLE');
        expect(admittedBeforeDisable.jobId).not.toBe(accepted.jobId);
        yield* admin`update core.principals set status='disabled',disabled_at=current_timestamp where principal_id=${integration.principalId} and tenant_id=${tenantId}`;
        const disabledWorker = yield* startProductWorker(
          workerArtifact,
          {
            ...environment,
            ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_CUSTOMER_DISABLED_ORIGIN',
          },
          moduleKey,
        );
        yield* observeUntil(
          admin`select effect_id,effect_key,owner_invocation_id,owner_receipt,state from symmy_integration.job_effects where job_id=${admittedBeforeDisable.jobId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(effectSchema))),
          ),
          (rows) => rows.some(({ state }) => state === 'blocked'),
        );
        const [afterDisable] = yield* admin<{ parties: number; profiles: number }>`select
          (select count(*)::integer from party.parties where tenant_id=${tenantId}) as parties,
          (select count(*)::integer from commerce_customer_context.customer_profiles where tenant_id=${tenantId}) as profiles`;
        expect(afterDisable).toEqual({ parties: 1, profiles: 1 });
        const [afterDisableWrites] = yield* admin<{
          count: number;
        }>`select count(*)::integer as count from core.action_invocations
          where tenant_id=${tenantId} and status='succeeded' and action_key in ('party.registry.create-party','party.registry.update-party','commerce.customer-context.ensure-retail-customer-profile')`;
        expect(afterDisableWrites?.count).toBe(beforeDisableWrites.length);
        yield* disabledWorker.child.kill();
        yield* disabledWorker.child.exitCode;
        return yield* Effect.void;
      }),
    ).pipe(Effect.provide(services)),
  240_000,
);
