import { expect, it } from '@app/effect-rstest';
import { DateTime, Effect } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import type { PartyContactPoint } from '../../shared/domain/contact-point.ts';
import { updateContactPointAction } from '../../src/actions/update-contact-point.action.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const originalContactPointRef = {
  moduleId: 'party.registry' as const,
  resourceId: '30000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party-contact-point' as const,
  tenantId,
};
const partyRef = {
  moduleId: 'party.registry' as const,
  resourceId: '10000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party' as const,
  tenantId,
};
const replacement: PartyContactPoint = {
  contactPointRef: {
    ...originalContactPointRef,
    resourceId: '30000000-0000-4000-8000-000000000002',
  },
  current: true,
  end: null,
  partyRef,
  privacyClassification: 'PERSONAL',
  provenance: {
    authoritative: false,
    evidenceReference: 'evidence:party-confirmation:42',
    method: 'MANUAL_CONFIRMATION',
    source: 'USER_ASSERTION',
  },
  recordedAt: DateTime.makeUnsafe('2026-09-03T10:00:00.000Z'),
  revision: 1,
  state: 'ACTIVE',
  storedPartyRef: partyRef,
  validFrom: DateTime.makeUnsafe('2026-09-03T10:00:00.000Z'),
  validTo: null,
  value: {
    displayValue: 'correct@example.test',
    lookupValue: 'correct@example.test',
    preferred: true,
    type: 'EMAIL',
  },
  verification: { state: 'UNVERIFIED' },
};
it.effect(
  'correction publishes the corrected stable ref while returning the validated replacement',
  () =>
    Effect.gen(function* correctionScenario() {
      const collector = createActionCollector(
        updateContactPointAction.descriptor.domainEvents,
        'party.registry',
        updateContactPointAction.descriptor.accessEvidencePolicy,
      );
      const handler = getActionHandler(updateContactPointAction);
      const result = yield* handler(
        {
          change: {
            evidenceReferences: ['evidence:party-confirmation:42'],
            reason: 'Original mailbox never belonged to this Party',
            replacement: {
              contactPoint: {
                preferred: true,
                type: 'EMAIL',
                value: 'correct@example.test',
              },
              privacyClassification: 'PERSONAL',
              provenance: replacement.provenance,
              validFrom: replacement.validFrom,
              verification: replacement.verification,
            },
            type: 'CORRECT_CONTACT_POINT',
          },
          contactPointRef: originalContactPointRef,
          expectedRevision: 2,
          provenance: replacement.provenance,
        },
        {
          actionInvocationId: '40000000-0000-4000-8000-000000000001',
          addDomainEvent: collector.addDomainEvent,
          addOutboxMessage: collector.addOutboxMessage,
          recordAuditEvidence: collector.recordAuditEvidence,
          recordDataAccess: collector.recordDataAccess,
          scope: {
            authMethod: 'system',
            correlationId: 'correction-test',
            principalId: '50000000-0000-4000-8000-000000000001',
            tenantId,
          },
          services: { update: () => Effect.succeed(replacement) },
        },
      );
      expect(result.contactPointRef).toEqual(replacement.contactPointRef);
      const snapshot = collector.snapshot();
      expect(snapshot.domainEvents.length).toBe(1);
      expect(snapshot.domainEvents[0]?.subjectResourceId).toBe(originalContactPointRef.resourceId);
      expect(snapshot.domainEvents[0]?.payloadJson).toEqual({
        contactPointRef: originalContactPointRef,
        partyRef,
        revision: 3,
      });
      expect(snapshot.outboxMessages[0]?.message.payloadJson).toEqual({
        contactPointRef: originalContactPointRef,
        partyRef,
      });
    }),
);
