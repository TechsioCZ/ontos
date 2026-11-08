import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AccessAssignmentSchema,
  AccessCompanyIdSchema,
  AccessPeopleRevisionSchema,
  AccessHumanIdSchema,
} from '../../shared/access-admin-api.ts';

import { PeopleListResponseSchema, SetPeopleCompanyMembershipRequestSchema } from '../../shared/people-api.ts';
import type { PeopleList, Person } from '../../shared/people-api.ts';
import { isChangeConfirmed, personKindLabel } from '../../src/routes/people/people-model.ts';
import type { PeopleAccessView, PendingPeopleChange } from '../../src/routes/people/people-model.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const legalEntityId = '00000000-0000-4000-8000-000000000002';
const principalId = '00000000-0000-4000-8000-000000000003';
const principalRef = { principalId, tenantId };
const scope = { _tag: 'company', legalEntityId } as const;
const companyScope = { kind: 'company', legalEntityId: AccessCompanyIdSchema.make(legalEntityId) } as const;
const revision = AccessPeopleRevisionSchema.make('people-revision-1');
const membership = { affiliation: 'external', legalEntityId, principalRef, revision: 2, status: 'departed' } as const;
const person: Person = {
  displayName: 'Jana',
  invitationDelivery: null,
  kind: 'human',
  principalRef,
  principalStatus: 'active',
  selectedCompanyMembership: membership,
};
const list = (overrides: Partial<PeopleList> = {}): PeopleList => ({
  items: [person],
  nextOffset: null,
  scope,
  tenantId,
  ...overrides,
});

type Assignment = PeopleAccessView['people']['items'][number]['assignments'][number];
const assignment = (incarnationId: string, status: Assignment['status']): Assignment =>
  Schema.decodeUnknownSync(AccessAssignmentSchema)({
    incarnationId,
    principalId,
    roleId: '00000000-0000-4000-8000-0000000000a1',
    roleName: 'Auditor',
    scope: companyScope,
    status,
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: null,
  });
/** The canonical access view of the same scope, carrying only the assignments a test declares. */
const access = (assignments: readonly Assignment[]): PeopleAccessView => ({
  options: {
    capabilities: [],
    managers: [],
    people: [],
    revision,
    roles: [],
    scopes: [],
    teams: [],
    writeAvailability: {
      canAssign: true,
      canDelegate: false,
      canManageTeams: false,
      canRevokeDelegation: false,
      canTransferOwnership: false,
      canUnassign: true,
    },
  },
  people: {
    items: [
      {
        assignments: [...assignments],
        delegations: [],
        displayName: person.displayName,
        memberships: [],
        ownership: { administersScopes: [], soleAdministratorScopes: [] },
        principalId: AccessHumanIdSchema.make(principalId),
        suspended: false,
        teams: [],
      },
    ],
    nextCursor: null,
    revision,
  },
});

it('confirms a committed membership change only from the organisation row it reads back', () => {
  const pending: PendingPeopleChange = { kind: 'membership', result: { membership, projection: 'pending' } };
  expect(isChangeConfirmed(pending, list(), access([]))).toBe(true);
  expect(isChangeConfirmed(pending, list({ items: [] }), access([]))).toBe(false);
  expect(
    isChangeConfirmed(
      pending,
      list({ items: [{ ...person, selectedCompanyMembership: { ...membership, revision: 3 } }] }),
      access([]),
    ),
  ).toBe(false);
  expect(
    isChangeConfirmed(
      pending,
      list({ items: [{ ...person, selectedCompanyMembership: { ...membership, status: 'disabled' } }] }),
      access([]),
    ),
  ).toBe(false);
  expect(isChangeConfirmed(pending, list({ scope: { _tag: 'tenant' } }), access([]))).toBe(false);
  expect(isChangeConfirmed(pending, list({ tenantId: '00000000-0000-4000-8000-000000000009' }), access([]))).toBe(
    false,
  );
});

it('confirms a canonical role only from the exact assignment incarnation the authority read reports', () => {
  const incarnationId = '00000000-0000-4000-8000-0000000000c1';
  const assign: PendingPeopleChange = {
    change: { incarnationId, present: true, principalId },
    kind: 'role',
  };
  expect(isChangeConfirmed(assign, list(), access([]))).toBe(false);
  expect(isChangeConfirmed(assign, list(), access([assignment(incarnationId, 'active')]))).toBe(true);
  expect(isChangeConfirmed(assign, list(), access([assignment(incarnationId, 'revoked')]))).toBe(false);
  expect(
    isChangeConfirmed(assign, list(), access([assignment('00000000-0000-4000-8000-0000000000c2', 'active')])),
  ).toBe(false);
  const revoke: PendingPeopleChange = { change: { incarnationId, present: false, principalId }, kind: 'role' };
  expect(isChangeConfirmed(revoke, list(), access([]))).toBe(true);
  expect(isChangeConfirmed(revoke, list(), access([assignment(incarnationId, 'revoked')]))).toBe(true);
  expect(isChangeConfirmed(revoke, list(), access([assignment(incarnationId, 'active')]))).toBe(false);
});

it('uses company affiliation only as a label, with no job title, inferred role or synthetic reassignment evidence', () => {
  expect(personKindLabel(person)).toBe('Externí osoba');
  expect(personKindLabel({ ...person, selectedCompanyMembership: { ...membership, affiliation: 'employee' } })).toBe(
    'Zaměstnanec',
  );
  expect(
    personKindLabel({ ...person, kind: 'agent', selectedCompanyMembership: { ...membership, affiliation: null } }),
  ).toBe('AI agent');
  expect(personKindLabel({ ...person, selectedCompanyMembership: null })).toBe('Člověk');
  expect(Schema.decodeUnknownSync(PeopleListResponseSchema)(list())).toEqual(list());
});

it('requires a real principal reference, revision and nonblank reason, never scope or flags in the membership command', () => {
  const decodeMembership = Schema.decodeUnknownSync(SetPeopleCompanyMembershipRequestSchema);
  expect(decodeMembership({ ...membership, expectedRevision: 0, reason: 'Pozvání' }).expectedRevision).toBe(0);
  expect(() => decodeMembership({ ...membership, expectedRevision: -1, reason: 'x' })).toThrow();
  expect(() => decodeMembership({ ...membership, expectedRevision: 0, reason: ' ' })).toThrow();
  expect(() => decodeMembership({ ...membership, expectedRevision: 0, reason: 'x'.repeat(501) })).toThrow();
  // The company is the request scope, never a payload field: an extra field is stripped, not honoured.
  expect(decodeMembership({ ...membership, expectedRevision: 0, legalEntityId, reason: 'x' })).not.toHaveProperty(
    'legalEntityId',
  );
});
