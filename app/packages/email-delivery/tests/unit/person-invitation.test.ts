import { DateTime, Redacted, Schema } from 'effect';
import { expect, test } from 'effect-rstest';

import { PersonInvitationEmailInputSchema, planPersonInvitationEmail } from '../../src/dispatcher/person-invitation.ts';

const invitation = Schema.decodeSync(PersonInvitationEmailInputSchema)({
  createdAt: '2026-10-23T10:00:00.000Z',
  displayName: '<Jana & Jan>',
  email: 'jana@example.org',
  expiresAt: '2026-10-24T10:00:00.000Z',
  invitationId: '70000000-0000-4000-8000-000000000001',
  legalEntityId: '70000000-0000-4000-8000-000000000002',
  legalName: 'Společnost <s.r.o.>',
  tenantId: '70000000-0000-4000-8000-000000000003',
  token: 'a'.repeat(43),
});

test('plans one Czech invitation with a native set-password link and stable ledger key', () => {
  const email = planPersonInvitationEmail(invitation, 'https://ontos.example.org/');
  expect(email.dedupeKey).toBe(`person-invitation:${invitation.invitationId}`);
  expect(email.source).toBe('person-invitation');
  expect(email.event).toBe('PERSON_INVITED');
  expect(email.eventAt).toBe(DateTime.formatIso(invitation.createdAt));
  expect(email.recipient).toBe(invitation.email);
  expect(email.subject).toBe('Pozvánka do OntOS – Společnost <s.r.o.>');
  expect(email.text).toContain(`https://ontos.example.org/cs/set-password?token=${Redacted.value(invitation.token)}`);
  expect(email.text).toContain('jednorázový odkaz');
  expect(email.text).toContain('24. 10. 2026');
  expect(email.text).toContain('Pozvánka sama nepřiděluje žádná oprávnění');
  expect(email.html).toContain('lang="cs"');
  expect(email.html).toContain('&lt;Jana &amp; Jan&gt;');
  expect(email.html).not.toContain('<Jana');
  expect(email).not.toHaveProperty('token');
  expect(planPersonInvitationEmail(invitation, 'https://ontos.example.org').dedupeKey).toBe(email.dedupeKey);
});
