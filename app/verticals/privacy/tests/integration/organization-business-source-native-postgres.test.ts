import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import {
  OrganizationBusinessOnboardFields,
  OrganizationBusinessOnboardTemplateProjectionVersion,
  OrganizationBusinessSourceFields,
  OrganizationBusinessSourceProjectionVersion,
} from '@app/party-registry/apis/organization-record-facts';
import {
  ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS,
  ORGANIZATION_PROFILE_SOURCE_CREATE_TEMPLATE_VERSION,
} from '@app/commerce-customer-context/domain/organization-profile-source';
import { SymmySourceOrganizationFactsGovernanceSelectorSchema } from '@app/symmy-integration/api/symmy-source-organization-facts';
import { Crypto, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { OrganizationBusinessSourceIntentSchema } from '../../shared/apis/organization-business-applicability.ts';
import { PrivacyApplicabilityPolicySchema } from '../../shared/domain/privacy-applicability.ts';
import {
  OrganizationBusinessSourceNativeFixtureError,
  seedOrganizationBusinessSourceNativeFixture,
} from '../support/organization-business-source-native.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

it.live('prepares only exact source organization governance using its real native canonical record revision', () =>
  Effect.gen(function* policyOnlySourceGovernance() {
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
    const sourceReference = {
      occurrenceId: 'internal-organization-occurrence',
      recordId: 'internal-organization-source-record',
      source: {
        issuer: 'internal:fixture',
        namespace: 'organization-fixtures',
        recordType: 'company',
        routeRef: 'organization-route',
      },
    };
    const intent = yield* Schema.decodeUnknownEffect(OrganizationBusinessSourceIntentSchema)({
      consumerModuleId: 'party.registry',
      fields: OrganizationBusinessSourceFields,
      inputDigest: 'a'.repeat(64),
      kind: 'SOURCE_ASSERTED',
      operation: 'CREATE',
      projectionVersion: OrganizationBusinessSourceProjectionVersion,
      sourceReference,
    });
    // A locator template only; no Symmy provider proof or business decision is manufactured here.
    const governanceSelector = yield* Schema.decodeUnknownEffect(SymmySourceOrganizationFactsGovernanceSelectorSchema)({
      effectKey: 'company-create',
      execution: { jobId: yield* crypto.randomUUIDv4(), kind: 'JOB' },
      purpose: 'GOVERNANCE',
      sourceReference,
    });
    const input = {
      callers: [{ authMethod: 'session' as const, principalId: governancePrincipalId }],
      connections: ownedDatabase.connections,
      governancePrincipalId,
      governanceSelector,
      intent,
      legalEntityId,
      ownedDatabase,
      purpose: 'implementation-1096-registered-workload-gateway' as const,
      tenantId,
    };
    const create = yield* seedOrganizationBusinessSourceNativeFixture(input);
    const matchIntent = yield* Schema.decodeUnknownEffect(OrganizationBusinessSourceIntentSchema)({
      ...intent,
      operation: 'MATCH',
    });
    const match = yield* seedOrganizationBusinessSourceNativeFixture({ ...input, intent: matchIntent });
    const onboardIntent = yield* Schema.decodeUnknownEffect(OrganizationBusinessSourceIntentSchema)({
      ...intent,
      fields: OrganizationBusinessOnboardFields,
      operation: 'ONBOARD_COUNTERPARTY_CUSTOMER',
      projectionVersion: OrganizationBusinessOnboardTemplateProjectionVersion,
    });
    const onboard = yield* seedOrganizationBusinessSourceNativeFixture({
      ...input,
      governanceSelector: { ...governanceSelector, effectKey: 'company-onboard' },
      intent: onboardIntent,
    });
    const profileSource = {
      effectId: 'internal-profile-effect-key',
      issuer: sourceReference.source.issuer,
      mappingRevision: 'internal-mapping-v1',
      namespace: sourceReference.source.namespace,
      occurrenceId: sourceReference.occurrenceId,
      order: 2,
      recordId: sourceReference.recordId,
      recordType: sourceReference.source.recordType,
      revision: 'internal-source-v1',
      route: { id: 'organization-route', revision: 'internal-route-v1' },
    };
    const profileIntent = yield* Schema.decodeUnknownEffect(OrganizationBusinessSourceIntentSchema)({
      ...intent,
      consumerModuleId: 'commerce.customer-context',
      fields: ORGANIZATION_PROFILE_SOURCE_CREATE_FIELDS,
      operation: 'COUNTERPARTY_PROFILE_CREATE',
      profileSource,
      projectionVersion: ORGANIZATION_PROFILE_SOURCE_CREATE_TEMPLATE_VERSION,
    });
    const profile = yield* seedOrganizationBusinessSourceNativeFixture({
      ...input,
      governanceSelector: { ...governanceSelector, effectKey: 'company-profile' },
      intent: profileIntent,
    });
    for (const template of [onboard, profile]) {
      expect(template.sourceSubjectRef).toEqual(create.sourceSubjectRef);
      expect(template.sourceSubjectRevision).toBe(create.sourceSubjectRevision);
      expect(yield* template.observe()).toEqual({
        decision: Option.none(),
        sourceSubjectRevision: create.sourceSubjectRevision,
      });
      expect(template.recordPayload.scope.operation).toBe(template.intent.operation);
      expect(template.contexts.at(0)?.request).toEqual(template.intent);
      expect('resolvedTarget' in template.intent).toBe(false);
      expect('processingWitness' in template.intent).toBe(false);
    }
    expect(profile.contexts.at(0)?.request).toMatchObject({ profileSource });
    expect(create.sourceSubjectRef).toEqual(match.sourceSubjectRef);
    expect(create.sourceSubjectRevision).toBe(match.sourceSubjectRevision);
    expect(create.sourceSubjectRevision).toMatch(/^[a-f\d]{64}$/u);
    expect(yield* create.observe()).toEqual({
      decision: Option.none(),
      sourceSubjectRevision: create.sourceSubjectRevision,
    });
    expect(create.contexts).toHaveLength(1);
    expect(create.contexts.at(0)?.request).toEqual(intent);
    expect(create.contexts.at(0)?.governanceSelector).toEqual(governanceSelector);
    expect(create.recordPayload.decisionId).toBe(create.decisionRef);
    const client = yield* PgClient.make({ url: Redacted.make(ownedDatabase.connections.admin.connectionString) });
    const [raw] =
      yield* client`select policy_record from privacy.applicability_policies where tenant_id=${tenantId}::uuid and policy_key=${create.policyRef}`;
    const row = yield* Schema.decodeUnknownEffect(Schema.Struct({ policy_record: PrivacyApplicabilityPolicySchema }))(
      raw,
    );
    expect(row.policy_record.factPredicates).toContainEqual({
      dimension: 'OWNER_RESOURCE_REVISION',
      operator: 'EQUALS',
      values: [create.sourceSubjectRevision],
    });
    expect(row.policy_record.factPredicates).toContainEqual({
      dimension: 'SOURCE_OCCURRENCE',
      operator: 'EQUALS',
      values: [sourceReference.occurrenceId],
    });
    expect(row.policy_record.factPredicates).toContainEqual({
      dimension: 'SOURCE_PROJECTION_DIGEST',
      operator: 'EQUALS',
      values: [intent.inputDigest],
    });
    expect(row.policy_record.nonPersonalApplicability).toEqual({
      allowedFields: OrganizationBusinessSourceFields,
      classification: 'SOURCE_ASSERTED_ORGANIZATION',
      consumerModuleId: 'party.registry',
      holdBehavior: 'NO_ACTIVE_SCOPE_HOLD',
      kind: 'ORGANIZATION_BUSINESS_ONLY',
      operation: 'CREATE',
      projectionVersion: OrganizationBusinessSourceProjectionVersion,
    });
    const before = yield* client`select
      (select count(*)::int from privacy.privacy_subjects where tenant_id=${tenantId}::uuid) as subjects,
      (select count(*)::int from privacy.processing_purposes where tenant_id=${tenantId}::uuid) as purposes,
      (select count(*)::int from privacy.legal_basis_assignments where tenant_id=${tenantId}::uuid) as bases,
      (select count(*)::int from privacy.applicability_decisions where tenant_id=${tenantId}::uuid) as decisions`;
    expect(before).toEqual([{ bases: 0, decisions: 0, purposes: 4, subjects: 1 }]);
    for (const template of [onboard, profile]) {
      const [templateRaw] =
        yield* client`select policy_record from privacy.applicability_policies where tenant_id=${tenantId}::uuid and policy_key=${template.policyRef}`;
      const templateRow = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ policy_record: PrivacyApplicabilityPolicySchema }),
      )(templateRaw);
      expect(templateRow.policy_record.nonPersonalApplicability).toEqual({
        allowedFields: template.intent.fields,
        classification: 'SOURCE_ASSERTED_ORGANIZATION',
        consumerModuleId: template.intent.consumerModuleId,
        holdBehavior: 'NO_ACTIVE_SCOPE_HOLD',
        kind: 'ORGANIZATION_BUSINESS_ONLY',
        operation: template.intent.operation,
        projectionVersion: template.intent.projectionVersion,
      });
    }
    const subsetIntent = yield* Schema.decodeUnknownEffect(OrganizationBusinessSourceIntentSchema)({
      ...intent,
      fields: intent.fields.slice(1),
    });
    const invalid = [
      { ...input, ownedDatabase: { ...ownedDatabase } },
      {
        ...input,
        governanceSelector: {
          ...governanceSelector,
          sourceReference: { ...sourceReference, occurrenceId: 'another-occurrence' },
        },
      },
      { ...input, intent: subsetIntent },
    ];
    for (const candidate of invalid) {
      expect(
        Schema.is(OrganizationBusinessSourceNativeFixtureError)(
          yield* Effect.flip(seedOrganizationBusinessSourceNativeFixture(candidate)),
        ),
      ).toBe(true);
    }
    const after = yield* client`select
      (select count(*)::int from privacy.privacy_subjects where tenant_id=${tenantId}::uuid) as subjects,
      (select count(*)::int from privacy.processing_purposes where tenant_id=${tenantId}::uuid) as purposes,
      (select count(*)::int from privacy.legal_basis_assignments where tenant_id=${tenantId}::uuid) as bases,
      (select count(*)::int from privacy.applicability_decisions where tenant_id=${tenantId}::uuid) as decisions`;
    expect(after).toEqual(before);
  }).pipe(Effect.scoped, Effect.provide(nativeServices), Effect.provide(Reactivity.layer)),
);
