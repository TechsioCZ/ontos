import { RetailCustomerProfileRefSchema } from '@app/commerce-customer-context/resources/retail-customer-profile';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { SourceProcessingContextSchema } from '@app/privacy/api';
import type { SourceProcessingContext } from '@app/privacy/api/source-processing-eligibility';
import { AntiResurrectionProtectionSchema } from '@app/privacy/domain/anti-resurrection';
import { seedSourceProcessingNativeFixture } from '@app/privacy/testing/source-processing-native';
import { makeApiKeyGatewayNativeFixture } from '@app/shell-super-app/testing/api-key-gateway-native';
import { SymmyEffectIdSchema } from '@app/shared-contracts/symmy';
import { SymmyJobStatusResponseSchema } from '@app/symmy-integration/api/symmy-job-status';
import {
  SymmyInternalExecutionPlanSchema,
  SymmyRouteExecutionConfigurationSchema,
} from '@app/symmy-integration/symmy-internal-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { assert, expect } from 'effect-rstest';
import { Config, DateTime, Duration, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpBody, HttpClient } from 'effect/http';
import type { HttpClientResponse } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import {
  bindCustomerFixtureProviderKey as bindProviderKey,
  customerFixtureUuid as uuid,
  seedCustomerFixtureProviderPrincipal as seedPrincipal,
} from './symmy-c14-customer-native-authority.mts';
import { internalCustomerSource, makeSymmyC14CustomerPlan } from './symmy-c14-customer-plan.mts';
import type { InternalCustomerPlanInput } from './symmy-c14-customer-plan.mts';
import {
  CustomerNativeProfileInvocationSchema,
  issueCustomerProfileFixtureRecovery,
} from './symmy-c14-customer-recovery.mts';
import {
  customerFixtureWorkloads,
  customerIntakeContext,
  customerOwnerRelaySources,
  customerRecoveryRules,
  customerWorkerKey,
  customerWorkerRules,
} from './symmy-c14-customer-rules.mts';
import {
  SymmyC14ProductFixtureUnavailable,
  buildProductOwner,
  buildProductWorker,
  encodeProductComposition,
  nativePort,
  productComposition,
  startProductOwner,
  startProductWorker,
} from './symmy-c14-product-runtime.mts';

export const customerFixtureServices = NodeChildProcessSpawner.layer.pipe(
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
const unavailable = (message: string) => new SymmyC14ProductFixtureUnavailable({ message });
const commerceApp = 'commerce-customer-context';
const priceGroupApp = 'price-group-catalog';
const priceGroupCreateAction = 'pricing.price-group-catalog.create-price-group';
const priceGroupModule = 'pricing.price-group-catalog';
const priceGroupReadWorkload = 'pricing.price-group-catalog.source-read';
const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const symmyAppId = 'symmy-integration';
const commerceModuleId = 'commerce.customer-context';
const partyModuleId = 'party.registry';

export const observeCustomerFixtureUntil = <Value, Failure, Requirements>(
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

const assignmentAction = 'commerce.customer-context.assign-customer-price-group';
const assignmentReceipt = 'commerce.customer-context.api.customer-price-group-assignment-receipt';
const assignmentRules = [
  {
    audience: commerceApp,
    declarationKey: 'commerce.customer-context.customer-price-group.assign',
    entrypointKey: assignmentAction,
    jobKey: customerWorkerKey,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey: customerWorkerKey,
    workloadKey: 'commerce.customer-context.source-write',
  },
  {
    allowHistoricalDeliveryRecovery: true,
    audience: commerceApp,
    declarationKey: 'commerce.customer-context.customer-price-group-assignment-receipt.read',
    entrypointKey: assignmentReceipt,
    jobKey: customerWorkerKey,
    legalEntityScope: 'required',
    recoveryOf: { actionKey: assignmentAction, jobKey: customerWorkerKey },
    schemaVersion: '1',
    workerKey: customerWorkerKey,
    workloadKey: 'commerce.customer-context.source-read',
  },
  {
    audience: priceGroupApp,
    declarationKey: 'pricing.price-group-catalog.price-group.create',
    entrypointKey: priceGroupCreateAction,
    jobKey: customerWorkerKey,
    legalEntityScope: 'forbidden',
    schemaVersion: '1',
    workerKey: customerWorkerKey,
    workloadKey: 'pricing.price-group-catalog.source-write',
  },
  {
    allowHistoricalDeliveryRecovery: true,
    audience: priceGroupApp,
    declarationKey: 'pricing.price-group-catalog.price-group-result-lookup.read',
    entrypointKey: 'pricing.price-group-catalog.api.price-group-result-lookup',
    jobKey: customerWorkerKey,
    legalEntityScope: 'forbidden',
    recoveryOf: { actionKey: priceGroupCreateAction, jobKey: customerWorkerKey },
    schemaVersion: '1',
    workerKey: customerWorkerKey,
    workloadKey: priceGroupReadWorkload,
  },
  {
    audience: 'privacy',
    declarationKey: 'privacy.core.source-processing-eligibility.read',
    entrypointKey: 'privacy.core.api.source-processing-eligibility',
    jobKey: customerWorkerKey,
    legalEntityScope: 'required',
    schemaVersion: '1',
    workerKey: customerWorkerKey,
    workloadKey: 'privacy.core.source-processing-check',
  },
] as const;
const assignmentOwnerRelaySources = [
  ...customerOwnerRelaySources.map((source) =>
    source.sourceAppId === commerceApp
      ? ({
          ...source,
          registeredWorkloads: [
            ...source.registeredWorkloads,
            {
              audience: priceGroupApp,
              declarationKey: 'pricing.price-group-catalog.price-group.read.compatibility',
              entrypointKey: 'pricing.price-group-catalog.api.validate-price-group-compatibility',
              jobKey: customerWorkerKey,
              legalEntityScope: 'forbidden' as const,
              schemaVersion: '1',
              sourceWorkloadKey: 'commerce.customer-context.source-write',
              workloadKey: priceGroupReadWorkload,
            },
          ],
        } as const)
      : source,
  ),
  { registeredWorkloads: [], sourceAppId: priceGroupApp } as const,
];

type ShellFixtureOptions = Parameters<typeof makeApiKeyGatewayNativeFixture>[0];
type RelaySource = NonNullable<ShellFixtureOptions['additionalRelaySources']>[number];
export interface SymmyC14CustomerFixtureScopeInput {
  readonly admin: PgClient.PgClient;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}
export interface SymmyC14CustomerFixtureOptions<Failure = never, Requirements = never> {
  readonly allowedOwnerOperations?: readonly {
    readonly entrypointKey: string;
    readonly moduleId: string;
    readonly schemaVersion: string;
  }[];
  readonly includePriceGroup?: boolean;
  readonly initializeScopes: (input: SymmyC14CustomerFixtureScopeInput) => Effect.Effect<void, Failure, Requirements>;
  readonly ownerRelaySources?: readonly RelaySource[];
  readonly verifyPausedIntake?: boolean;
  readonly workerRules?: NonNullable<NonNullable<ShellFixtureOptions['relaySource']>['registeredWorkloads']>;
  readonly workloads?: readonly string[];
}

export const seedCustomerIntakeProtection = Effect.fn('SymmyC14CustomerFixture.seedIntakeProtection')(
  function* seedIntakeProtection(admin: PgClient.PgClient, context: SourceProcessingContext) {
    const protectedAt = DateTime.formatIso(yield* DateTime.now);
    const { legalEntityId, tenantId } = context;
    const protectionScope = {
      contentScopeRefs: context.contentScopeRefs,
      evidenceRefs: ['INTERNAL_C14_ERASURE_CONTROL'],
      measure: 'DELETE' as const,
      resourceRefs: context.resourceRefs,
      subjectRef: context.intendedScope.subjectRef.resourceId,
      tenantId,
    };
    const protection = yield* Schema.decodeUnknownEffect(AntiResurrectionProtectionSchema)({
      ...protectionScope,
      enforcementReceipt: {
        ...protectionScope,
        authorityRef: 'INTERNAL_C14_PRIVACY_OWNER',
        operations: ['IMPORT', 'REPLAY', 'PROJECTION_REBUILD', 'BACKUP_RECOVERY'],
        ownerModuleId: 'party.registry',
        receiptRef: 'INTERNAL_C14_ERASURE_ENFORCEMENT',
        taskId: 'INTERNAL_C14_ERASURE_TASK',
      },
      outcomeStatus: 'SUCCEEDED',
      ownerExecutionOutcomeRef: 'INTERNAL_C14_ERASURE_OUTCOME',
      protectedAt,
      protectionId: yield* uuid,
      sourceDecisionRef: 'INTERNAL_C14_ERASURE_DECISION',
      sourceDecisionRevision: 1,
    });
    const protectionRecord = yield* Schema.encodeEffect(Schema.fromJsonString(AntiResurrectionProtectionSchema))(
      protection,
    );
    yield* admin`insert into privacy.anti_resurrection_protections
      (tenant_id,legal_entity_id,protection_id,subject_ref,measure,protected_at,protection_record)
      values(${tenantId},${legalEntityId},${protection.protectionId},${protection.subjectRef},${protection.measure},
        ${protectedAt}::timestamptz,${protectionRecord}::jsonb)`;
  },
);

export const customerIntakeCounts = (admin: PgClient.PgClient, tenantId: string) => admin`select
  (select count(*)::integer from symmy_integration.import_jobs where tenant_id=${tenantId}) as jobs,
  (select count(*)::integer from symmy_integration.job_effects where tenant_id=${tenantId}) as effects,
  (select count(*)::integer from core.domain_events where tenant_id=${tenantId}
    and event_type='integration.symmy.job-admitted.v1') as events,
  (select count(*)::integer from core.outbox_messages where tenant_id=${tenantId}
    and producer_module_key='integration.symmy') as messages`;
const verifyPausedCustomerIntake = Effect.fn('SymmyC14CustomerFixture.verifyPausedIntake')(function* verify<
  Failure,
  Requirements,
>(input: {
  readonly admin: PgClient.PgClient;
  readonly contexts: readonly SourceProcessingContext[];
  readonly deniedSource: SourceProcessingContext['request']['source'];
  readonly identity: Omit<InternalCustomerPlanInput, 'occurrenceId' | 'recordId'>;
  readonly submit: (
    key: string,
    plan: typeof SymmyInternalExecutionPlanSchema.Type,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, Failure, Requirements>;
}) {
  const { admin, contexts, deniedSource, identity, submit } = input;
  if (deniedSource === null) {
    return yield* Effect.void;
  }
  const protectedContext = contexts.find(({ request }) => request.source?.occurrenceId === deniedSource.occurrenceId);
  if (protectedContext === undefined) {
    return yield* unavailable('The exact blocked source fixture context is missing');
  }
  yield* seedCustomerIntakeProtection(admin, protectedContext);
  const before = yield* customerIntakeCounts(admin, identity.tenantId);
  yield* Effect.forEach(
    [
      { caseKey: 'PROTECTED', occurrenceId: deniedSource.occurrenceId, status: 403 },
      { caseKey: 'UNKNOWN', occurrenceId: yield* uuid, status: 503 },
    ],
    Effect.fn('SymmyC14CustomerFixture.assertPausedIntakeDenial')(function* assertPausedIntakeDenial(testCase) {
      const deniedPlan = yield* makeSymmyC14CustomerPlan({
        ...identity,
        occurrenceId: testCase.occurrenceId,
        recordId: deniedSource.recordId,
      });
      const result = yield* submit(`INTERNAL_C14_PAUSED_INTAKE_${testCase.caseKey}`, deniedPlan);
      expect(result.status).toBe(testCase.status);
      expect(yield* result.text).not.toContain(deniedSource.recordId);
    }),
    { concurrency: 1, discard: true },
  );
  expect(yield* customerIntakeCounts(admin, identity.tenantId)).toEqual(before);
  return yield* Effect.logInfo(
    'INTERNAL_C14 paused worker kept protected and unresolved customer inputs out of durable storage',
  );
});

const mergeRelaySources = (baseline: readonly RelaySource[], additions: readonly RelaySource[]) => {
  const byOwner = new Map<string, RelaySource>(baseline.map((source) => [source.sourceAppId, source]));
  for (const source of additions) {
    const current = byOwner.get(source.sourceAppId);
    byOwner.set(source.sourceAppId, {
      ...source,
      registeredWorkloads: [...(current?.registeredWorkloads ?? []), ...(source.registeredWorkloads ?? [])],
    });
  }
  return [...byOwner.values()];
};

const customerFixtureConfiguration = (options: Omit<SymmyC14CustomerFixtureOptions, 'initializeScopes'>) => ({
  allowedOwnerOperations: [
    ...(options.includePriceGroup === true
      ? [{ entrypointKey: assignmentAction, moduleId: commerceModuleId, schemaVersion: '1' }]
      : []),
    ...(options.allowedOwnerOperations ?? []),
  ],
  appIds: [
    'party-registry',
    commerceApp,
    'privacy',
    ...(options.includePriceGroup === true ? ([priceGroupApp] as const) : []),
    symmyAppId,
  ] as const,
  expectedEffects: options.includePriceGroup === true ? 3 : 2,
  includePriceGroup: options.includePriceGroup === true,
  relaySources: mergeRelaySources(
    options.includePriceGroup === true ? assignmentOwnerRelaySources : customerOwnerRelaySources,
    options.ownerRelaySources ?? [],
  ),
  workerRules: [
    ...customerWorkerRules,
    ...customerRecoveryRules,
    ...(options.includePriceGroup === true ? assignmentRules : []),
    ...(options.workerRules ?? []),
  ],
  workloads: [
    ...customerFixtureWorkloads,
    customerWorkerKey,
    ...(options.includePriceGroup === true ? ['pricing.price-group-catalog.source-write', priceGroupReadWorkload] : []),
    ...(options.workloads ?? []),
  ],
});

export const makeSymmyC14CustomerFixture = <Failure, Requirements>(
  options: SymmyC14CustomerFixtureOptions<Failure, Requirements>,
) =>
  Effect.fn('SymmyC14CustomerFixture.bootstrap')(function* bootstrapCustomerFixture() {
    const configuration = customerFixtureConfiguration(options);
    const { appIds } = configuration;
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
      mode: 'schema-only',
      purpose: 'implementation-1096-registered-workload-gateway',
    });
    const admin = yield* PgClient.make({ url: Redacted.make(isolated.connections.admin.connectionString) });
    const shell = yield* makeApiKeyGatewayNativeFixture({
      additionalRelaySources: configuration.relaySources,
      ownedDatabase: isolated,
      productionGate: true,
      relaySource: {
        registeredWorkloads: configuration.workerRules,
        sourceAppId: symmyAppId,
      },
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
    yield* options.initializeScopes({ admin, legalEntityId, principalId: governancePrincipalId, tenantId });
    for (const principalId of [integration.principalId, systemId]) {
      for (const workload of configuration.workloads) {
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
    const occurrenceId = yield* uuid;
    const recordId = 'INTERNAL_C14_NAMED_PERSON';
    const observedAt = yield* DateTime.now;
    const customerPlan = yield* makeSymmyC14CustomerPlan({
      legalEntityId,
      observedAt,
      occurrenceId,
      recordId,
      sourceRouteId,
      tenantId,
    });
    const priceGroupEffectiveFrom = DateTime.add(observedAt, { seconds: 45 });
    const plan = yield* Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
      items: [
        ...(yield* Schema.encodeEffect(SymmyInternalExecutionPlanSchema)(customerPlan)).items,
        ...(configuration.includePriceGroup
          ? [
              {
                effects: [
                  {
                    effectKey: 'price-group-create',
                    intent: {
                      _tag: 'PriceGroupCreate',
                      payload: {
                        businessCode: 'INTERNAL_C14_EXPLICIT_GROUP',
                        classificationPurpose: 'Explicit internal assignment fixture',
                        compatibilityContracts: [
                          { contractId: 'commerce.customer-price-group-assignment.v1', version: 1 },
                        ],
                        description: 'Actual native producer for the explicit Retail assignment',
                        displayName: 'Internal explicit group',
                        effectiveFrom: DateTime.formatIso(priceGroupEffectiveFrom),
                        effectiveTo: null,
                        expectedCatalogRevision: 0,
                        reason: 'INTERNAL_C14 genuine owner producer fixture',
                        sourceCorrelation: {
                          issuer: internalCustomerSource.issuerId,
                          mappingVersion: internalCustomerSource.mappingVersion,
                          namespace: internalCustomerSource.namespace,
                          recordKey: 'INTERNAL_C14_EXPLICIT_GROUP',
                          routeId: sourceRouteId,
                        },
                      },
                    },
                    operation: {
                      entrypointKey: priceGroupCreateAction,
                      moduleId: priceGroupModule,
                      schemaVersion: '1',
                    },
                  },
                ],
                itemKey: 'price-group',
                source: {
                  entityKind: 'PRICE_GROUP',
                  issuerId: internalCustomerSource.issuerId,
                  sourceNamespace: internalCustomerSource.namespace,
                  sourceRecordId: 'INTERNAL_C14_EXPLICIT_GROUP',
                },
                sourceOccurrenceId: yield* uuid,
              },
            ]
          : []),
      ],
    });
    const sourceIdentity = {
      issuer: internalCustomerSource.issuerId,
      namespace: internalCustomerSource.namespace,
      recordType: internalCustomerSource.recordType,
      routeRef: sourceRouteId,
    };
    const flatSource = { ...sourceIdentity, occurrenceId, recordId };
    const intakeContexts = [customerIntakeContext(integration.principalId, flatSource, null)];
    const deniedSource =
      options.verifyPausedIntake === true
        ? { ...flatSource, occurrenceId: yield* uuid, recordId: 'INTERNAL_C14_BLOCKED_INTAKE_SOURCE' }
        : null;
    if (deniedSource !== null) {
      intakeContexts.push(customerIntakeContext(integration.principalId, deniedSource, null));
    }
    const privacy = yield* seedSourceProcessingNativeFixture({
      connections: isolated.connections,
      contexts: [
        ...intakeContexts,
        {
          authMethod: 'api_key',
          principalId: integration.principalId,
          request: { consumerModuleId: partyModuleId, operation: 'EVIDENCE_READ', source: flatSource, target: null },
        },
        ...(['CREATE', 'EVIDENCE_READ'] as const).map(
          (operation) =>
            ({
              authMethod: 'system',
              principalId: systemId,
              request: { consumerModuleId: partyModuleId, operation, source: flatSource, target: null },
            }) satisfies Parameters<typeof seedSourceProcessingNativeFixture>[0]['contexts'][number],
        ),
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
    const encodedPlan = yield* Schema.encodeEffect(SymmyInternalExecutionPlanSchema)(plan);
    const configuredPlan = yield* Schema.decodeUnknownEffect(SymmyRouteExecutionConfigurationSchema)({
      ...encodedPlan,
      items: encodedPlan.items.map((item) => ({
        ...item,
        effects: [
          ...item.effects,
          ...configuration.allowedOwnerOperations.map((operation, index) => ({
            effectKey: `permitted-operation-${index}`,
            operation,
          })),
        ],
      })),
      sourceRouteId,
    });
    const lifecyclePolicy = { policyId: 'INTERNAL_C14_CUSTOMER_RETENTION', revision: 'v1' };
    yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,legal_entity_id,principal_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_revision,lifecycle_policy)
          values(${routeId},${tenantId},${legalEntityId},${integration.principalId},true,array['INTERNAL_C14'],${yield* Schema.encodeEffect(Schema.fromJsonString(SymmyRouteExecutionConfigurationSchema))(configuredPlan)}::jsonb,${internalCustomerSource.mappingVersion},'customersBatch',${internalCustomerSource.routeRevision},${yield* json(lifecyclePolicy)}::jsonb)`;
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
      [commerceApp]: '/commerce-customer-context-api',
      'party-registry': '/party-registry-api',
      [priceGroupApp]: '/price-group-catalog-api',
      privacy: '/privacy-api',
      'symmy-integration': '/symmy-integration-api',
    } as const;
    const ownerDiagnostics = new Map<string, Effect.Effect<string>>();
    const ownerRuntimes = new Map<
      string,
      {
        artifacts: Effect.Success<ReturnType<typeof buildProductOwner>>;
        contract: (typeof contracts)[number];
        moduleKey: string;
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
        environment: { ...environment, ONTOS_GATEWAY_MODULE_API_KEY: moduleKey },
        port,
        prefix: prefixes[appId],
      });
      ownerDiagnostics.set(appId, receiver.diagnostic);
      ownerRuntimes.set(appId, { artifacts, contract, moduleKey, port, receiver });
    }
    const client = yield* HttpClient.HttpClient;
    const headers = { 'idempotency-key': 'INTERNAL_C14_CUSTOMER_JOB', 'x-api-key': Redacted.value(key.secret) };
    const submitResponse = (idempotencyKey: string, submittedPlan = plan) =>
      Effect.gen(function* submitCustomer() {
        return yield* client.post(`${shell.baseUrl}/api/symmy/v1/customers/batch`, {
          body: yield* HttpBody.json({
            contractVersion: 'INTERNAL_C14',
            plan: yield* Schema.encodeEffect(SymmyInternalExecutionPlanSchema)(submittedPlan),
          }),
          headers: { ...headers, 'idempotency-key': idempotencyKey },
        });
      });
    const submitFor = (idempotencyKey: string, submittedPlan = plan) =>
      Effect.gen(function* submitCustomer() {
        const response = yield* submitResponse(idempotencyKey, submittedPlan);
        if (response.status !== 202) {
          return yield* unavailable(`Actual customer admission returned ${response.status}: ${yield* response.text}`);
        }
        return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(receiptSchema)));
      });
    const submit = submitFor('INTERNAL_C14_CUSTOMER_JOB');
    const accepted = yield* submit;
    expect(yield* submit).toEqual(accepted);
    yield* verifyPausedCustomerIntake({
      admin,
      contexts: privacy.contexts,
      deniedSource,
      identity: { legalEntityId, observedAt, sourceRouteId, tenantId },
      submit: submitResponse,
    });
    const symmy = contracts.find(({ deployment }) => deployment.appId === symmyAppId);
    const moduleKey = moduleKeys.get(symmyAppId);
    assert.isOk(symmy);
    if (moduleKey === undefined) {
      return yield* unavailable('The actual independent module credential is missing');
    }
    const workerArtifact = yield* buildProductWorker(symmy);
    const worker = yield* startProductWorker(workerArtifact, {
      ...environment,
      ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_CUSTOMER_NATIVE_WORKER',
      ONTOS_GATEWAY_MODULE_API_KEY: moduleKey,
    });
    const ledger =
      admin`select effect_id,effect_key,owner_invocation_id,owner_receipt,state from symmy_integration.job_effects where job_id=${accepted.jobId}`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(effectSchema))),
      );
    const dependencyDiagnostics = Effect.all([
      worker.diagnostic.pipe(Effect.flatMap(Effect.logError)),
      shell.gatewayDiagnostics().pipe(Effect.flatMap(Effect.logError)),
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
    ]);
    const completed = yield* observeCustomerFixtureUntil(
      ledger.pipe(
        Effect.flatMap((rows) =>
          rows.some(({ state }) => state === 'indeterminate')
            ? Effect.fail(unavailable('An actual customer owner response was uncertain during the positive proof'))
            : Effect.succeed(rows),
        ),
      ),
      (rows) => rows.length === configuration.expectedEffects && rows.every(({ state }) => state === 'settled'),
    ).pipe(Effect.tapError(() => dependencyDiagnostics));
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
      return yield* unavailable('Settled customer effects must retain their actual Core native invocation identities');
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
    yield* observeCustomerFixtureUntil(
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
    yield* Effect.logInfo('INTERNAL_C14 issuing genuine profile prerequisite receipt');
    const proofTransport = yield* issueCustomerProfileFixtureRecovery({
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
    yield* Effect.logInfo('INTERNAL_C14 genuine profile prerequisite receipt issued');
    return {
      admin,
      completed,
      contracts,
      environment,
      flatSource,
      governancePrincipalId,
      integration,
      isolated,
      legalEntityId,
      moduleKey,
      moduleKeys,
      occurrenceId,
      ownerDiagnostics,
      ownerRuntimes,
      partyReceipt,
      priceGroupEffectiveFrom,
      privacy,
      profileReceipt,
      proofTransport,
      providerKey: key,
      recordId,
      routeId,
      shell,
      snapshot,
      sourceIdentity,
      sourceRouteId,
      submitFor,
      submitResponse,
      symmy,
      systemId,
      tenantId,
      workerArtifact,
    };
  })();
