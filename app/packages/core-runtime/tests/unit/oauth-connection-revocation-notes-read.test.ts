import { Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  latestOAuthRevocationNotes,
  OAuthConnectionRevocationNotesInputSchema,
  oauthConnectionRevocationNotesRead,
} from '../../src/auth/oauth-connection-revocation-notes-read.ts';
import { ownedOAuthRevocationGrantIds, retainedOAuthRevocationGrantOwners } from '../../src/auth/oauth-grant-owners.ts';

const scope = {
  legalEntityId: '00000000-0000-4000-8000-000000000001',
  principalId: '00000000-0000-4000-8000-000000000002',
  tenantId: '00000000-0000-4000-8000-000000000003',
};
const own = '00000000-0000-4000-8000-000000000004';
const another = '00000000-0000-4000-8000-000000000005';
const notRetained = '00000000-0000-4000-8000-000000000006';
const query = { ...scope, grantIds: [own, another, notRetained] };
const owners = [
  { ...scope, grantId: own, userPrincipalId: scope.principalId },
  { ...scope, grantId: another, userPrincipalId: '00000000-0000-4000-8000-000000000007' },
];

it('requested IDs never assert ownership: self-service sees only the retained grant owner', () => {
  expect(ownedOAuthRevocationGrantIds(query, owners)).toEqual([own]);
  expect(ownedOAuthRevocationGrantIds(query, [])).toEqual([]);
});
it('authorized administrators retain company visibility but cannot invent retained owners or cross scopes', () => {
  expect(retainedOAuthRevocationGrantOwners(query, owners).map((owner) => owner.grantId)).toEqual([own, another]);
  expect(
    retainedOAuthRevocationGrantOwners(
      query,
      owners.map((owner) => ({ ...owner, legalEntityId: another })),
    ),
  ).toEqual([]);
  expect(
    retainedOAuthRevocationGrantOwners(
      query,
      owners.map((owner) => ({ ...owner, tenantId: another })),
    ),
  ).toEqual([]);
  expect(retainedOAuthRevocationGrantOwners({ ...query, grantIds: [notRetained] }, owners)).toEqual([]);
});
it('historical notes without grant-user evidence survive; the newest nonblank note wins, not actor identity', () => {
  expect(
    latestOAuthRevocationNotes([
      { evidence: { note: '  ' }, grantId: own },
      { evidence: { note: ' newest ', revokedByPrincipalId: another }, grantId: own },
      { evidence: { note: 'older', userPrincipalId: another }, grantId: own },
      { evidence: { note: 'historical admin reason' }, grantId: another },
      { evidence: { note: 42 }, grantId: notRetained },
    ]),
  ).toEqual([
    { grantId: own, note: 'newest' },
    { grantId: another, note: 'historical admin reason' },
  ]);
});
it('the governed read is bounded, exact-company and returns only notes, not a generic audit capability', () => {
  const decode = Schema.decodeUnknownOption(OAuthConnectionRevocationNotesInputSchema);
  expect(Option.isSome(decode({ grantIds: [own] }))).toBe(true);
  expect(Option.isSome(decode({ grantIds: ['not-a-grant'] }))).toBe(false);
  expect(Option.isSome(decode({ grantIds: Array.from({ length: 501 }, () => own) }))).toBe(false);
  expect(Object.keys(OAuthConnectionRevocationNotesInputSchema.fields)).toEqual(['grantIds']);
  expect(oauthConnectionRevocationNotesRead.descriptor.legalEntityScope).toBe('required');
  expect(oauthConnectionRevocationNotesRead.descriptor.entrypoint.authorization).toEqual({
    kind: 'authenticated_principal',
  });
});
