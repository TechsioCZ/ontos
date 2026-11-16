import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { writeTestTenantScopes } from '@app/core-runtime/testing/tenant-access';
import { PgClient } from '@effect/sql-pg';
import { retireSourceProcessingNativePurpose } from '@app/privacy/testing/source-processing-governance-native';
import { ProcessingPurposeRefSchema } from '@app/privacy/resources/processing-purpose';
import { SourceProcessingContextSchema } from '@app/privacy/api';
import {
  seedCommittedProfileSourceProcessingNativeFixture,
  seedSourceProcessingNativeFixture,
} from '@app/privacy/testing/source-processing-native';
import { SymmyJobStatusResponseSchema } from '@app/symmy-integration/api/symmy-job-status';
import {
  SymmyInternalExecutionPlanSchema,
  SymmyRouteExecutionConfigurationSchema,
} from '@app/symmy-integration/symmy-internal-contracts';
import { expect, it } from 'effect-rstest';
import { DateTime, Duration, Effect, Match, Option, Redacted, Schema } from 'effect';
import { HttpBody, HttpClient } from 'effect/http';
import { encodeSymmySourceSelector } from '@app/symmy-integration/symmy-source-selector';
import { customerFixtureUuid as uuid } from './support/symmy-c14-customer-native-authority.mts';
import { internalCustomerSource } from './support/symmy-c14-customer-plan.mts';
import { customerIntakeContext, customerWorkerKey } from './support/symmy-c14-customer-rules.mts';
import {
  SymmyC14ProductFixtureUnavailable,
  startProductOwner,
  startProductWorker,
} from './support/symmy-c14-product-runtime.mts';
import { AssignCustomerPriceGroupPayloadSchema } from '@app/commerce-customer-context/api/assign-customer-price-group-action';
import {
  CustomerPriceGroupAssignmentReceiptInvalidProblemSchema,
  CustomerPriceGroupAssignmentReceiptRequestSchema,
  CustomerPriceGroupAssignmentReceiptResponseSchema,
} from '@app/commerce-customer-context/api/customer-price-group-assignment-receipt';
import { assignCustomerPriceGroupRequestIdentity } from '@app/commerce-customer-context/domain/native-action-request-identity';
import { computeActionRequestHash, computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { PriceGroupRefSchema } from '@app/price-group-catalog/resources/price-group';
import { issueDelegatedGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import {
  customerFixtureServices as assignmentFixtureServices,
  makeSymmyC14CustomerFixture as makeAssignmentFixture,
  observeCustomerFixtureUntil as observeAssignmentUntil,
} from './support/symmy-c14-customer-assignment-fixture.mts';

const commerceModuleId = 'commerce.customer-context';
const commerceApp = 'commerce-customer-context';
const partyModuleId = 'party.registry';
const priceGroupCreateAction = 'pricing.price-group-catalog.create-price-group';
const unavailable = (message: string) => new SymmyC14ProductFixtureUnavailable({ message });
const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const actionKey = 'commerce.customer-context.assign-customer-price-group';
const readKey = 'commerce.customer-context.api.customer-price-group-assignment-receipt';
const uuidText = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('AssignmentFixtureId'),
  Schema.decodeTo(Schema.String),
);
const nativeSchema = Schema.Struct({
  actionInvocationId: uuidText,
  authContextRef: Schema.String,
  effectId: uuidText,
  idempotencyKey: Schema.String.pipe(Schema.brand('AssignmentIdempotencyKey'), Schema.decodeTo(Schema.String)),
  payload: AssignCustomerPriceGroupPayloadSchema,
  principalId: TrustedPrincipalContextSchema.fields.principalId,
  requestHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});

type AssignmentFixture = Effect.Success<ReturnType<typeof makeAssignmentFixture>>;
const carrierEffectSchema = Schema.Struct({
  effect_id: Schema.String,
  effect_key: Schema.String,
  owner_invocation_id: Schema.OptionFromNullOr(uuidText),
  owner_receipt: Schema.Unknown,
  state: Schema.String,
});
const symmyApp = 'symmy-integration';
const carrierCode = 'INTERNAL_C14_ASSIGNMENT_CARRIER';
const priceGroupRecordId = 'INTERNAL_C14_EXPLICIT_GROUP';
const carrierGroupRecordId = 'INTERNAL_C14_CARRIER_GROUP';

const enrolled = (effectKey: string, entrypointKey: string, moduleId: string) => ({
  effects: [{ effectKey, operation: { entrypointKey, moduleId, schemaVersion: '1' } }],
});
/** The internal Price Group plan: the public routes have no Price Group create for a customer assignment. */
const makePriceGroupPlan = Effect.fn('SymmyC14Assignment.priceGroupPlan')(function* makePriceGroupPlan(
  fixture: AssignmentFixture,
  effectiveFrom: DateTime.Utc,
) {
  return yield* Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
    items: [
      {
        effects: [
          {
            effectKey: 'price-group-create',
            intent: {
              _tag: 'PriceGroupCreate',
              payload: {
                businessCode: priceGroupRecordId,
                classificationPurpose: 'Explicit internal assignment fixture',
                compatibilityContracts: [{ contractId: 'commerce.customer-price-group-assignment.v1', version: 1 }],
                description: 'Actual native producer for the explicit Retail assignment',
                displayName: 'Internal explicit group',
                effectiveFrom: DateTime.formatIso(effectiveFrom),
                effectiveTo: null,
                expectedCatalogRevision: 0,
                reason: 'INTERNAL_C14 genuine owner producer fixture',
                sourceCorrelation: {
                  issuer: internalCustomerSource.issuerId,
                  mappingVersion: internalCustomerSource.mappingVersion,
                  namespace: internalCustomerSource.namespace,
                  recordKey: priceGroupRecordId,
                  routeId: fixture.sourceRouteId,
                },
              },
            },
            operation: {
              entrypointKey: priceGroupCreateAction,
              moduleId: 'pricing.price-group-catalog',
              schemaVersion: '1',
            },
          },
        ],
        itemKey: 'price-group',
        source: {
          entityKind: 'PRICE_GROUP',
          issuerId: internalCustomerSource.issuerId,
          sourceNamespace: internalCustomerSource.namespace,
          sourceRecordId: priceGroupRecordId,
        },
        sourceOccurrenceId: yield* uuid,
      },
    ],
  });
});

/**
 * A test-only carrier for the internal plans of this suite. The public customers route no longer takes a plan, and the
 * price group and the explicit assignment have no public route. The still internal selected group route carries them
 * under a test-only enrollment of this fixture: it changes no production route and no allowed effect of one.
 */
const enrollInternalPlanCarrier = Effect.fn('SymmyC14Assignment.carrier')(function* enrollInternalPlanCarrier(
  fixture: AssignmentFixture,
) {
  const { admin, integration, legalEntityId, shell, sourceIdentity, sourceRouteId, tenantId } = fixture;
  const routeId = yield* uuid;
  const groupRef = {
    moduleId: commerceModuleId,
    resourceId: yield* uuid,
    resourceType: 'commerce.customer-context.customer-group',
    tenantId,
  };
  const source = (entityKind: string, sourceRecordId: string) => ({
    entityKind,
    issuerId: sourceIdentity.issuer,
    sourceNamespace: sourceIdentity.namespace,
    sourceRecordId,
  });
  const configuration = yield* Schema.decodeUnknownEffect(SymmyRouteExecutionConfigurationSchema)({
    items: [
      {
        ...enrolled('enrolled-price-group', priceGroupCreateAction, 'pricing.price-group-catalog'),
        itemKey: 'price-group',
        source: source('PRICE_GROUP', priceGroupRecordId),
      },
      {
        ...enrolled('enrolled-assignment', actionKey, commerceModuleId),
        itemKey: 'assignment',
        source: source('CUSTOMER', fixture.recordId),
      },
    ],
    selector: {
      kind: 'CUSTOMER_GROUP',
      source: {
        entityKind: 'CUSTOMER_GROUP',
        issuerId: sourceIdentity.issuer,
        route: { integrationRouteId: sourceRouteId, tenantId },
        sourceNamespace: sourceIdentity.namespace,
        sourceRecordId: carrierGroupRecordId,
      },
      target: groupRef,
    },
    sourceRouteId,
  });
  const policy = { policyId: 'INTERNAL_C14_ASSIGNMENT_CARRIER_RETENTION', revision: '1' };
  yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,legal_entity_id,principal_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_code,route_revision,lifecycle_policy)
    values(${routeId},${tenantId},${legalEntityId},${integration.principalId},true,array['INTERNAL_C14'],${yield* Schema.encodeEffect(Schema.fromJsonString(SymmyRouteExecutionConfigurationSchema))(configuration)}::jsonb,${internalCustomerSource.mappingVersion},'customerGroupCustomersBatch',${carrierCode},${internalCustomerSource.routeRevision},${yield* json(policy)}::jsonb)`;
  const existing = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.Json)))(
    fixture.environment.ONTOS_SYMMY_JOB_RETENTION_POLICIES,
  );
  const environment = {
    ...fixture.environment,
    ONTOS_SYMMY_JOB_RETENTION_POLICIES: yield* json([
      ...existing,
      {
        ...policy,
        governanceLegalEntityId: legalEntityId,
        retentionMs: 60_000,
        routeId,
        targetLegalEntityId: legalEntityId,
        tenantId,
      },
    ]),
  };
  const symmyRuntime = fixture.ownerRuntimes.get(symmyApp);
  if (symmyRuntime === undefined) {
    return yield* unavailable('The actual Symmy receiver is required');
  }
  yield* symmyRuntime.receiver.child.kill();
  yield* symmyRuntime.receiver.child.exitCode;
  const restarted = yield* startProductOwner({
    artifacts: symmyRuntime.artifacts,
    contract: symmyRuntime.contract,
    environment: { ...environment, ONTOS_GATEWAY_MODULE_API_KEY: symmyRuntime.moduleKey },
    port: symmyRuntime.port,
    prefix: '/symmy-integration-api',
  });
  fixture.ownerRuntimes.set(symmyApp, { ...symmyRuntime, receiver: restarted });
  fixture.ownerDiagnostics.set(symmyApp, restarted.diagnostic);
  const selectedCode = encodeSymmySourceSelector(
    {
      issuerId: sourceIdentity.issuer,
      routeId: sourceRouteId,
      selectorKind: 'CUSTOMER_GROUP',
      sourceNamespace: sourceIdentity.namespace,
      tenantId,
    },
    carrierGroupRecordId,
    groupRef.resourceId,
  );
  const client = yield* HttpClient.HttpClient;
  const submit = (idempotencyKey: string, plan: typeof SymmyInternalExecutionPlanSchema.Type) =>
    Effect.gen(function* submitPlan() {
      const response = yield* client.post(
        `${shell.baseUrl}/api/symmy/v1/customer-groups/${selectedCode}/customers/batch`,
        {
          body: yield* HttpBody.json({
            contractVersion: 'INTERNAL_C14',
            plan: yield* Schema.encodeEffect(SymmyInternalExecutionPlanSchema)(plan),
          }),
          headers: { 'idempotency-key': idempotencyKey, 'x-api-key': Redacted.value(fixture.providerKey.secret) },
        },
      );
      if (response.status !== 202) {
        return yield* unavailable(`The internal plan carrier returned ${response.status}: ${yield* response.text}`);
      }
      return yield* response.json.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({ jobId: SymmyJobStatusResponseSchema.members[0].fields.jobId, status: Schema.String }),
          ),
        ),
      );
    });
  return { environment, submit };
});

it.live(
  'INTERNAL_C14 explicit Retail assignment retains its native command and admits only current minimal recovery after write retirement',
  () =>
    Effect.scoped(
      Effect.gen(function* assignmentConformance() {
        const fixture = yield* makeAssignmentFixture({
          includePriceGroup: true,
          initializeScopes: ({ admin, legalEntityId, principalId, tenantId }) =>
            testCoreDatabase.pipe(
              Effect.provideService(PgClient.PgClient, admin),
              Effect.flatMap((core) =>
                writeTestTenantScopes(core, { legalEntityIds: [legalEntityId], principalId, tenantId }),
              ),
            ),
        });
        const { admin, legalEntityId, systemId, tenantId } = fixture;
        const carrier = yield* enrollInternalPlanCarrier(fixture);
        const priceGroupEffectiveFrom = DateTime.add(yield* DateTime.now, { seconds: 45 });
        const priceGroupJob = yield* carrier.submit(
          'INTERNAL_C14_EXPLICIT_PRICE_GROUP',
          yield* makePriceGroupPlan(fixture, priceGroupEffectiveFrom),
        );
        const groupWorker = yield* startProductWorker(fixture.workerArtifact, {
          ...carrier.environment,
          ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_PRICE_GROUP_WORKER',
          ONTOS_GATEWAY_MODULE_API_KEY: fixture.moduleKey,
        });
        const priceGroupRows = yield* observeAssignmentUntil(
          admin`select effect_id,effect_key,owner_invocation_id,owner_receipt,state from symmy_integration.job_effects
            where job_id=${priceGroupJob.jobId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(carrierEffectSchema))),
          ),
          (rows) => rows.length === 1 && rows.every(({ state }) => state === 'settled'),
        );
        const priceGroup = priceGroupRows.at(0);
        yield* groupWorker.child.kill();
        yield* groupWorker.child.exitCode;
        if (priceGroup === undefined || priceGroup.owner_receipt === null) {
          return yield* unavailable(
            'The native Price Group producer did not commit; no assignment recovery proof can proceed',
          );
        }
        const produced = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            _tag: Schema.Literal('PriceGroupCreated'),
            actionInvocationId: uuidText,
            priceGroupRef: PriceGroupRefSchema,
          }),
        )(priceGroup.owner_receipt);
        expect(Option.getOrUndefined(priceGroup.owner_invocation_id)).toBe(produced.actionInvocationId);
        const [producer] = yield* admin<{ count: number }>`select count(*)::integer as count
          from core.action_invocations where tenant_id=${tenantId} and status='succeeded'
          and action_invocation_id=${produced.actionInvocationId}
          and action_key=${priceGroupCreateAction}`;
        expect(producer?.count).toBe(1);
        const recoveryReaderId = yield* uuid;
        yield* admin`insert into core.principals(principal_id,tenant_id,kind,status,display_name)
          values(${recoveryReaderId},${tenantId},'system','active','INTERNAL_C14 independent assignment recovery actor')`;
        const occurrenceId = yield* uuid;
        const source = { ...fixture.flatSource, occurrenceId };
        const target = {
          kind: 'RETAIL_CUSTOMER_PROFILE' as const,
          resourceId: fixture.profileReceipt.profileRef.resourceId,
        };
        const policy = yield* seedCommittedProfileSourceProcessingNativeFixture({
          connections: fixture.isolated.connections,
          contexts: [
            customerIntakeContext(fixture.integration.principalId, source, target),
            {
              authMethod: 'system',
              principalId: systemId,
              request: {
                consumerModuleId: commerceModuleId,
                operation: 'PRICE_GROUP_ASSIGN',
                source,
                target,
              },
            },
            {
              authMethod: 'system',
              principalId: recoveryReaderId,
              request: {
                consumerModuleId: commerceModuleId,
                operation: 'PRICE_GROUP_ASSIGNMENT_RECEIPT_READ',
                source,
                target,
              },
            },
          ],
          contractEvidenceRef: 'INTERNAL_C14_EXPLICIT_ASSIGNMENT_AND_MINIMAL_RECOVERY',
          controllerRef: 'internal:customer-assignment',
          dataCategoryRefs: ['INTERNAL_C14_CUSTOMER_RECORD'],
          governancePrincipalId: fixture.governancePrincipalId,
          legalEntityId,
          meaning:
            'Separate current policies authorize explicit Retail assignment and exact minimal historical receipt for an independent recovery actor',
          profileReceipt: fixture.proofTransport,
          tenantId,
        }).pipe(
          Effect.tapError(() =>
            Effect.all([
              fixture.shell.gatewayDiagnostics().pipe(Effect.flatMap(Effect.logError)),
              ...[...fixture.ownerDiagnostics].map(([appId, diagnostic]) =>
                diagnostic.pipe(Effect.flatMap((message) => Effect.logError({ appId, message }))),
              ),
            ]),
          ),
        );
        yield* Effect.logInfo(
          'INTERNAL_C14 actual committed Retail receipt admitted independent per-profile assignment and recovery Privacy policies',
        );
        expect(policy.profileReceipt.result.profileRef).toEqual(fixture.profileReceipt.profileRef);
        const evidencePolicy = yield* seedSourceProcessingNativeFixture({
          connections: fixture.isolated.connections,
          contexts: [
            {
              authMethod: 'system',
              principalId: recoveryReaderId,
              request: {
                consumerModuleId: partyModuleId,
                operation: 'EVIDENCE_READ',
                source: fixture.flatSource,
                target: null,
              },
            },
          ],
          contractEvidenceRef: 'INTERNAL_C14_EXPLICIT_CURRENT_RECOVERY_PERSON_EVIDENCE',
          controllerRef: 'internal:customer-assignment',
          dataCategoryRefs: ['INTERNAL_C14_CUSTOMER_RECORD'],
          governancePrincipalId: fixture.governancePrincipalId,
          legalEntityId,
          meaning:
            'The independent current recovery actor may inspect only the exact original source PERSON admission citation',
          tenantId,
        });
        const privacyRuntime = fixture.ownerRuntimes.get('privacy');
        if (privacyRuntime === undefined) {
          return yield* unavailable('The actual Privacy receiver is missing');
        }
        yield* privacyRuntime.receiver.child.kill();
        yield* privacyRuntime.receiver.child.exitCode;
        const privacy = yield* startProductOwner({
          ...privacyRuntime,
          environment: {
            ...carrier.environment,
            ONTOS_GATEWAY_MODULE_API_KEY: privacyRuntime.moduleKey,
            ONTOS_PRIVACY_SOURCE_PROCESSING_CONTEXTS: yield* Schema.encodeEffect(
              Schema.fromJsonString(Schema.Array(SourceProcessingContextSchema)),
            )([...fixture.privacy.contexts, ...policy.contexts, ...evidencePolicy.contexts]),
          },
          prefix: '/privacy-api',
        });
        fixture.ownerDiagnostics.set('privacy', privacy.diagnostic);
        yield* Effect.sleep(
          Duration.max(Duration.zero, DateTime.distance(yield* DateTime.now, priceGroupEffectiveFrom)),
        );
        const effectiveFrom = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 2 }));
        const payload = {
          effectiveFrom,
          expectedProfileRevision: 1,
          priceGroupRef: produced.priceGroupRef,
          profile: { ...fixture.profileReceipt.profileRef, kind: 'RETAIL' as const },
          reason: 'INTERNAL_C14 explicitAssign from the qualified source record',
          source: {
            effectId: 'INTERNAL_C14_ASSIGNED_AT_ADMISSION',
            issuer: source.issuer,
            mappingRevision: internalCustomerSource.mappingVersion,
            namespace: source.namespace,
            occurrenceId,
            order: 2,
            recordId: source.recordId,
            recordType: source.recordType,
            revision: 'INTERNAL_C14_ASSIGNMENT_REVISION_2',
            route: { id: fixture.sourceRouteId, revision: internalCustomerSource.routeRevision },
          },
        };
        const plan = yield* Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
          items: [
            {
              effects: [
                {
                  effectKey: 'explicit-assign',
                  intent: { _tag: 'AssignCustomerPriceGroup', authorizationSubject: { kind: 'RETAIL' }, payload },
                  operation: { entrypointKey: actionKey, moduleId: commerceModuleId, schemaVersion: '1' },
                  originalTarget: fixture.profileReceipt.profileRef,
                },
              ],
              itemKey: 'explicit-assignment',
              source: {
                entityKind: source.recordType,
                issuerId: source.issuer,
                sourceNamespace: source.namespace,
                sourceRecordId: source.recordId,
              },
              sourceOccurrenceId: occurrenceId,
            },
          ],
        });
        const accepted = yield* carrier.submit('INTERNAL_C14_EXPLICIT_ASSIGNMENT', plan);
        const worker = yield* startProductWorker(fixture.workerArtifact, {
          ...carrier.environment,
          ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_ASSIGNMENT_WORKER',
          ONTOS_GATEWAY_MODULE_API_KEY: fixture.moduleKey,
        });
        const assignedEffects = yield* observeAssignmentUntil(
          admin<{ outcome_status: string | null; state: string }>`select state,outcome->>'status' as outcome_status
            from symmy_integration.job_effects where job_id=${accepted.jobId}`,
          (rows) => rows.length === 1 && rows.every(({ state }) => state === 'settled'),
        ).pipe(
          Effect.tapError(() =>
            Effect.all([
              worker.diagnostic.pipe(Effect.flatMap(Effect.logError)),
              fixture.shell.gatewayDiagnostics().pipe(Effect.flatMap(Effect.logError)),
              ...[...fixture.ownerDiagnostics].map(([appId, diagnostic]) =>
                diagnostic.pipe(Effect.flatMap((message) => Effect.logError({ appId, message }))),
              ),
            ]),
          ),
        );
        expect(assignedEffects).toEqual([{ outcome_status: 'accepted_change', state: 'settled' }]);
        const [native] = yield* admin`select a.action_invocation_id as "actionInvocationId",
          a.auth_context_ref as "authContextRef",a.idempotency_key as "idempotencyKey",a.principal_id as "principalId",
          a.request_hash as "requestHash",e.effect_id as "effectId",coalesce(e.resolved_effect,e.effect)#>'{intent,payload}' as payload
          from symmy_integration.job_effects e join core.action_invocations a
          on a.tenant_id=e.tenant_id and a.action_invocation_id=e.owner_invocation_id
          and a.principal_id=e.owner_executor_principal_id and a.request_hash=e.owner_request_hash
          and a.auth_context_ref=e.owner_auth_context_ref
          where e.job_id=${accepted.jobId} and a.action_key=${actionKey} and a.status='succeeded'`;
        const original = yield* Schema.decodeUnknownEffect(nativeSchema)(native);
        expect(original.principalId).toBe(systemId);
        expect(original.idempotencyKey).toBe(original.effectId);
        const identity = yield* assignCustomerPriceGroupRequestIdentity(
          yield* Schema.encodeEffect(AssignCustomerPriceGroupPayloadSchema)(original.payload),
        );
        expect(
          computeActionRequestHash({
            ...identity,
            principal: {
              legalEntityId,
              principalId: original.principalId,
              tenantId,
            },
          }),
        ).toBe(original.requestHash);
        expect(original.payload).toEqual({ ...payload, source: { ...payload.source, effectId: original.effectId } });
        expect(original.payload.source?.effectId).toBe(original.effectId);
        expect(original.payload.source?.recordId).toBe(source.recordId);
        expect(original.payload.priceGroupRef).toEqual(produced.priceGroupRef);
        const runPrefix = `job:${customerWorkerKey}:run:`;
        expect(original.authContextRef.startsWith(runPrefix)).toBe(true);
        const deliveryId = original.authContextRef.slice(runPrefix.length);
        yield* observeAssignmentUntil(
          admin<{ status: string }>`select status from core.outbox_deliveries where outbox_delivery_id=${deliveryId}`,
          (rows) => rows.some(({ status }) => status === 'done'),
        );
        yield* worker.child.kill();
        yield* worker.child.exitCode;
        const [requirement] = yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ key: Schema.String })]))(
          (fixture.symmy.manifest.requirements?.operations ?? []).filter(
            (operation) =>
              operation.entrypointKey === customerWorkerKey && operation.provider.entrypointKey === readKey,
          ),
        );
        const partyRuntime = fixture.ownerRuntimes.get('party-registry');
        if (partyRuntime === undefined) {
          return yield* unavailable('The real Party proof receiver is required for independent recovery');
        }
        yield* partyRuntime.receiver.child.kill();
        yield* partyRuntime.receiver.child.exitCode;
        const recoveryParty = yield* startProductOwner({
          ...partyRuntime,
          environment: {
            ...carrier.environment,
            ONTOS_GATEWAY_MODULE_API_KEY: partyRuntime.moduleKey,
            ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: yield* json(
              [systemId, recoveryReaderId].map((principalId) => ({
                ...fixture.sourceIdentity,
                authMethod: 'system',
                principalId,
                tenantId,
              })),
            ),
          },
          prefix: '/party-registry-api',
        });
        fixture.ownerDiagnostics.set('party-registry', recoveryParty.diagnostic);
        for (const workload of [
          'commerce.customer-context.source-read',
          'privacy.core.source-processing-check',
          'party.registry.source-read',
        ]) {
          yield* admin`insert into core.access_workload_bindings(binding_id,incarnation,tenant_id,principal_id,workload_key,status)
            values(${yield* uuid},${yield* uuid},${tenantId},${recoveryReaderId},${workload},'active')`;
        }
        yield* admin`update core.access_workload_bindings set status='revoked',revoked_at=now()
          where tenant_id=${tenantId} and ((principal_id=${systemId} and workload_key in
            ('commerce.customer-context.source-write','commerce.customer-context.source-read','privacy.core.source-processing-check','party.registry.source-read'))
            or principal_id=${fixture.integration.principalId})`;
        yield* admin`update core.principals set status='disabled',disabled_at=now()
          where tenant_id=${tenantId} and principal_id=${fixture.integration.principalId}`;
        const request = yield* Schema.decodeUnknownEffect(CustomerPriceGroupAssignmentReceiptRequestSchema)({
          actionInvocationId: original.actionInvocationId,
          authorizationSubject: { kind: 'RETAIL' },
          originalCommand: { _tag: 'RETAIL', payload: original.payload },
          profile: original.payload.profile,
        });
        const client = yield* HttpClient.HttpClient;
        const recoveryDiagnostics = Effect.all([
          fixture.shell.gatewayDiagnostics().pipe(Effect.flatMap(Effect.logError)),
          ...[...fixture.ownerDiagnostics].map(([appId, diagnostic]) =>
            diagnostic.pipe(Effect.flatMap((message) => Effect.logError({ appId, message }))),
          ),
        ]);
        const readReceipt = (
          input: typeof CustomerPriceGroupAssignmentReceiptRequestSchema.Type,
          transported = input,
        ) =>
          Effect.gen(function* readNativeAssignmentReceipt() {
            const encoded = yield* Schema.encodeEffect(CustomerPriceGroupAssignmentReceiptRequestSchema)(transported);
            const issued = yield* issueDelegatedGatewayContext(
              {
                audience: commerceApp,
                compositionRevision: fixture.snapshot.composition.revision,
                exchangeId: yield* uuid,
                legalEntityScope: 'subject',
                subject: {
                  _tag: 'RegisteredRecovery',
                  declarationKey: 'commerce.customer-context.customer-price-group-assignment-receipt.read',
                  expectedPrincipalId: recoveryReaderId,
                  operationRequirementKey: requirement.key,
                  originalActionKey: actionKey,
                  originalIdempotencyKey: original.idempotencyKey,
                  originalPrincipalId: original.principalId,
                  originalRequestHash: original.requestHash,
                  requestHash: computeCanonicalValueHash(input),
                  source: {
                    _tag: 'HistoricalDelivery',
                    deliveryId,
                    legalEntityId,
                    tenantId,
                    workerKey: customerWorkerKey,
                  },
                },
              },
              {
                apiKey: Redacted.make(fixture.moduleKey),
                baseUrl: carrier.environment.ONTOS_SHELL_GATEWAY_BASE_URL,
                requestCorrelation: yield* uuid,
              },
            );
            expect(issued.machineContext?.principalId).toBe(recoveryReaderId);
            expect(issued.recovery?.originalActionInvocationId).toBe(original.actionInvocationId);
            const response = yield* client.post(
              `${new URL(issued.apiBaseUrl, fixture.shell.baseUrl)}/reads/customer-price-group-assignment-receipt`,
              {
                body: yield* HttpBody.json(encoded),
                headers: {
                  authorization: `Bearer ${issued.token}`,
                  'x-correlation-id': yield* uuid,
                  'x-ontos-composition-revision': issued.compositionRevision,
                },
              },
            );
            if (response.status >= 500) {
              yield* Effect.logError({ currentReader: issued.machineContext, originalRecovery: issued.recovery });
              yield* admin`select principal_id,workload_key,status from core.access_workload_bindings
                where tenant_id=${tenantId} and principal_id in (${systemId},${recoveryReaderId},${fixture.integration.principalId})
                order by principal_id,workload_key`.pipe(Effect.flatMap(Effect.logError));
              yield* admin`select module_key,state from core.tenant_module_states where tenant_id=${tenantId}`.pipe(
                Effect.flatMap(Effect.logError),
              );
              yield* recoveryDiagnostics;
            }
            return response;
          });
        const response = yield* readReceipt(request);
        if (response.status !== 200) {
          return yield* unavailable(
            `Actual minimal assignment recovery returned ${response.status}: ${yield* response.text}`,
          );
        }
        const result = yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CustomerPriceGroupAssignmentReceiptResponseSchema)),
        );
        const committed = yield* Match.value(result).pipe(
          Match.tag('COMMITTED', (value) => Effect.succeed(value)),
          Match.tag('INDETERMINATE', () =>
            Effect.fail(unavailable('The exact committed native assignment was not recovered')),
          ),
          Match.exhaustive,
        );
        expect(committed.receipt.actionInvocationId).toBe(original.actionInvocationId);
        expect(committed.receipt.priceGroupRef).toEqual(produced.priceGroupRef);
        expect(committed.receipt.profile).toEqual(original.payload.profile);
        expect(committed.receipt.effectiveFrom).toBe(effectiveFrom);
        expect(committed.receipt.changed).toBe(true);
        expect(committed.receipt.intentFingerprint).toMatch(/^[a-f0-9]{64}$/u);
        expect(Object.keys(committed.receipt)).toHaveLength(10);
        expect(Object.keys(committed.receipt)).toEqual(
          expect.arrayContaining([
            'actionInvocationId',
            'assignmentRef',
            'changed',
            'effectiveFrom',
            'effectiveTo',
            'intentFingerprint',
            'priceGroupRef',
            'profile',
            'replacedAssignmentRef',
            'revision',
          ]),
        );
        const changed = yield* Schema.decodeUnknownEffect(CustomerPriceGroupAssignmentReceiptRequestSchema)({
          ...request,
          originalCommand: {
            ...request.originalCommand,
            payload: { ...request.originalCommand.payload, reason: 'Changed intent must not recover' },
          },
        });
        const mismatch = yield* readReceipt(changed);
        expect(mismatch.status).toBe(200);
        const refused = yield* mismatch.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CustomerPriceGroupAssignmentReceiptResponseSchema)),
        );
        yield* Match.value(refused).pipe(
          Match.tag('INDETERMINATE', ({ retryCommand }) => Effect.sync(() => expect(retryCommand).toBe(false))),
          Match.tag('COMMITTED', () => Effect.fail(unavailable('Changed native intent must never recover'))),
          Match.exhaustive,
        );
        const foreignTarget = { ...original.payload.profile, resourceId: yield* uuid };
        const foreign = yield* Schema.decodeUnknownEffect(CustomerPriceGroupAssignmentReceiptRequestSchema)({
          ...request,
          originalCommand: { _tag: 'RETAIL', payload: { ...original.payload, profile: foreignTarget } },
          profile: foreignTarget,
        });
        const foreignResponse = yield* readReceipt(foreign);
        expect(foreignResponse.status).toBe(200);
        const foreignResult = yield* foreignResponse.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CustomerPriceGroupAssignmentReceiptResponseSchema)),
        );
        yield* Match.value(foreignResult).pipe(
          Match.tag('INDETERMINATE', ({ retryCommand }) => Effect.sync(() => expect(retryCommand).toBe(false))),
          Match.tag('COMMITTED', () =>
            Effect.fail(unavailable('A foreign profile must not recover the original assignment')),
          ),
          Match.exhaustive,
        );
        const tamperedScope = yield* Schema.decodeUnknownEffect(CustomerPriceGroupAssignmentReceiptRequestSchema)({
          ...request,
          originalCommand: { _tag: 'RETAIL', payload: original.payload },
          profile: { ...original.payload.profile, tenantId: yield* uuid },
        }).pipe(Effect.option);
        // The public contract itself rejects a cross-Tenant original command before any transport.
        expect(Option.isNone(tamperedScope)).toBe(true);
        const alteredBody = yield* readReceipt(request, changed);
        expect(alteredBody.status).toBe(400);
        yield* alteredBody.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CustomerPriceGroupAssignmentReceiptInvalidProblemSchema)),
        );
        const foreignTenantProfile = { ...original.payload.profile, tenantId: yield* uuid };
        const foreignScope = yield* Schema.decodeUnknownEffect(CustomerPriceGroupAssignmentReceiptRequestSchema)({
          ...request,
          originalCommand: { _tag: 'RETAIL', payload: { ...original.payload, profile: foreignTenantProfile } },
          profile: foreignTenantProfile,
        });
        const alteredScope = yield* readReceipt(request, foreignScope);
        expect(alteredScope.status).toBe(400);
        yield* alteredScope.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CustomerPriceGroupAssignmentReceiptInvalidProblemSchema)),
        );
        const retired = yield* retireSourceProcessingNativePurpose({
          connections: fixture.isolated.connections,
          governancePrincipalId: fixture.governancePrincipalId,
          legalEntityId,
          ownedDatabase: fixture.isolated,
          purpose: 'implementation-1096-registered-workload-gateway',
          purposeRef: yield* Schema.decodeUnknownEffect(ProcessingPurposeRefSchema)(policy.purposeRef),
          tenantId,
        });
        expect(retired.lifecycle).toBe('RETIRED');
        const revokedReceipt = yield* readReceipt(request);
        expect(revokedReceipt.status).toBe(403);
        const [writes] = yield* admin<{ count: number }>`select count(*)::integer as count from core.action_invocations
          where tenant_id=${tenantId} and action_key=${actionKey} and status='succeeded'`;
        expect(writes?.count).toBe(1);
        yield* Effect.logInfo(
          'INTERNAL_C14 explicit assignment recovered under an independent current actor after original ingress and source write retirement',
        );
        return yield* Effect.void;
      }),
    ).pipe(Effect.provide(assignmentFixtureServices)),
  240_000,
);
