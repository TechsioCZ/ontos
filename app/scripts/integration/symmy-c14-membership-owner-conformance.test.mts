import {
  CustomerGroupMembershipSourceReceiptNotFoundProblemSchema,
  CustomerGroupMembershipSourceReceiptRequestSchema,
} from '@app/commerce-customer-context/api/customer-group-membership-source-receipt';
import { executeCustomerGroupMembershipSourceReceiptWithAuthorization } from '@app/commerce-customer-context/api/customer-group-membership-source-receipt/client';
import { seedCustomerGroupMembershipSourceAuthority } from '@app/commerce-customer-context/testing/customer-group-membership-source-authority';
import { seedCustomerGroupSourceAuthority } from '@app/commerce-customer-context/testing/customer-group-source-authority';
import { observeCustomerGroupSourceNativeFixture } from '@app/commerce-customer-context/testing/customer-group-source-observation';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { writeTestTenantScopes } from '@app/core-runtime/testing/tenant-access';
import { SourceProcessingContextSchema } from '@app/privacy/api';
import { ProcessingPurposeRefSchema } from '@app/privacy/resources/processing-purpose';
import { retireSourceProcessingNativePurpose } from '@app/privacy/testing/source-processing-governance-native';
import { seedCommittedProfileSourceProcessingNativeFixture } from '@app/privacy/testing/source-processing-native';
import { GatewayForbiddenProblemSchema } from '@app/shared-contracts';
import { SymmyEffectIdSchema } from '@app/shared-contracts/symmy';
import { SymmyJobStatusResponseSchema } from '@app/symmy-integration/api/symmy-job-status';
import { encodeSymmySourceSelector } from '@app/symmy-integration/symmy-source-selector';
import {
  SymmyInternalExecutionPlanSchema,
  SymmyRouteExecutionConfigurationSchema,
} from '@app/symmy-integration/symmy-internal-contracts';
import { assert, expect, it } from 'effect-rstest';
import { PgClient } from '@effect/sql-pg';
import { DateTime, Effect, Option, Redacted, Schema } from 'effect';
import { HttpBody, HttpClient } from 'effect/http';

import {
  customerFixtureServices,
  makeSymmyC14CustomerFixture,
  observeCustomerFixtureUntil,
} from './support/symmy-c14-customer-assignment-fixture.mts';
import { customerFixtureUuid as uuid } from './support/symmy-c14-customer-native-authority.mts';
import { customerWorkerKey } from './support/symmy-c14-customer-rules.mts';
import { makeInternalMembershipPlan } from './support/symmy-c14-membership-plan.mts';
import { prepareManualMembershipNativeFixture } from './support/symmy-c14-membership-manual.mts';
import {
  issueMembershipFixtureRecovery,
  MembershipNativeInvocationSchema,
} from './support/symmy-c14-membership-recovery.mts';
import {
  membershipActionKey,
  membershipReceiptKey,
  membershipWorkerRules,
} from './support/symmy-c14-membership-rules.mts';
import {
  startProductOwner,
  startProductWorker,
  SymmyC14ProductFixtureUnavailable,
} from './support/symmy-c14-product-runtime.mts';
import { internalSyncSource, makeInternalGroupCreatePlan } from './support/symmy-c14-sync-plans.mts';

const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const planJson = Schema.encodeEffect(Schema.fromJsonString(SymmyRouteExecutionConfigurationSchema));
const receiptSchema = Schema.Struct({
  jobId: SymmyJobStatusResponseSchema.members[0].fields.jobId,
  status: Schema.Literal('admitted'),
});
const uuidText = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('MembershipNativeReference'),
  Schema.decodeTo(Schema.String),
);
const effectSchema = Schema.Struct({
  effectId: Schema.toEncoded(SymmyEffectIdSchema),
  invocationId: Schema.OptionFromNullOr(uuidText),
  state: Schema.String,
});
const unavailable = (message: string) => new SymmyC14ProductFixtureUnavailable({ message });
type CustomerFixture = Effect.Success<ReturnType<typeof makeSymmyC14CustomerFixture>>;

const restartOwner = Effect.fn('SymmyC14Membership.restartOwner')(function* restartOwner(
  fixture: CustomerFixture,
  appId: 'privacy' | 'symmy-integration',
  environment: Readonly<Record<string, string>>,
) {
  const runtime = fixture.ownerRuntimes.get(appId);
  if (runtime === undefined) {
    return yield* unavailable('The actual owner receiver is missing');
  }
  yield* runtime.receiver.child.kill();
  yield* runtime.receiver.child.exitCode;
  const receiver = yield* startProductOwner({
    artifacts: runtime.artifacts,
    contract: runtime.contract,
    environment: { ...environment, ONTOS_GATEWAY_MODULE_API_KEY: runtime.moduleKey },
    port: runtime.port,
    prefix: appId === 'privacy' ? '/privacy-api' : '/symmy-integration-api',
  });
  fixture.ownerRuntimes.set(appId, { ...runtime, receiver });
  fixture.ownerDiagnostics.set(appId, receiver.diagnostic);
  return yield* Effect.void;
});

it.live(
  'INTERNAL_C14 selected Group Membership route assigns the actual Retail profile and recovers its original native receipt',
  () =>
    Effect.scoped(
      Effect.gen(function* membershipConformance() {
        const fixture = yield* makeSymmyC14CustomerFixture({
          initializeScopes: ({ admin, legalEntityId, principalId, tenantId }) =>
            testCoreDatabase.pipe(
              Effect.provideService(PgClient.PgClient, admin),
              Effect.flatMap((core) =>
                writeTestTenantScopes(core, { legalEntityIds: [legalEntityId], principalId, tenantId }),
              ),
            ),
          workerRules: membershipWorkerRules,
        });
        const { admin, integration, isolated, legalEntityId, shell, systemId, tenantId } = fixture;
        const sourceRouteId = yield* uuid;
        const groupRouteId = yield* uuid;
        const memberRouteId = yield* uuid;
        const groupRecordId = 'INTERNAL_C14_GROUP/source key:Žluťoučký';
        const selectedRouteCode = 'INTERNAL_C14_SELECTED_GROUP_ROUTE';
        const groupSource = {
          definitionEvidence: { kind: 'SOURCE_RECORD' as const, reference: groupRecordId, revision: '1' },
          effectId: yield* uuid,
          issuer: internalSyncSource.issuerId,
          mappingRevision: internalSyncSource.mappingVersion,
          namespace: internalSyncSource.namespace,
          order: 1,
          recordId: groupRecordId,
          revision: '1',
          route: { id: sourceRouteId, revision: internalSyncSource.routeRevision },
          sourceCode: 'INTERNAL_C14_DIFFERENT_SOURCE_CODE',
        };
        yield* seedCustomerGroupSourceAuthority({
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          fixture: isolated,
          operatorPrincipalId: integration.issuerPrincipalId,
          operatorProviderUserId: shell.providerUserId,
          route: {
            active: true,
            issuer: groupSource.issuer,
            legalEntityId,
            mappingRevision: groupSource.mappingRevision,
            namespace: groupSource.namespace,
            principalId: systemId,
            routeId: sourceRouteId,
            routeRevision: groupSource.route.revision,
            tenantId,
          },
        });
        yield* seedCustomerGroupMembershipSourceAuthority({
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          fixture: isolated,
          operatorPrincipalId: integration.issuerPrincipalId,
          operatorProviderUserId: shell.providerUserId,
          route: {
            active: true,
            allowComplete: false,
            completenessContract: null,
            issuer: groupSource.issuer,
            legalEntityId,
            principalId: systemId,
            routeId: sourceRouteId,
            routeRevision: groupSource.route.revision,
            sourceNamespace: groupSource.namespace,
            tenantId,
          },
        });
        const groupPlan = yield* makeInternalGroupCreatePlan(
          { occurrenceId: yield* uuid, recordId: groupRecordId },
          {
            businessCode: 'INTERNAL_C14_MEMBERSHIP_GROUP',
            description: 'Explicit internal native Membership classification',
            initialState: 'ACTIVE',
            meaningKey: 'internal-c14.membership-classification',
            membershipCriteria: 'Explicitly named internal native customer profiles',
            name: 'Internal native Membership Group',
            purpose: 'Internal selected source classification',
            reason: 'INTERNAL_C14 explicit source Group producer',
            source: groupSource,
          },
        );
        const groupConfiguration = yield* Schema.decodeUnknownEffect(SymmyRouteExecutionConfigurationSchema)({
          ...Schema.encodeSync(SymmyInternalExecutionPlanSchema)(groupPlan),
          sourceRouteId,
        });
        const groupPolicy = { policyId: 'INTERNAL_C14_MEMBERSHIP_GROUP_RETENTION', revision: '1' };
        const memberPolicy = { policyId: 'INTERNAL_C14_MEMBERSHIP_ASSIGN_RETENTION', revision: '1' };
        yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,legal_entity_id,principal_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_revision,lifecycle_policy)
    values(${groupRouteId},${tenantId},${legalEntityId},${integration.principalId},true,array['INTERNAL_C14'],${yield* planJson(groupConfiguration)}::jsonb,${internalSyncSource.mappingVersion},'customerGroupsBatch',${internalSyncSource.routeRevision},${yield* json(groupPolicy)}::jsonb)`;
        const existingPolicies = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.Json)))(
          fixture.environment.ONTOS_SYMMY_JOB_RETENTION_POLICIES,
        );
        const environment = {
          ...fixture.environment,
          ONTOS_SYMMY_JOB_RETENTION_POLICIES: yield* json([
            ...existingPolicies,
            ...[
              { ...groupPolicy, routeId: groupRouteId },
              { ...memberPolicy, routeId: memberRouteId },
            ].map((policy) => ({
              ...policy,
              governanceLegalEntityId: legalEntityId,
              retentionMs: 60_000,
              targetLegalEntityId: legalEntityId,
              tenantId,
            })),
          ]),
        };
        yield* restartOwner(fixture, 'symmy-integration', environment);
        const client = yield* HttpClient.HttpClient;
        const headers = { 'x-api-key': Redacted.value(fixture.providerKey.secret) };
        const groupResponse = yield* client.post(`${shell.baseUrl}/api/symmy/v1/customer-groups/batch`, {
          body: yield* HttpBody.json({
            contractVersion: 'INTERNAL_C14',
            plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(groupPlan),
          }),
          headers: { ...headers, 'idempotency-key': 'INTERNAL_C14_MEMBERSHIP_GROUP_CREATE' },
        });
        if (groupResponse.status !== 200) {
          return yield* unavailable(
            `Actual native Group producer returned ${groupResponse.status}: ${yield* groupResponse.text}`,
          );
        }
        const groupResult = yield* groupResponse.json;
        expect(groupResult).toMatchObject({
          items: [{ effects: [{ status: 'accepted_change' }], outcome: 'accepted' }],
        });
        const observationInput = {
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          legalEntityId,
          operatorPrincipalId: integration.issuerPrincipalId,
          operatorProviderUserId: shell.providerUserId,
          ownedDatabase: isolated,
          source: {
            issuer: groupSource.issuer,
            mappingRevision: groupSource.mappingRevision,
            namespace: groupSource.namespace,
            recordId: groupRecordId,
            route: groupSource.route,
          },
          tenantId,
        };
        const group = yield* observeCustomerGroupSourceNativeFixture(observationInput);
        if (Option.isNone(group)) {
          return yield* unavailable('The actual Group producer has no exact native source binding');
        }
        expect(group.value).toMatchObject({ revision: 1, state: 'ACTIVE' });
        for (const source of [
          { ...observationInput.source, namespace: 'INTERNAL_C14_DIFFERENT_NAMESPACE' },
          { ...observationInput.source, recordId: 'INTERNAL_C14_ABSENT_GROUP' },
          { ...observationInput.source, mappingRevision: 'INTERNAL_C14_WRONG_MAPPING' },
          { ...observationInput.source, route: { ...groupSource.route, revision: 'INTERNAL_C14_WRONG_REVISION' } },
        ]) {
          expect(Option.isNone(yield* observeCustomerGroupSourceNativeFixture({ ...observationInput, source }))).toBe(
            true,
          );
        }
        for (const invalid of [
          { ...observationInput, ownedDatabase: { ...isolated } },
          { ...observationInput, operatorPrincipalId: systemId },
        ]) {
          expect(yield* observeCustomerGroupSourceNativeFixture(invalid).pipe(Effect.isFailure)).toBe(true);
        }
        const occurrenceId = yield* uuid;
        const removalOccurrenceId = yield* uuid;
        const manual = yield* prepareManualMembershipNativeFixture(fixture);
        expect(manual.membership.management).toEqual({ kind: 'MANUAL' });
        const memberRecordId = 'INTERNAL_C14_EXPLICIT_MEMBER';
        const source = {
          issuer: groupSource.issuer,
          namespace: groupSource.namespace,
          occurrenceId,
          recordId: memberRecordId,
          recordType: 'CUSTOMER_GROUP_MEMBERSHIP',
          routeRef: sourceRouteId,
        };
        const dataPrivacy = yield* seedCommittedProfileSourceProcessingNativeFixture({
          connections: isolated.connections,
          contexts: [source, { ...source, occurrenceId: removalOccurrenceId }].flatMap((exactSource) =>
            (['customer-group-membership.write', 'customer-group-membership.recover'] as const).map((operation) => ({
              authMethod: 'system' as const,
              principalId: systemId,
              request: {
                consumerModuleId: 'commerce.customer-context' as const,
                operation,
                source: exactSource,
                target: {
                  kind: 'RETAIL_CUSTOMER_PROFILE' as const,
                  resourceId: fixture.profileReceipt.profileRef.resourceId,
                },
              },
            })),
          ),
          contractEvidenceRef: 'INTERNAL_C14_EXPLICIT_MEMBERSHIP_DATA_CONTRACT',
          controllerRef: 'internal:membership-conformance',
          dataCategoryRefs: ['INTERNAL_C14_CUSTOMER_RECORD'],
          governancePrincipalId: fixture.governancePrincipalId,
          legalEntityId,
          meaning: 'Independent current internal DATA authority for this exact explicit Membership and receipt only',
          profileReceipt: fixture.proofTransport,
          tenantId,
        });
        expect(dataPrivacy.personAdmission.partyRef).toEqual(fixture.partyReceipt.partyRef);
        expect(dataPrivacy.profileReceipt.result.profileRef).toEqual(fixture.profileReceipt.profileRef);
        yield* restartOwner(fixture, 'privacy', {
          ...environment,
          ONTOS_PRIVACY_SOURCE_PROCESSING_CONTEXTS: yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Array(SourceProcessingContextSchema)),
          )([...fixture.privacy.contexts, ...dataPrivacy.contexts]),
        });
        const memberPlan = yield* makeInternalMembershipPlan({
          effectiveAt: DateTime.formatIso(yield* DateTime.now),
          groupRef: group.value.groupRef,
          manager: {
            factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
            issuer: groupSource.issuer,
            sourceNamespace: groupSource.namespace,
            tenantId,
          },
          operation: 'ASSIGN',
          profile: { profileKind: 'RETAIL', profileRef: fixture.profileReceipt.profileRef },
          reason: 'INTERNAL_C14 explicit named customer assignment',
          route: groupSource.route,
          source: {
            assertionId: occurrenceId,
            effectId: 'INTERNAL_C14_ASSIGNED_AT_ADMISSION',
            order: 1,
            sourceRecordId: memberRecordId,
          },
        });
        const selector = {
          kind: 'CUSTOMER_GROUP' as const,
          source: {
            entityKind: 'CUSTOMER_GROUP',
            issuerId: groupSource.issuer,
            route: { integrationRouteId: sourceRouteId, tenantId },
            sourceNamespace: groupSource.namespace,
            sourceRecordId: groupRecordId,
          },
          target: group.value.groupRef,
        };
        const memberConfiguration = yield* Schema.decodeUnknownEffect(SymmyRouteExecutionConfigurationSchema)({
          ...Schema.encodeSync(SymmyInternalExecutionPlanSchema)(memberPlan),
          selector,
          sourceRouteId,
        });
        yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,legal_entity_id,principal_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_code,route_revision,lifecycle_policy)
    values(${memberRouteId},${tenantId},${legalEntityId},${integration.principalId},true,array['INTERNAL_C14'],${yield* planJson(memberConfiguration)}::jsonb,${internalSyncSource.mappingVersion},'customerGroupCustomersBatch',${selectedRouteCode},${internalSyncSource.routeRevision},${yield* json(memberPolicy)}::jsonb)`;
        const selectorScope = {
          issuerId: groupSource.issuer,
          routeId: sourceRouteId,
          selectorKind: 'CUSTOMER_GROUP' as const,
          sourceNamespace: groupSource.namespace,
          tenantId,
        };
        const selectedCode = encodeSymmySourceSelector(selectorScope, groupRecordId, group.value.groupRef.resourceId);
        const submit = (code = selectedCode, idempotencyKey = 'INTERNAL_C14_SELECTED_MEMBERSHIP', plan = memberPlan) =>
          client.post(`${shell.baseUrl}/api/symmy/v1/customer-groups/${code}/customers/batch`, {
            body: HttpBody.jsonUnsafe({
              contractVersion: 'INTERNAL_C14',
              plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(plan),
            }),
            headers: { ...headers, 'idempotency-key': idempotencyKey },
          });
        for (const wrongScope of [
          { ...selectorScope, issuerId: 'INTERNAL_C14_FOREIGN_ISSUER' },
          { ...selectorScope, sourceNamespace: 'INTERNAL_C14_FOREIGN_NAMESPACE' },
          { ...selectorScope, routeId: yield* uuid },
        ]) {
          const rejected = yield* submit(
            encodeSymmySourceSelector(wrongScope, groupRecordId, group.value.groupRef.resourceId),
          );
          if (rejected.status !== 403) {
            const symmyDiagnostic = fixture.ownerDiagnostics.get('symmy-integration');
            return yield* unavailable(
              `Qualified Membership refusal returned ${rejected.status}: ${yield* rejected.text}; gateway ${JSON.stringify(yield* shell.gatewayDiagnostics())}; Symmy ${symmyDiagnostic === undefined ? 'diagnostic unavailable' : yield* symmyDiagnostic}`,
            );
          }
        }
        const response = yield* submit();
        if (response.status !== 202) {
          return yield* unavailable(
            `Actual Membership route admission returned ${response.status}: ${yield* response.text}`,
          );
        }
        const admitted = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(receiptSchema)));
        const replay = yield* submit();
        expect(replay.status).toBe(202);
        expect(yield* replay.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(receiptSchema)))).toEqual(admitted);
        const effects =
          admin`select effect_id as "effectId",owner_invocation_id as "invocationId",state from symmy_integration.job_effects where tenant_id=${tenantId} and job_id=${admitted.jobId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(effectSchema))),
          );
        const beforeWorker = yield* effects;
        expect(beforeWorker).toHaveLength(1);
        expect(beforeWorker.every(({ invocationId }) => Option.isNone(invocationId))).toBe(true);
        const worker = yield* startProductWorker(fixture.workerArtifact, {
          ...environment,
          ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_SELECTED_MEMBERSHIP',
          ONTOS_GATEWAY_MODULE_API_KEY: fixture.moduleKey,
        });
        const settled = yield* observeCustomerFixtureUntil(
          effects,
          (rows) => rows.length === 1 && rows.every(({ state }) => state === 'settled'),
        ).pipe(
          Effect.tapError(() =>
            Effect.all([
              worker.diagnostic.pipe(Effect.flatMap(Effect.logError)),
              shell.gatewayDiagnostics().pipe(Effect.flatMap(Effect.logError)),
              ...[...fixture.ownerDiagnostics.values()].map((diagnostic) =>
                diagnostic.pipe(Effect.flatMap(Effect.logError)),
              ),
            ]),
          ),
        );
        const [effect] = settled;
        assert.isDefined(effect);
        assert.isTrue(Option.isSome(effect.invocationId));
        const nativeRows =
          yield* admin`select a.action_invocation_id as "actionInvocationId",a.action_key as "actionKey",a.auth_context_ref as "authContextRef",a.idempotency_key as "idempotencyKey",a.principal_id as "principalId",a.request_hash as "requestHash"
    from core.action_invocations a join symmy_integration.job_effects e on e.tenant_id=a.tenant_id and e.owner_invocation_id=a.action_invocation_id
    and e.owner_executor_principal_id=a.principal_id and e.owner_auth_context_ref=a.auth_context_ref and e.owner_request_hash=a.request_hash and e.effect_id::text=a.idempotency_key
    where a.tenant_id=${tenantId} and a.legal_entity_id=${legalEntityId} and e.effect_id=${effect.effectId} and a.status='succeeded'`;
        expect(nativeRows).toHaveLength(1);
        const native = yield* Schema.decodeUnknownEffect(MembershipNativeInvocationSchema)(nativeRows.at(0));
        expect(native.actionInvocationId).toBe(Option.getOrUndefined(effect.invocationId));
        expect(native.idempotencyKey).toBe(effect.effectId);
        expect(native.principalId).toBe(systemId);
        const prefix = `job:${customerWorkerKey}:run:`;
        if (!native.authContextRef.startsWith(prefix)) {
          return yield* unavailable('Actual Membership write has no original native worker delivery');
        }
        const deliveryId = yield* Schema.decodeUnknownEffect(uuidText)(native.authContextRef.slice(prefix.length));
        yield* observeCustomerFixtureUntil(
          admin<{ status: string }>`select status from core.outbox_deliveries where outbox_delivery_id=${deliveryId}`,
          (rows) => rows.some(({ status }) => status === 'done'),
        );
        yield* worker.child.kill();
        yield* worker.child.exitCode;
        const [requirement] = yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ key: Schema.String })]))(
          (fixture.symmy.manifest.requirements?.operations ?? []).filter(
            (operation) =>
              operation.entrypointKey === customerWorkerKey &&
              operation.provider.entrypointKey === membershipReceiptKey,
          ),
        );
        const request = yield* Schema.decodeUnknownEffect(CustomerGroupMembershipSourceReceiptRequestSchema)({
          effectId: effect.effectId,
          manager: {
            factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
            issuer: groupSource.issuer,
            sourceNamespace: groupSource.namespace,
            tenantId,
          },
          profile: { profileKind: 'RETAIL', profileRef: fixture.profileReceipt.profileRef },
          route: groupSource.route,
        });
        const readReceipt = Effect.gen(function* readOriginalMembership() {
          const transport = yield* issueMembershipFixtureRecovery({
            compositionRevision: fixture.snapshot.composition.revision,
            deliveryId,
            expectedReadPrincipalId: systemId,
            legalEntityId,
            moduleApiKey: Redacted.make(fixture.moduleKey),
            nativeAction: native,
            operationRequirementKey: requirement.key,
            request,
            shellGatewayBaseUrl: environment.ONTOS_SHELL_GATEWAY_BASE_URL,
            tenantId,
          });
          return yield* executeCustomerGroupMembershipSourceReceiptWithAuthorization(
            transport.request,
            Redacted.value(transport.authorization),
            transport.requestCorrelation,
            { baseUrl: transport.baseUrl, compositionRevision: transport.compositionRevision },
          );
        });
        const receipt = yield* readReceipt;
        expect(receipt).toMatchObject({
          items: [
            {
              membership: {
                groupRef: group.value.groupRef,
                management: {
                  kind: 'EXTERNAL_SOURCE',
                  manager: {
                    factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
                    issuer: groupSource.issuer,
                    sourceNamespace: groupSource.namespace,
                    tenantId,
                  },
                },
                profile: { profileKind: 'RETAIL', profileRef: fixture.profileReceipt.profileRef },
              },
              outcome: 'ASSIGNED',
            },
          ],
          source: { assertionId: occurrenceId, effectId: effect.effectId },
        });
        expect(yield* readReceipt).toEqual(receipt);
        const currentMemberships = yield* manual.read;
        expect(currentMemberships.memberships).toHaveLength(2);
        const preservedManual = currentMemberships.memberships.find(
          (membership) => membership.membershipRef.resourceId === manual.membership.membershipRef.resourceId,
        );
        expect(preservedManual).toMatchObject({
          management: { kind: 'MANUAL' },
          revision: manual.membership.revision,
          state: manual.membership.state,
        });
        const assigned = receipt.items.find((item) => item.outcome === 'ASSIGNED' && 'membership' in item);
        assert(assigned !== undefined && 'membership' in assigned);
        const removalPlan = yield* makeInternalMembershipPlan({
          effectiveAt: DateTime.formatIso(yield* DateTime.now),
          expectedRevision: assigned.membership.revision,
          groupRef: group.value.groupRef,
          manager: {
            factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
            issuer: groupSource.issuer,
            sourceNamespace: groupSource.namespace,
            tenantId,
          },
          membershipRef: assigned.membership.membershipRef,
          operation: 'REMOVE',
          profile: { profileKind: 'RETAIL', profileRef: fixture.profileReceipt.profileRef },
          reason: 'INTERNAL_C14 explicit removal on the assignment-only route',
          route: groupSource.route,
          source: {
            assertionId: removalOccurrenceId,
            effectId: 'INTERNAL_C14_REMOVE_AT_ADMISSION',
            order: 2,
            sourceRecordId: memberRecordId,
          },
        });
        const membershipInvocations = admin`select action_invocation_id from core.action_invocations where tenant_id=${tenantId} and action_key=${membershipActionKey} order by action_invocation_id`;
        const admittedJobs = admin`select job_id from symmy_integration.import_jobs where tenant_id=${tenantId} and route_id=${memberRouteId} order by job_id`;
        const beforeRemoval = yield* membershipInvocations;
        const jobsBeforeRemoval = yield* admittedJobs;
        const rejectedRemoval = yield* submit(selectedCode, 'INTERNAL_C14_SELECTED_MEMBERSHIP_REMOVE', removalPlan);
        expect(rejectedRemoval.status).toBe(403);
        expect(
          yield* rejectedRemoval.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(GatewayForbiddenProblemSchema))),
        ).toMatchObject({
          status: 403,
        });
        expect(yield* membershipInvocations).toEqual(beforeRemoval);
        expect(yield* admittedJobs).toEqual(jobsBeforeRemoval);
        expect((yield* manual.read).memberships).toEqual(currentMemberships.memberships);
        const retired = yield* retireSourceProcessingNativePurpose({
          connections: isolated.connections,
          governancePrincipalId: fixture.governancePrincipalId,
          legalEntityId,
          ownedDatabase: isolated,
          purpose: 'implementation-1096-registered-workload-gateway',
          purposeRef: yield* Schema.decodeUnknownEffect(ProcessingPurposeRefSchema)(dataPrivacy.purposeRef),
          tenantId,
        });
        expect(retired.lifecycle).toBe('RETIRED');
        const deniedReceipt = yield* readReceipt.pipe(Effect.flip);
        expect(Schema.is(CustomerGroupMembershipSourceReceiptNotFoundProblemSchema)(deniedReceipt)).toBe(true);
        const deniedResponse = yield* submit(selectedCode, 'INTERNAL_C14_MEMBERSHIP_CURRENT_PRIVACY_DENIED');
        expect(deniedResponse.status).toBe(202);
        const deniedJob = yield* deniedResponse.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(receiptSchema)));
        const deniedWorker = yield* startProductWorker(fixture.workerArtifact, {
          ...environment,
          ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_MEMBERSHIP_CURRENT_PRIVACY_DENIED',
          ONTOS_GATEWAY_MODULE_API_KEY: fixture.moduleKey,
        });
        const deniedEffects = yield* observeCustomerFixtureUntil(
          admin<{
            state: string;
            status: string;
          }>`select state,outcome->>'status' as status from symmy_integration.job_effects where tenant_id=${tenantId} and job_id=${deniedJob.jobId}`,
          (rows) => rows.length === 1 && rows.every(({ state }) => state === 'settled'),
        );
        expect(deniedEffects).toEqual([{ state: 'settled', status: 'denied' }]);
        yield* deniedWorker.child.kill();
        yield* deniedWorker.child.exitCode;
        expect((yield* manual.read).memberships).toEqual(currentMemberships.memberships);
        const [implicit] = yield* admin<{
          count: number;
        }>`select count(*)::integer as count from core.action_invocations where tenant_id=${tenantId} and (action_key like 'commerce.pricing.%' or action_key like 'commerce.assortment.%' or action_key like '%promotion%' or action_key in ('commerce.customer-context.assign-customer-price-group','commerce.customer-context.assign-counterparty-price-group'))`;
        expect(implicit?.count).toBe(0);
        const [writes] = yield* admin<{
          count: number;
        }>`select count(*)::integer as count from core.action_invocations where tenant_id=${tenantId} and action_key=${membershipActionKey} and status='succeeded'`;
        expect(writes?.count).toBe(1);
        yield* Effect.logInfo(
          'INTERNAL_C14 selected Membership route settled one actual native ASSIGN with exact original receipt',
        );
        return yield* Effect.void;
      }),
    ).pipe(Effect.provide(customerFixtureServices)),
  240_000,
);
