import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  PeopleListResponseSchema,
  SetPeopleCompanyMembershipRequestSchema,
  SetPeopleRoleRequestSchema,
} from '../../shared/people-api.ts';
import type { PeopleList, Person } from '../../shared/people-api.ts';
import { isChangeConfirmed, personKindLabel } from '../../src/routes/people/people-model.ts';
import type { PendingPeopleChange } from '../../src/routes/people/people-model.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const legalEntityId = '00000000-0000-4000-8000-000000000002';
const principalRef = { principalId: '00000000-0000-4000-8000-000000000003', tenantId };
const scope = { _tag: 'company', legalEntityId } as const;
const membership = { affiliation: 'external', legalEntityId, principalRef, revision: 2, status: 'departed' } as const;
const person: Person = {
  displayName: 'Jana',
  kind: 'human',
  principalRef,
  principalStatus: 'active',
  roleAssignments: [],
  selectedCompanyMembership: membership,
  selectedCompanyMembershipProjection: { expectedMember: false, observedMember: true },
};
const list = (overrides: Partial<PeopleList> = {}): PeopleList => ({
  items: [person],
  nextOffset: null,
  scope,
  tenantId,
  ...overrides,
});

it('keeps a committed departure pending until exact membership revision AND actual graph edge agree', () => {
  const pending: PendingPeopleChange = { kind: 'membership', result: { membership, projection: 'pending' } };
  expect(isChangeConfirmed(pending, list())).toBe(false);
  const projected = {
    ...person,
    selectedCompanyMembershipProjection: { expectedMember: false, observedMember: false },
  };
  expect(isChangeConfirmed(pending, list({ items: [projected] }))).toBe(true);
  expect(
    isChangeConfirmed(
      pending,
      list({ items: [{ ...projected, selectedCompanyMembership: { ...membership, revision: 3 } }] }),
    ),
  ).toBe(false);
  expect(
    isChangeConfirmed(pending, list({ items: [{ ...projected, selectedCompanyMembershipProjection: null }] })),
  ).toBe(false);
  expect(isChangeConfirmed(pending, list({ scope: { _tag: 'tenant' } }))).toBe(false);
});

it('confirms a role only from actual graph assignments in the exact tenant and company', () => {
  const role = { roleKey: 'auditor', scope, tenantId };
  const pending: PendingPeopleChange = {
    kind: 'role',
    result: { operation: 'assign', principalRef, projection: 'pending', role },
  };
  expect(isChangeConfirmed(pending, list())).toBe(false);
  expect(isChangeConfirmed(pending, list({ items: [{ ...person, roleAssignments: [role] }] }))).toBe(true);
  expect(
    isChangeConfirmed(pending, list({ items: [{ ...person, roleAssignments: [role] }], scope: { _tag: 'tenant' } })),
  ).toBe(false);
  expect(isChangeConfirmed({ kind: 'role', result: { ...pending.result, operation: 'revoke' } }, list())).toBe(true);
  expect(
    isChangeConfirmed({ kind: 'role', result: { ...pending.result, operation: 'revoke' } }, list({ items: [] })),
  ).toBe(false);
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

it('requires a real principal reference, revision and nonblank reason, never scope or flags in command payloads', () => {
  const decodeMembership = Schema.decodeUnknownSync(SetPeopleCompanyMembershipRequestSchema);
  expect(decodeMembership({ ...membership, expectedRevision: 0, reason: 'Pozvání' }).expectedRevision).toBe(0);
  expect(() => decodeMembership({ ...membership, expectedRevision: -1, reason: 'x' })).toThrow();
  expect(() => decodeMembership({ ...membership, expectedRevision: 0, reason: ' ' })).toThrow();
  expect(() => decodeMembership({ ...membership, expectedRevision: 0, reason: 'x'.repeat(501) })).toThrow();
  const decoded = Schema.decodeUnknownSync(SetPeopleRoleRequestSchema)({
    administrator: true,
    operation: 'assign',
    principalRef,
    reason: 'Správa',
    roleKey: ' admin ',
    scope: { _tag: 'tenant' },
  });
  expect(decoded).toEqual({ operation: 'assign', principalRef, reason: 'Správa', roleKey: 'admin' });
});
