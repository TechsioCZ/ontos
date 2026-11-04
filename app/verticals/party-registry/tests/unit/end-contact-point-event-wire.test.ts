import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { DateTime, Effect, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import { EndContactPointPayloadSchema } from '../../shared/actions/end-contact-point.ts';
import { PartyContactPointSchema } from '../../shared/domain/contact-point.ts';
import type { PartyContactPoint } from '../../shared/domain/contact-point.ts';
import { endContactPointAction } from '../../src/actions/end-contact-point.action.ts';
import type { EndContactPointCommand } from '../../src/actions/end-contact-point.action.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '20000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:end-contact-point-event-wire',
  authMethod: 'session',
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId,
});
const effectiveEnd = '2099-01-01T00:00:00.000Z';
const recordedAt = '2026-09-03T12:00:00.000Z';
const provenance = {
  authoritative: false,
  method: 'MANUAL_CONFIRMATION',
  source: 'USER_ASSERTION',
} as const;
const end = {
  effectiveEnd,
  endedByActionInvocationId: '40000000-0000-4000-8000-000000000001',
  endedByPrincipalId: principal.principalId,
  provenance: { evidenceReferences: [], method: provenance.method, source: provenance.source },
  reason: 'Scheduled postal assertion End',
  recordedAt,
};
const contactPoint: PartyContactPoint = Schema.decodeUnknownSync(PartyContactPointSchema)({
  contactPointRef: {
    moduleId: 'party.registry',
    resourceId: '50000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.party-contact-point',
    tenantId,
  },
  current: true,
  end,
  partyRef: {
    moduleId: 'party.registry',
    resourceId: '60000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.party',
    tenantId,
  },
  privacyClassification: 'BUSINESS_SENSITIVE',
  provenance,
  recordedAt,
  revision: 2,
  state: 'ACTIVE',
  storedPartyRef: {
    moduleId: 'party.registry',
    resourceId: '60000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.party',
    tenantId,
  },
  validFrom: '2020-01-01T00:00:00.000Z',
  validTo: effectiveEnd,
  value: {
    address: {
      addressLine1: '1 Collector Street',
      addressLine2: null,
      city: 'Prague',
      countryCode: 'CZ',
      postalCode: '11000',
      region: null,
    },
    purposes: [
      {
        current: true,
        end,
        preferred: false,
        provenance,
        purpose: 'BILLING',
        recordedAt,
        revision: 2,
        state: 'ACTIVE',
        validFrom: '2020-01-01T00:00:00.000Z',
        validTo: effectiveEnd,
        verification: { state: 'UNVERIFIED' },
      },
    ],
    type: 'ADDRESS',
  },
  verification: { state: 'UNVERIFIED' },
});
const targets = [{ type: 'WHOLE_CONTACT_POINT' }, { target: { purpose: 'BILLING' }, type: 'ADDRESS_PURPOSE' }] as const;

for (const target of targets) {
  for (const changed of [true, false]) {
    it.effect(`${target.type} changed=${String(changed)} preserves the real collector JSON event boundary`, () =>
      Effect.gen(function* endEventWireBoundary() {
        const commands: EndContactPointCommand[] = [];
        const harness = yield* makeActionTestHarness({
          ownerRegistration: partyRegistryBackendRegistration,
          actionPermission: 'allowed',
          services: [
            bindActionTestServices(endContactPointAction, {
              end: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { changed, contactPoint };
                }),
            }),
          ],
          tenantPermission: 'allowed',
        });
        const payload = yield* Schema.decodeEffect(EndContactPointPayloadSchema)({
          contactPointRef: contactPoint.contactPointRef,
          effectiveEnd,
          provenance,
          reason: end.reason,
          target,
        });
        expect(DateTime.formatIso(payload.effectiveEnd)).toBe(effectiveEnd);
        const result = yield* harness.runtime.runAction({
          payload: yield* Schema.encodeEffect(EndContactPointPayloadSchema)(payload),
          principal,
          registration: endContactPointAction,
          transport: {
            correlationId: 'end-contact-point-event-wire',
            idempotencyKey: `${target.type}-${String(changed)}`,
            targetModuleKey: 'party.registry',
          },
        });
        expect(result).toEqual(contactPoint);
        expect(commands).toHaveLength(1);
        expect(commands[0]).toMatchObject({
          acceptedByPrincipalId: principal.principalId,
          contactPointRef: contactPoint.contactPointRef,
          effectiveEnd,
          target,
        });
        const { committed } = harness.snapshot();
        expect(committed).toHaveLength(1);
        const [commit] = committed;
        assert.isOk(commit !== undefined);
        expect(commands[0]?.acceptedByActionInvocationId).toBe(commit.actionInvocationId);
        expect(commit.evidence.domainEvents).toHaveLength(changed ? 1 : 0);
        expect(commit.evidence.outboxMessages).toHaveLength(changed ? 1 : 0);
        if (changed) {
          expect(commit.evidence.domainEvents[0]?.payloadJson).toEqual({
            contactPointRef: contactPoint.contactPointRef,
            effectiveEnd,
            partyRef: contactPoint.partyRef,
            revision: contactPoint.revision,
          });
          expect(commit.evidence.outboxMessages[0]).toMatchObject({
            domainEventIndex: 0,
            message: {
              payloadJson: { contactPointRef: contactPoint.contactPointRef, partyRef: contactPoint.partyRef },
              topic: 'party.registry.contact-point-ended.v1',
            },
          });
        }
      }),
    );
  }
}
