import { CustomerProfileSourceRequestSchema } from '@app/commerce-customer-context/api/customer-profile-source';
import { SavedAddressSourceReceiptResponseSchema } from '@app/commerce-customer-context/api/saved-address-source-receipt';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { writeTestTenantScopes } from '@app/core-runtime/testing/tenant-access';
import { PgClient } from '@effect/sql-pg';
import { SourceProcessingContextSchema } from '@app/privacy/api';
import {
  seedCommittedProfileSourceProcessingNativeFixture,
  seedSourceProcessingNativeFixture,
} from '@app/privacy/testing/source-processing-native';
import { SymmyEffectIdSchema } from '@app/shared-contracts/symmy';
import { expect, it } from 'effect-rstest';
import { Array as EffectArray, Duration, Effect, Order, Redacted, Schema } from 'effect';
import { HttpClient } from 'effect/http';
import {
  customerFixtureServices as services,
  makeSymmyC14CustomerFixture,
  observeCustomerFixtureUntil as observeUntil,
} from './support/symmy-c14-customer-assignment-fixture.mts';
import { customerContexts } from './support/symmy-c14-customer-contexts.mts';
import type { CustomerContextScope, CustomerExpectation } from './support/symmy-c14-customer-contexts.mts';
import { addressRecordId, customerItemSource, customersBody } from './support/symmy-c14-customer-public.mts';
import type { PublicAddress } from './support/symmy-c14-customer-public.mts';
import { internalCustomerSource } from './support/symmy-c14-customer-plan.mts';
import {
  CustomerNativeProfileInvocationSchema,
  issueCustomerProfileFixtureRecovery,
} from './support/symmy-c14-customer-recovery.mts';
import { customerWorkerKey } from './support/symmy-c14-customer-rules.mts';
import {
  SymmyC14ProductFixtureUnavailable,
  startProductOwner,
  startProductWorker,
} from './support/symmy-c14-product-runtime.mts';

type CustomerFixture = Effect.Success<ReturnType<typeof makeSymmyC14CustomerFixture>>;
type Contexts = readonly (typeof SourceProcessingContextSchema.Type)[];
interface Worker {
  readonly diagnostic: Effect.Effect<string>;
}

const nativeInvocationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('NativeActionInvocationId'),
  Schema.decodeTo(Schema.String),
);
const effectSchema = Schema.Struct({
  effect_id: Schema.toEncoded(SymmyEffectIdSchema),
  effect_key: Schema.String,
  owner_invocation_id: Schema.OptionFromNullOr(nativeInvocationIdSchema),
  owner_receipt: Schema.Unknown,
  record_id: Schema.String,
  state: Schema.String,
});
const profileEffectSchema = Schema.Struct({
  effect_id: Schema.toEncoded(SymmyEffectIdSchema),
  owner_receipt: Schema.Unknown,
  state: Schema.String,
});
const profileReceiptSchema = Schema.Struct({
  profileRef: Schema.Struct({ resourceId: Schema.String.pipe(Schema.brand('NewProfileResourceId')) }),
});
const jobStatusSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      effects: Schema.Array(Schema.Struct({ status: Schema.String })),
      outcome: Schema.String,
    }),
  ),
  status: Schema.String,
});
const commerceModuleId = 'commerce.customer-context';
const partyModuleId = 'party.registry';
const addAddressEntrypoint = 'commerce.customer-context.add-saved-address';
const addContactEntrypoint = 'party.registry.add-contact-point';
const unavailable = (message: string) => new SymmyC14ProductFixtureUnavailable({ message });
const sortedStrings = (values: readonly string[]) => EffectArray.sort(values, Order.String);

const billingContact = { preferred: true, type: 'EMAIL', value: 'internal.customer@example.test' } as const;
const billingAddress: PublicAddress = {
  label: 'INTERNAL_C14 billing address',
  postalAddress: { addressLine1: '17 Internal Street', city: 'Prague', countryCode: 'CZ', postalCode: '11000' },
  purposes: ['BILLING'],
};
const deliveryAddress: PublicAddress = {
  postalAddress: { addressLine1: '18 Internal Street', city: 'Brno', countryCode: 'CZ', postalCode: '60200' },
  purposes: ['DELIVERY'],
};
const existingKey = 'INTERNAL_C14_PUBLIC_ADDRESS_EXISTING_CUSTOMER';
const resendKey = 'INTERNAL_C14_PUBLIC_ADDRESS_RESEND';
const createdKey = 'INTERNAL_C14_PUBLIC_ADDRESS_NEW_CUSTOMER';
const ambiguousKey = 'INTERNAL_C14_PUBLIC_ADDRESS_AMBIGUOUS_CUSTOMER';
const ambiguousRecord = 'INTERNAL_C14_AMBIGUOUS_CUSTOMER';
const siblingRecord = 'INTERNAL_C14_SIBLING_CUSTOMER';
const createdRecord = 'INTERNAL_C14_NEW_CUSTOMER_WITH_ADDRESS';
const person = (
  customerId: string,
  firstName: string,
  addresses: readonly PublicAddress[],
  contacts: readonly (typeof billingContact)[] = [],
) => ({ addresses, contacts, customerId, firstName, kind: 'PERSON' as const, lastName: 'Customer' });
const streetOf = (street: string) => ({ lifecycle: 'ACTIVE', revision: 1, street });
const MAX_ENVIRONMENT_VALUE_LENGTH = 120_000;

const belongsTo = (occurrences: ReadonlySet<string | undefined>) => (context: Contexts[number]) =>
  occurrences.has(context.request.source?.occurrenceId);
const billingStreet = '17 Internal Street';
const deliveryStreet = '18 Internal Street';

const restartPrivacy = Effect.fn('SymmyC14PublicAddress.restartPrivacy')(function* restartPrivacy(
  fixture: CustomerFixture,
  contexts: Contexts,
) {
  const runtime = fixture.ownerRuntimes.get('privacy');
  if (runtime === undefined) {
    return yield* unavailable('The actual Privacy receiver is required for SavedAddress DATA processing');
  }
  // The contexts travel in one environment value, which Linux limits to 128 KiB: CI fails with E2BIG above it.
  const encodedContexts = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Array(SourceProcessingContextSchema)),
  )(contexts);
  expect(encodedContexts.length).toBeLessThan(MAX_ENVIRONMENT_VALUE_LENGTH);
  yield* runtime.receiver.child.kill();
  yield* runtime.receiver.child.exitCode;
  const restarted = yield* startProductOwner({
    artifacts: runtime.artifacts,
    contract: runtime.contract,
    environment: {
      ...fixture.environment,
      ONTOS_GATEWAY_MODULE_API_KEY: runtime.moduleKey,
      ONTOS_PRIVACY_SOURCE_PROCESSING_CONTEXTS: encodedContexts,
    },
    port: runtime.port,
    prefix: '/privacy-api',
  });
  fixture.ownerDiagnostics.set('privacy', restarted.diagnostic);
  fixture.ownerRuntimes.set('privacy', { ...runtime, receiver: restarted });
  return yield* Effect.void;
});

const effectRows = (fixture: CustomerFixture, jobId: string) =>
  fixture.admin`select e.effect_id,e.effect_key,e.effect->'ref'->'occurrence'->'record'->>'sourceRecordId' as record_id,
    e.owner_invocation_id,e.owner_receipt,e.state
    from symmy_integration.job_effects e where e.job_id=${jobId} order by e.effect_key,record_id`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(effectSchema))),
  );

const dumpDiagnostics = (fixture: CustomerFixture, worker: Worker) =>
  Effect.all([
    worker.diagnostic.pipe(Effect.flatMap(Effect.logError)),
    fixture.shell.gatewayDiagnostics().pipe(Effect.flatMap(Effect.logError)),
    ...[...fixture.ownerDiagnostics].map(([appId, diagnostic]) =>
      diagnostic.pipe(Effect.flatMap((message) => Effect.logError({ appId, message }))),
    ),
    fixture.admin`select action_key,status,count(*)::integer as count from core.action_invocations where tenant_id=${fixture.tenantId} group by action_key,status`.pipe(
      Effect.flatMap(Effect.logError),
    ),
  ]);

const settle = (fixture: CustomerFixture, worker: Worker, jobId: string, count: number) =>
  observeUntil(
    effectRows(fixture, jobId),
    (rows) => rows.length === count && rows.every(({ state }) => state === 'settled'),
  ).pipe(Effect.tapError(() => dumpDiagnostics(fixture, worker)));

const ownerCounts = (fixture: CustomerFixture) => fixture.admin`select
  (select count(*)::integer from party.parties where tenant_id=${fixture.tenantId}) as parties,
  (select count(*)::integer from commerce_customer_context.customer_profiles where tenant_id=${fixture.tenantId}) as profiles`;
const savedAddresses = (fixture: CustomerFixture) =>
  fixture.admin`select address_line_1 as street,lifecycle,revision from commerce_customer_context.saved_addresses
    where tenant_id=${fixture.tenantId} order by address_line_1`;

const jobStatus = (fixture: CustomerFixture, jobId: string) =>
  Effect.gen(function* readJobStatus() {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(`${fixture.shell.baseUrl}/api/symmy/v1/jobs/${jobId}`, {
      headers: { 'x-api-key': Redacted.value(fixture.providerKey.secret) },
    });
    return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(jobStatusSchema)));
  });

const contextScope = (fixture: CustomerFixture): CustomerContextScope => ({
  integrationPrincipalId: fixture.integration.principalId,
  partyId: fixture.partyReceipt.partyRef.resourceId,
  profileId: fixture.profileReceipt.profileRef.resourceId,
  source: fixture.sourceIdentity,
  systemId: fixture.systemId,
});

/** The governance step between jobs: DATA policy for the profile the fixture job created and the plain intake policy. */
const governExistingProfile = Effect.fn('SymmyC14PublicAddress.governExisting')(function* governExisting(
  fixture: CustomerFixture,
  expectations: readonly (readonly [string, readonly CustomerExpectation[]])[],
) {
  const all = expectations.flatMap(([key, customers]) => customerContexts(contextScope(fixture), key, customers));
  const common = {
    connections: fixture.isolated.connections,
    controllerRef: 'internal:customer-conformance',
    dataCategoryRefs: ['INTERNAL_C14_CUSTOMER_RECORD'],
    governancePrincipalId: fixture.governancePrincipalId,
    legalEntityId: fixture.legalEntityId,
    tenantId: fixture.tenantId,
  };
  // A source assertion names no owner target; what is aimed at the existing Party or profile is a DATA use.
  const source = yield* seedSourceProcessingNativeFixture({
    ...common,
    contexts: all.filter(({ request }) => request.target === null),
    contractEvidenceRef: 'INTERNAL_C14_EXPLICIT_PUBLIC_SOURCE_INTAKE',
    meaning:
      'Independent current fixture policy allows the public customers to name their source records and create or match their Party and profile',
  });
  const data = yield* seedCommittedProfileSourceProcessingNativeFixture({
    ...common,
    contexts: all.filter(({ request }) => request.target !== null),
    contractEvidenceRef: 'INTERNAL_C14_EXPLICIT_PUBLIC_SAVED_ADDRESS',
    meaning:
      'Independent current fixture policy allows the public customers to match the original source person and save Commerce-only addresses',
    profileReceipt: fixture.proofTransport,
  });
  return [...fixture.privacy.contexts, ...source.contexts, ...data.contexts];
});

/** The governance step for a profile the job itself created: it exists only once the profile effect settled. */
const governCreatedProfile = Effect.fn('SymmyC14PublicAddress.governCreated')(function* governCreated(
  fixture: CustomerFixture,
  profileEffect: { readonly effect_id: string; readonly owner_receipt: unknown },
  addressSource: ReturnType<typeof customerItemSource>,
) {
  const profile = yield* Schema.decodeUnknownEffect(profileReceiptSchema)(profileEffect.owner_receipt);
  const [native] =
    yield* fixture.admin`select a.action_invocation_id as "actionInvocationId",a.action_key as "actionKey",
    a.auth_context_ref as "authContextRef",a.idempotency_key as "idempotencyKey",a.principal_id as "principalId",a.request_hash as "requestHash"
    from core.action_invocations a join symmy_integration.job_effects e on e.tenant_id=a.tenant_id
    and e.owner_invocation_id=a.action_invocation_id and e.owner_executor_principal_id=a.principal_id
    and e.owner_auth_context_ref=a.auth_context_ref and e.owner_request_hash=a.request_hash and e.effect_id::text=a.idempotency_key
    where a.tenant_id=${fixture.tenantId} and e.effect_id=${profileEffect.effect_id} and a.legal_entity_id=${fixture.legalEntityId} and a.status='succeeded'`;
  const nativeProfile = yield* Schema.decodeUnknownEffect(CustomerNativeProfileInvocationSchema)(native);
  const [requirement] = yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ key: Schema.String })]))(
    (fixture.symmy.manifest.requirements?.operations ?? []).filter(
      ({ entrypointKey, provider }) =>
        entrypointKey === customerWorkerKey &&
        provider.moduleId === commerceModuleId &&
        provider.entrypointKey === 'commerce.customer-context.api.customer-profile-source' &&
        provider.schemaVersion === '1',
    ),
  );
  const transport = yield* issueCustomerProfileFixtureRecovery({
    compositionRevision: fixture.snapshot.composition.revision,
    deliveryId: nativeProfile.authContextRef.slice(`job:${customerWorkerKey}:run:`.length),
    expectedReadPrincipalId: fixture.systemId,
    legalEntityId: fixture.legalEntityId,
    moduleApiKey: Redacted.make(fixture.moduleKey),
    nativeAction: nativeProfile,
    operationRequirementKey: requirement.key,
    request: Schema.decodeUnknownSync(CustomerProfileSourceRequestSchema)({
      effectId: profileEffect.effect_id,
      issuer: fixture.sourceIdentity.issuer,
      mappingRevision: internalCustomerSource.mappingVersion,
      mode: 'MINIMAL_RECEIPT',
      namespace: fixture.sourceIdentity.namespace,
      recordType: fixture.sourceIdentity.recordType,
      route: { id: fixture.sourceRouteId, revision: internalCustomerSource.routeRevision },
    }),
    shellGatewayBaseUrl: fixture.environment.ONTOS_SHELL_GATEWAY_BASE_URL,
    tenantId: fixture.tenantId,
  });
  const target = { kind: 'RETAIL_CUSTOMER_PROFILE' as const, resourceId: profile.profileRef.resourceId };
  const data = yield* seedCommittedProfileSourceProcessingNativeFixture({
    connections: fixture.isolated.connections,
    contexts: ['saved-address-source.add', 'saved-address-source.receipt'].map((operation) => ({
      authMethod: 'system' as const,
      principalId: fixture.systemId,
      request: { consumerModuleId: commerceModuleId, operation, source: addressSource, target },
    })),
    contractEvidenceRef: 'INTERNAL_C14_EXPLICIT_PUBLIC_NEW_CUSTOMER_ADDRESS',
    controllerRef: 'internal:customer-conformance',
    dataCategoryRefs: ['INTERNAL_C14_CUSTOMER_RECORD'],
    governancePrincipalId: fixture.governancePrincipalId,
    legalEntityId: fixture.legalEntityId,
    meaning: 'Independent current fixture policy allows the Commerce-only address of the profile this job created',
    profileReceipt: transport,
    tenantId: fixture.tenantId,
  });
  return { contexts: data.contexts, profileId: profile.profileRef.resourceId };
});

it.live(
  'INTERNAL_C14 public customers save Commerce-only addresses on an existing and on a created profile, never without their customer',
  () =>
    Effect.scoped(
      Effect.gen(function* publicSavedAddressConformance() {
        const fixture = yield* makeSymmyC14CustomerFixture({
          allowedOwnerOperations: [
            { entrypointKey: addAddressEntrypoint, moduleId: commerceModuleId, schemaVersion: '1' },
            { entrypointKey: addContactEntrypoint, moduleId: partyModuleId, schemaVersion: '1' },
          ],
          initializeScopes: ({ admin, legalEntityId, principalId, tenantId }) =>
            testCoreDatabase.pipe(
              Effect.provideService(PgClient.PgClient, admin),
              Effect.flatMap((core) =>
                writeTestTenantScopes(core, { legalEntityIds: [legalEntityId], principalId, tenantId }),
              ),
            ),
          verifyPausedIntake: true,
        });
        const { admin, legalEntityId, recordId, sourceIdentity, submitFor, systemId, tenantId } = fixture;
        yield* admin`insert into commerce_customer_context.saved_address_source_routes
          (tenant_id,legal_entity_id,route_ref,route_revision,principal_id,issuer,namespace,record_type,mapping_revision,active)
          values(${tenantId},${legalEntityId},${sourceIdentity.routeRef},${internalCustomerSource.routeRevision},${systemId},
          ${sourceIdentity.issuer},${sourceIdentity.namespace},${sourceIdentity.recordType},${internalCustomerSource.mappingVersion},true)`;
        const customer = (addresses: readonly PublicAddress[], contacts: readonly (typeof billingContact)[] = []) =>
          customersBody(person(recordId, 'Internal', addresses, contacts));
        // Each request is one observation: its source occurrences derive from its Idempotency-Key, so Privacy is
        // seeded for exactly the sources the owner will name. Each contact and address is a source record of its own.
        // Privacy is restarted for each stage, because all the contexts together would not fit one environment value
        // on Linux: the ambiguous customer's and the created customer's contexts wait for their own launches.
        const createdExpectation = [{ addresses: [billingAddress], kind: 'created', recordId: createdRecord }] as const;
        const ambiguousExpectation = [
          { addresses: [billingAddress], kind: 'ambiguous', recordId: ambiguousRecord },
          { addresses: [], kind: 'created', recordId: siblingRecord },
        ] as const;
        const allPrivacyContexts = yield* governExistingProfile(fixture, [
          [existingKey, [{ addresses: [billingAddress], contacts: [billingContact], kind: 'existing', recordId }]],
          [resendKey, [{ addresses: [billingAddress, deliveryAddress], kind: 'existing', recordId }]],
          [createdKey, createdExpectation],
          [ambiguousKey, ambiguousExpectation],
        ]);
        // A context names its source by the occurrence the owner derives from the request key, so a job's contexts
        // are the ones whose occurrences its own expectations produce.
        const occurrencesOf = (key: string, expectations: readonly CustomerExpectation[]) =>
          new Set(
            customerContexts(contextScope(fixture), key, expectations).map(
              ({ request }) => request.source?.occurrenceId,
            ),
          );
        const createdOccurrences = occurrencesOf(createdKey, createdExpectation);
        const ambiguousOccurrences = occurrencesOf(ambiguousKey, ambiguousExpectation);
        const privacyContexts = allPrivacyContexts.filter(
          (context) => !belongsTo(createdOccurrences)(context) && !belongsTo(ambiguousOccurrences)(context),
        );
        const ambiguousPrivacyContexts = [
          ...fixture.privacy.contexts,
          ...allPrivacyContexts.filter(belongsTo(ambiguousOccurrences)),
        ];
        const createdPrivacyContexts = [
          ...fixture.privacy.contexts,
          ...allPrivacyContexts.filter(belongsTo(createdOccurrences)),
        ];
        yield* restartPrivacy(fixture, privacyContexts);
        const worker = yield* startProductWorker(fixture.workerArtifact, {
          ...fixture.environment,
          ONTOS_C14_WORKER_CLAIM_OWNER: 'INTERNAL_C14_PUBLIC_ADDRESS_WORKER',
          ONTOS_GATEWAY_MODULE_API_KEY: fixture.moduleKey,
        });

        // Scenario 1: the customer exists, the same customer is sent with a new address and a contact.
        const existing = yield* submitFor(existingKey, customer([billingAddress], [billingContact]));
        expect(yield* submitFor(existingKey, customer([billingAddress], [billingContact]))).toEqual(existing);
        const existingRows = yield* settle(fixture, worker, existing.jobId, 4);
        expect(existingRows.map(({ effect_key }) => effect_key)).toEqual([
          'address-add',
          'contact-add',
          'party-create',
          'retail-profile',
        ]);
        const existingStatus = yield* jobStatus(fixture, existing.jobId);
        expect(existingStatus.status).toBe('completed_all');
        // One customer in the request is one item, whatever contacts and addresses the plan binds beside it.
        expect(existingStatus.items.map(({ outcome }) => outcome)).toEqual(['accepted']);
        expect(existingStatus.items[0]?.effects).toHaveLength(4);
        const [contacts] = yield* admin<{
          count: number;
        }>`select count(*)::integer as count from party.party_contact_points
          where tenant_id=${tenantId} and party_id=${fixture.partyReceipt.partyRef.resourceId}`;
        expect(contacts).toEqual({ count: 1 });
        expect(yield* ownerCounts(fixture)).toEqual([{ parties: 1, profiles: 1 }]);
        expect(yield* savedAddresses(fixture)).toEqual([streetOf(billingStreet)]);
        const receipts = yield* admin`select result from commerce_customer_context.saved_address_source_receipts
          where tenant_id=${tenantId} and legal_entity_id=${legalEntityId}`;
        const [{ result: added }, ...otherReceipts] = yield* Schema.decodeUnknownEffect(
          Schema.NonEmptyArray(Schema.Struct({ result: Schema.Unknown })),
        )(receipts);
        expect(otherReceipts).toHaveLength(0);
        expect(Schema.is(SavedAddressSourceReceiptResponseSchema.members[3].fields.receipt)(added)).toBe(true);
        expect(added).toMatchObject({
          operation: 'ADD',
          outcome: 'ADDED',
          profile: { kind: 'RETAIL', profileRef: fixture.profileReceipt.profileRef },
        });
        expect(JSON.stringify(added)).not.toContain('Internal Street');

        // The same customer again with the same address and one more: nothing is duplicated, the new one is saved.
        const resend = yield* submitFor(resendKey, customer([billingAddress, deliveryAddress]));
        const resendRows = yield* settle(fixture, worker, resend.jobId, 4);
        expect(resendRows.find(({ effect_key }) => effect_key === 'party-create')?.state).toBe('settled');
        expect(yield* ownerCounts(fixture)).toEqual([{ parties: 1, profiles: 1 }]);
        expect(yield* savedAddresses(fixture)).toEqual([streetOf(billingStreet), streetOf(deliveryStreet)]);
        const resendStatus = yield* jobStatus(fixture, resend.jobId);
        expect(resendStatus.status).toBe('completed_partial');
        expect(resendStatus.items.map(({ outcome }) => outcome)).toEqual(['partial']);
        // The address sent again is the same source record: the owner refuses it and the job goes on.
        expect(
          resendStatus.items.flatMap(({ effects }) => effects.filter(({ status }) => status === 'conflict')),
        ).toEqual([{ status: 'conflict' }]);

        // No address without its customer: a customer the Party owner cannot match or create (its name belongs to
        // another Party) saves no address and gets no profile; the other customer of the same request is created.
        yield* restartPrivacy(fixture, ambiguousPrivacyContexts);
        const ambiguous = yield* submitFor(
          ambiguousKey,
          customersBody(person(ambiguousRecord, 'Internal', [billingAddress]), person(siblingRecord, 'Sibling', [])),
        );
        // ambiguous: party, profile, address; sibling: party, profile.
        const ambiguousRows = yield* settle(fixture, worker, ambiguous.jobId, 5);
        const ambiguousStatus = yield* jobStatus(fixture, ambiguous.jobId);
        expect(ambiguousStatus.status).toBe('completed_partial');
        // items[n] is customers[n]: the ambiguous customer first, its sibling second.
        expect(ambiguousStatus.items.map(({ outcome }) => outcome)).toEqual(['not_accepted', 'accepted']);
        const dependents = ambiguousStatus.items.flatMap(({ effects, outcome }) =>
          outcome === 'not_accepted' ? effects.map(({ status }) => status) : [],
        );
        // The Party owner refuses the ambiguous name under this fixture policy; its dependents end unsupported.
        expect(sortedStrings(dependents)).toEqual(['denied', 'unsupported', 'unsupported']);
        expect(ambiguousRows.map(({ state }) => state)).toEqual(Array.from({ length: 5 }, () => 'settled'));
        // The sibling is created, the ambiguous customer is not and neither is its address.
        expect(yield* ownerCounts(fixture)).toEqual([{ parties: 2, profiles: 2 }]);
        expect(yield* savedAddresses(fixture)).toEqual([streetOf(billingStreet), streetOf(deliveryStreet)]);

        // Scenario 2: the customer does not exist. It is created, its profile is created, then its address is saved.
        // The profile does not exist when Privacy is seeded, so the address waits (its effect is retried) until the
        // profile the job created is governed, exactly as a real data source governance step would do between.
        yield* restartPrivacy(fixture, createdPrivacyContexts);
        const created = yield* submitFor(createdKey, customersBody(person(createdRecord, 'Fresh', [billingAddress])));
        const createdProfile = yield* observeUntil(
          admin`select effect_id,owner_receipt,state from symmy_integration.job_effects
            where job_id=${created.jobId} and effect_key='retail-profile'`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(profileEffectSchema))),
          ),
          (rows) => rows.length === 1 && rows.every(({ state }) => state === 'settled'),
        ).pipe(Effect.tapError(() => dumpDiagnostics(fixture, worker)));
        const [profileEffect] = createdProfile;
        if (profileEffect === undefined) {
          return yield* unavailable('The new customer profile effect is required');
        }
        const governed = yield* governCreatedProfile(
          fixture,
          profileEffect,
          customerItemSource(sourceIdentity, createdKey, 'address-0-0', addressRecordId(createdRecord, billingAddress)),
        );
        yield* restartPrivacy(fixture, [...createdPrivacyContexts, ...governed.contexts]);
        // The address effect was refused while Privacy did not know the profile and is retried by the worker.
        for (let attempt = 0; attempt < 240; attempt += 1) {
          const rows = yield* effectRows(fixture, created.jobId);
          if (rows.length === 3 && rows.every(({ state }) => state === 'settled')) {
            break;
          }
          yield* Effect.sleep(Duration.millis(500));
        }
        const createdRows = yield* effectRows(fixture, created.jobId);
        expect(createdRows.map(({ state }) => state)).toEqual(['settled', 'settled', 'settled']);
        const createdStatus = yield* jobStatus(fixture, created.jobId);
        expect(createdStatus.status).toBe('completed_all');
        expect(createdStatus.items.map(({ outcome }) => outcome)).toEqual(['accepted']);
        expect(yield* ownerCounts(fixture)).toEqual([{ parties: 3, profiles: 3 }]);
        expect(yield* savedAddresses(fixture)).toEqual([
          streetOf(billingStreet),
          streetOf(billingStreet),
          streetOf(deliveryStreet),
        ]);
        const [onNewProfile] = yield* admin<{
          count: number;
        }>`select count(*)::integer as count from commerce_customer_context.saved_addresses
          where tenant_id=${tenantId} and customer_profile_id=${governed.profileId}`;
        expect(onNewProfile).toEqual({ count: 1 });
        yield* worker.child.kill();
        yield* worker.child.exitCode;
        return yield* Effect.void;
      }),
    ).pipe(Effect.provide(services)),
  // 2.5 min on an idle runner, over 4 min when it shares the job with the Privacy composition suites.
  420_000,
);
