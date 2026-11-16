import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Crypto, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { OrganizationIcoApplicabilityRequestSchema } from '../../shared/apis/organization-ico-applicability.ts';
import { OrganizationProfileIcoApplicabilityRequestSchema } from '../../shared/apis/organization-profile-ico-applicability.ts';
import { PrivacyApplicabilityPolicySchema } from '../../shared/domain/privacy-applicability.ts';
import {
  OrganizationIcoNativeFixtureError,
  seedOrganizationIcoNativeFixture,
} from '../support/organization-ico-native.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const isolation = Effect.fn('OrganizationIcoFixtureTests.isolation')(function* isolation() {
  // Setup-only test authority; this does not claim receiving-owner composition or HTTP admission.
  const compositionSnapshot = yield* makeApplicationCompositionSnapshotFixture(['privacy']);
  return yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot,
    mode: 'schema-only',
    purpose: 'implementation-1096-registered-workload-gateway',
  });
});
const scope = Effect.gen(function* actualScope() {
  const crypto = yield* Crypto.Crypto;
  return {
    governancePrincipalId: yield* crypto.randomUUIDv4(),
    legalEntityId: yield* crypto.randomUUIDv4(),
    partyId: yield* crypto.randomUUIDv4(),
    principalId: yield* crypto.randomUUIDv4(),
    profileId: yield* crypto.randomUUIDv4(),
    tenantId: yield* crypto.randomUUIDv4(),
  };
});
const requestsFor = (ids: Effect.Success<typeof scope>) => ({
  party: Schema.decodeUnknownSync(OrganizationIcoApplicabilityRequestSchema)({
    fields: ['partyRef', 'revision', 'normalizedValue'],
    operation: 'party-ico-legacy-inventory.read',
    partyRef: {
      moduleId: 'party.registry',
      resourceId: ids.partyId,
      resourceType: 'party.registry.party',
      tenantId: ids.tenantId,
    },
  }),
  profile: Schema.decodeUnknownSync(OrganizationProfileIcoApplicabilityRequestSchema)({
    fields: ['profileRef', 'partyRef', 'revision', 'normalizedValue'],
    operation: 'customer-profile-ico.write',
    profileRef: {
      moduleId: 'commerce.customer-context',
      resourceId: ids.profileId,
      resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
      tenantId: ids.tenantId,
    },
  }),
});

it.live(
  'seeds exact organization/profile governance without decisions or receipts and appends current hold history',
  () =>
    Effect.gen(function* explicitGovernanceOnly() {
      const ownedDatabase = yield* isolation();
      const ids = yield* scope;
      const requests = requestsFor(ids);
      const shared = {
        callers: [
          { authMethod: 'session' as const, principalId: ids.governancePrincipalId },
          { authMethod: 'api_key' as const, principalId: ids.principalId },
        ],
        connections: ownedDatabase.connections,
        governancePrincipalId: ids.governancePrincipalId,
        legalEntityId: ids.legalEntityId,
        ownedDatabase,
        purpose: 'implementation-1096-registered-workload-gateway' as const,
        tenantId: ids.tenantId,
      };
      const party = yield* seedOrganizationIcoNativeFixture({
        ...shared,
        target: { expectedRevision: 7, kind: 'PARTY', request: requests.party },
      });
      const profile = yield* seedOrganizationIcoNativeFixture({
        ...shared,
        target: { expectedRevision: 9, kind: 'PROFILE', request: requests.profile },
      });
      expect(party.organizationContexts).toHaveLength(2);
      expect(party.profileContexts).toHaveLength(0);
      expect(profile.profileContexts).toHaveLength(2);
      expect(profile.organizationContexts).toHaveLength(0);
      expect(party.processingScopeRef.scopeId).toBe(
        `party.registry.organization-ico-business-fields.v1:${ids.partyId}`,
      );
      expect(profile.processingScopeRef.scopeId).toBe(
        `commerce.customer-context.organization-ico-business-fields.v1:${ids.profileId}`,
      );
      expect(party.recordPayload.decisionId).toBe(party.decisionRef);
      expect(profile.recordPayload.scope.operation).toBe('customer-profile-ico.write');
      expect(yield* party.observe()).toEqual({ decision: Option.none() });
      expect(yield* profile.observe()).toEqual({ decision: Option.none() });
      expect(yield* party.setHold(true)).toBe(true);
      expect(yield* party.setHold(false)).toBe(false);
      const client = yield* PgClient.make({ url: Redacted.make(ownedDatabase.connections.admin.connectionString) });
      const rows =
        yield* client`select policy_record from privacy.applicability_policies where tenant_id=${ids.tenantId}::uuid and legal_entity_id=${ids.legalEntityId}::uuid order by policy_key`;
      const records = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ policy_record: PrivacyApplicabilityPolicySchema })),
      )(rows);
      expect(records).toHaveLength(2);
      const profilePolicy = records.find(
        ({ policy_record }) => policy_record.policyKey === profile.policyRef,
      )?.policy_record;
      expect(profilePolicy?.factPredicates).toContainEqual({
        dimension: 'OWNER_RESOURCE_REVISION',
        operator: 'EQUALS',
        values: ['9'],
      });
      expect(profilePolicy?.factPredicates).toContainEqual({
        dimension: 'OWNER_RESOURCE',
        operator: 'EQUALS',
        values: [`commerce.customer-context.counterparty-purchasing-profile:${ids.profileId}`],
      });
      expect(profilePolicy?.nonPersonalApplicability).toEqual({
        allowedFields: requests.profile.fields,
        fieldContractVersion: 'commerce.customer-context.organization-ico-business-fields.v1',
        holdBehavior: 'NO_ACTIVE_SCOPE_HOLD',
        kind: 'ORGANIZATION_ICO_ONLY',
      });
      const counts = yield* client`select
      (select count(*)::int from privacy.processing_purposes where tenant_id=${ids.tenantId}::uuid) as purposes,
      (select count(*)::int from privacy.purpose_versions where tenant_id=${ids.tenantId}::uuid) as versions,
      (select count(*)::int from privacy.responsibility_assignments where tenant_id=${ids.tenantId}::uuid and role='CONTROLLER') as controllers,
      (select count(*)::int from privacy.applicability_decisions where tenant_id=${ids.tenantId}::uuid) as decisions,
      (select count(*)::int from privacy.legal_holds where tenant_id=${ids.tenantId}::uuid) as holds,
      (select count(*)::int from privacy.legal_holds where tenant_id=${ids.tenantId}::uuid and released_at is not null) as releases`;
      expect(counts).toEqual([{ controllers: 2, decisions: 0, holds: 2, purposes: 2, releases: 1, versions: 2 }]);
    }).pipe(Effect.scoped, Effect.provide(nativeServices), Effect.provide(Reactivity.layer)),
);

it.live('refuses copied ownership, altered connection targets and cross-tenant input before governance mutation', () =>
  Effect.gen(function* refuseForgedBoundaries() {
    const ownedDatabase = yield* isolation();
    const ids = yield* scope;
    const request = requestsFor(ids).party;
    const input = {
      callers: [{ authMethod: 'session' as const, principalId: ids.governancePrincipalId }],
      connections: ownedDatabase.connections,
      governancePrincipalId: ids.governancePrincipalId,
      legalEntityId: ids.legalEntityId,
      ownedDatabase,
      purpose: 'implementation-1096-registered-workload-gateway' as const,
      target: { expectedRevision: 1, kind: 'PARTY' as const, request },
      tenantId: ids.tenantId,
    };
    const invalid = [
      { ...input, ownedDatabase: { ...ownedDatabase } },
      {
        ...input,
        connections: {
          ...input.connections,
          admin: { ...input.connections.admin, connectionString: 'postgres://invalid@127.0.0.1:1/ontos' },
        },
      },
      { ...input, tenantId: ids.legalEntityId },
    ];
    for (const candidate of invalid) {
      const error = yield* Effect.flip(seedOrganizationIcoNativeFixture(candidate));
      expect(Schema.is(OrganizationIcoNativeFixtureError)(error)).toBe(true);
    }
    const client = yield* PgClient.make({ url: Redacted.make(ownedDatabase.connections.admin.connectionString) });
    expect(
      yield* client`select count(*)::int as total from privacy.processing_purposes where tenant_id=${ids.tenantId}::uuid`,
    ).toEqual([{ total: 0 }]);
  }).pipe(Effect.scoped, Effect.provide(nativeServices), Effect.provide(Reactivity.layer)),
);
