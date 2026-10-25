import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { PrincipalIdSchema, TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler } from '../../../../packages/core-runtime/src/actions/definition.ts';
import type { PartyContactPoint } from '../../shared/domain/contact-point.ts';
import { updateContactPointAction } from '../../src/actions/update-contact-point.action.ts';
import { endContactPointAction } from '../../src/actions/end-contact-point.action.ts';

const tenantId = Schema.decodeSync(TenantIdSchema)('20000000-0000-4000-8000-000000000001');
const principalId = Schema.decodeSync(PrincipalIdSchema)('50000000-0000-4000-8000-000000000001');
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
it.effect('correction publishes the corrected stable ref while returning the validated replacement', () =>
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
        compositionRevision: 'a'.repeat(64),
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope: {
          authMethod: 'system',
          correlationId: 'correction-test',
          principalId,
          tenantId,
        },
        services: { update: () => Effect.succeed(replacement) },
      },
    );
    if (!('contactPointRef' in result)) {
      throw new Error('contact-point correction did not return its committed result');
    }
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

it.effect('ending a contact publishes a JSON timestamp accepted by the real Action collector', () =>
  Effect.gen(function* endContactScenario() {
    const effectiveEnd = DateTime.makeUnsafe('2026-10-15T11:42:02.000Z');
    const actionInvocationId = '40000000-0000-4000-8000-000000000001';
    const reason = 'Mailbox is no longer used';
    const ended = {
      ...replacement,
      current: false,
      provenance: { ...replacement.provenance, evidenceReferences: ['evidence:party-confirmation:42'] },
      end: {
        effectiveEnd,
        endedByActionInvocationId: actionInvocationId,
        endedByPrincipalId: principalId,
        provenance: {
          evidenceReferences: ['evidence:party-confirmation:42'],
          method: 'MANUAL_CONFIRMATION',
          source: 'USER_ASSERTION',
        },
        reason,
        recordedAt: effectiveEnd,
      },
      revision: 2,
      state: 'ENDED',
      validTo: effectiveEnd,
      value: {
        displayValue: 'correct@example.test',
        lookupValue: 'correct@example.test',
        preferred: false,
        type: 'EMAIL',
      },
    } satisfies PartyContactPoint;
    const collector = createActionCollector(
      endContactPointAction.descriptor.domainEvents,
      'party.registry',
      endContactPointAction.descriptor.accessEvidencePolicy,
    );
    const result = yield* getActionHandler(endContactPointAction)(
      {
        contactPointRef: ended.contactPointRef,
        effectiveEnd,
        provenance: replacement.provenance,
        reason,
        target: { type: 'WHOLE_CONTACT_POINT' },
      },
      {
        actionInvocationId,
        compositionRevision: 'a'.repeat(64),
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope: {
          authMethod: 'system',
          correlationId: 'end-contact-test',
          principalId,
          tenantId,
        },
        services: {
          end: (command) => {
            expect(command.effectiveEnd).toBe('2026-10-15T11:42:02.000Z');
            return Effect.succeed({ changed: true, contactPoint: ended });
          },
        },
      },
    );
    expect(result).toEqual(ended);
    const snapshot = collector.snapshot();
    expect(snapshot.domainEvents).toHaveLength(1);
    expect(snapshot.domainEvents[0]?.payloadJson).toEqual({
      contactPointRef: ended.contactPointRef,
      effectiveEnd: '2026-10-15T11:42:02.000Z',
      partyRef,
      revision: 2,
    });
    expect(snapshot.outboxMessages).toHaveLength(1);
    expect(snapshot.outboxMessages[0]?.message.payloadJson).toEqual({
      contactPointRef: ended.contactPointRef,
      partyRef,
    });
  }),
);
