import { ApplyCustomerGroupMembershipSourcePayloadSchema } from '@app/commerce-customer-context/api/apply-customer-group-membership-source-action';
import {
  CustomerGroupMembershipSourceReceiptNotFoundProblemSchema,
  CustomerGroupMembershipSourceReceiptRequestSchema,
} from '@app/commerce-customer-context/api/customer-group-membership-source-receipt';
import { executeCustomerGroupMembershipSourceReceiptWithAuthorization } from '@app/commerce-customer-context/api/customer-group-membership-source-receipt/client';
import { enrollCustomerProfileSourceReaderNativeFixture } from '@app/commerce-customer-context/testing/customer-profile-source-reader';
import { seedCustomerGroupMembershipSourceAuthority } from '@app/commerce-customer-context/testing/customer-group-membership-source-authority';
import { seedCustomerGroupSourceAuthority } from '@app/commerce-customer-context/testing/customer-group-source-authority';
import { observeCustomerGroupSourceNativeFixture } from '@app/commerce-customer-context/testing/customer-group-source-observation';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { writeTestTenantScopes } from '@app/core-runtime/testing/tenant-access';
import { ProcessingPurposeRefSchema } from '@app/privacy/resources/processing-purpose';
import { retireSourceProcessingNativePurpose } from '@app/privacy/testing/source-processing-governance-native';
import { seedSourceProcessingNativeFixture } from '@app/privacy/testing/source-processing-native';
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
import { groupMembershipOccurrenceId, groupMembershipRecordId } from './support/symmy-c14-customer-public.mts';
import { customerWorkerKey, customerIntakeContext } from './support/symmy-c14-customer-rules.mts';
import { nameGroupDefinitionRouteReader } from './support/symmy-c14-group-definition-reader.mts';
import { makeInternalMembershipPlan } from './support/symmy-c14-membership-plan.mts';
import { prepareManualMembershipNativeFixture } from './support/symmy-c14-membership-manual.mts';
import {
  issueMembershipFixtureRecovery,
  MembershipNativeInvocationSchema,
} from './support/symmy-c14-membership-recovery.mts';
import { membershipActionKey, membershipReceiptKey } from './support/symmy-c14-membership-rules.mts';
import {
  startProductOwner,
  startProductWorker,
  SymmyC14ProductFixtureUnavailable,
} from './support/symmy-c14-product-runtime.mts';
import { internalSyncSource } from './support/symmy-c14-sync-plans.mts';

const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const planJson = Schema.encodeEffect(Schema.fromJsonString(SymmyRouteExecutionConfigurationSchema));
const commerceModuleId = 'commerce.customer-context' as const;
const groupOperation = (entrypointKey: string) => ({
  entrypointKey,
  moduleId: commerceModuleId,
  schemaVersion: '1',
});
const receiptSchema = Schema.Struct({
  jobId: SymmyJobStatusResponseSchema.members[0].fields.jobId,
  status: Schema.Literal('queued'),
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
const [membershipAssignmentSchema] = ApplyCustomerGroupMembershipSourcePayloadSchema.members;
const pinnedMembershipSchema = Schema.Struct({
  effectId: Schema.toEncoded(SymmyEffectIdSchema),
  payload: membershipAssignmentSchema,
});
const unavailable = (message: string) => new SymmyC14ProductFixtureUnavailable({ message });
type CustomerFixture = Effect.Success<ReturnType<typeof makeSymmyC14CustomerFixture>>;

const restartSymmy = Effect.fn('SymmyC14Membership.restartSymmy')(function* restartSymmy(
  fixture: CustomerFixture,
  environment: Readonly<Record<string, string>>,
) {
  const appId = 'symmy-integration';
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
    prefix: '/symmy-integration-api',
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
        });
        const { admin, integration, isolated, legalEntityId, shell, systemId, tenantId } = fixture;
        const sourceRouteId = yield* uuid;
        const groupRouteId = yield* uuid;
        const memberRouteId = yield* uuid;
        const groupRecordId = 'INTERNAL_C14_GROUP/source key:Žluťoučký';
        const selectedRouteCode = 'INTERNAL_C14_SELECTED_GROUP_ROUTE';
        const groupSource = {
          issuer: internalSyncSource.issuerId,
          mappingRevision: internalSyncSource.mappingVersion,
          namespace: internalSyncSource.namespace,
          route: { id: sourceRouteId, revision: internalSyncSource.routeRevision },
        };
        // The memberships are managed by the source that sent the customers, so its customer ids name them.
        // A namespace reserved for ERP memberships: the Symmy ledger alone issues the orders of this source.
        const membershipSource = {
          issuer: fixture.sourceIdentity.issuer,
          namespace: 'erp-membership-v1:internal-membership-authority',
        };
        const manager = {
          factFamily: 'CUSTOMER_GROUP_MEMBERSHIP' as const,
          issuer: membershipSource.issuer,
          sourceNamespace: membershipSource.namespace,
          tenantId,
        };
        const groupDefinitionRoute = {
          active: true,
          issuer: groupSource.issuer,
          legalEntityId,
          mappingRevision: groupSource.mappingRevision,
          namespace: groupSource.namespace,
          principalId: systemId,
          routeId: sourceRouteId,
          routeRevision: groupSource.route.revision,
          tenantId,
        };
        yield* seedCustomerGroupSourceAuthority({
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          fixture: isolated,
          operatorPrincipalId: integration.issuerPrincipalId,
          operatorProviderUserId: shell.providerUserId,
          route: groupDefinitionRoute,
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
            issuer: membershipSource.issuer,
            legalEntityId,
            principalId: systemId,
            routeId: sourceRouteId,
            routeRevision: groupSource.route.revision,
            sourceNamespace: membershipSource.namespace,
            tenantId,
          },
        });
        // The group route enrolls the create and the definition read that fences each public group on the owner.
        const groupConfiguration = yield* Schema.decodeUnknownEffect(SymmyRouteExecutionConfigurationSchema)({
          items: [
            {
              effects: [
                {
                  effectKey: 'customer-group-create',
                  operation: groupOperation('commerce.customer-context.create-customer-group'),
                },
                {
                  effectKey: 'customer-group-definition-read',
                  operation: groupOperation('commerce.customer-context.api.customer-group-definition-source'),
                },
              ],
              itemKey: 'customer-group',
              source: {
                entityKind: 'CUSTOMER_GROUP',
                issuerId: groupSource.issuer,
                sourceNamespace: groupSource.namespace,
                sourceRecordId: groupRecordId,
              },
            },
          ],
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
        yield* restartSymmy(fixture, environment);
        // The manual setup binds the human administrator's session, which then names the Group definition route reader:
        // the Shell reads each code's current definition as the API-key integration principal before it admits.
        const manual = yield* prepareManualMembershipNativeFixture(fixture);
        expect(manual.membership.management).toEqual({ kind: 'MANUAL' });
        const commerce = fixture.ownerRuntimes.get('commerce-customer-context');
        assert.isDefined(commerce);
        yield* nameGroupDefinitionRouteReader({
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          administratorPrincipalId: integration.issuerPrincipalId,
          commerceBaseUrl: `http://127.0.0.1:${commerce.port}/commerce-customer-context-api`,
          compositionRevision: fixture.snapshot.composition.revision,
          readerPrincipalId: integration.principalId,
          route: groupDefinitionRoute,
          shell,
        });
        const client = yield* HttpClient.HttpClient;
        const headers = { 'x-api-key': Redacted.value(fixture.providerKey.secret) };
        const groupResponse = yield* client.put(`${shell.baseUrl}/api/symmy/v1/customer-groups/batch`, {
          body: yield* HttpBody.json({
            customerGroups: [
              {
                businessCode: 'INTERNAL_C14_MEMBERSHIP_GROUP',
                code: groupRecordId,
                description: 'Explicit internal native Membership classification',
                meaningKey: 'internal-c14.membership-classification',
                membershipCriteria: 'Explicitly named internal native customer profiles',
                name: 'Internal native Membership Group',
                purpose: 'Internal selected source classification',
              },
            ],
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
          items: [{ code: groupRecordId, effects: [{ status: 'accepted_change' }], outcome: 'accepted' }],
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
        const removalOccurrenceId = yield* uuid;
        /**
         * The occurrence the admission derives for the first customer (plan item `membership-0`) of a request on the
         * member route that selects this group; the pinned plan of the first job checks it before it is relied on.
         */
        const membershipOccurrenceId = (idempotencyKey: string) =>
          groupMembershipOccurrenceId({
            groupId: group.value.groupRef.resourceId,
            idempotencyKey,
            itemKey: 'membership-0',
            routeId: memberRouteId,
          });
        const effectiveAdmissions = admin<{ record_id: string; role: string; subject_id: string }>`select distinct
          a.source_record->>'recordId' as record_id, a.role, a.privacy_subject_id as subject_id
          from privacy.source_processing_admissions a
          where a.tenant_id=${tenantId} and a.legal_entity_id=${legalEntityId}
            and (a.symmy_invocation_id is null or exists (
              select 1 from core.action_invocations i
              join core.source_execution_fences f
                on f.tenant_id=i.tenant_id and f.admission_invocation_id=i.action_invocation_id
              where i.tenant_id=a.tenant_id and i.legal_entity_id=a.legal_entity_id
                and i.principal_id=a.symmy_principal_id and i.action_invocation_id=a.symmy_invocation_id
                and i.status='succeeded' and i.action_key='integration.symmy.admit-symmy-job'
                and i.committed_reply_json->>'kind'='result'
                and i.committed_reply_json->'encoded'->>'sourcePreparationId'=a.symmy_preparation_id::text
            ))
          order by role`;
        const subjectKinds = admin`select subject_kind from privacy.privacy_subjects
          where tenant_id=${tenantId} and legal_entity_id=${legalEntityId}`;
        const initialAdmissions = yield* effectiveAdmissions;
        expect(initialAdmissions).toHaveLength(1);
        const [rootCustomer] = initialAdmissions;
        assert.isDefined(rootCustomer);
        expect(rootCustomer).toMatchObject({ record_id: fixture.recordId, role: 'SUBJECT' });
        expect(Schema.is(Schema.String.check(Schema.isUUID()))(rootCustomer.subject_id)).toBe(true);
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
        // The selected group route enrolls the profile read and membership write; the selector binds the created group.
        const memberConfiguration = yield* Schema.decodeUnknownEffect(SymmyRouteExecutionConfigurationSchema)({
          items: [
            {
              effects: [
                { effectKey: 'customer-group-assignment', operation: groupOperation(membershipActionKey) },
                {
                  effectKey: 'customer-profile-current',
                  operation: groupOperation('commerce.customer-context.api.customer-profile-source'),
                },
              ],
              itemKey: 'customer-group-assignment',
              source: {
                entityKind: 'CUSTOMER_GROUP_MEMBERSHIP',
                issuerId: membershipSource.issuer,
                sourceNamespace: membershipSource.namespace,
                sourceRecordId: groupRecordId,
              },
            },
          ],
          selector,
          sourceRouteId,
        });
        yield* admin`insert into symmy_integration.job_routes(route_id,tenant_id,legal_entity_id,principal_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_code,route_revision,lifecycle_policy)
    values(${memberRouteId},${tenantId},${legalEntityId},${integration.principalId},true,array['ERP_MEMBERSHIP_V1'],${yield* planJson(memberConfiguration)}::jsonb,${internalSyncSource.mappingVersion},'customerGroupCustomersBatch',${selectedRouteCode},${internalSyncSource.routeRevision},${yield* json(memberPolicy)}::jsonb)`;
        const selectorScope = {
          issuerId: groupSource.issuer,
          routeId: sourceRouteId,
          selectorKind: 'CUSTOMER_GROUP' as const,
          sourceNamespace: groupSource.namespace,
          tenantId,
        };
        const selectedCode = encodeSymmySourceSelector(selectorScope, groupRecordId, group.value.groupRef.resourceId);
        // The customer exactly as the source sent it to POST /customers/batch: by its own customer id.
        const customer = { customerId: fixture.recordId };
        const membershipKey = 'INTERNAL_C14_SELECTED_MEMBERSHIP';
        const deniedKey = 'INTERNAL_C14_MEMBERSHIP_CURRENT_PRIVACY_DENIED';
        // The membership source the admission derives for the first customer of this request; the grant names a sample.
        const source = {
          issuer: membershipSource.issuer,
          namespace: membershipSource.namespace,
          occurrenceId: membershipOccurrenceId(membershipKey),
          recordId: groupMembershipRecordId(groupRecordId, fixture.recordId),
          recordType: 'CUSTOMER_GROUP_MEMBERSHIP',
          routeRef: sourceRouteId,
        };
        yield* enrollCustomerProfileSourceReaderNativeFixture({
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          authority: {
            issuer: fixture.sourceIdentity.issuer,
            mappingRevision: fixture.proofTransport.request.mappingRevision,
            namespace: fixture.sourceIdentity.namespace,
            recordType: fixture.sourceIdentity.recordType,
            route: fixture.proofTransport.request.route,
          },
          legalEntityId,
          operatorPrincipalId: integration.issuerPrincipalId,
          operatorProviderUserId: shell.providerUserId,
          ownedDatabase: isolated,
          readerPrincipalId: integration.principalId,
          tenantId,
        });
        const unknownKey = 'INTERNAL_C14_MEMBERSHIP_UNKNOWN_CUSTOMER';
        const unknownId = 'INTERNAL_C14_NEVER_SENT_CUSTOMER';
        // An ERP membership names its customer by the customer id, so the customer route's standing authorization also
        // covers the current customer read: Shell's at admission and Commerce's again inside the membership write.
        // Renewing the route keeps its principals and grants; the read grant names a target kind, not a customer.
        yield* seedSourceProcessingNativeFixture({
          connections: isolated.connections,
          contexts: [customerIntakeContext(integration.principalId, fixture.flatSource, null)],
          contractEvidenceRef: 'INTERNAL_C14_CUSTOMER_READ_CONTRACT',
          controllerRef: 'internal:customer-conformance',
          dataCategoryRefs: ['INTERNAL_C14_CUSTOMER_RECORD'],
          governancePrincipalId: fixture.governancePrincipalId,
          grants: [
            {
              allowTargetless: false,
              consumerModuleId: commerceModuleId,
              operation: 'customer-profile-source.read',
              targetKinds: ['RETAIL_CUSTOMER_PROFILE'],
            },
          ],
          legalEntityId,
          meaning: 'Current customer read for the ERP membership admission and its Commerce write',
          tenantId,
        });
        // The membership route has its own standing policy, as the customer route has the one the customer fixture
        // seeds for the customer read. No membership, person or profile binding is seeded.
        const intakeContext = customerIntakeContext(integration.principalId, source, null);
        const dataPrivacy = yield* seedSourceProcessingNativeFixture({
          connections: isolated.connections,
          contexts: [intakeContext, { ...intakeContext, authMethod: 'system', principalId: systemId }],
          contractEvidenceRef: 'INTERNAL_C14_MEMBERSHIP_ROUTE_CONTRACT',
          controllerRef: 'internal:membership-conformance',
          dataCategoryRefs: ['INTERNAL_C14_CUSTOMER_RECORD'],
          governancePrincipalId: fixture.governancePrincipalId,
          grants: [
            {
              allowTargetless: false,
              consumerModuleId: 'integration.symmy',
              operation: 'CUSTOMER_SOURCE_INTAKE',
              targetKinds: ['RETAIL_CUSTOMER_PROFILE'],
            },
            ...(['customer-group-membership.write', 'customer-group-membership.recover'] as const).map((operation) => ({
              allowTargetless: false,
              consumerModuleId: commerceModuleId,
              operation,
              targetKinds: ['RETAIL_CUSTOMER_PROFILE'] as const,
            })),
          ],
          legalEntityId,
          meaning: 'Standing membership processing for the customer that Commerce proves owns the profile',
          tenantId,
        });
        expect(dataPrivacy.plans).toEqual([]);
        expect(dataPrivacy.subjectRefs).toEqual([]);
        const customersBody = HttpBody.jsonUnsafe({ customers: [customer, { customerId: unknownId }] });
        const submit = (code = selectedCode, idempotencyKey = membershipKey, body: HttpBody.HttpBody = customersBody) =>
          client.post(`${shell.baseUrl}/api/symmy/v1/customer-groups/${code}/customers/batch`, {
            body,
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
        // The route is an ERP membership route: it enrolls that contract alone, for the reserved membership source,
        // and the database refuses it any other contract beside it.
        const mixed =
          yield* admin`update symmy_integration.job_routes set fixture_ids=array['INTERNAL_C14','ERP_MEMBERSHIP_V1'] where tenant_id=${tenantId} and route_id=${memberRouteId}`.pipe(
            Effect.flip,
          );
        expect(mixed).toBeDefined();
        const response = yield* submit();
        if (response.status !== 202) {
          return yield* unavailable(
            `Actual Membership route admission returned ${response.status}: ${yield* response.text}`,
          );
        }
        const admitted = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(receiptSchema)));
        expect(yield* effectiveAdmissions).toEqual([
          { record_id: source.recordId, role: 'CHILD', subject_id: rootCustomer.subject_id },
          rootCustomer,
        ]);
        expect(yield* subjectKinds).toEqual([{ subject_kind: 'SOURCE_ASSERTED' }]);
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
        const pinnedMemberships = (jobId: string) =>
          admin`select effect_id as "effectId",effect #> '{intent,payload}' as payload from symmy_integration.job_effects where tenant_id=${tenantId} and job_id=${jobId}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(pinnedMembershipSchema))),
          );
        // The admission resolved the customer id to the profile the customers job created for that source record and
        // pinned one source ASSIGN of it to the group the route binds, under lineage order 1.
        const pinnedRows = yield* pinnedMemberships(admitted.jobId);
        expect(pinnedRows).toHaveLength(1);
        const [pinned] = pinnedRows;
        assert.isDefined(pinned);
        expect(pinned.payload).toMatchObject({
          // The exact customer record the owner resolved, which Commerce reads again inside the membership write.
          customerSource: {
            issuer: fixture.sourceIdentity.issuer,
            namespace: fixture.sourceIdentity.namespace,
            recordType: fixture.sourceIdentity.recordType,
            route: fixture.proofTransport.request.route,
          },
          groupRef: group.value.groupRef,
          manager,
          operation: 'ASSIGN',
          profile: { profileKind: 'RETAIL', profileRef: fixture.profileReceipt.profileRef },
          route: groupSource.route,
          source: { assertionId: membershipOccurrenceId(membershipKey), effectId: pinned.effectId, order: 1 },
        });
        expect(
          yield* admin`select source_order from symmy_integration.membership_source_orders where tenant_id=${tenantId} and effect_id=${pinned.effectId}`,
        ).toEqual([{ source_order: 1 }]);
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
          manager,
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
                management: { kind: 'EXTERNAL_SOURCE', manager },
                profile: { profileKind: 'RETAIL', profileRef: fixture.profileReceipt.profileRef },
              },
              outcome: 'ASSIGNED',
            },
          ],
          source: {
            assertionId: source.occurrenceId,
            effectId: effect.effectId,
            order: 1,
            sourceRecordId: source.recordId,
          },
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
          manager,
          membershipRef: assigned.membership.membershipRef,
          operation: 'REMOVE',
          profile: { profileKind: 'RETAIL', profileRef: fixture.profileReceipt.profileRef },
          reason: 'INTERNAL_C14 explicit removal on the assignment-only route',
          route: groupSource.route,
          source: {
            assertionId: removalOccurrenceId,
            effectId: 'INTERNAL_C14_REMOVE_AT_ADMISSION',
            order: 2,
            sourceRecordId: source.recordId,
          },
        });
        const membershipInvocations = admin`select action_invocation_id from core.action_invocations where tenant_id=${tenantId} and action_key=${membershipActionKey} order by action_invocation_id`;
        const admittedJobs = admin`select job_id from symmy_integration.import_jobs where tenant_id=${tenantId} and route_id=${memberRouteId} order by job_id`;
        const ledgerOrders = admin`select effect_id from symmy_integration.membership_source_orders where tenant_id=${tenantId} order by source_order`;
        const ordersBeforeRemoval = yield* ledgerOrders;
        const beforeRemoval = yield* membershipInvocations;
        const jobsBeforeRemoval = yield* admittedJobs;
        // The public body has no removal: a customer that asks for one is refused before admission.
        const removalBody = yield* submit(
          selectedCode,
          'INTERNAL_C14_SELECTED_MEMBERSHIP_REMOVE_BODY',
          HttpBody.jsonUnsafe({ customers: [{ ...customer, operation: 'REMOVE' }] }),
        );
        expect(removalBody.status).toBe(400);
        // The route admits the ERP's customers and nothing else: an internal plan, here one that removes the assigned
        // membership, is refused as the caller's request, with no job, no ledger order and no owner call.
        const rejectedRemoval = yield* submit(
          selectedCode,
          'INTERNAL_C14_SELECTED_MEMBERSHIP_REMOVE',
          HttpBody.jsonUnsafe({
            contractVersion: 'INTERNAL_C14',
            plan: Schema.encodeSync(SymmyInternalExecutionPlanSchema)(removalPlan),
          }),
        );
        expect([400, 403]).toContain(rejectedRemoval.status);
        expect(yield* ledgerOrders).toEqual(ordersBeforeRemoval);
        expect(yield* membershipInvocations).toEqual(beforeRemoval);
        expect(yield* admittedJobs).toEqual(jobsBeforeRemoval);
        expect((yield* manual.read).memberships).toEqual(currentMemberships.memberships);
        // A customer the source never sent is refused for its item alone: the job pins no owner effect and no
        // ledger order, and its item answers unsupported for missing context, as the job status shows at once.
        const unknownResponse = yield* submit(
          selectedCode,
          unknownKey,
          HttpBody.jsonUnsafe({ customers: [{ customerId: unknownId }] }),
        );
        expect(unknownResponse.status).toBe(202);
        const unknownJob = yield* unknownResponse.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(receiptSchema)));
        expect(yield* pinnedMemberships(unknownJob.jobId)).toEqual([]);
        expect(yield* ledgerOrders).toEqual(ordersBeforeRemoval);
        const unknownStatus = yield* client.get(`${shell.baseUrl}/api/symmy/v1/jobs/${unknownJob.jobId}`, { headers });
        expect(unknownStatus.status).toBe(200);
        expect(yield* unknownStatus.json).toMatchObject({
          items: [
            {
              effects: [
                {
                  branchKind: 'CustomerHint',
                  owner: groupOperation(membershipActionKey).moduleId,
                  reason: 'missing_context',
                  status: 'unsupported',
                },
              ],
              outcome: 'not_accepted',
            },
          ],
          jobId: unknownJob.jobId,
          status: 'completed_none',
        });
        const deniedResponse = yield* submit(selectedCode, deniedKey);
        expect(deniedResponse.status).toBe(202);
        const deniedJob = yield* deniedResponse.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(receiptSchema)));
        // The new assertion is the one Privacy was seeded for: the same record, the next order of the lineage.
        const deniedPinnedRows = yield* pinnedMemberships(deniedJob.jobId);
        expect(deniedPinnedRows).toHaveLength(1);
        const [deniedPinned] = deniedPinnedRows;
        assert.isDefined(deniedPinned);
        expect(deniedPinned.payload.source).toMatchObject({
          assertionId: membershipOccurrenceId(deniedKey),
          order: 2,
          sourceRecordId: source.recordId,
        });
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
        // Even with the membership assertion authority retired, exact replay returns the original job;
        // a fresh request for the same customer cannot admit a job.
        const jobsBeforeDenial = yield* admittedJobs;
        const replayAfterRetirement = yield* submit();
        expect(replayAfterRetirement.status).toBe(202);
        expect(
          yield* replayAfterRetirement.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(receiptSchema))),
        ).toEqual(admitted);
        const refused = yield* submit(selectedCode, 'INTERNAL_C14_FRESH_AFTER_RETIREMENT');
        expect(refused.status).toBe(403);
        expect(yield* admittedJobs).toEqual(jobsBeforeDenial);
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
