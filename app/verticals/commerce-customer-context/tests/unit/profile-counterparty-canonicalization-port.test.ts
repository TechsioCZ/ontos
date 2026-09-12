import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import {
  CounterpartyCanonicalizationEvidenceSchema,
  CounterpartyCanonicalizationOwnerUnavailable,
  unavailableCounterpartyCanonicalizationObservationPort,
} from '../../shared/domain/profile-counterparty-canonicalization-port.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '20000000-0000-4000-8000-000000000002';

const counterpartyRef = (resourceId: string, ownerTenantId = tenantId) => ({
  moduleId: 'party.registry' as const,
  resourceId,
  resourceType: 'party.registry.counterparty' as const,
  tenantId: ownerTenantId,
});

const evidence = {
  aliasedCounterpartyRefs: [counterpartyRef('counterparty-alias')],
  canonicalCounterpartyRef: counterpartyRef('counterparty-canonical'),
  correlationRef: 'counterparty-alias:counterparty-canonical',
  managedLegalEntityRef: {
    moduleId: 'core.identity' as const,
    resourceId: '30000000-0000-4000-8000-000000000003',
    resourceType: 'core.identity.legal-entity' as const,
    tenantId,
  },
  observedAt: '2026-09-09T12:00:00.000Z',
  policyVersion: 'party-registry-counterparty-canonicalization-v1',
  sourceDomainEventId: 'party-event-1',
  sourceEventVersion: '1',
  sourceMessageId: 'party-message-1',
  trigger: 'COUNTERPARTY_ALIAS' as const,
};

describe('Counterparty canonicalization observation port', () => {
  it.each(['CREATE_COLLISION', 'IMPORT_CORRELATION'] as const)(
    'admits %s only with complete durable canonicalization evidence',
    (trigger) => {
      const decoded = Schema.decodeUnknownSync(CounterpartyCanonicalizationEvidenceSchema)({
        ...evidence,
        trigger,
      });

      expect(decoded.sourceEventVersion).toBe(1n);
      expect(decoded.trigger).toBe(trigger);
      expect(decoded.correlationRef).toBe(evidence.correlationRef);
    },
  );

  it('rejects cross-Tenant observations before an owner handler can run', () => {
    expect(() =>
      Schema.decodeUnknownSync(CounterpartyCanonicalizationEvidenceSchema)({
        ...evidence,
        aliasedCounterpartyRefs: [counterpartyRef('counterparty-alias', otherTenantId)],
      }),
    ).toThrow();
  });

  it('rejects self aliases and duplicate aliases', () => {
    expect(() =>
      Schema.decodeUnknownSync(CounterpartyCanonicalizationEvidenceSchema)({
        ...evidence,
        aliasedCounterpartyRefs: [counterpartyRef('counterparty-canonical')],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CounterpartyCanonicalizationEvidenceSchema)({
        ...evidence,
        aliasedCounterpartyRefs: [counterpartyRef('counterparty-alias'), counterpartyRef('counterparty-alias')],
      }),
    ).toThrow();
  });

  it.effect('fails closed when Party Registry has no Counterparty canonicalization producer', () =>
    Effect.gen(function* counterpartyCanonicalizationUnavailableEffect() {
      const decoded = Schema.decodeUnknownSync(CounterpartyCanonicalizationEvidenceSchema)(evidence);
      const failure = yield* Effect.flip(unavailableCounterpartyCanonicalizationObservationPort().observe(decoded));

      expect(Schema.is(CounterpartyCanonicalizationOwnerUnavailable)(failure)).toBe(true);
      expect(failure.ownerModuleId).toBe('party.registry');
      expect(failure.retryable).toBe(true);
    }),
  );
});
