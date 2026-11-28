import { findPostgresFailure } from '@app/core-runtime';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { writeTestTenantScopes } from '@app/core-runtime/testing/tenant-access';
import { PartyContactPointRefSchema } from '@app/party-registry/resources/party-contact-point';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { seedSourceProcessingNativeFixture } from '@app/privacy/testing/source-processing-native';
import { SymmyJobStatusResponseSchema } from '@app/symmy-integration/api/symmy-job-status';
import {
  SymmyInternalExecutionPlanSchema,
  SymmyRouteExecutionConfigurationSchema,
} from '@app/symmy-integration/symmy-internal-contracts';
import { encodeSymmySourceSelector } from '@app/symmy-integration/symmy-source-selector';
import { PgClient } from '@effect/sql-pg';
import { assert, expect, it } from 'effect-rstest';
import { DateTime, Effect, Option, Redacted, Schema } from 'effect';
import { HttpBody, HttpClient } from 'effect/http';

import {
  customerFixtureServices,
  customerIntakeCounts,
  makeSymmyC14CustomerFixture,
  observeCustomerFixtureUntil,
} from './support/symmy-c14-customer-assignment-fixture.mts';
import { customerContexts } from './support/symmy-c14-customer-contexts.mts';
import { customerFixtureUuid as uuid } from './support/symmy-c14-customer-native-authority.mts';
import { internalCustomerSource, symmyC14CustomerPlanData } from './support/symmy-c14-customer-plan.mts';
import { contactRecordId, customersBody } from './support/symmy-c14-customer-public.mts';
import {
  startProductOwner,
  startProductWorker,
  SymmyC14ProductFixtureUnavailable,
} from './support/symmy-c14-product-runtime.mts';

type CustomerFixture = Effect.Success<ReturnType<typeof makeSymmyC14CustomerFixture>>;
type Plan = typeof SymmyInternalExecutionPlanSchema.Type;
type ContactRef = typeof PartyContactPointRefSchema.Type;
const partyModule = 'party.registry';
const contactLifecycleEffectKey = 'contact-lifecycle';
const symmyAppId = 'symmy-integration';
const endContactActionKey = 'party.registry.end-contact-point';
const updateContactActionKey = 'party.registry.update-contact-point';
const carrierCode = 'INTERNAL_C14_CONTACT_LIFECYCLE_CARRIER';
const carrierRecord = 'INTERNAL_C14_CONTACT_LIFECYCLE_GROUP';
const addKey = 'INTERNAL_C14_CONTACT_LIFECYCLE_ADD';
const otherKey = 'INTERNAL_C14_CONTACT_LIFECYCLE_OTHER';
const otherRecord = 'INTERNAL_C14_CONTACT_LIFECYCLE_OTHER_PERSON';
const contact = { preferred: true, type: 'EMAIL', value: 'contact.lifecycle@example.test' } as const;
const otherContact = { ...contact, value: 'other.lifecycle@example.test' };
const provenance = { authoritative: false, method: 'PROVIDER_OBSERVATION', source: 'EXTERNAL_EVIDENCE' } as const;
const operation = (entrypointKey: string) => ({ entrypointKey, moduleId: partyModule, schemaVersion: '1' });
const operations = [
  operation('party.registry.create-party'),
  operation('party.registry.add-contact-point'),
  operation(updateContactActionKey),
  operation(endContactActionKey),
];
const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const unavailable = (message: string) => new SymmyC14ProductFixtureUnavailable({ message });
const invocationId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('ContactLifecycleInvocationId'),
  Schema.decodeTo(Schema.String),
);
const effectSchema = Schema.Struct({
  effect_key: Schema.String,
  outcome_status: Schema.Union([Schema.String, Schema.Null]),
  owner_invocation_id: Schema.OptionFromNullOr(invocationId),
  owner_receipt: Schema.Unknown,
  state: Schema.String,
});
const addedReceiptSchema = Schema.Struct({
  _tag: Schema.Literal('PartyContactPointAdded'),
  contactPointRef: PartyContactPointRefSchema,
  partyRef: PartyRefSchema,
  revision: Schema.Int,
});

const recordSource = (fixture: CustomerFixture, recordId: string) => ({
  entityKind: fixture.sourceIdentity.recordType,
  issuerId: fixture.sourceIdentity.issuer,
  sourceNamespace: fixture.sourceIdentity.namespace,
  sourceRecordId: recordId,
});

/** Extend standing capabilities only: public intake must establish every person and CHILD admission itself. */
const governContacts = Effect.fn('SymmyC14ContactLifecycle.govern')(function* govern(fixture: CustomerFixture) {
  const scope = {
    integrationPrincipalId: fixture.integration.principalId,
    partyId: fixture.partyReceipt.partyRef.resourceId,
    profileId: fixture.profileReceipt.profileRef.resourceId,
    source: fixture.sourceIdentity,
    systemId: fixture.systemId,
  };
  const contexts = [
    ...customerContexts(scope, addKey, [{ contacts: [contact], kind: 'existing', recordId: fixture.recordId }]),
    ...customerContexts(scope, otherKey, [{ contacts: [otherContact], kind: 'created', recordId: otherRecord }]),
  ];
  const policy = yield* seedSourceProcessingNativeFixture({
    connections: fixture.isolated.connections,
    // Samples describe targetless uses only; target capabilities are grants, not invented owner assurance.
    contexts: contexts.filter(({ request }) => request.target === null),
    contractEvidenceRef: 'INTERNAL_C14_CONTACT_LIFECYCLE_STANDING_GRANTS',
    controllerRef: 'internal:customer-conformance',
    dataCategoryRefs: ['INTERNAL_C14_CUSTOMER_RECORD'],
    governancePrincipalId: fixture.governancePrincipalId,
    grants: [
      {
        allowTargetless: true,
        consumerModuleId: 'integration.symmy',
        operation: 'CUSTOMER_SOURCE_INTAKE',
        targetKinds: ['PARTY_CONTACT_POINT'],
      },
      { allowTargetless: true, consumerModuleId: partyModule, operation: 'CREATE', targetKinds: ['PARTY'] },
      { allowTargetless: true, consumerModuleId: partyModule, operation: 'EVIDENCE_READ', targetKinds: ['PARTY'] },
      ...(['ADD_CONTACT_POINT', 'UPDATE_CONTACT_POINT', 'END_CONTACT_POINT'] as const).map(
        (ownerOperation) =>
          ({
            allowTargetless: false,
            consumerModuleId: partyModule,
            operation: ownerOperation,
            targetKinds: ['PARTY'],
          }) as const,
      ),
      ...(['customer-profile-source.write', 'customer-profile-source.read'] as const).map(
        (ownerOperation) =>
          ({
            allowTargetless: false,
            consumerModuleId: 'commerce.customer-context',
            operation: ownerOperation,
            targetKinds: ['RETAIL_CUSTOMER_PROFILE'],
          }) as const,
      ),
    ],
    legalEntityId: fixture.legalEntityId,
    meaning: 'Standing source processing permits actual owner-correlated contact lifecycle, never a different Party',
    tenantId: fixture.tenantId,
  });
  expect(policy.plans).toEqual([]);
  expect(policy.subjectRefs).toEqual([]);
});

/**
 * The same internal selected-group carrier used by customer-assignment.test.mts: no new public wire or production
 * enrollment. Its selector is just the internal carrier; both personal items keep their actual CUSTOMER sources.
 */
const enrollCarrier = Effect.fn('SymmyC14ContactLifecycle.carrier')(function* enroll(fixture: CustomerFixture) {
  const { admin, integration, legalEntityId, sourceIdentity, sourceRouteId, tenantId } = fixture;
  const routeId = yield* uuid;
  const groupRef = {
    moduleId: 'commerce.customer-context',
    resourceId: yield* uuid,
    resourceType: 'commerce.customer-context.customer-group',
    tenantId,
  };
  const configuration = yield* Schema.decodeUnknownEffect(SymmyRouteExecutionConfigurationSchema)({
    items: [
      {
        effects: [{ effectKey: 'party-create', operation: operations[0] }],
        itemKey: 'customer',
        source: recordSource(fixture, fixture.recordId),
      },
      {
        effects: operations.slice(1).map((ownerOperation, index) => ({
          effectKey: `contact-operation-${index}`,
          operation: ownerOperation,
        })),
        itemKey: 'contact',
        source: recordSource(fixture, contactRecordId(fixture.recordId, contact)),
      },
    ],
    selector: {
      kind: 'CUSTOMER_GROUP',
      source: {
        entityKind: 'CUSTOMER_GROUP',
        issuerId: sourceIdentity.issuer,
        route: { integrationRouteId: sourceRouteId, tenantId },
        sourceNamespace: sourceIdentity.namespace,
        sourceRecordId: carrierRecord,
      },
      target: groupRef,
    },
    sourceRouteId,
  });
  const policy = { policyId: 'INTERNAL_C14_CONTACT_LIFECYCLE_RETENTION', revision: '1' };
  yield* admin`insert into symmy_integration.job_routes
    (route_id,tenant_id,legal_entity_id,principal_id,active,fixture_ids,fixture_plan,mapping_version,route_key,route_code,route_revision,lifecycle_policy)
    values(${routeId},${tenantId},${legalEntityId},${integration.principalId},true,array['INTERNAL_C14'],
      ${yield* Schema.encodeEffect(Schema.fromJsonString(SymmyRouteExecutionConfigurationSchema))(configuration)}::jsonb,
      ${internalCustomerSource.mappingVersion},'customerGroupCustomersBatch',${carrierCode},
      ${internalCustomerSource.routeRevision},${yield* json(policy)}::jsonb)`;
  const priorPolicies = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.Json)))(
    fixture.environment.ONTOS_SYMMY_JOB_RETENTION_POLICIES,
  );
  const environment = {
    ...fixture.environment,
    ONTOS_SYMMY_JOB_RETENTION_POLICIES: yield* json([
      ...priorPolicies,
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
  const runtime = fixture.ownerRuntimes.get(symmyAppId);
  if (runtime === undefined) {
    return yield* unavailable('The actual Symmy receiver is required for the internal carrier');
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
  fixture.ownerRuntimes.set(symmyAppId, { ...runtime, receiver });
  fixture.ownerDiagnostics.set(symmyAppId, receiver.diagnostic);
  const selector = encodeSymmySourceSelector(
    {
      issuerId: sourceIdentity.issuer,
      routeId: sourceRouteId,
      selectorKind: 'CUSTOMER_GROUP',
      sourceNamespace: sourceIdentity.namespace,
      tenantId,
    },
    carrierRecord,
    groupRef.resourceId,
  );
  const client = yield* HttpClient.HttpClient;
  const submitResponse = (key: string, plan: Plan) =>
    Effect.gen(function* sendPlan() {
      return yield* client.post(`${fixture.shell.baseUrl}/api/symmy/v1/customer-groups/${selector}/customers/batch`, {
        body: yield* HttpBody.json({
          contractVersion: 'INTERNAL_C14',
          plan: yield* Schema.encodeEffect(SymmyInternalExecutionPlanSchema)(plan),
        }),
        headers: { 'idempotency-key': key, 'x-api-key': Redacted.value(fixture.providerKey.secret) },
      });
    });
  const submit = (key: string, plan: Plan) =>
    Effect.gen(function* submitPlan() {
      const response = yield* submitResponse(key, plan);
      if (response.status !== 202) {
        return yield* unavailable(`The internal contact carrier returned ${response.status}: ${yield* response.text}`);
      }
      return yield* response.json.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              jobId: SymmyJobStatusResponseSchema.members[0].fields.jobId,
              status: Schema.Literal('queued'),
            }),
          ),
        ),
      );
    });
  return { environment, submit, submitResponse };
});

/** Fresh observations, same admitted source records: UPDATE and END must not replay the original ADD occurrence. */
const lifecyclePlan = Effect.fn('SymmyC14ContactLifecycle.plan')(function* plan(
  fixture: CustomerFixture,
  contactPointRef: ContactRef,
  kind: 'UPDATE' | 'END',
) {
  const observedAt = yield* DateTime.now;
  const customerPlan = symmyC14CustomerPlanData({
    legalEntityId: fixture.legalEntityId,
    observedAt,
    occurrenceId: yield* uuid,
    recordId: fixture.recordId,
    sourceRouteId: fixture.sourceRouteId,
    tenantId: fixture.tenantId,
  });
  const [customer] = customerPlan.items;
  assert.isDefined(customer);
  const [root] = customer.effects;
  assert.isDefined(root);
  const occurrenceId = yield* uuid;
  const sourceReference = {
    occurrenceId,
    recordId: contactRecordId(fixture.recordId, contact),
    source: fixture.sourceIdentity,
  };
  const intent =
    kind === 'UPDATE'
      ? {
          _tag: 'UpdatePartyContactPoint',
          payload: {
            change: { preferred: false, type: 'SET_CHANNEL_PREFERRED' },
            contactPointRef,
            expectedRevision: 1,
            provenance,
            sourceReference,
          },
        }
      : {
          _tag: 'EndPartyContactPoint',
          payload: {
            contactPointRef,
            effectiveEnd: DateTime.formatIso(observedAt),
            provenance,
            reason: 'INTERNAL_C14 source ends its existing contact',
            sourceReference,
            target: { type: 'WHOLE_CONTACT_POINT' },
          },
        };
  return yield* Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
    items: [
      { ...customer, effects: [root] },
      {
        effects: [
          {
            dependsOn: [{ effectKey: root.effectKey, itemKey: customer.itemKey }],
            effectKey: contactLifecycleEffectKey,
            intent,
            operation: operation(kind === 'UPDATE' ? updateContactActionKey : endContactActionKey),
            originalTarget: contactPointRef,
          },
        ],
        itemKey: 'contact',
        source: recordSource(fixture, sourceReference.recordId),
        sourceOccurrenceId: occurrenceId,
      },
    ],
  });
});

const effectRows = (fixture: CustomerFixture, jobId: string) =>
  fixture.admin`select effect_key,owner_invocation_id,owner_receipt,state,outcome->>'status' as outcome_status
    from symmy_integration.job_effects where tenant_id=${fixture.tenantId} and job_id=${jobId}`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(effectSchema))),
  );
const settle = (fixture: CustomerFixture, jobId: string, count: number) =>
  observeCustomerFixtureUntil(
    effectRows(fixture, jobId),
    (rows) => rows.length === count && rows.every(({ state }) => state === 'settled'),
  );
const point = (fixture: CustomerFixture, ref: ContactRef) =>
  fixture.admin`select party_id,display_value,normalized_value,preferred,revision,state,is_current,end_reason,
      ended_by_action_invocation_id::text as ended_by_action_invocation_id
    from party.party_contact_points where tenant_id=${fixture.tenantId} and contact_point_id=${ref.resourceId}`;
const subjects = (fixture: CustomerFixture) =>
  fixture.admin`select count(*) filter(where subject_kind='DATA_SUBJECT')::integer as data_subjects,
    count(*) filter(where subject_kind='SOURCE_ASSERTED')::integer as source_asserted
    from privacy.privacy_subjects where tenant_id=${fixture.tenantId} and legal_entity_id=${fixture.legalEntityId}`;

const contactCustomer = (fixture: CustomerFixture, foreign: boolean) => ({
  contacts: [foreign ? otherContact : contact],
  customerId: foreign ? otherRecord : fixture.recordId,
  firstName: foreign ? 'Other' : 'Internal',
  kind: 'PERSON' as const,
  lastName: 'Customer',
});

/** Two deterministic database faults in this disposable clone. Each hits a different real transaction. */
const proveRefusedPreparations = Effect.fn('SymmyC14ContactLifecycle.refusedPreparations')(function* prove(
  fixture: CustomerFixture,
  carrier: Effect.Success<ReturnType<typeof enrollCarrier>>,
) {
  const { admin, legalEntityId, tenantId } = fixture;
  const body = customersBody(contactCustomer(fixture, false), contactCustomer(fixture, true));
  const candidates = admin`select count(*)::int as count from privacy.source_processing_admissions where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and role='CHILD'`;
  const effective = admin`select a.source_identity_key from privacy.source_processing_admissions a
    where a.tenant_id=${tenantId} and a.legal_entity_id=${legalEntityId} and a.role='CHILD' and exists (
      select 1 from core.action_invocations i join core.source_execution_fences f on f.tenant_id=i.tenant_id and f.admission_invocation_id=i.action_invocation_id
      where i.tenant_id=a.tenant_id and i.legal_entity_id=a.legal_entity_id and i.principal_id=a.symmy_principal_id and i.action_invocation_id=a.symmy_invocation_id
        and i.status='succeeded' and i.action_key='integration.symmy.admit-symmy-job' and i.committed_reply_json->>'kind'='result'
        and i.committed_reply_json->'encoded'->>'sourcePreparationId'=a.symmy_preparation_id::text)`;
  const before = yield* customerIntakeCounts(admin, tenantId);
  // Each customer group is a separate governed Privacy Action. The first commits; the second cannot insert.
  yield* Effect.acquireUseRelease(
    admin`create unique index c14_fail_second_child_group on privacy.source_processing_admissions(symmy_preparation_id) where symmy_preparation_id is not null`,
    () =>
      fixture
        .submitResponse('C14_REFUSE_SECOND_GROUP', body)
        .pipe(Effect.tap((response) => Effect.sync(() => expect(response.status).not.toBe(202)))),
    () => admin`drop index privacy.c14_fail_second_child_group`.pipe(Effect.orDie),
  );
  expect(yield* candidates).toEqual([{ count: 1 }]);
  // Even a writer with ledger access cannot turn a pending candidate into an unconditional CHILD.
  for (const mutation of [
    admin`update privacy.source_processing_admissions set symmy_invocation_id=null,symmy_preparation_id=null,symmy_principal_id=null
      where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and role='CHILD'`,
    admin`update privacy.source_processing_admissions set symmy_principal_id=null
      where tenant_id=${tenantId} and legal_entity_id=${legalEntityId} and role='CHILD'`,
  ]) {
    const failure = yield* Effect.flip(mutation);
    expect(Option.getOrUndefined(findPostgresFailure(failure, ({ code }) => code === '23514'))).toEqual({
      code: '23514',
      constraint: 'privacy_source_admissions_candidate_ck',
    });
  }
  expect(yield* effective).toEqual([]);
  expect(yield* customerIntakeCounts(admin, tenantId)).toEqual(before);
  // This signed internal plan asserts the SAME contact under the other customer. Privacy prepares it; failing
  // the effects insert rolls back even the new job and fence. A fresh public ADD must bind the corrected root.
  const observedAt = yield* DateTime.now;
  const [root] = symmyC14CustomerPlanData({
    legalEntityId,
    observedAt,
    occurrenceId: yield* uuid,
    recordId: otherRecord,
    sourceRouteId: fixture.sourceRouteId,
    tenantId,
  }).items;
  assert.isDefined(root);
  const [create] = root.effects;
  assert.isDefined(create);
  const fromPartyEffect = { effectKey: create.effectKey, itemKey: root.itemKey };
  const occurrenceId = yield* uuid;
  const recordId = contactRecordId(fixture.recordId, contact);
  const wrongPlan = yield* Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
    items: [
      { ...root, effects: [create] },
      {
        effects: [
          {
            dependsOn: [fromPartyEffect],
            effectKey: 'contact-add',
            intent: {
              _tag: 'AddPartyContactPointFromParty',
              fromPartyEffect,
              payload: {
                contactPoint: contact,
                privacyClassification: 'PERSONAL',
                provenance,
                sourceReference: { occurrenceId, recordId, source: fixture.sourceIdentity },
                validFrom: DateTime.formatIso(observedAt),
              },
            },
            operation: operation('party.registry.add-contact-point'),
          },
        ],
        itemKey: 'contact',
        source: recordSource(fixture, recordId),
        sourceOccurrenceId: occurrenceId,
      },
    ],
  });
  yield* Effect.acquireUseRelease(
    admin`alter table symmy_integration.job_effects add constraint c14_refuse_prepared_job check (state <> 'planned') not valid`,
    () =>
      carrier
        .submitResponse('C14_REFUSE_PREPARED_JOB', wrongPlan)
        .pipe(Effect.tap((response) => Effect.sync(() => expect(response.status).not.toBe(202)))),
    () => admin`alter table symmy_integration.job_effects drop constraint c14_refuse_prepared_job`.pipe(Effect.orDie),
  );
  expect(yield* candidates).toEqual([{ count: 2 }]);
  const refusedWrongRoot =
    yield* admin`select a.role from privacy.source_processing_admissions a join privacy.source_processing_admissions root
    on root.tenant_id=a.tenant_id and root.legal_entity_id=a.legal_entity_id and root.privacy_subject_id=a.privacy_subject_id and root.role='SUBJECT'
    where a.tenant_id=${tenantId} and a.legal_entity_id=${legalEntityId} and a.source_record->>'recordId'=${recordId}
      and root.source_record->>'recordId'=${otherRecord} and not exists (select 1 from core.source_execution_fences f where f.tenant_id=a.tenant_id and f.admission_invocation_id=a.symmy_invocation_id)`;
  expect(refusedWrongRoot).toEqual([{ role: 'CHILD' }]);
  expect(yield* effective).toEqual([]);
  expect(yield* customerIntakeCounts(admin, tenantId)).toEqual(before);
  return wrongPlan;
});

const addContact = Effect.fn('SymmyC14ContactLifecycle.add')(function* add(fixture: CustomerFixture, foreign: boolean) {
  const accepted = yield* fixture.submitFor(
    foreign ? otherKey : addKey,
    customersBody(contactCustomer(fixture, foreign)),
  );
  const rows = yield* settle(fixture, accepted.jobId, 3);
  expect(rows.every((row) => Option.isSome(row.owner_invocation_id))).toBe(true);
  const added = rows.find(({ effect_key }) => effect_key === 'contact-add');
  assert.isDefined(added);
  expect(added.outcome_status).toBe('accepted_change');
  const receipt = yield* Schema.decodeUnknownEffect(addedReceiptSchema)(added.owner_receipt);
  expect(receipt.revision).toBe(1);
  return receipt;
});

/** This owner-local test trigger adds an unrequested relationship to the same preparation BEFORE the foreign job
 * commits. It shares every attempt/receipt identifier with the genuine row, but not its source-to-subject assertion. */
const addForeignWithExtraClaim = Effect.fn('SymmyC14ContactLifecycle.unselectedClaim')(function* extraClaim(
  fixture: CustomerFixture,
) {
  const { admin, legalEntityId, tenantId } = fixture;
  const foreign = yield* Effect.acquireUseRelease(
    admin`create function privacy.c14_extra_child_claim() returns trigger language plpgsql as $$
      begin
        insert into privacy.source_processing_admissions
          (tenant_id,legal_entity_id,authorization_id,first_admitted_at,last_admitted_at,last_action_invocation_id,
           privacy_subject_id,role,source_identity_key,source_record,symmy_invocation_id,symmy_preparation_id,symmy_principal_id)
        select new.tenant_id,new.legal_entity_id,new.authorization_id,new.first_admitted_at,new.last_admitted_at,new.last_action_invocation_id,
          new.privacy_subject_id,'CHILD',a.source_identity_key,a.source_record,new.symmy_invocation_id,new.symmy_preparation_id,new.symmy_principal_id
          from privacy.source_processing_admissions a where a.tenant_id=new.tenant_id and a.legal_entity_id=new.legal_entity_id
          and a.role='CHILD' and a.privacy_subject_id<>new.privacy_subject_id and a.source_identity_key<>new.source_identity_key
          limit 1;
        return null;
      end $$`,
    () =>
      Effect.acquireUseRelease(
        admin`create trigger c14_extra_child_claim after insert on privacy.source_processing_admissions for each row
        when (new.role='CHILD' and pg_trigger_depth()=0) execute function privacy.c14_extra_child_claim()`,
        () => addContact(fixture, true),
        () => admin`drop trigger c14_extra_child_claim on privacy.source_processing_admissions`.pipe(Effect.orDie),
      ),
    () => admin`drop function privacy.c14_extra_child_claim()`.pipe(Effect.orDie),
  );
  const rows =
    yield* admin`select a.source_record->>'recordId' as record_id, jsonb_array_length(i.committed_reply_json->'encoded'->'sourceBindingCommitments') as selected
    from privacy.source_processing_admissions a join core.action_invocations i on i.action_invocation_id=a.symmy_invocation_id and i.tenant_id=a.tenant_id
    where a.tenant_id=${tenantId} and a.legal_entity_id=${legalEntityId} and a.role='CHILD' and a.symmy_preparation_id::text=i.committed_reply_json->'encoded'->>'sourcePreparationId'
      and exists (select 1 from privacy.source_processing_admissions own where own.symmy_invocation_id=a.symmy_invocation_id and own.symmy_preparation_id=a.symmy_preparation_id
        and own.last_action_invocation_id=a.last_action_invocation_id and own.privacy_subject_id=a.privacy_subject_id and own.source_record->>'recordId'=${contactRecordId(otherRecord, otherContact)})`;
  expect(rows).toHaveLength(2);
  expect(rows).toEqual(
    expect.arrayContaining([
      { record_id: contactRecordId(otherRecord, otherContact), selected: 1 },
      { record_id: contactRecordId(fixture.recordId, contact), selected: 1 },
    ]),
  );
  // The owner operations below must still resolve the first source to ITS customer, never this unselected claimant.
  return foreign;
});

const assertNativeContact = Effect.fn('SymmyC14ContactLifecycle.nativeIdentity')(function* assertNative(
  fixture: CustomerFixture,
  jobId: string,
  actionKey: string,
  ref: ContactRef,
  revision: number,
) {
  const rows = yield* settle(fixture, jobId, 2);
  expect(rows.every((row) => Option.isSome(row.owner_invocation_id))).toBe(true);
  const changed = rows.find(({ effect_key }) => effect_key === contactLifecycleEffectKey);
  assert.isDefined(changed);
  expect(changed.outcome_status).toBe('accepted_change');
  const native = yield* fixture.admin`select r.result->>'revision' as revision,
      r.result->'contactPointRef'->>'resourceId' as contact_id
    from symmy_integration.job_effects e join core.action_invocations a
      on a.tenant_id=e.tenant_id and a.action_invocation_id=e.owner_invocation_id
      and a.principal_id=e.owner_executor_principal_id and a.auth_context_ref=e.owner_auth_context_ref
      and a.request_hash=e.owner_request_hash and a.idempotency_key=e.effect_id::text
    join party.party_source_effect_receipts r
      on r.tenant_id=a.tenant_id and r.action_invocation_id=a.action_invocation_id
    where e.tenant_id=${fixture.tenantId} and e.job_id=${jobId} and e.effect_key=${contactLifecycleEffectKey}
      and a.action_key=${actionKey} and a.status='succeeded' and a.principal_id=${fixture.systemId}
      and a.legal_entity_id=${fixture.legalEntityId}`;
  expect(native).toEqual([{ contact_id: ref.resourceId, revision: String(revision) }]);
  return Option.getOrThrow(changed.owner_invocation_id);
});

it.live(
  'INTERNAL_C14 SOURCE_ASSERTED contact adds, updates and ends through real owners, never a different Party',
  () =>
    Effect.scoped(
      Effect.gen(function* contactLifecycle() {
        const fixture = yield* makeSymmyC14CustomerFixture({
          allowedOwnerOperations: operations.slice(1),
          initializeScopes: ({ admin, legalEntityId, principalId, tenantId }) =>
            testCoreDatabase.pipe(
              Effect.provideService(PgClient.PgClient, admin),
              Effect.flatMap((core) =>
                writeTestTenantScopes(core, { legalEntityIds: [legalEntityId], principalId, tenantId }),
              ),
            ),
        });
        expect(yield* subjects(fixture)).toEqual([{ data_subjects: 0, source_asserted: 1 }]);
        yield* governContacts(fixture);
        const carrier = yield* enrollCarrier(fixture);
        const worker = yield* startProductWorker(fixture.workerArtifact, {
          ...carrier.environment,
          ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_CONTACT_LIFECYCLE_WORKER',
          ONTOS_GATEWAY_MODULE_API_KEY: fixture.moduleKey,
        });
        yield* Effect.gen(function* proveLifecycle() {
          const wrongRoot = yield* proveRefusedPreparations(fixture, carrier);
          const added = yield* addContact(fixture, false);
          expect(added.partyRef).toEqual(fixture.partyReceipt.partyRef);
          expect(yield* point(fixture, added.contactPointRef)).toMatchObject([
            {
              display_value: contact.value,
              normalized_value: contact.value,
              preferred: true,
              revision: 1,
              state: 'ACTIVE',
            },
          ]);
          // The fresh ADD committed the corrected root; that same contact can no longer claim the other one.
          const beforeRootChange = yield* customerIntakeCounts(fixture.admin, fixture.tenantId);
          const rebind = yield* carrier.submitResponse('C14_REFUSE_COMMITTED_ROOT_CHANGE', wrongRoot);
          expect(rebind.status).not.toBe(202);
          expect(yield* customerIntakeCounts(fixture.admin, fixture.tenantId)).toEqual(beforeRootChange);
          const foreign = yield* addForeignWithExtraClaim(fixture);
          expect(foreign.partyRef.resourceId).not.toBe(added.partyRef.resourceId);
          // Cancelling future execution of the original ADD does not revoke its historical choice of subject.
          const cancelled =
            yield* fixture.admin`update core.source_execution_fences f set state='cancelled' from privacy.source_processing_admissions a
            join privacy.source_processing_admissions root on root.tenant_id=a.tenant_id and root.legal_entity_id=a.legal_entity_id
                and root.privacy_subject_id=a.privacy_subject_id and root.role='SUBJECT'
            where f.tenant_id=${fixture.tenantId} and f.tenant_id=a.tenant_id and a.legal_entity_id=${fixture.legalEntityId}
              and f.admission_invocation_id=a.symmy_invocation_id and a.source_record->>'recordId'=${contactRecordId(fixture.recordId, contact)}
              and root.source_record->>'recordId'=${fixture.recordId} returning f.state`;
          expect(cancelled).toEqual([{ state: 'cancelled' }]);
          const foreignBefore = yield* point(fixture, foreign.contactPointRef);
          const ownBefore = yield* point(fixture, added.contactPointRef);
          // Exact enrolled source and native target, but the target's Party is not the Party of this CHILD source.
          const beforeForeign = yield* customerIntakeCounts(fixture.admin, fixture.tenantId);
          for (const kind of ['UPDATE', 'END'] as const) {
            const denied = yield* carrier.submitResponse(
              `INTERNAL_C14_CONTACT_FOREIGN_${kind}`,
              yield* lifecyclePlan(fixture, foreign.contactPointRef, kind),
            );
            // Privacy cannot attest the required owner correlation.
            expect(denied.status).toBe(503);
            expect(yield* customerIntakeCounts(fixture.admin, fixture.tenantId)).toEqual(beforeForeign);
            expect(yield* point(fixture, foreign.contactPointRef)).toEqual(foreignBefore);
            expect(yield* point(fixture, added.contactPointRef)).toEqual(ownBefore);
          }
          const update = yield* carrier.submit(
            'INTERNAL_C14_CONTACT_UPDATE',
            yield* lifecyclePlan(fixture, added.contactPointRef, 'UPDATE'),
          );
          yield* assertNativeContact(fixture, update.jobId, updateContactActionKey, added.contactPointRef, 2);
          expect(yield* point(fixture, added.contactPointRef)).toMatchObject([
            {
              display_value: contact.value,
              is_current: true,
              normalized_value: contact.value,
              party_id: added.partyRef.resourceId,
              preferred: false,
              revision: 2,
              state: 'ACTIVE',
            },
          ]);
          const ended = yield* carrier.submit(
            'INTERNAL_C14_CONTACT_END',
            yield* lifecyclePlan(fixture, added.contactPointRef, 'END'),
          );
          const endInvocation = yield* assertNativeContact(
            fixture,
            ended.jobId,
            endContactActionKey,
            added.contactPointRef,
            3,
          );
          expect(yield* point(fixture, added.contactPointRef)).toMatchObject([
            {
              display_value: contact.value,
              end_reason: 'INTERNAL_C14 source ends its existing contact',
              ended_by_action_invocation_id: endInvocation,
              is_current: false,
              normalized_value: contact.value,
              party_id: added.partyRef.resourceId,
              preferred: false,
              revision: 3,
              state: 'ENDED',
            },
          ]);
          expect(yield* point(fixture, foreign.contactPointRef)).toEqual(foreignBefore);
          expect(yield* subjects(fixture)).toEqual([{ data_subjects: 0, source_asserted: 2 }]);
          const bindings = yield* fixture.admin`select distinct child.role,
              child.source_record->>'recordId' as record_id,subject.subject_kind
            from privacy.source_processing_admissions child
            join core.action_invocations i on i.tenant_id=child.tenant_id and i.action_invocation_id=child.symmy_invocation_id
              and i.legal_entity_id=child.legal_entity_id and i.principal_id=child.symmy_principal_id and i.status='succeeded'
              and i.action_key='integration.symmy.admit-symmy-job' and i.committed_reply_json->>'kind'='result'
              and i.committed_reply_json->'encoded'->>'sourcePreparationId'=child.symmy_preparation_id::text
            join core.source_execution_fences f on f.tenant_id=i.tenant_id and f.admission_invocation_id=i.action_invocation_id
            join privacy.source_processing_admissions parent
              on parent.tenant_id=child.tenant_id and parent.legal_entity_id=child.legal_entity_id
              and parent.privacy_subject_id=child.privacy_subject_id and parent.role='SUBJECT'
            join privacy.privacy_subjects subject
              on subject.tenant_id=child.tenant_id and subject.legal_entity_id=child.legal_entity_id
              and subject.privacy_subject_id=child.privacy_subject_id
            where child.tenant_id=${fixture.tenantId} and child.legal_entity_id=${fixture.legalEntityId}
              and child.source_record->>'recordId'=${contactRecordId(fixture.recordId, contact)}
              and parent.source_record->>'recordId'=${fixture.recordId}`;
          expect(bindings).toEqual([
            {
              record_id: contactRecordId(fixture.recordId, contact),
              role: 'CHILD',
              subject_kind: 'SOURCE_ASSERTED',
            },
          ]);
        }).pipe(
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
      }),
    ).pipe(Effect.provide(customerFixtureServices)),
  { timeout: 240_000 },
);
