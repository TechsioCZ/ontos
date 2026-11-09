import { createActionCollector, getActionHandler } from '@app/core-runtime/testing/actions';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  OrganizationMembershipChangeEventSchema,
  OrganizationMembershipSourcePayloadSchema,
  OrganizationMembershipSourceResultSchema,
} from '../../shared/domain/organization-membership-source.ts';
import { applyCustomerGroupMembershipSourceAction } from '../../src/actions/apply-customer-group-membership-source.action.ts';
import { CommerceSourceProcessingEligibility } from '../../src/integrations/source-processing-eligibility.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const owner = 'commerce.customer-context';
const groupRef = {
  moduleId: owner,
  resourceId: '20000000-0000-4000-8000-000000000001',
  resourceType: `${owner}.customer-group`,
  tenantId,
};
const membershipRef = {
  ...groupRef,
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: `${owner}.customer-group-membership`,
};
const profile = {
  profileKind: 'COUNTERPARTY',
  profileRef: {
    ...groupRef,
    resourceId: '40000000-0000-4000-8000-000000000001',
    resourceType: `${owner}.counterparty-purchasing-profile`,
  },
};
const source = { assertionId: 'org-source-1', effectId: 'org-source-1', order: 1, sourceRecordId: 'company-1' };
const at = '2026-11-07T10:00:00.000Z';
const later = '2026-11-07T11:00:00.000Z';
const membership = {
  assignedAt: at,
  effectiveFrom: at,
  effectiveTo: null,
  groupRef,
  membershipRef,
  profile,
  removal: null,
  revision: 1,
  state: 'VALID',
};
const unused = () => Effect.die('This contract test must not call unrelated owner operations');

const collectOrganizationChange = Effect.fn('OrganizationMembershipEvents.collect')(function* collect(
  outcome: 'ASSIGNED' | 'ENDED' | 'CANCELLED',
  replayed: boolean,
) {
  const payload = yield* Schema.decodeUnknownEffect(OrganizationMembershipSourcePayloadSchema)({
    effectiveAt: outcome === 'ENDED' ? later : at,
    groupRef,
    manager: {
      factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
      issuer: 'internal-source',
      sourceNamespace: 'membership',
      tenantId,
    },
    ...(outcome === 'ASSIGNED'
      ? { operation: 'ASSIGN', reasonCode: 'SOURCE_MEMBERSHIP_ASSERTED' }
      : { expectedRevision: 1, membershipRef, operation: 'REMOVE', reasonCode: 'SOURCE_MEMBERSHIP_WITHDRAWN' }),
    processingKind: 'ORG_BUSINESS_REFERENCE',
    profile,
    route: { id: 'internal-source', revision: '1' },
    source,
  });
  const changedMembership =
    outcome === 'ASSIGNED'
      ? membership
      : {
          ...membership,
          ...(outcome === 'CANCELLED' ? { effectiveFrom: later, state: 'CANCELLED' } : { effectiveTo: later }),
          removal: {
            effectiveAt: outcome === 'ENDED' ? later : at,
            kind: outcome === 'ENDED' ? 'EXPLICIT_END' : 'EXPLICIT_CANCEL',
            recordedAt: at,
          },
          revision: 2,
        };
  const result = yield* Schema.decodeUnknownEffect(OrganizationMembershipSourceResultSchema)({
    items: [{ membership: changedMembership, outcome: outcome === 'ASSIGNED' ? 'ASSIGNED' : 'ENDED' }],
    processingKind: payload.processingKind,
    reasonCode: payload.reasonCode,
    source,
  });
  const { descriptor } = applyCustomerGroupMembershipSourceAction;
  const collector = createActionCollector(
    descriptor.domainEvents,
    owner,
    descriptor.accessEvidencePolicy,
    descriptor.auditEvidenceSchema,
  );
  const returned = yield* getActionHandler(applyCustomerGroupMembershipSourceAction)(payload, {
    actionInvocationId: '50000000-0000-4000-8000-000000000001',
    addDomainEvent: collector.addDomainEvent,
    addOutboxMessage: collector.addOutboxMessage,
    compositionRevision: 'a'.repeat(64),
    recordAuditEvidence: collector.recordAuditEvidence,
    recordDataAccess: collector.recordDataAccess,
    scope: {
      authMethod: 'system',
      correlationId: 'organization-membership-evidence',
      legalEntityId: '60000000-0000-4000-8000-000000000001',
      principalId: '70000000-0000-4000-8000-000000000001',
      tenantId,
    },
    services: { admitSnapshot: unused, apply: () => Effect.succeed({ replayed, result }), recover: unused },
  }).pipe(Effect.provideService(CommerceSourceProcessingEligibility, { check: unused }));
  expect(returned).toEqual(result);
  return collector.snapshot();
});

it.effect('emits only safe organization events and matching outbox payloads for all membership changes', () =>
  Effect.gen(function* safeOrganizationEvents() {
    for (const outcome of ['ASSIGNED', 'ENDED', 'CANCELLED'] as const) {
      const evidence = yield* collectOrganizationChange(outcome, false);
      const eventType = `${owner}.organization-customer-group-membership-${outcome.toLowerCase()}.v1`;
      expect(evidence.domainEvents).toHaveLength(1);
      expect(evidence.outboxMessages).toHaveLength(1);
      expect(evidence.domainEvents[0]).toMatchObject({ eventType, subjectResourceId: membershipRef.resourceId });
      expect(evidence.outboxMessages[0]?.message).toMatchObject({
        payloadJson: evidence.domainEvents[0]?.payloadJson,
        topic: eventType,
      });
      const safe = yield* Schema.decodeUnknownEffect(OrganizationMembershipChangeEventSchema, {
        onExcessProperty: 'error',
      })(evidence.domainEvents[0]?.payloadJson);
      expect(safe.membership).not.toHaveProperty('assignmentReason');
      expect(safe.membership).not.toHaveProperty('actorPrincipalId');
      if (safe.membership.removal !== null) {
        expect(safe.membership.removal).not.toHaveProperty('reason');
      }
    }
  }),
);

it.effect('returns original organization receipt on replay without adding event or outbox evidence', () =>
  Effect.gen(function* safeOrganizationReplay() {
    const evidence = yield* collectOrganizationChange('ASSIGNED', true);
    expect(evidence.domainEvents).toEqual([]);
    expect(evidence.outboxMessages).toEqual([]);
  }),
);
