import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { OutboxPayloadSchema as ActivatedSchema } from '../../src/outbox/core-identity-principal-binding-activated-v1.ts';
import { OutboxPayloadSchema as ReservedSchema } from '../../src/outbox/core-identity-principal-binding-reserved-v1.ts';
import { OutboxPayloadSchema as StatusChangedSchema } from '../../src/outbox/core-identity-principal-binding-status-changed-v1.ts';
import { createChangePrincipalBindingStatusCoreIdentityPrincipalBindingStatusChangedV1OutboxMessage as statusMessage } from '../../src/modules/actions/change-principal-binding-status-core-identity-principal-binding-status-changed-v1.outbox-message.ts';

const identity = {
  authBindingId: '70000000-0000-4000-8000-000000000001',
  authenticationNamespaceId: 'test.third-provider.realm',
  bindingRevision: 1,
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId: '30000000-0000-4000-8000-000000000001',
  transitionRef: '50000000-0000-4000-8000-000000000001',
};

it('publishes exact neutral reservation and activation facts', () => {
  const reserve = Schema.decodeUnknownSync(ReservedSchema);
  const activate = Schema.decodeUnknownSync(ActivatedSchema);
  expect(reserve({ data: { ...identity, bindingStatus: 'pending' } }).data.bindingRevision).toBe(1);
  expect(() => reserve({ data: { ...identity, bindingRevision: 2, bindingStatus: 'pending' } })).toThrow();
  expect(
    activate({ data: { ...identity, bindingRevision: 2, newStatus: 'active', previousStatus: 'pending' } }).data
      .newStatus,
  ).toBe('active');
  expect(() => activate({ data: { ...identity, newStatus: 'active', previousStatus: 'pending' } })).toThrow();
  expect(() =>
    activate({ data: { ...identity, bindingRevision: 2, newStatus: 'active', previousStatus: 'revoked' } }),
  ).toThrow();
});

it('rejects terminal resurrection and fabricated no-op status events', () => {
  const decode = Schema.decodeUnknownSync(StatusChangedSchema);
  expect(() => decode({ data: { ...identity, newStatus: 'revoked', previousStatus: 'active' } })).toThrow();
  for (const previousStatus of ['pending', 'active', 'disabled', 'revoked']) {
    for (const newStatus of ['active', 'disabled', 'revoked']) {
      const payload = { data: { ...identity, bindingRevision: 2, newStatus, previousStatus } };
      const valid =
        previousStatus !== 'revoked' &&
        previousStatus !== newStatus &&
        (previousStatus !== 'pending' || newStatus === 'revoked');
      if (valid) {
        expect(decode(payload)).toEqual(payload);
      } else {
        expect(() => decode(payload)).toThrow();
      }
    }
  }
});

it('keeps the generated message JSON-safe and rejects provider or workflow data', () => {
  // The Action collector and the Outbox runtime decode published payloads with these options.
  const decode = Schema.decodeUnknownSync(StatusChangedSchema, { onExcessProperty: 'error' });
  const payload = { data: { ...identity, bindingRevision: 2, newStatus: 'revoked', previousStatus: 'active' } };
  const decoded = decode(payload);
  expect(statusMessage(decoded)).toEqual({
    payloadJson: payload,
    producerModuleKey: 'core.identity',
    topic: 'core.identity.principal-binding-status-changed.v1',
  });
  for (const field of ['providerSubjectId', 'sessionRef', 'enrollmentAttemptId', 'emailVerified']) {
    expect(() => decode({ data: { ...payload.data, [field]: 'forbidden' } })).toThrow();
  }
});
