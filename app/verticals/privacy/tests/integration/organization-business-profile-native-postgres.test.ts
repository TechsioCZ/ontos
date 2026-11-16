import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import {
  ORGANIZATION_MEMBERSHIP_PROJECTION_VERSION,
  ORGANIZATION_MEMBERSHIP_RECOVER_FIELDS,
  ORGANIZATION_MEMBERSHIP_WRITE_FIELDS,
} from '@app/commerce-customer-context/domain/organization-membership-source';
import {
  ORGANIZATION_PRICE_ASSIGNMENT_PROJECTION_VERSION,
  ORGANIZATION_PRICE_ASSIGNMENT_RECEIPT_READ_FIELDS,
  ORGANIZATION_PRICE_ASSIGNMENT_WRITE_FIELDS,
} from '@app/commerce-customer-context/domain/organization-price-assignment-fields';
import {
  ORGANIZATION_PROFILE_SOURCE_CURRENT_FIELDS,
  ORGANIZATION_PROFILE_SOURCE_CURRENT_VERSION,
} from '@app/commerce-customer-context/domain/organization-profile-source';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Crypto, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { OrganizationBusinessApplicabilityIntentSchema } from '../../shared/apis/organization-business-applicability.ts';
import { PrivacyApplicabilityPolicySchema } from '../../shared/domain/privacy-applicability.ts';
import { PrivacyLegalHoldSchema } from '../../shared/domain/privacy-retention-disposition.ts';
import {
  OrganizationBusinessProfileNativeFixtureError,
  seedOrganizationBusinessProfileNativeFixture,
} from '../support/organization-business-profile-native.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const {
  10: priceWrite,
  11: priceReceipt,
  6: profileCurrent,
  8: membershipWrite,
  9: membershipRecover,
} = OrganizationBusinessApplicabilityIntentSchema.members;
const ProfileSourceReadIntentSchema = Schema.Struct({
  ...profileCurrent.fields,
  operation: Schema.Literal('customer-profile-source.read'),
});
const ProfileIntentSchema = Schema.Union([
  membershipWrite,
  membershipRecover,
  priceWrite,
  priceReceipt,
  ProfileSourceReadIntentSchema,
]);

it.live('prepares exact current-profile membership/price/source-read policies without owner proofs or decisions', () =>
  Effect.gen(function* nativeKnownProfilePolicySetup() {
    const compositionSnapshot = yield* makeApplicationCompositionSnapshotFixture(['privacy']);
    const ownedDatabase = yield* makeIsolatedNativeDatabaseFixture({
      compositionSnapshot,
      mode: 'schema-only',
      purpose: 'implementation-1096-registered-workload-gateway',
    });
    const crypto = yield* Crypto.Crypto;
    const tenantId = yield* crypto.randomUUIDv4();
    const legalEntityId = yield* crypto.randomUUIDv4();
    const governancePrincipalId = yield* crypto.randomUUIDv4();
    const readerId = yield* crypto.randomUUIDv4();
    const profileId = yield* crypto.randomUUIDv4();
    const profileRef = {
      moduleId: 'commerce.customer-context',
      resourceId: profileId,
      resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
      tenantId,
    };
    const sourceReference = {
      occurrenceId: 'original-party-source-occurrence',
      recordId: 'original-party-source-record',
      source: {
        issuer: 'internal:fixture',
        namespace: 'companies',
        recordType: 'company',
        routeRef: 'original-party-route',
      },
    };
    const profileSource = {
      effectId: yield* crypto.randomUUIDv4(),
      issuer: 'internal:fixture',
      mappingRevision: 'internal-profile-mapping-v1',
      namespace: 'profiles',
      occurrenceId: 'actual-profile-source-occurrence',
      order: 2,
      recordId: 'actual-profile-source-record',
      recordType: 'counterparty-profile',
      revision: 'original-profile-source-v1',
      route: { id: 'original-profile-route', revision: 'original-profile-route-v1' },
    };
    const operations = [
      {
        fields: ORGANIZATION_MEMBERSHIP_WRITE_FIELDS,
        operation: 'customer-group-membership.write',
        projectionVersion: ORGANIZATION_MEMBERSHIP_PROJECTION_VERSION,
      },
      {
        fields: ORGANIZATION_MEMBERSHIP_RECOVER_FIELDS,
        operation: 'customer-group-membership.recover',
        projectionVersion: ORGANIZATION_MEMBERSHIP_PROJECTION_VERSION,
      },
      {
        fields: ORGANIZATION_PRICE_ASSIGNMENT_WRITE_FIELDS,
        operation: 'PRICE_GROUP_ASSIGN',
        projectionVersion: ORGANIZATION_PRICE_ASSIGNMENT_PROJECTION_VERSION,
      },
      {
        fields: ORGANIZATION_PRICE_ASSIGNMENT_RECEIPT_READ_FIELDS,
        operation: 'PRICE_GROUP_ASSIGNMENT_RECEIPT_READ',
        projectionVersion: ORGANIZATION_PRICE_ASSIGNMENT_PROJECTION_VERSION,
      },
      {
        fields: ORGANIZATION_PROFILE_SOURCE_CURRENT_FIELDS,
        operation: 'customer-profile-source.read',
        profileSource,
        projectionVersion: ORGANIZATION_PROFILE_SOURCE_CURRENT_VERSION,
        sourceReference,
      },
    ];
    const shared = {
      callers: [
        { authMethod: 'session' as const, principalId: governancePrincipalId },
        { authMethod: 'system' as const, principalId: readerId },
      ],
      connections: ownedDatabase.connections,
      expectedProfileRevision: 9,
      governancePrincipalId,
      legalEntityId,
      ownedDatabase,
      purpose: 'implementation-1096-registered-workload-gateway' as const,
      tenantId,
    };
    // These are explicit expected owner locators only. The real receiving owner/public RecordAction
    // acceptance must independently obtain the actual acknowledged Profile and its current revision.
    const prepared = [];
    for (const operation of operations) {
      const intent = yield* Schema.decodeUnknownEffect(ProfileIntentSchema)({
        ...operation,
        consumerModuleId: 'commerce.customer-context',
        expectedProfileRevision: 9,
        inputDigest: 'a'.repeat(64),
        kind: 'COUNTERPARTY_PROFILE',
        profileRef,
      });
      const fixture = yield* seedOrganizationBusinessProfileNativeFixture({ ...shared, intent });
      expect(yield* fixture.observe()).toEqual({ decision: Option.none() });
      expect(fixture.contexts).toHaveLength(2);
      expect(fixture.contexts.at(0)?.request).toEqual(intent);
      expect(fixture.recordPayload.decisionId).toBe(fixture.decisionRef);
      expect(fixture.contentScopeRef).toBe(`${intent.projectionVersion}:${profileId}`);
      expect(fixture.contexts.at(0)?.governanceSelector).toBeUndefined();
      prepared.push(fixture);
    }
    const first = prepared.at(0);
    if (first === undefined) {
      return yield* new OrganizationBusinessProfileNativeFixtureError({
        reason: 'An explicit native fixture must be prepared',
      });
    }
    expect(yield* first.setHold(true)).toBe(true);
    expect(yield* first.setHold(false)).toBe(false);
    const client = yield* PgClient.make({ url: Redacted.make(ownedDatabase.connections.admin.connectionString) });
    for (const fixture of prepared) {
      const [raw] =
        yield* client`select policy_record from privacy.applicability_policies where tenant_id=${tenantId}::uuid and policy_key=${fixture.policyRef}`;
      const row = yield* Schema.decodeUnknownEffect(Schema.Struct({ policy_record: PrivacyApplicabilityPolicySchema }))(
        raw,
      );
      expect(row.policy_record.nonPersonalApplicability).toEqual({
        allowedFields: fixture.intent.fields,
        classification: 'CANONICAL_ORGANIZATION',
        consumerModuleId: fixture.intent.consumerModuleId,
        holdBehavior: 'NO_ACTIVE_SCOPE_HOLD',
        kind: 'ORGANIZATION_BUSINESS_ONLY',
        operation: fixture.intent.operation,
        projectionVersion: fixture.intent.projectionVersion,
      });
      expect(row.policy_record.factPredicates).toContainEqual({
        dimension: 'OWNER_RESOURCE',
        operator: 'EQUALS',
        values: [`commerce.customer-context.counterparty-purchasing-profile:${profileId}`],
      });
      expect(row.policy_record.factPredicates).toContainEqual({
        dimension: 'OWNER_RESOURCE_REVISION',
        operator: 'EQUALS',
        values: ['9'],
      });
    }
    const holds =
      yield* client`select hold_record from privacy.legal_holds where tenant_id=${tenantId}::uuid order by recorded_at`;
    const history = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ hold_record: PrivacyLegalHoldSchema })),
    )(holds);
    expect(history).toHaveLength(2);
    expect(
      history.every(
        ({ hold_record }) =>
          hold_record.contentScopeRefs.length === 1 && hold_record.contentScopeRefs.at(0) === first.contentScopeRef,
      ),
    ).toBe(true);
    const before = yield* client`select
      (select count(*)::int from privacy.processing_purposes where tenant_id=${tenantId}::uuid) as purposes,
      (select count(*)::int from privacy.privacy_subjects where tenant_id=${tenantId}::uuid) as subjects,
      (select count(*)::int from privacy.legal_basis_assignments where tenant_id=${tenantId}::uuid) as bases,
      (select count(*)::int from privacy.applicability_decisions where tenant_id=${tenantId}::uuid) as decisions`;
    expect(before).toEqual([{ bases: 0, decisions: 0, purposes: 5, subjects: 0 }]);
    const sourceReadIntent = yield* Schema.decodeUnknownEffect(ProfileSourceReadIntentSchema)({
      consumerModuleId: 'commerce.customer-context',
      expectedProfileRevision: 9,
      fields: ORGANIZATION_PROFILE_SOURCE_CURRENT_FIELDS,
      inputDigest: 'a'.repeat(64),
      kind: 'COUNTERPARTY_PROFILE',
      operation: 'customer-profile-source.read',
      profileRef,
      profileSource,
      projectionVersion: ORGANIZATION_PROFILE_SOURCE_CURRENT_VERSION,
      sourceReference,
    });
    const sourceSubset = yield* Schema.decodeUnknownEffect(ProfileSourceReadIntentSchema)({
      ...sourceReadIntent,
      fields: sourceReadIntent.fields.slice(1),
    });
    const sourceHistorical = yield* Schema.decodeUnknownEffect(ProfileSourceReadIntentSchema)({
      ...sourceReadIntent,
      identityState: 'HISTORICAL',
    });
    expect(
      prepared.find((fixture) => fixture.intent.operation === 'customer-profile-source.read')?.contexts.at(0)?.request,
    ).toMatchObject({ profileSource, sourceReference });
    const subset = yield* Schema.decodeUnknownEffect(ProfileIntentSchema)({
      ...first.intent,
      fields: first.intent.fields.slice(1),
    });
    const historical = yield* Schema.decodeUnknownEffect(ProfileIntentSchema)({
      ...first.intent,
      fields: ORGANIZATION_MEMBERSHIP_RECOVER_FIELDS,
      identityState: 'HISTORICAL',
      operation: 'customer-group-membership.recover',
    });
    const wrongRevision = yield* Schema.decodeUnknownEffect(ProfileIntentSchema)({
      ...first.intent,
      expectedProfileRevision: 10,
    });
    for (const candidate of [
      { ...shared, intent: first.intent, ownedDatabase: { ...ownedDatabase } },
      { ...shared, intent: sourceSubset },
      { ...shared, intent: sourceHistorical },
      { ...shared, intent: historical },
      { ...shared, intent: subset },
      { ...shared, intent: wrongRevision },
      { ...shared, intent: first.intent, tenantId: legalEntityId },
    ]) {
      expect(
        Schema.is(OrganizationBusinessProfileNativeFixtureError)(
          yield* Effect.flip(seedOrganizationBusinessProfileNativeFixture(candidate)),
        ),
      ).toBe(true);
    }
    const after = yield* client`select
      (select count(*)::int from privacy.processing_purposes where tenant_id=${tenantId}::uuid) as purposes,
      (select count(*)::int from privacy.privacy_subjects where tenant_id=${tenantId}::uuid) as subjects,
      (select count(*)::int from privacy.legal_basis_assignments where tenant_id=${tenantId}::uuid) as bases,
      (select count(*)::int from privacy.applicability_decisions where tenant_id=${tenantId}::uuid) as decisions`;
    expect(after).toEqual(before);
    return yield* Effect.void;
  }).pipe(Effect.scoped, Effect.provide(nativeServices), Effect.provide(Reactivity.layer)),
);
