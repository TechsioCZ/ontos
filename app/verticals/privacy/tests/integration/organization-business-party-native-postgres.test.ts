import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import {
  OrganizationBusinessNameExportFields,
  OrganizationBusinessNameExportProjectionVersion,
  organizationBusinessNameExportInputDigest,
} from '@app/party-registry/apis/organization-business-name-export';
import {
  OrganizationBusinessRecordProjectionVersion,
  OrganizationBusinessSourceReferenceSchema,
  OrganizationBusinessSourceStatement,
  OrganizationBusinessUpdateFields,
  OrganizationBusinessUpdateInputSchema,
  organizationBusinessRecordInputDigest,
} from '@app/party-registry/apis/organization-record-facts';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Crypto, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { OrganizationBusinessApplicabilityIntentSchema } from '../../shared/apis/organization-business-applicability.ts';
import { PrivacyApplicabilityPolicySchema } from '../../shared/domain/privacy-applicability.ts';
import { PrivacyLegalHoldSchema } from '../../shared/domain/privacy-retention-disposition.ts';
import {
  OrganizationBusinessPartyNativeFixtureError,
  seedOrganizationBusinessPartyNativeFixture,
} from '../support/organization-business-party-native.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const { 1: PublicUpdateIntentSchema, 14: NameExportIntentSchema } =
  OrganizationBusinessApplicabilityIntentSchema.members;
const UpdateIntentSchema = Schema.Struct({
  ...PublicUpdateIntentSchema.fields,
  sourceReference: OrganizationBusinessSourceReferenceSchema,
});

it.live('prepares only Name Export and strict corporate UPDATE policies with exact native input digests', () =>
  Effect.gen(function* nativePartyNameExportPolicyOnly() {
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
    // Expected locator metadata only. Actual Party/source admission and classification remain
    // separate receiving-owner public RecordAction/NameExport acceptance, with no proof stub here.
    const partyRef = {
      moduleId: 'party.registry',
      resourceId: yield* crypto.randomUUIDv4(),
      resourceType: 'party.registry.party',
      tenantId,
    };
    const sourceReference = {
      occurrenceId: 'original-party-occurrence',
      recordId: 'original-party-record',
      source: {
        issuer: 'internal:fixture',
        namespace: 'companies',
        recordType: 'company',
        routeRef: 'original-party-route',
      },
    };
    const digest = yield* organizationBusinessNameExportInputDigest({ partyRef, sourceReference });
    const intent = yield* Schema.decodeUnknownEffect(NameExportIntentSchema)({
      consumerModuleId: 'party.registry',
      expectedPartyRevision: 7,
      fields: OrganizationBusinessNameExportFields,
      inputDigest: digest.inputDigest,
      kind: 'PARTY',
      operation: 'ORGANIZATION_BUSINESS_NAME_EXPORT',
      partyRef,
      projectionVersion: OrganizationBusinessNameExportProjectionVersion,
      sourceReference,
    });
    const input = {
      callers: [{ authMethod: 'session' as const, principalId: governancePrincipalId }],
      connections: ownedDatabase.connections,
      expectedPartyRevision: 7,
      governancePrincipalId,
      intent,
      legalEntityId,
      ownedDatabase,
      purpose: 'implementation-1096-registered-workload-gateway' as const,
      tenantId,
    };
    const fixture = yield* seedOrganizationBusinessPartyNativeFixture(input);
    expect(fixture.contexts.at(0)?.request).toEqual(intent);
    expect(fixture.contexts.at(0)?.governanceSelector).toBeUndefined();
    expect(fixture.contentScopeRef).toBe(`${OrganizationBusinessNameExportProjectionVersion}:${partyRef.resourceId}`);
    expect(fixture.recordPayload.decisionId).toBe(fixture.decisionRef);
    expect(yield* fixture.observe()).toEqual({ decision: Option.none() });
    const updateSourceReference = { ...sourceReference, occurrenceId: 'fresh-update-occurrence' };
    const updateBody = yield* Schema.decodeUnknownEffect(OrganizationBusinessUpdateInputSchema, {
      onExcessProperty: 'error',
    })({
      businessName: 'INTERNAL Synthetic Company Updated',
      expectedRevision: 7,
      partyRef,
      provenanceMethod: 'CLIENT_SOURCE_ASSERTION',
      provenanceSource: sourceReference.source.routeRef,
      subjectEvidence: [
        {
          kind: 'CLIENT_SOURCE_ASSERTION',
          observedSubject: 'ORGANIZATION',
          occurrenceId: updateSourceReference.occurrenceId,
          recordId: sourceReference.recordId,
          source: sourceReference.source,
          sourceObservedAt: DateTime.formatIso(yield* DateTime.now),
          statement: OrganizationBusinessSourceStatement,
          subjectKey: sourceReference.recordId,
        },
      ],
      validFrom: DateTime.formatIso(yield* DateTime.now),
    });
    const nativeUpdateInput = yield* Schema.encodeEffect(OrganizationBusinessUpdateInputSchema)(updateBody);
    const updateInputJson = yield* Schema.decodeUnknownEffect(Schema.Json)({
      operation: 'UPDATE',
      payload: nativeUpdateInput,
    });
    const updateDigest = yield* organizationBusinessRecordInputDigest(updateInputJson);
    const updateIntent = yield* Schema.decodeUnknownEffect(UpdateIntentSchema)({
      consumerModuleId: 'party.registry',
      expectedPartyRevision: 7,
      fields: OrganizationBusinessUpdateFields,
      inputDigest: updateDigest.inputDigest,
      kind: 'PARTY',
      operation: 'UPDATE',
      partyRef,
      projectionVersion: OrganizationBusinessRecordProjectionVersion,
      sourceReference: updateDigest.sourceReference,
    });
    const update = yield* seedOrganizationBusinessPartyNativeFixture({
      ...input,
      intent: updateIntent,
      nativeUpdateInput,
    });
    expect(yield* update.observe()).toEqual({ decision: Option.none() });
    expect(update.contexts.at(0)?.request).toEqual(updateIntent);
    expect(update.contentScopeRef).toBe(`${OrganizationBusinessRecordProjectionVersion}:${partyRef.resourceId}`);
    expect(updateIntent.sourceReference?.occurrenceId).not.toBe(sourceReference.occurrenceId);

    expect(yield* fixture.setHold(true)).toBe(true);
    expect(yield* fixture.setHold(false)).toBe(false);
    const client = yield* PgClient.make({ url: Redacted.make(ownedDatabase.connections.admin.connectionString) });
    const [raw] =
      yield* client`select policy_record from privacy.applicability_policies where tenant_id=${tenantId}::uuid and policy_key=${fixture.policyRef}`;
    const row = yield* Schema.decodeUnknownEffect(Schema.Struct({ policy_record: PrivacyApplicabilityPolicySchema }))(
      raw,
    );
    expect(row.policy_record.nonPersonalApplicability).toEqual({
      allowedFields: OrganizationBusinessNameExportFields,
      classification: 'CANONICAL_ORGANIZATION',
      consumerModuleId: 'party.registry',
      holdBehavior: 'NO_ACTIVE_SCOPE_HOLD',
      kind: 'ORGANIZATION_BUSINESS_ONLY',
      operation: 'ORGANIZATION_BUSINESS_NAME_EXPORT',
      projectionVersion: OrganizationBusinessNameExportProjectionVersion,
    });
    expect(row.policy_record.factPredicates).toContainEqual({
      dimension: 'OWNER_RESOURCE_REVISION',
      operator: 'EQUALS',
      values: ['7'],
    });
    const holds =
      yield* client`select hold_record from privacy.legal_holds where tenant_id=${tenantId}::uuid order by recorded_at`;
    const history = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ hold_record: PrivacyLegalHoldSchema })),
    )(holds);
    expect(history).toHaveLength(2);
    expect(
      history.every(
        ({ hold_record }) =>
          hold_record.contentScopeRefs.length === 1 && hold_record.contentScopeRefs.at(0) === fixture.contentScopeRef,
      ),
    ).toBe(true);
    const before = yield* client`select
      (select count(*)::int from privacy.processing_purposes where tenant_id=${tenantId}::uuid) as purposes,
      (select count(*)::int from privacy.privacy_subjects where tenant_id=${tenantId}::uuid) as subjects,
      (select count(*)::int from privacy.legal_basis_assignments where tenant_id=${tenantId}::uuid) as bases,
      (select count(*)::int from privacy.applicability_decisions where tenant_id=${tenantId}::uuid) as decisions`;
    expect(before).toEqual([{ bases: 0, decisions: 0, purposes: 2, subjects: 0 }]);
    const [updateRaw] =
      yield* client`select policy_record from privacy.applicability_policies where tenant_id=${tenantId}::uuid and policy_key=${update.policyRef}`;
    const updateRow = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ policy_record: PrivacyApplicabilityPolicySchema }),
    )(updateRaw);
    expect(updateRow.policy_record.nonPersonalApplicability).toEqual({
      allowedFields: OrganizationBusinessUpdateFields,
      classification: 'CANONICAL_ORGANIZATION',
      consumerModuleId: 'party.registry',
      holdBehavior: 'NO_ACTIVE_SCOPE_HOLD',
      kind: 'ORGANIZATION_BUSINESS_ONLY',
      operation: 'UPDATE',
      projectionVersion: OrganizationBusinessRecordProjectionVersion,
    });
    const updateSubset = yield* Schema.decodeUnknownEffect(UpdateIntentSchema)({
      ...updateIntent,
      fields: updateIntent.fields.slice(1),
    });

    const subset = yield* Schema.decodeUnknownEffect(NameExportIntentSchema)({
      ...intent,
      fields: intent.fields.slice(1),
    });
    for (const candidate of [
      { ...input, intent: updateSubset, nativeUpdateInput },
      { ...input, intent: { ...updateIntent, inputDigest: 'b'.repeat(64) }, nativeUpdateInput },
      { ...input, intent: updateIntent, nativeUpdateInput: { ...nativeUpdateInput, expectedRevision: 8 } },
      { ...input, intent: subset },
      { ...input, intent: { ...intent, inputDigest: 'b'.repeat(64) } },
      { ...input, expectedPartyRevision: 8 },
      { ...input, tenantId: legalEntityId },
      { ...input, ownedDatabase: { ...ownedDatabase } },
    ]) {
      expect(
        Schema.is(OrganizationBusinessPartyNativeFixtureError)(
          yield* Effect.flip(seedOrganizationBusinessPartyNativeFixture(candidate)),
        ),
      ).toBe(true);
    }
    const after = yield* client`select
      (select count(*)::int from privacy.processing_purposes where tenant_id=${tenantId}::uuid) as purposes,
      (select count(*)::int from privacy.privacy_subjects where tenant_id=${tenantId}::uuid) as subjects,
      (select count(*)::int from privacy.legal_basis_assignments where tenant_id=${tenantId}::uuid) as bases,
      (select count(*)::int from privacy.applicability_decisions where tenant_id=${tenantId}::uuid) as decisions`;
    expect(after).toEqual(before);
  }).pipe(Effect.scoped, Effect.provide(nativeServices), Effect.provide(Reactivity.layer)),
);
