import { createActionCollector, getActionHandler } from '@app/core-runtime/testing/actions';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AdmitCustomerGroupMembershipSnapshotPayloadSchema,
  AdmitCustomerGroupMembershipSnapshotResultSchema,
} from '../../shared/domain/customer-group-membership-snapshot.ts';
import { admitCustomerGroupMembershipSnapshotAction } from '../../src/actions/admit-customer-group-membership-snapshot.action.ts';
import { CommerceSourceProcessingEligibility } from '../../src/integrations/source-processing-eligibility.ts';

const owner = 'commerce.customer-context';
const tenantId = '10000000-0000-4000-8000-000000000001';
const groupType = 'commerce.customer-context.customer-group';
const groupIds = ['30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002'];
const payload = Schema.decodeUnknownSync(AdmitCustomerGroupMembershipSnapshotPayloadSchema)({
  completenessContract: {
    coverage: 'ALL_GROUP_MEMBERSHIPS_FOR_EXACT_PROFILE',
    ref: 'internal-completeness-contract',
    revision: '1',
  },
  expiresAt: '2026-11-07T12:00:00.000Z',
  snapshot: {
    completenessProofRef: 'internal-audit-proof',
    effectiveAt: '2026-11-07T10:00:00.000Z',
    groupRefs: groupIds.map((resourceId) => ({ moduleId: owner, resourceId, resourceType: groupType, tenantId })),
    manager: {
      factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
      issuer: 'internal-source',
      sourceNamespace: 'membership',
      tenantId,
    },
    operation: 'COMPLETE',
    profile: {
      profileKind: 'COUNTERPARTY',
      profileRef: {
        moduleId: owner,
        resourceId: '20000000-0000-4000-8000-000000000001',
        resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
        tenantId,
      },
    },
    reason: 'Internal snapshot admission evidence assertion',
    route: { id: 'internal-route', revision: '1' },
    source: {
      assertionId: 'internal-assertion',
      effectId: 'internal-effect',
      order: 1,
      sourceRecordId: 'internal-record',
    },
  },
});
const result = Schema.decodeUnknownSync(AdmitCustomerGroupMembershipSnapshotResultSchema)({
  digest: 'a'.repeat(64),
  expiresAt: payload.expiresAt,
  proofRef: payload.snapshot.completenessProofRef,
});
const unused = () => Effect.die('This evidence test must not call unrelated Membership operations');

const collectAdmissionEvidence = Effect.fn('MembershipSnapshotEvidence.collect')(function* collect(replayed: boolean) {
  const { descriptor } = admitCustomerGroupMembershipSnapshotAction;
  const collector = createActionCollector(
    descriptor.domainEvents,
    owner,
    descriptor.accessEvidencePolicy,
    descriptor.auditEvidenceSchema,
  );
  const returned = yield* getActionHandler(admitCustomerGroupMembershipSnapshotAction)(payload, {
    actionInvocationId: '40000000-0000-4000-8000-000000000001',
    addDomainEvent: collector.addDomainEvent,
    addOutboxMessage: collector.addOutboxMessage,
    compositionRevision: 'b'.repeat(64),
    recordAuditEvidence: collector.recordAuditEvidence,
    recordDataAccess: collector.recordDataAccess,
    scope: {
      authMethod: 'system',
      correlationId: 'internal-snapshot-evidence',
      legalEntityId: '50000000-0000-4000-8000-000000000001',
      principalId: '60000000-0000-4000-8000-000000000001',
      tenantId,
    },
    services: { admitSnapshot: () => Effect.succeed({ replayed, result }), apply: unused, recover: unused },
  }).pipe(Effect.provideService(CommerceSourceProcessingEligibility, { check: unused }));
  expect(returned).toEqual(result);
  return collector.snapshot();
});

it.effect('records each exact Group whose Current facts admitted the source snapshot', () =>
  Effect.gen(function* recordsGroupLookups() {
    const evidence = yield* collectAdmissionEvidence(false);
    const groups = evidence.dataAccessEvents.filter((event) => event.targetResourceType === groupType);
    expect(groups).toHaveLength(groupIds.length);
    expect(groups.map((event) => event.targetResourceId)).toEqual(groupIds);
    for (const group of groups) {
      expect(group).toMatchObject({
        accessKind: 'read',
        evidenceCaptureMode: 'metadata_only',
        queryHash: `membership-snapshot-group:${group.targetResourceId}`,
        resultCount: 1,
        servingModuleKey: owner,
        targetModuleKey: owner,
      });
      expect(group).not.toHaveProperty('evidencePayloadJson');
    }
    expect(evidence.domainEvents).toEqual([]);
  }),
);

it.effect('does not claim fresh Group reads when returning an existing snapshot proof', () =>
  Effect.gen(function* retainsReplayEvidence() {
    const evidence = yield* collectAdmissionEvidence(true);
    expect(evidence.dataAccessEvents.filter((event) => event.targetResourceType === groupType)).toEqual([]);
    expect(evidence.dataAccessEvents).toHaveLength(3);
  }),
);
