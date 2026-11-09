import {
  OrganizationBusinessUpdateInputSchema,
  OrganizationBusinessSourceReferenceSchema,
  OrganizationBusinessUpdateFields,
  OrganizationBusinessRecordProjectionVersion,
  OrganizationBusinessSourceStatement,
  organizationBusinessRecordInputDigest,
} from '@app/party-registry/apis/organization-record-facts';
import { MigrateOrganizationCustomerProfileIcoResultSchema } from '@app/commerce-customer-context/domain/organization-profile-ico-migration';
import { FenceLegacyIcoAuthorityResultSchema } from '@app/party-registry/actions/fence-legacy-ico-authority';
import { seedOrganizationBusinessPartyNativeFixture } from '@app/privacy/testing/organization-business-party-native';
import {
  OrganizationBusinessNameExportFields,
  organizationBusinessNameExportInputDigest,
} from '@app/party-registry/apis/organization-business-name-export';
import { seedOrganizationIcoNativeFixture } from '@app/privacy/testing/organization-ico-native';
import {
  ORGANIZATION_PROFILE_ICO_FIELDS,
  OrganizationCustomerProfileIcoResponseSchema,
} from '@app/commerce-customer-context/domain/organization-profile-ico';
import { executeOrganizationCustomerProfileIcoWithAuthorization } from '@app/commerce-customer-context/api/organization-customer-profile-ico/client';
import { executeOrganizationProfileIcoApplicabilityWithAuthorization } from '@app/privacy/api/organization-profile-ico-applicability/client';
import {
  OrganizationProfileIcoApplicabilityContextSchema,
  OrganizationProfileIcoApplicabilityResponseSchema,
} from '@app/privacy/api/organization-profile-ico-applicability';
import { PrivacyApplicabilityDecisionSchema } from '@app/privacy/domain/privacy-applicability';
import { executeOrganizationCustomerProfileIcoMigrationWithAuthorization } from '@app/commerce-customer-context/api/organization-customer-profile-ico-migration/client';
import { executeMigrateOrganizationCustomerProfileIcoWithAuthorization } from '@app/commerce-customer-context/api/migrate-organization-customer-profile-ico-action/client';
import { executeLegacyIcoInventoryWithAuthorization } from '@app/party-registry/apis/legacy-ico-inventory/client';
import { executeFenceLegacyIcoAuthorityWithAuthorization } from '@app/party-registry/actions/fence-legacy-ico-authority/client';
import {
  CustomerGroupMembershipSourceReceiptRequestSchema,
  CustomerGroupMembershipSourceReceiptResponseSchema,
} from '@app/commerce-customer-context/api/customer-group-membership-source-receipt';
import {
  CustomerPriceGroupAssignmentReceiptRequestSchema,
  CustomerPriceGroupAssignmentReceiptResponseSchema,
} from '@app/commerce-customer-context/api/customer-price-group-assignment-receipt';
import {
  CustomerProfileOrganizationIcoFactsCurrentSchema,
  CustomerProfileOrganizationIcoFactsHistoricalIdentitySchema,
} from '@app/commerce-customer-context/api/customer-profile-organization-ico-facts';
import { randomUUID } from 'node:crypto';
import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { observeAcceptedEffectIdNativeFixture } from '@app/symmy-integration/testing/accepted-effect-native';
import { SymmyInternalExecutionPlanSchema } from '@app/symmy-integration/symmy-internal-contracts';
import { executeCustomerProfileOrganizationIcoFactsWithAuthorization } from '@app/commerce-customer-context/api/customer-profile-organization-ico-facts/client';
import { AssignCounterpartyPriceGroupPayloadSchema } from '@app/commerce-customer-context/api/assign-counterparty-price-group-action';
import {
  OrganizationMembershipSourcePayloadSchema,
  ORGANIZATION_MEMBERSHIP_WRITE_FIELDS,
  ORGANIZATION_MEMBERSHIP_RECOVER_FIELDS,
  ORGANIZATION_MEMBERSHIP_PROJECTION_VERSION,
} from '@app/commerce-customer-context/domain/organization-membership-source';
import {
  ORGANIZATION_PRICE_ASSIGNMENT_WRITE_FIELDS,
  ORGANIZATION_PRICE_ASSIGNMENT_RECEIPT_READ_FIELDS,
  ORGANIZATION_PRICE_ASSIGNMENT_PROJECTION_VERSION,
} from '@app/commerce-customer-context/domain/organization-price-assignment-fields';
import {
  OrganizationProfileSourceCurrentSchema,
  ORGANIZATION_PROFILE_SOURCE_CURRENT_FIELDS,
  ORGANIZATION_PROFILE_SOURCE_CURRENT_VERSION,
} from '@app/commerce-customer-context/domain/organization-profile-source';
import {
  CustomerGroupMembershipSourceAuthorityFixtureRouteSchema,
  seedCustomerGroupMembershipSourceAuthority,
} from '@app/commerce-customer-context/testing/customer-group-membership-source-authority';
import { seedOrganizationBusinessProfileNativeFixture } from '@app/privacy/testing/organization-business-profile-native';
import { OrganizationBusinessApplicabilityIntentSchema } from '@app/privacy/api/organization-business-applicability';
import { executeRecordPrivacyApplicabilityWithAuthorization } from '@app/privacy/api/client';
import type { CustomerGroupRefSchema } from '@app/commerce-customer-context/resources/customer-group';
import { observeCustomerGroupSourceNativeFixture } from '@app/commerce-customer-context/testing/customer-group-source-observation';
import { PriceGroupRefSchema } from '@app/price-group-catalog/resources/price-group';
import { DateTime, Duration, Effect, Layer, Match, Option, Redacted, Schema } from 'effect';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { CounterpartyPurchasingProfileRefSchema } from '@app/commerce-customer-context/resources/counterparty-purchasing-profile';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { FetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { assert, expect, it } from 'effect-rstest';
import { makeOrganizationSourceCustomerOwnerFixture } from './support/organization-source-customer-owner-fixture.mts';

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
const partyReceipt = Schema.Struct({ _tag: Schema.Literal('PartyCreated'), partyRef: PartyRefSchema });
const onboardReceipt = Schema.Struct({
  _tag: Schema.Literal('CounterpartyCustomerOnboarded'),
  counterpartyRef: CounterpartyRefSchema,
  partyRef: PartyRefSchema,
});
const priceReceipt = Schema.Struct({ _tag: Schema.Literal('PriceGroupCreated'), priceGroupRef: PriceGroupRefSchema });
const profileReceipt = Schema.Struct({
  _tag: Schema.Literal('CounterpartyProfileCreated'),
  counterpartyRef: CounterpartyRefSchema,
  profileRef: CounterpartyPurchasingProfileRefSchema,
});
const COMMERCE_APP = 'commerce-customer-context';
const COMMERCE_MODULE = 'commerce.customer-context';
const MEMBERSHIP_ACTION = 'commerce.customer-context.apply-customer-group-membership-source';
const ASSIGN_ACTION = 'commerce.customer-context.assign-counterparty-price-group';
const MEMBERSHIP_EFFECT = 'organization-membership';
const ASSIGN_EFFECT = 'organization-price-assignment';
const PARTY_MODULE = 'party.registry';
const PARTY_APP = 'party-registry';
const SOURCE_READ_OPERATION = 'customer-profile-source.read';
const ICO_PROJECTION = 'ORGANIZATION_ICO_FIELDS_V1';
const FIXTURE_PURPOSE = 'implementation-1096-registered-workload-gateway';
const knownReadIntent = Schema.Struct({
  ...OrganizationBusinessApplicabilityIntentSchema.members[6].fields,
  operation: Schema.Literal(SOURCE_READ_OPERATION),
});
const knownIntents = Schema.Union([
  knownReadIntent,
  OrganizationBusinessApplicabilityIntentSchema.members[8],
  OrganizationBusinessApplicabilityIntentSchema.members[9],
  OrganizationBusinessApplicabilityIntentSchema.members[10],
  OrganizationBusinessApplicabilityIntentSchema.members[11],
]);
type OrganizationFixture = Effect.Success<ReturnType<typeof makeOrganizationSourceCustomerOwnerFixture>>;
interface KnownOrganizationTargets {
  readonly counterpartyRef: typeof CounterpartyRefSchema.Type;
  readonly groupRef: typeof CustomerGroupRefSchema.Type;
  readonly priceGroupRef: typeof PriceGroupRefSchema.Type;
  readonly profileRef: typeof CounterpartyPurchasingProfileRefSchema.Type;
}
const verifyOrganizationOriginalReceipts = Effect.fn('OrganizationSourceCustomer.originalReceipts')(
  function* originalReceipts(
    fixture: OrganizationFixture,
    targets: KnownOrganizationTargets,
    input: {
      readonly actualAssignment: unknown;
      readonly actualMembership: unknown;
      readonly facts: typeof CustomerProfileOrganizationIcoFactsCurrentSchema.Type;
      readonly jobId: OrganizationFixture['accepted']['jobId'];
      readonly prepared: readonly Effect.Success<ReturnType<typeof seedOrganizationBusinessProfileNativeFixture>>[];
    },
  ) {
    const { actualAssignment, actualMembership, facts, jobId, prepared } = input;
    const rows = yield* fixture.ledgerFor(jobId);
    const membershipEffect = rows.find((row) => row.effectKey === MEMBERSHIP_EFFECT);
    const assignmentEffect = rows.find((row) => row.effectKey === ASSIGN_EFFECT);
    assert.isDefined(membershipEffect);
    assert.isDefined(assignmentEffect);
    if (membershipEffect === undefined || assignmentEffect === undefined) {
      return yield* Effect.die('Both immutable original effect acknowledgments must exist');
    }
    const membershipInvocation = Option.getOrUndefined(membershipEffect.ownerInvocationId);
    const assignmentInvocation = Option.getOrUndefined(assignmentEffect.ownerInvocationId);
    if (membershipInvocation === undefined || assignmentInvocation === undefined) {
      return yield* Effect.die('Receipt recovery requires the actual original Core invocation');
    }
    // The retained materialized command is the source of receipt identity, never the current business row.
    const originalRows =
      yield* fixture.admin`select effect_key as "effectKey",coalesce(resolved_effect,effect)#>'{intent,payload}' as payload from symmy_integration.job_effects where job_id=${jobId}`;
    const originals = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          effectKey: Schema.String.pipe(Schema.brand('OrganizationNativeEffectKey')),
          payload: Schema.Unknown,
        }),
      ),
    )(originalRows);
    const retainedMembership = yield* Schema.decodeUnknownEffect(OrganizationMembershipSourcePayloadSchema)(
      originals.find((row) => row.effectKey === MEMBERSHIP_EFFECT)?.payload,
    );
    const retainedAssignment = yield* Schema.decodeUnknownEffect(AssignCounterpartyPriceGroupPayloadSchema)(
      originals.find((row) => row.effectKey === ASSIGN_EFFECT)?.payload,
    );
    expect(yield* Schema.encodeEffect(OrganizationMembershipSourcePayloadSchema)(retainedMembership)).toEqual(
      actualMembership,
    );
    expect(yield* Schema.encodeEffect(AssignCounterpartyPriceGroupPayloadSchema)(retainedAssignment)).toEqual(
      actualAssignment,
    );
    const membershipRequest = yield* Schema.decodeUnknownEffect(CustomerGroupMembershipSourceReceiptRequestSchema)({
      effectId: retainedMembership.source.effectId,
      manager: retainedMembership.manager,
      processingKind: 'ORG_BUSINESS_REFERENCE',
      profile: retainedMembership.profile,
      route: retainedMembership.route,
    });
    const assignmentRequest = yield* Schema.decodeUnknownEffect(CustomerPriceGroupAssignmentReceiptRequestSchema)({
      actionInvocationId: assignmentInvocation,
      authorizationSubject: { counterpartyRef: retainedAssignment.counterpartyRef, kind: 'COUNTERPARTY' },
      originalCommand: {
        _tag: 'COUNTERPARTY',
        payload: yield* Schema.encodeEffect(AssignCounterpartyPriceGroupPayloadSchema)(retainedAssignment),
      },
      profile: retainedAssignment.profile,
    });
    const recoveryPolicies = [];
    const recoveryIntents = [
      {
        consumerModuleId: COMMERCE_MODULE,
        expectedProfileRevision: facts.profileRevision,
        fields: ORGANIZATION_MEMBERSHIP_RECOVER_FIELDS,
        inputDigest: computeCanonicalValueHash(membershipRequest),
        kind: 'COUNTERPARTY_PROFILE',
        operation: 'customer-group-membership.recover',
        profileRef: targets.profileRef,
        projectionVersion: ORGANIZATION_MEMBERSHIP_PROJECTION_VERSION,
      },
      {
        consumerModuleId: COMMERCE_MODULE,
        fields: ORGANIZATION_PRICE_ASSIGNMENT_RECEIPT_READ_FIELDS,
        inputDigest: computeCanonicalValueHash(
          yield* Schema.encodeEffect(CustomerPriceGroupAssignmentReceiptRequestSchema)(assignmentRequest),
        ),
        kind: 'COUNTERPARTY_PROFILE',
        operation: 'PRICE_GROUP_ASSIGNMENT_RECEIPT_READ',
        profileRef: targets.profileRef,
        projectionVersion: ORGANIZATION_PRICE_ASSIGNMENT_PROJECTION_VERSION,
      },
    ];
    for (const raw of recoveryIntents) {
      recoveryPolicies.push(
        yield* seedOrganizationBusinessProfileNativeFixture({
          callers: [
            { authMethod: 'session', principalId: fixture.integration.issuerPrincipalId },
            { authMethod: 'system', principalId: fixture.systemId },
          ],
          connections: fixture.isolated.connections,
          expectedProfileRevision: facts.profileRevision,
          governancePrincipalId: fixture.integration.issuerPrincipalId,
          intent: yield* Schema.decodeUnknownEffect(knownIntents, { onExcessProperty: 'error' })(raw),
          legalEntityId: fixture.legalEntityId,
          ownedDatabase: fixture.isolated,
          purpose: FIXTURE_PURPOSE,
          tenantId: fixture.tenantId,
        }),
      );
    }
    yield* fixture.start('privacy', {
      ONTOS_PRIVACY_ORGANIZATION_BUSINESS_CONTEXTS: JSON.stringify(
        [...fixture.prepared, ...prepared, ...recoveryPolicies].flatMap((policy) => policy.contexts),
      ),
    });
    for (const policy of recoveryPolicies) {
      yield* executeRecordPrivacyApplicabilityWithAuthorization(
        policy.recordPayload,
        yield* fixture.authorize('privacy'),
        randomUUID(),
        fixture.options('privacy'),
      );
      expect(Option.isSome((yield* policy.observe()).decision)).toBe(true);
    }
    const readMembership = fixture.readOriginalReceipt({
      actionInvocationId: membershipInvocation,
      actionKey: MEMBERSHIP_ACTION,
      body: yield* Schema.decodeUnknownEffect(Schema.Json)(
        yield* Schema.encodeEffect(CustomerGroupMembershipSourceReceiptRequestSchema)(membershipRequest),
      ),
      declarationKey: 'commerce.customer-context.customer-group-membership-source-receipt.read',
      endpoint: 'customer-group-membership-source-receipt',
      readKey: 'commerce.customer-context.api.customer-group-membership-source-receipt',
      requestHash: computeCanonicalValueHash(membershipRequest),
    });
    const readAssignment = fixture.readOriginalReceipt({
      actionInvocationId: assignmentInvocation,
      actionKey: ASSIGN_ACTION,
      body: yield* Schema.decodeUnknownEffect(Schema.Json)(
        yield* Schema.encodeEffect(CustomerPriceGroupAssignmentReceiptRequestSchema)(assignmentRequest),
      ),
      declarationKey: 'commerce.customer-context.customer-price-group-assignment-receipt.read',
      endpoint: 'customer-price-group-assignment-receipt',
      readKey: 'commerce.customer-context.api.customer-price-group-assignment-receipt',
      requestHash: computeCanonicalValueHash(assignmentRequest),
    });
    const membershipResponse = yield* readMembership;
    expect(membershipResponse.status).toBe(200);
    const originalMembership = yield* membershipResponse.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(CustomerGroupMembershipSourceReceiptResponseSchema)),
    );
    expect(originalMembership.processingKind).toBe('ORG_BUSINESS_REFERENCE');
    expect(originalMembership.source.effectId).toBe(retainedMembership.source.effectId);
    const assignmentResponse = yield* readAssignment;
    expect(assignmentResponse.status).toBe(200);
    const originalAssignment = yield* assignmentResponse.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(CustomerPriceGroupAssignmentReceiptResponseSchema)),
    );
    yield* Match.value(originalAssignment).pipe(
      Match.tag('INDETERMINATE', () => Effect.die('Original assignment must be committed')),
      Match.tag('COMMITTED', ({ receipt }) =>
        Effect.sync(() => {
          expect(receipt.actionInvocationId).toBe(assignmentInvocation);
          expect(Object.keys(receipt)).toHaveLength(10);
          expect(Object.keys(receipt)).toEqual(
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
        }),
      ),
      Match.exhaustive,
    );
    const originalLedger = yield* fixture.ledgerFor(jobId);
    const beforeHold =
      yield* fixture.admin`select action_invocation_id,status from core.action_invocations where tenant_id=${fixture.tenantId} and action_key in (${MEMBERSHIP_ACTION},${ASSIGN_ACTION}) order by action_invocation_id`;
    const [membershipPolicy, assignmentPolicy] = recoveryPolicies;
    if (membershipPolicy === undefined || assignmentPolicy === undefined) {
      return yield* Effect.die('Two explicit recovery policies required');
    }
    yield* membershipPolicy.setHold(true);
    expect((yield* readMembership).status).toBe(404);
    yield* membershipPolicy.setHold(false);
    const releasedMembership = yield* readMembership;
    expect(releasedMembership.status).toBe(200);
    expect(
      yield* releasedMembership.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CustomerGroupMembershipSourceReceiptResponseSchema)),
      ),
    ).toEqual(originalMembership);
    yield* assignmentPolicy.setHold(true);
    expect((yield* readAssignment).status).toBe(403);
    yield* assignmentPolicy.setHold(false);
    const releasedAssignment = yield* readAssignment;
    expect(releasedAssignment.status).toBe(200);
    expect(
      yield* releasedAssignment.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(CustomerPriceGroupAssignmentReceiptResponseSchema)),
      ),
    ).toEqual(originalAssignment);
    expect(
      yield* fixture.admin`select action_invocation_id,status from core.action_invocations where tenant_id=${fixture.tenantId} and action_key in (${MEMBERSHIP_ACTION},${ASSIGN_ACTION}) order by action_invocation_id`,
    ).toEqual(beforeHold);
    expect(yield* fixture.ledgerFor(jobId)).toEqual(originalLedger);
    yield* Effect.logInfo({ phase: 'original-receipts-and-hold-controls-accepted' });
    return recoveryPolicies;
  },
);
const runKnownOrganizationFollowup = Effect.fn('OrganizationSourceCustomer.knownFollowup')(function* knownFollowup(
  fixture: OrganizationFixture,
  targets: KnownOrganizationTargets,
) {
  let firstStatus = yield* fixture.statusFor(fixture.accepted.jobId);
  for (let attempt = 0; attempt < 200 && firstStatus.status !== 'completed_all'; attempt += 1) {
    yield* Effect.sleep(Duration.millis(50));
    firstStatus = yield* fixture.statusFor(fixture.accepted.jobId);
  }
  expect(firstStatus.status).toBe('completed_all');
  yield* fixture.worker.child.kill();
  yield* fixture.worker.child.exitCode;
  const facts = yield* executeCustomerProfileOrganizationIcoFactsWithAuthorization(
    { profileRef: targets.profileRef },
    yield* fixture.authorize(COMMERCE_APP),
    randomUUID(),
    fixture.options(COMMERCE_APP),
  );
  const historical = yield* executeCustomerProfileOrganizationIcoFactsWithAuthorization(
    { identityState: 'HISTORICAL', profileRef: targets.profileRef },
    yield* fixture.authorize(COMMERCE_APP),
    randomUUID(),
    fixture.options(COMMERCE_APP),
  );
  if (
    !Schema.is(CustomerProfileOrganizationIcoFactsCurrentSchema)(facts) ||
    !Schema.is(CustomerProfileOrganizationIcoFactsHistoricalIdentitySchema)(historical)
  ) {
    return yield* Effect.die('Actual protected profile facts must be available before governance setup');
  }
  expect(historical.profileRevision).toBe(facts.profileRevision);
  expect(historical.profileRef).toEqual(facts.profileRef);
  // The catalog proves a definition current at the real operation time, independently of the later assignment schedule.
  const priceDefinitionStart = DateTime.toDateUtc(DateTime.makeUnsafe(fixture.priceEffectiveFrom)).getTime();
  while (DateTime.toDateUtc(yield* DateTime.now).getTime() <= priceDefinitionStart) {
    yield* Effect.sleep(Duration.millis(250));
  }
  const assignmentEffectiveFrom = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 2 }));

  const occurrenceId = randomUUID();
  const profile = { profileKind: 'COUNTERPARTY', profileRef: targets.profileRef };
  const manager = {
    factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
    issuer: fixture.acceptedProfile.payload.source.issuer,
    sourceNamespace: fixture.acceptedProfile.payload.source.namespace,
    tenantId: fixture.tenantId,
  };
  const route = { id: fixture.sourceRouteId, revision: fixture.acceptedProfile.payload.source.route.revision };
  yield* seedCustomerGroupMembershipSourceAuthority({
    adminConnectionString: Redacted.make(fixture.isolated.connections.admin.connectionString),
    fixture: fixture.isolated,
    operatorPrincipalId: fixture.integration.issuerPrincipalId,
    operatorProviderUserId: fixture.shell.providerUserId,
    route: yield* Schema.decodeUnknownEffect(CustomerGroupMembershipSourceAuthorityFixtureRouteSchema)({
      active: true,
      allowComplete: false,
      completenessContract: null,
      issuer: manager.issuer,
      legalEntityId: fixture.legalEntityId,
      principalId: fixture.systemId,
      routeId: route.id,
      routeRevision: route.revision,
      sourceNamespace: manager.sourceNamespace,
      tenantId: fixture.tenantId,
    }),
  });
  const membership = yield* Schema.decodeUnknownEffect(OrganizationMembershipSourcePayloadSchema)({
    effectiveAt: DateTime.formatIso(yield* DateTime.now),
    groupRef: targets.groupRef,
    manager,
    operation: 'ASSIGN',
    processingKind: 'ORG_BUSINESS_REFERENCE',
    profile,
    reasonCode: 'SOURCE_MEMBERSHIP_ASSERTED',
    route,
    source: {
      assertionId: occurrenceId,
      effectId: 'ASSIGNED_BY_NATIVE_ADMISSION',
      order: 1,
      sourceRecordId: fixture.sourceReference.recordId,
    },
  });
  const assignment = yield* Schema.decodeUnknownEffect(AssignCounterpartyPriceGroupPayloadSchema)({
    counterpartyRef: targets.counterpartyRef,
    effectiveFrom: assignmentEffectiveFrom,
    expectedProfileRevision: facts.profileRevision,
    priceGroupRef: targets.priceGroupRef,
    processingKind: 'ORGANIZATION_BUSINESS',
    profile: { ...targets.profileRef, kind: 'COUNTERPARTY' },
    source: {
      ...fixture.acceptedProfile.payload.source,
      effectId: 'ASSIGNED_BY_NATIVE_ADMISSION',
      occurrenceId,
      order: 2,
      revision: '2',
    },
  });
  const encodedMembership = yield* Schema.encodeEffect(OrganizationMembershipSourcePayloadSchema)(membership);
  const encodedAssignment = yield* Schema.encodeEffect(AssignCounterpartyPriceGroupPayloadSchema)(assignment);
  const plan = yield* Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
    items: [
      {
        effects: [
          {
            effectKey: MEMBERSHIP_EFFECT,
            intent: { _tag: 'CustomerGroupMembership', payload: encodedMembership },
            operation: {
              entrypointKey: MEMBERSHIP_ACTION,
              moduleId: COMMERCE_MODULE,
              schemaVersion: '1',
            },
            originalTarget: targets.profileRef,
          },
          {
            effectKey: ASSIGN_EFFECT,
            intent: {
              _tag: 'AssignCounterpartyPriceGroup',
              authorizationSubject: { counterpartyRef: targets.counterpartyRef, kind: 'COUNTERPARTY' },
              payload: encodedAssignment,
            },
            operation: {
              entrypointKey: ASSIGN_ACTION,
              moduleId: COMMERCE_MODULE,
              schemaVersion: '1',
            },
            originalTarget: { ...targets.profileRef, kind: 'COUNTERPARTY' },
          },
        ],
        itemKey: 'organization',
        source: {
          entityKind: fixture.acceptedProfile.payload.source.recordType,
          issuerId: fixture.acceptedProfile.payload.source.issuer,
          sourceNamespace: fixture.acceptedProfile.payload.source.namespace,
          sourceRecordId: fixture.sourceReference.recordId,
        },
        sourceOccurrenceId: occurrenceId,
      },
    ],
  });
  const admitted = yield* fixture.submitFor('INTERNAL_ORGANIZATION_KNOWN_TARGET_JOB', plan);
  const observe = (effectKey: string) =>
    observeAcceptedEffectIdNativeFixture({
      adminConnectionString: Redacted.make(fixture.isolated.connections.admin.connectionString),
      effectKey,
      jobId: admitted.jobId,
      legalEntityId: fixture.legalEntityId,
      operatorPrincipalId: fixture.integration.issuerPrincipalId,
      operatorProviderUserId: fixture.shell.providerUserId,
      ownedDatabase: fixture.isolated,
      purpose: FIXTURE_PURPOSE,
      tenantId: fixture.tenantId,
    });
  const actualMembership = {
    ...encodedMembership,
    source: { ...encodedMembership.source, effectId: yield* observe(MEMBERSHIP_EFFECT) },
  };
  const actualAssignment = {
    ...encodedAssignment,
    source: { ...encodedAssignment.source, effectId: yield* observe(ASSIGN_EFFECT) },
  };
  const safeCurrent = yield* Schema.decodeUnknownEffect(OrganizationProfileSourceCurrentSchema)({
    partyRef: facts.partyRef,
    partySourceReference: fixture.sourceReference,
    profile: {
      profileRef: { ...targets.profileRef, kind: 'COUNTERPARTY' },
      revision: facts.profileRevision,
      state: historical.profileState,
      subject: { counterpartyRef: targets.counterpartyRef, kind: 'COUNTERPARTY' },
    },
    source: fixture.acceptedProfile.payload.source,
  });
  const intents = [
    {
      consumerModuleId: COMMERCE_MODULE,
      expectedProfileRevision: facts.profileRevision,
      fields: ORGANIZATION_MEMBERSHIP_WRITE_FIELDS,
      inputDigest: computeCanonicalValueHash(actualMembership),
      kind: 'COUNTERPARTY_PROFILE',
      operation: 'customer-group-membership.write',
      profileRef: targets.profileRef,
      projectionVersion: ORGANIZATION_MEMBERSHIP_PROJECTION_VERSION,
    },
    {
      consumerModuleId: COMMERCE_MODULE,
      expectedProfileRevision: facts.profileRevision,
      fields: ORGANIZATION_PRICE_ASSIGNMENT_WRITE_FIELDS,
      inputDigest: computeCanonicalValueHash(actualAssignment),
      kind: 'COUNTERPARTY_PROFILE',
      operation: 'PRICE_GROUP_ASSIGN',
      profileRef: targets.profileRef,
      projectionVersion: ORGANIZATION_PRICE_ASSIGNMENT_PROJECTION_VERSION,
    },
    {
      consumerModuleId: COMMERCE_MODULE,
      expectedProfileRevision: facts.profileRevision,
      fields: ORGANIZATION_PROFILE_SOURCE_CURRENT_FIELDS,
      inputDigest: computeCanonicalValueHash(
        yield* Schema.encodeEffect(OrganizationProfileSourceCurrentSchema)(safeCurrent),
      ),
      kind: 'COUNTERPARTY_PROFILE',
      operation: SOURCE_READ_OPERATION,
      profileRef: targets.profileRef,
      profileSource: safeCurrent.source,
      projectionVersion: ORGANIZATION_PROFILE_SOURCE_CURRENT_VERSION,
      sourceReference: safeCurrent.partySourceReference,
    },
  ];
  const prepared = [];
  for (const raw of intents) {
    const intent = yield* Schema.decodeUnknownEffect(knownIntents, { onExcessProperty: 'error' })(raw);
    prepared.push(
      yield* seedOrganizationBusinessProfileNativeFixture({
        callers: [
          { authMethod: 'session', principalId: fixture.integration.issuerPrincipalId },
          { authMethod: 'system', principalId: fixture.systemId },
          ...(intent.operation === SOURCE_READ_OPERATION
            ? [{ authMethod: 'api_key' as const, principalId: fixture.integration.principalId }]
            : []),
        ],
        connections: fixture.isolated.connections,
        expectedProfileRevision: facts.profileRevision,
        governancePrincipalId: fixture.integration.issuerPrincipalId,
        intent,
        legalEntityId: fixture.legalEntityId,
        ownedDatabase: fixture.isolated,
        purpose: FIXTURE_PURPOSE,
        tenantId: fixture.tenantId,
      }),
    );
  }
  yield* fixture.start('privacy', {
    ONTOS_PRIVACY_ORGANIZATION_BUSINESS_CONTEXTS: JSON.stringify([
      ...fixture.prepared.flatMap((item) => item.contexts),
      ...prepared.flatMap((item) => item.contexts),
    ]),
  });
  for (const policy of prepared) {
    expect(Option.isNone((yield* policy.observe()).decision)).toBe(true);
    yield* executeRecordPrivacyApplicabilityWithAuthorization(
      policy.recordPayload,
      yield* fixture.authorize('privacy'),
      randomUUID(),
      fixture.options('privacy'),
    );
    expect(Option.isSome((yield* policy.observe()).decision)).toBe(true);
  }
  yield* Effect.logInfo({ phase: 'known-profile-governance-accepted' });
  const worker = yield* fixture.startWorker();
  let rows = yield* fixture.ledgerFor(admitted.jobId);
  for (
    let attempt = 0;
    attempt < 600 && !(rows.length === 2 && rows.every((row) => row.state === 'settled'));
    attempt += 1
  ) {
    yield* Effect.sleep(Duration.millis(50));
    rows = yield* fixture.ledgerFor(admitted.jobId);
  }
  if (!rows.every((row) => row.state === 'settled')) {
    yield* fixture.writeDiagnostics();
    yield* Effect.logError({ rows, worker: yield* worker.diagnostic });
  }
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.state === 'settled')).toBe(true);
  for (const effect of rows) {
    const id = Option.getOrUndefined(effect.ownerInvocationId);
    expect(id).toBeDefined();
    if (id === undefined) {
      return yield* Effect.die('Known-target native ACK must retain actual Core invocation');
    }
    const [native] = yield* fixture.admin<{
      count: number;
    }>`select count(*)::integer as count from core.action_invocations a join symmy_integration.job_effects e on e.owner_invocation_id=a.action_invocation_id and e.tenant_id=a.tenant_id where a.action_invocation_id=${id} and a.tenant_id=${fixture.tenantId} and a.legal_entity_id=${fixture.legalEntityId} and a.principal_id=${fixture.systemId} and a.status='succeeded' and e.owner_executor_principal_id=a.principal_id and e.owner_request_hash=a.request_hash and e.owner_auth_context_ref=a.auth_context_ref and a.idempotency_key=e.effect_id::text`;
    expect(native?.count).toBe(1);
  }
  yield* Effect.logInfo({ phase: 'known-profile-native-membership-and-price-accepted' });
  const recoveryPolicies = yield* verifyOrganizationOriginalReceipts(fixture, targets, {
    actualAssignment,
    actualMembership,
    facts,
    jobId: admitted.jobId,
    prepared,
  });
  return { facts, historical, prepared, recoveryPolicies, safeCurrent, worker };
});
const verifyOrganizationZeroLegacyIco = Effect.fn('OrganizationSourceCustomer.icoCutover')(function* icoCutover(
  fixture: OrganizationFixture,
  targets: KnownOrganizationTargets,
  known: Effect.Success<ReturnType<typeof runKnownOrganizationFollowup>>,
) {
  const governance = [];
  for (const operation of [
    'customer-profile-ico.read',
    'customer-profile-ico.write',
    'customer-profile-ico.migrate',
  ] as const) {
    governance.push(
      yield* seedOrganizationIcoNativeFixture({
        callers: [
          { authMethod: 'session', principalId: fixture.integration.issuerPrincipalId },
          { authMethod: 'system', principalId: fixture.systemId },
          { authMethod: 'api_key', principalId: fixture.integration.principalId },
        ],
        connections: fixture.isolated.connections,
        governancePrincipalId: fixture.integration.issuerPrincipalId,
        legalEntityId: fixture.legalEntityId,
        ownedDatabase: fixture.isolated,
        purpose: FIXTURE_PURPOSE,
        target: {
          expectedRevision: known.facts.profileRevision,
          kind: 'PROFILE',
          request: { fields: ORGANIZATION_PROFILE_ICO_FIELDS, operation, profileRef: targets.profileRef },
        },
        tenantId: fixture.tenantId,
      }),
    );
  }
  const nameInput = yield* organizationBusinessNameExportInputDigest({
    partyRef: known.facts.partyRef,
    sourceReference: fixture.sourceReference,
  });
  const namePolicy = yield* seedOrganizationBusinessPartyNativeFixture({
    callers: [
      { authMethod: 'session', principalId: fixture.integration.issuerPrincipalId },
      { authMethod: 'api_key', principalId: fixture.integration.principalId },
    ],
    connections: fixture.isolated.connections,
    expectedPartyRevision: known.facts.partyRevision,
    governancePrincipalId: fixture.integration.issuerPrincipalId,
    intent: {
      consumerModuleId: PARTY_MODULE,
      kind: 'PARTY',
      operation: 'ORGANIZATION_BUSINESS_NAME_EXPORT',
      ...nameInput,
      fields: OrganizationBusinessNameExportFields,
    },
    legalEntityId: fixture.legalEntityId,
    ownedDatabase: fixture.isolated,
    purpose: FIXTURE_PURPOSE,
    tenantId: fixture.tenantId,
  });
  yield* fixture.start('privacy', {
    ONTOS_PRIVACY_ORGANIZATION_BUSINESS_CONTEXTS: JSON.stringify(
      [...fixture.prepared, ...known.prepared, ...known.recoveryPolicies, namePolicy].flatMap(
        (policy) => policy.contexts,
      ),
    ),
    ONTOS_PRIVACY_ORGANIZATION_PROFILE_ICO_CONTEXTS: JSON.stringify(
      governance.flatMap((policy) => policy.profileContexts),
    ),
  });
  for (const policy of [namePolicy, ...governance]) {
    expect(Option.isNone((yield* policy.observe()).decision)).toBe(true);
    yield* executeRecordPrivacyApplicabilityWithAuthorization(
      policy.recordPayload,
      yield* fixture.authorize('privacy'),
      randomUUID(),
      fixture.options('privacy'),
    );
    expect(Option.isSome((yield* policy.observe()).decision)).toBe(true);
  }
  const read = Effect.gen(function* currentIco() {
    return yield* executeOrganizationCustomerProfileIcoWithAuthorization(
      { profileRef: targets.profileRef },
      yield* fixture.authorize(COMMERCE_APP),
      randomUUID(),
      fixture.options(COMMERCE_APP),
    );
  });
  expect(Schema.is(OrganizationCustomerProfileIcoResponseSchema.members[0])(yield* read)).toBe(true);
  const input = { asOf: DateTime.formatIso(yield* DateTime.now), planId: randomUUID(), sourceContext: null };
  const report = yield* executeOrganizationCustomerProfileIcoMigrationWithAuthorization(
    input,
    yield* fixture.authorize(COMMERCE_APP),
    randomUUID(),
    fixture.options(COMMERCE_APP),
  );
  expect(report.records).toHaveLength(0);
  const base = {
    ...input,
    expectedPartySnapshotVersion: report.partySnapshotVersion,
    expectedTargetInventoryVersion: report.targetInventoryVersion,
  };
  expect(
    (yield* executeMigrateOrganizationCustomerProfileIcoWithAuthorization(
      { ...base, operation: 'STAGE' },
      yield* fixture.authorize(COMMERCE_APP),
      randomUUID(),
      fixture.options(COMMERCE_APP),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(MigrateOrganizationCustomerProfileIcoResultSchema)))).phase,
  ).toBe('STAGING');
  const inventory = yield* executeLegacyIcoInventoryWithAuthorization(
    { projection: ICO_PROJECTION },
    yield* fixture.authorize(PARTY_APP),
    randomUUID(),
    fixture.options(PARTY_APP),
  );
  expect(inventory.assertions).toHaveLength(0);
  expect(inventory.snapshotVersion).toBe(report.partySnapshotVersion);
  const fence = yield* executeFenceLegacyIcoAuthorityWithAuthorization(
    {
      expectedSnapshotVersion: report.partySnapshotVersion,
      migrationPlanRef: report.planId,
      projection: ICO_PROJECTION,
    },
    yield* fixture.authorize(PARTY_APP),
    randomUUID(),
    fixture.options(PARTY_APP),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(FenceLegacyIcoAuthorityResultSchema)));
  expect(fence.snapshotVersion).toBe(report.partySnapshotVersion);
  expect(
    (yield* executeMigrateOrganizationCustomerProfileIcoWithAuthorization(
      { ...base, operation: 'CUTOVER' },
      yield* fixture.authorize(COMMERCE_APP),
      randomUUID(),
      fixture.options(COMMERCE_APP),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(MigrateOrganizationCustomerProfileIcoResultSchema)))).phase,
  ).toBe('COMMERCE');
  const absent = yield* read;
  expect(Schema.is(OrganizationCustomerProfileIcoResponseSchema.members[2])(absent)).toBe(true);
  if (!Schema.is(OrganizationCustomerProfileIcoResponseSchema.members[2])(absent)) {
    return yield* Effect.die('Actual empty cutover must remain ABSENT, with no fabricated assertion');
  }
  const icoAction = 'commerce.customer-context.change-organization-customer-profile-ico';
  const icoPlan = yield* Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
    items: [
      {
        effects: [
          {
            effectKey: 'organization-ico-set',
            intent: {
              _tag: 'OrganizationCustomerProfileIco',
              payload: {
                countryCode: 'CZ',
                effectId: randomUUID(),
                effectiveAt: DateTime.formatIso(yield* DateTime.now),
                expectedRevision: absent.revision,
                identifier: { identifierType: 'ICO', value: '19' },
                operation: 'SET',
                originalInput: '19',
                profileRef: targets.profileRef,
              },
              sourceReference: fixture.sourceReference,
            },
            operation: { entrypointKey: icoAction, moduleId: COMMERCE_MODULE, schemaVersion: '1' },
            originalTarget: targets.profileRef,
          },
        ],
        itemKey: 'organization',
        source: {
          entityKind: fixture.acceptedProfile.payload.source.recordType,
          issuerId: fixture.acceptedProfile.payload.source.issuer,
          sourceNamespace: fixture.acceptedProfile.payload.source.namespace,
          sourceRecordId: fixture.sourceReference.recordId,
        },
        sourceOccurrenceId: fixture.sourceReference.occurrenceId,
      },
    ],
  });
  const icoJob = yield* fixture.submitFor('INTERNAL_ORGANIZATION_ICO_SET', icoPlan);
  let icoRows = yield* fixture.ledgerFor(icoJob.jobId);
  for (let attempt = 0; attempt < 600 && !icoRows.every((row) => row.state === 'settled'); attempt += 1) {
    yield* Effect.sleep(Duration.millis(50));
    icoRows = yield* fixture.ledgerFor(icoJob.jobId);
  }
  expect(icoRows).toHaveLength(1);
  expect(icoRows.every((row) => row.state === 'settled')).toBe(true);
  const icoInvocation = Option.getOrUndefined(icoRows.at(0)?.ownerInvocationId ?? Option.none());
  if (icoInvocation === undefined) {
    return yield* Effect.die('Company ICO native acknowledgment must retain its exact original Core invocation');
  }
  const [icoNative] = yield* fixture.admin<{
    count: number;
  }>`select count(*)::integer as count from core.action_invocations a join symmy_integration.job_effects e on e.owner_invocation_id=a.action_invocation_id and e.tenant_id=a.tenant_id where a.action_invocation_id=${icoInvocation} and a.action_key=${icoAction} and a.tenant_id=${fixture.tenantId} and a.legal_entity_id=${fixture.legalEntityId} and a.principal_id=${fixture.systemId} and a.status='succeeded' and e.owner_executor_principal_id=a.principal_id and e.owner_request_hash=a.request_hash and e.owner_auth_context_ref=a.auth_context_ref and a.idempotency_key=e.effect_id::text`;
  expect(icoNative?.count).toBe(1);

  const present = yield* read;
  if (!Schema.is(OrganizationCustomerProfileIcoResponseSchema.members[1])(present)) {
    return yield* Effect.die('Real Symmy company SET must produce current native company ICO');
  }
  expect(present.current.normalizedValue).toBe('00000019');
  expect(present.current.originalInput).toEqual({ digits: '19', kind: 'KNOWN' });
  expect(present.history).toHaveLength(1);
  const companyResponse = yield* fixture.getCompany();
  if (companyResponse.status !== 200) {
    yield* Effect.logError({
      body: yield* companyResponse.text,
      boundary: 'company-get',
      status: companyResponse.status,
    });
  }
  expect(companyResponse.status).toBe(200);
  const company = yield* companyResponse.json;
  expect(company).toMatchObject({
    contractVersion: 'INTERNAL_C14',
    customers: [
      {
        business_name: { outcome: 'AVAILABLE', value: 'Internal organization customer seventeen' },
        ico: { _tag: 'PRESENT', normalizedValue: '00000019' },
        id: fixture.acceptedProfile.payload.source.recordId,
        partyRef: known.facts.partyRef,
        profile: { profileRef: { ...targets.profileRef, kind: 'COUNTERPARTY' } },
      },
    ],
    projection: 'customers',
    unsupported_fields: ['addresses', 'groups', 'contacts'],
  });
  const output = JSON.stringify(company);
  expect(output).not.toContain('actorPrincipalId');
  expect(output).not.toContain('first_name');
  expect(output).not.toContain('last_name');
  return { governance, namePolicy, read };
});
const verifyOrganizationBusinessNameUpdate = Effect.fn('OrganizationSourceCustomer.companyNameUpdate')(
  function* companyNameUpdate(
    fixture: OrganizationFixture,
    targets: KnownOrganizationTargets,
    known: Effect.Success<ReturnType<typeof runKnownOrganizationFollowup>>,
    ico: Effect.Success<ReturnType<typeof verifyOrganizationZeroLegacyIco>>,
  ) {
    const before = yield* executeCustomerProfileOrganizationIcoFactsWithAuthorization(
      { profileRef: targets.profileRef },
      yield* fixture.authorize(COMMERCE_APP),
      randomUUID(),
      fixture.options(COMMERCE_APP),
    );
    if (!Schema.is(CustomerProfileOrganizationIcoFactsCurrentSchema)(before)) {
      return yield* Effect.die('Actual current canonical Party revision required before company update');
    }
    const occurrenceId = randomUUID();
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    const updatedName = 'Revised internal organization customer seventeen';
    const nativeUpdateInput = yield* Schema.encodeEffect(OrganizationBusinessUpdateInputSchema)(
      yield* Schema.decodeUnknownEffect(OrganizationBusinessUpdateInputSchema)({
        businessName: updatedName,
        expectedRevision: before.partyRevision,
        partyRef: before.partyRef,
        provenanceMethod: 'CLIENT_SOURCE_ASSERTION',
        provenanceSource: fixture.sourceReference.source.routeRef,
        subjectEvidence: [
          {
            kind: 'CLIENT_SOURCE_ASSERTION',
            observedSubject: 'ORGANIZATION',
            occurrenceId,
            recordId: fixture.sourceReference.recordId,
            source: fixture.sourceReference.source,
            sourceObservedAt: observedAt,
            statement: OrganizationBusinessSourceStatement,
            subjectKey: fixture.sourceReference.recordId,
          },
        ],
        validFrom: observedAt,
      }),
    );
    const digest = yield* organizationBusinessRecordInputDigest(
      yield* Schema.decodeUnknownEffect(Schema.Json)({ operation: 'UPDATE', payload: nativeUpdateInput }),
    );
    const updateIntent = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        ...OrganizationBusinessApplicabilityIntentSchema.members[1].fields,
        sourceReference: OrganizationBusinessSourceReferenceSchema,
      }),
    )({
      consumerModuleId: PARTY_MODULE,
      expectedPartyRevision: before.partyRevision,
      fields: OrganizationBusinessUpdateFields,
      inputDigest: digest.inputDigest,
      kind: 'PARTY',
      operation: 'UPDATE',
      partyRef: before.partyRef,
      projectionVersion: OrganizationBusinessRecordProjectionVersion,
      sourceReference: digest.sourceReference,
    });
    const updatePolicy = yield* seedOrganizationBusinessPartyNativeFixture({
      callers: [
        { authMethod: 'session', principalId: fixture.integration.issuerPrincipalId },
        { authMethod: 'system', principalId: fixture.systemId },
      ],
      connections: fixture.isolated.connections,
      expectedPartyRevision: before.partyRevision,
      governancePrincipalId: fixture.integration.issuerPrincipalId,
      intent: updateIntent,
      legalEntityId: fixture.legalEntityId,
      nativeUpdateInput,
      ownedDatabase: fixture.isolated,
      purpose: FIXTURE_PURPOSE,
      tenantId: fixture.tenantId,
    });
    let activeBusinessPolicies = [...fixture.prepared, ...known.prepared, ...known.recoveryPolicies];
    let activeIcoContexts = ico.governance.flatMap((policy) => policy.profileContexts);
    const restart = (name: typeof ico.namePolicy) =>
      fixture.start('privacy', {
        ONTOS_PRIVACY_ORGANIZATION_BUSINESS_CONTEXTS: JSON.stringify(
          [...activeBusinessPolicies, name, updatePolicy].flatMap((policy) => policy.contexts),
        ),
        ONTOS_PRIVACY_ORGANIZATION_PROFILE_ICO_CONTEXTS: JSON.stringify(activeIcoContexts),
      });
    yield* restart(ico.namePolicy);
    yield* executeRecordPrivacyApplicabilityWithAuthorization(
      updatePolicy.recordPayload,
      yield* fixture.authorize('privacy'),
      randomUUID(),
      fixture.options('privacy'),
    );
    expect(Option.isSome((yield* updatePolicy.observe()).decision)).toBe(true);
    const plan = yield* Schema.decodeUnknownEffect(SymmyInternalExecutionPlanSchema)({
      items: [
        {
          effects: [
            {
              effectKey: 'organization-business-name-update',
              intent: { _tag: 'PartyUpdate', payload: nativeUpdateInput },
              operation: {
                entrypointKey: 'party.registry.update-party',
                moduleId: PARTY_MODULE,
                schemaVersion: '1',
              },
              originalTarget: before.partyRef,
            },
          ],
          itemKey: 'organization',
          source: {
            entityKind: fixture.acceptedProfile.payload.source.recordType,
            issuerId: fixture.acceptedProfile.payload.source.issuer,
            sourceNamespace: fixture.acceptedProfile.payload.source.namespace,
            sourceRecordId: fixture.sourceReference.recordId,
          },
          sourceOccurrenceId: occurrenceId,
        },
      ],
    });
    const accepted = yield* fixture.submitFor('INTERNAL_ORGANIZATION_COMPANY_NAME_UPDATE', plan);
    let rows = yield* fixture.ledgerFor(accepted.jobId);
    for (let attempt = 0; attempt < 600 && !rows.every((row) => row.state === 'settled'); attempt += 1) {
      yield* Effect.sleep(Duration.millis(50));
      rows = yield* fixture.ledgerFor(accepted.jobId);
    }
    expect(rows).toHaveLength(1);
    expect(rows.every((row) => row.state === 'settled')).toBe(true);
    const after = yield* executeCustomerProfileOrganizationIcoFactsWithAuthorization(
      { profileRef: targets.profileRef },
      yield* fixture.authorize(COMMERCE_APP),
      randomUUID(),
      fixture.options(COMMERCE_APP),
    );
    if (!Schema.is(CustomerProfileOrganizationIcoFactsCurrentSchema)(after)) {
      return yield* Effect.die('Actual current Party proof is required after acknowledged update');
    }
    expect(after.partyRevision).toBeGreaterThan(before.partyRevision);
    expect(after.partyRef).toEqual(before.partyRef);
    expect(after.profileRef).toEqual(targets.profileRef);
    const nameInput = yield* organizationBusinessNameExportInputDigest({
      partyRef: after.partyRef,
      sourceReference: fixture.sourceReference,
    });
    const freshNamePolicy = yield* seedOrganizationBusinessPartyNativeFixture({
      callers: [
        { authMethod: 'session', principalId: fixture.integration.issuerPrincipalId },
        { authMethod: 'api_key', principalId: fixture.integration.principalId },
      ],
      connections: fixture.isolated.connections,
      expectedPartyRevision: after.partyRevision,
      governancePrincipalId: fixture.integration.issuerPrincipalId,
      intent: {
        consumerModuleId: PARTY_MODULE,
        fields: OrganizationBusinessNameExportFields,
        ...nameInput,
        kind: 'PARTY',
        operation: 'ORGANIZATION_BUSINESS_NAME_EXPORT',
      },
      legalEntityId: fixture.legalEntityId,
      ownedDatabase: fixture.isolated,
      purpose: FIXTURE_PURPOSE,
      tenantId: fixture.tenantId,
    });
    yield* restart(freshNamePolicy);
    yield* executeRecordPrivacyApplicabilityWithAuthorization(
      freshNamePolicy.recordPayload,
      yield* fixture.authorize('privacy'),
      randomUUID(),
      fixture.options('privacy'),
    );
    expect(Option.isSome((yield* freshNamePolicy.observe()).decision)).toBe(true);
    // The earlier approval retains the old Party evidence. It cannot authorize the revised record.
    expect((yield* fixture.getCompany()).status).toBe(503);
    const historical = yield* executeCustomerProfileOrganizationIcoFactsWithAuthorization(
      { identityState: 'HISTORICAL', profileRef: targets.profileRef },
      yield* fixture.authorize(COMMERCE_APP),
      randomUUID(),
      fixture.options(COMMERCE_APP),
    );
    if (!Schema.is(CustomerProfileOrganizationIcoFactsHistoricalIdentitySchema)(historical)) {
      return yield* Effect.die('Fresh protected profile identity is required for revised read governance');
    }
    expect(historical.profileRevision).toBe(after.profileRevision);
    const current = yield* Schema.decodeUnknownEffect(OrganizationProfileSourceCurrentSchema)({
      partyRef: after.partyRef,
      partySourceReference: fixture.sourceReference,
      profile: {
        profileRef: { ...after.profileRef, kind: 'COUNTERPARTY' },
        revision: after.profileRevision,
        state: historical.profileState,
        subject: { counterpartyRef: after.counterpartyRef, kind: 'COUNTERPARTY' },
      },
      source: fixture.acceptedProfile.payload.source,
    });
    const readCallers = [
      { authMethod: 'session' as const, principalId: fixture.integration.issuerPrincipalId },
      { authMethod: 'api_key' as const, principalId: fixture.integration.principalId },
      { authMethod: 'system' as const, principalId: fixture.systemId },
    ];
    const freshSourcePolicy = yield* seedOrganizationBusinessProfileNativeFixture({
      callers: readCallers,
      connections: fixture.isolated.connections,
      expectedProfileRevision: after.profileRevision,
      governancePrincipalId: fixture.integration.issuerPrincipalId,
      intent: yield* Schema.decodeUnknownEffect(knownReadIntent)({
        consumerModuleId: COMMERCE_MODULE,
        expectedProfileRevision: after.profileRevision,
        fields: ORGANIZATION_PROFILE_SOURCE_CURRENT_FIELDS,
        inputDigest: computeCanonicalValueHash(
          yield* Schema.encodeEffect(OrganizationProfileSourceCurrentSchema)(current),
        ),
        kind: 'COUNTERPARTY_PROFILE',
        operation: SOURCE_READ_OPERATION,
        profileRef: after.profileRef,
        profileSource: current.source,
        projectionVersion: ORGANIZATION_PROFILE_SOURCE_CURRENT_VERSION,
        sourceReference: current.partySourceReference,
      }),
      legalEntityId: fixture.legalEntityId,
      ownedDatabase: fixture.isolated,
      purpose: FIXTURE_PURPOSE,
      tenantId: fixture.tenantId,
    });
    const icoReadOperation = 'customer-profile-ico.read';
    const originalIcoRead = ico.governance.find((policy) =>
      policy.profileContexts.some((context) => context.request.operation === icoReadOperation),
    );
    if (originalIcoRead === undefined) {
      return yield* Effect.die('The original approved ICO read policy must exist before decision refresh');
    }
    const refreshedDecisionRef = `internal:organization-ico-current-decision:${randomUUID()}`;
    // Only the decision pointer changes. The existing approved policy, purpose and controller remain authoritative.
    const refreshedIcoContexts = yield* Schema.decodeUnknownEffect(
      Schema.Array(OrganizationProfileIcoApplicabilityContextSchema),
    )(originalIcoRead.profileContexts.map((context) => ({ ...context, decisionRef: refreshedDecisionRef })));
    activeBusinessPolicies = [
      ...activeBusinessPolicies.filter((policy) => policy.intent.operation !== SOURCE_READ_OPERATION),
      freshSourcePolicy,
    ];
    activeIcoContexts = [
      ...activeIcoContexts.filter((context) => context.request.operation !== icoReadOperation),
      ...refreshedIcoContexts,
    ];
    yield* restart(freshNamePolicy);
    for (const policy of [freshSourcePolicy]) {
      expect(Option.isNone((yield* policy.observe()).decision)).toBe(true);
      yield* executeRecordPrivacyApplicabilityWithAuthorization(
        policy.recordPayload,
        yield* fixture.authorize('privacy'),
        randomUUID(),
        fixture.options('privacy'),
      );
      const observation = yield* policy.observe();
      expect(Option.isSome(observation.decision)).toBe(true);
      if (Option.isSome(observation.decision)) {
        yield* Effect.logInfo({
          boundary: 'refreshed-company-read-decision',
          outcome: observation.decision.value.outcome,
        });
        expect(observation.decision.value.outcome).toBe('APPLICABLE');
      }
    }
    const refreshedIcoDecision = yield* executeRecordPrivacyApplicabilityWithAuthorization(
      { ...originalIcoRead.recordPayload, decisionId: refreshedDecisionRef },
      yield* fixture.authorize('privacy'),
      randomUUID(),
      fixture.options('privacy'),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PrivacyApplicabilityDecisionSchema)));
    expect(refreshedIcoDecision.outcome).toBe('APPLICABLE');
    expect(refreshedIcoDecision.nonPersonalApplicability?.kind).toBe('ORGANIZATION_ICO_ONLY');
    expect(refreshedIcoDecision.policyIdentities.map((identity) => identity.policyKey)).toEqual([
      originalIcoRead.policyRef,
    ]);
    expect(Option.isSome((yield* originalIcoRead.observe()).decision)).toBe(true);
    for (const policy of known.prepared) {
      expect(Option.isSome((yield* policy.observe()).decision)).toBe(true);
    }
    const specialized = yield* executeOrganizationProfileIcoApplicabilityWithAuthorization(
      { fields: ORGANIZATION_PROFILE_ICO_FIELDS, operation: icoReadOperation, profileRef: after.profileRef },
      yield* fixture.authorize('privacy'),
      randomUUID(),
      fixture.options('privacy'),
    );
    const specializedAllowed = Schema.is(OrganizationProfileIcoApplicabilityResponseSchema.members[0])(specialized);
    yield* Effect.logInfo({
      boundary: 'refreshed-company-ico-authority',
      outcome: specialized.outcome,
      reason: specializedAllowed ? 'NONE' : specialized.reason,
    });
    expect(specializedAllowed).toBe(true);
    if (specializedAllowed) {
      expect(specialized.applicabilityDecisionRef).toBe(refreshedDecisionRef);
      expect(specialized.partyRevision).toBe(after.partyRevision);
    }
    const response = yield* fixture.getCompany();
    expect(response.status).toBe(200);
    expect(yield* response.json).toMatchObject({
      customers: [
        {
          business_name: { outcome: 'AVAILABLE', value: updatedName },
          ico: { _tag: 'PRESENT', normalizedValue: '00000019' },
          id: fixture.acceptedProfile.payload.source.recordId,
        },
      ],
    });
    expect(yield* fixture.submitFor('INTERNAL_ORGANIZATION_COMPANY_NAME_UPDATE', plan)).toEqual(accepted);
    const counts =
      yield* fixture.admin`select action_key as "actionKey",count(*)::integer as count from core.action_invocations where tenant_id=${fixture.tenantId} and status='succeeded' and action_key in ('party.registry.create-party','party.registry.update-party','party.registry.counterparty-customer-onboard','commerce.customer-context.create-counterparty-purchasing-profile') group by action_key order by action_key`;
    expect(counts).toHaveLength(4);
    expect(counts.every((row) => row.count === 1)).toBe(true);
    yield* Effect.logInfo({ phase: 'company-name-updated-and-readback-under-fresh-governance' });
    return yield* Effect.void;
  },
);
it.live(
  'actual source Organization completes customer onboarding, memberships, company ICO and governed name roundtrip without future UUID policy seeds',
  () =>
    Effect.scoped(
      Effect.gen(function* organizationSourceCustomer() {
        const fixture = yield* makeOrganizationSourceCustomerOwnerFixture();
        let rows = yield* fixture.ledger;
        for (
          let attempt = 0;
          attempt < 600 && !(rows.length === 5 && rows.every((row) => row.state === 'settled'));
          attempt += 1
        ) {
          yield* Effect.sleep(Duration.millis(50));
          rows = yield* fixture.ledger;
        }
        if (rows.length !== 5 || !rows.every((row) => row.state === 'settled')) {
          yield* fixture.writeDiagnostics();
          yield* Effect.logError({ diagnostics: JSON.stringify(yield* fixture.diagnostics), rows });
        }
        expect(rows).toHaveLength(5);
        expect(rows.every((row) => row.state === 'settled')).toBe(true);
        const party = rows.find((row) => row.effectKey === 'party-create');
        const onboard = rows.find((row) => row.effectKey === 'counterparty-onboard');
        const profile = rows.find((row) => row.effectKey === 'counterparty-profile');
        assert.isOk(party);
        assert.isOk(onboard);
        assert.isOk(profile);
        if (party === undefined || onboard === undefined || profile === undefined) {
          return yield* Effect.die('Expected exact three accepted effects');
        }
        const createdParty = yield* Schema.decodeUnknownEffect(partyReceipt)(party.ownerReceipt);
        const createdCounterparty = yield* Schema.decodeUnknownEffect(onboardReceipt)(onboard.ownerReceipt);
        const createdProfile = yield* Schema.decodeUnknownEffect(profileReceipt)(profile.ownerReceipt);
        expect(createdCounterparty.partyRef).toEqual(createdParty.partyRef);
        expect(createdProfile.counterpartyRef).toEqual(createdCounterparty.counterpartyRef);
        expect(createdProfile.profileRef.tenantId).toBe(fixture.tenantId);
        const customerEffects = rows.filter((effect) =>
          ['party-create', 'counterparty-onboard', 'counterparty-profile'].includes(effect.effectKey),
        );
        expect(customerEffects).toHaveLength(3);
        for (const effect of customerEffects) {
          const invocationId = Option.getOrUndefined(effect.ownerInvocationId);
          expect(invocationId).toBeDefined();
          if (invocationId === undefined) {
            return yield* Effect.die('A native ACK must retain its exact original Core invocation');
          }
          const [native] = yield* fixture.admin<{
            count: number;
          }>`select count(*)::integer as count from core.action_invocations a join symmy_integration.job_effects e on e.owner_invocation_id=a.action_invocation_id and e.tenant_id=a.tenant_id where a.action_invocation_id=${invocationId} and a.tenant_id=${fixture.tenantId} and a.legal_entity_id=${fixture.legalEntityId} and a.principal_id=${fixture.systemId} and a.status='succeeded' and e.effect_id=${effect.effectId} and e.owner_executor_principal_id=a.principal_id and e.owner_auth_context_ref=a.auth_context_ref and e.owner_request_hash=a.request_hash and a.idempotency_key=e.effect_id::text`;
          expect(native?.count).toBe(1);
        }
        const group = yield* observeCustomerGroupSourceNativeFixture({
          adminConnectionString: Redacted.make(fixture.isolated.connections.admin.connectionString),
          legalEntityId: fixture.legalEntityId,
          operatorPrincipalId: fixture.integration.issuerPrincipalId,
          operatorProviderUserId: fixture.shell.providerUserId,
          ownedDatabase: fixture.isolated,
          source: {
            issuer: fixture.groupSource.issuer,
            mappingRevision: fixture.groupSource.mappingRevision,
            namespace: fixture.groupSource.namespace,
            recordId: fixture.groupSource.recordId,
            route: fixture.groupSource.route,
          },
          tenantId: fixture.tenantId,
        });
        expect(Option.isSome(group)).toBe(true);
        const price = rows.find((effect) => effect.effectKey === 'organization-price-create');
        assert.isOk(price);
        if (price === undefined) {
          return yield* Effect.die('Expected actual native price definition ACK');
        }
        const createdPrice = yield* Schema.decodeUnknownEffect(priceReceipt)(price.ownerReceipt);
        expect(createdPrice.priceGroupRef.tenantId).toBe(fixture.tenantId);
        expect(yield* fixture.submit).toEqual(fixture.accepted);
        const [count] = yield* fixture.admin<{
          count: number;
        }>`select count(*)::integer as count from core.action_invocations where tenant_id=${fixture.tenantId} and principal_id=${fixture.systemId} and action_key in ('party.registry.create-party','party.registry.counterparty-customer-onboard','commerce.customer-context.create-counterparty-purchasing-profile') and status='succeeded'`;
        expect(count?.count).toBe(3);
        expect(fixture.prepared.every((value) => value.intent.kind === 'SOURCE_ASSERTED')).toBe(true);
        if (Option.isNone(group)) {
          return yield* Effect.die('Native Group metadata is required for actual assignment');
        }
        const targets = {
          counterpartyRef: createdCounterparty.counterpartyRef,
          groupRef: group.value.groupRef,
          priceGroupRef: createdPrice.priceGroupRef,
          profileRef: createdProfile.profileRef,
        };
        const known = yield* runKnownOrganizationFollowup(fixture, targets).pipe(
          Effect.tapCause(() => fixture.writeDiagnostics()),
        );
        const ico = yield* verifyOrganizationZeroLegacyIco(fixture, targets, known).pipe(
          Effect.tapCause(() => fixture.writeDiagnostics()),
        );
        yield* verifyOrganizationBusinessNameUpdate(fixture, targets, known, ico).pipe(
          Effect.tapCause(() => fixture.writeDiagnostics()),
        );
        return yield* Effect.void;
      }),
    ).pipe(Effect.provide(services)),
  1_200_000,
);
