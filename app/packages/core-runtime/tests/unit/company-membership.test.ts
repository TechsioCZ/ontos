import { v1 } from '@authzed/authzed-node';
import { Effect, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CompanyMembershipSchema,
  companyActorKind,
  isCompanyAffiliationValid,
} from '../../src/permissions/company-membership.ts';
import {
  buildScopedRoleMembershipUpdates,
  fromScopedRoleObjectId,
  toScopedRoleObjectId,
} from '../../src/permissions/scoped-role.ts';
import { PeopleDirectoryInputSchema, PeopleDirectoryResultSchema } from '../../src/auth/people-directory-read.ts';

const tenantId = '71000000-0000-4000-8000-000000000001';
const legalEntityId = '72000000-0000-4000-8000-000000000001';
const principalId = '73000000-0000-4000-8000-000000000001';
const principal = { principalId, tenantId };

it.effect('keeps human affiliation company-local and refuses technical workloads or human affiliation on agents', () =>
  Effect.sync(() => {
    expect(isCompanyAffiliationValid('human', 'employee')).toBe(true);
    expect(isCompanyAffiliationValid('human', 'external')).toBe(true);
    expect(isCompanyAffiliationValid('human', null)).toBe(false);
    expect(isCompanyAffiliationValid('agent', null)).toBe(true);
    expect(isCompanyAffiliationValid('agent', 'external')).toBe(false);
    expect(isCompanyAffiliationValid('service', null)).toBe(false);
    expect(isCompanyAffiliationValid('service', 'employee')).toBe(false);
    expect(companyActorKind('human', 'employee')).toBe('employee');
    expect(companyActorKind('human', 'external')).toBe('external');
    expect(companyActorKind('agent', null)).toBe('agent');
    expect(companyActorKind('agent', 'employee')).toBeUndefined();
  }),
);

it.effect(
  'decodes a tenant-bound PrincipalRef and explicit affiliation absence without weakening membership revisions',
  () =>
    Effect.gen(function* decodeCompanyMembership() {
      const member = yield* Schema.decodeEffect(CompanyMembershipSchema)({
        affiliation: null,
        legalEntityId,
        principalRef: principal,
        revision: 1,
        status: 'invited',
      });
      expect(Option.isNone(member.affiliation)).toBe(true);
      expect(member.principalRef).toEqual(principal);
      expect((yield* Schema.encodeEffect(CompanyMembershipSchema)(member)).affiliation).toBeNull();
      expect(() => Schema.decodeSync(CompanyMembershipSchema)({ ...member, affiliation: null, revision: 0 })).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(CompanyMembershipSchema)({ ...member, affiliation: 'salesperson' }),
      ).toThrow();
    }),
);

it.effect('links context admission only for an explicitly assigned exact tenant-scoped role', () =>
  Effect.gen(function* exactTenantRole() {
    const role = { roleKey: 'ordinary-reader', tenantId };
    const updates = yield* buildScopedRoleMembershipUpdates({ operation: 'assign', principal, role });
    expect(updates).toHaveLength(2);
    expect(updates[0]?.relationship?.resource?.objectId).toBe(toScopedRoleObjectId(role));
    expect(updates[0]?.relationship?.relation).toBe('member');
    expect(updates[1]?.relationship?.resource).toEqual({ objectId: tenantId, objectType: 'tenant' });
    expect(updates[1]?.relationship?.relation).toBe('context_role');
    expect(updates[1]?.relationship?.subject?.object?.objectId).toBe(toScopedRoleObjectId(role));
    expect(updates[1]?.relationship?.subject?.optionalRelation).toBe('member');
    expect(updates.every(({ operation }) => operation === v1.RelationshipUpdate_Operation.TOUCH)).toBe(true);
  }),
);

it.effect('never promotes a company role, even one labelled superadmin or auditor, into tenant context', () =>
  Effect.gen(function* exactCompanyRole() {
    for (const roleKey of ['superadmin', 'auditor', 'ordinary-reader']) {
      const role = { legalEntityId, roleKey, tenantId };
      const updates = yield* buildScopedRoleMembershipUpdates({ operation: 'assign', principal, role });
      expect(updates).toHaveLength(1);
      expect(updates[0]?.relationship?.resource?.objectId).toBe(toScopedRoleObjectId(role));
      expect(updates[0]?.relationship?.relation).toBe('member');
    }
  }),
);

it.effect('revokes only one assignee and preserves the role admission link for other members', () =>
  Effect.gen(function* revokeOneMember() {
    const updates = yield* buildScopedRoleMembershipUpdates({
      operation: 'revoke',
      principal,
      role: { roleKey: 'ordinary-reader', tenantId },
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.operation).toBe(v1.RelationshipUpdate_Operation.DELETE);
    expect(updates[0]?.relationship?.relation).toBe('member');
    expect(updates[0]?.relationship?.subject?.object?.objectId).toBe(principalId);
  }),
);

it.effect('decodes only canonical scoped-role graph identities without guessing company scope from role names', () =>
  Effect.sync(() => {
    const tenantRole = { roleKey: 'superadmin', tenantId };
    const companyRole = { legalEntityId, roleKey: 'superadmin', tenantId };
    expect(fromScopedRoleObjectId(toScopedRoleObjectId(tenantRole))).toEqual(Option.some(tenantRole));
    expect(fromScopedRoleObjectId(toScopedRoleObjectId(companyRole))).toEqual(Option.some(companyRole));
    const malformedRoleJson = `["${tenantId}",null,"reader","extra"]`;
    for (const invalid of [
      'superadmin',
      'sr_not-json',
      `${toScopedRoleObjectId(tenantRole)}=`,
      toScopedRoleObjectId({ roleKey: '', tenantId }),
      toScopedRoleObjectId({ roleKey: 'reader', tenantId: '' }),
      toScopedRoleObjectId({ legalEntityId: '', roleKey: 'reader', tenantId }),
      `sr_${Buffer.from(malformedRoleJson).toString('base64url')}`,
    ]) {
      expect(Option.isNone(fromScopedRoleObjectId(invalid))).toBe(true);
    }
  }),
);

it.effect('carries only organisation data: no role assignment and no trailing membership projection', () =>
  Effect.gen(function* decodeDirectoryWireResult() {
    const wire = {
      items: [
        {
          displayName: 'Retained person',
          invitationDelivery: null,
          kind: 'human',
          principalRef: principal,
          principalStatus: 'disabled',
          selectedCompanyMembership: {
            affiliation: 'employee',
            legalEntityId,
            principalRef: principal,
            revision: 3,
            status: 'departed',
          },
        },
      ],
      nextOffset: null,
      scope: { _tag: 'company', legalEntityId },
      tenantId,
    };
    const decoded = yield* Schema.decodeUnknownEffect(PeopleDirectoryResultSchema)(wire);
    expect(yield* Schema.encodeEffect(PeopleDirectoryResultSchema)(decoded)).toEqual(wire);
    // A role assignment or a membership projection on the wire is not this read's contract any more.
    for (const field of ['roleAssignments', 'selectedCompanyMembershipProjection'] as const) {
      expect(() =>
        Schema.decodeUnknownSync(PeopleDirectoryResultSchema, { onExcessProperty: 'error' })({
          ...wire,
          items: [{ ...wire.items[0], [field]: field === 'roleAssignments' ? [] : null }],
        }),
      ).toThrow();
    }
    expect(() => Schema.decodeSync(PeopleDirectoryInputSchema)({ limit: 101, offset: 0 })).toThrow();
    expect(() => Schema.decodeSync(PeopleDirectoryInputSchema)({ limit: 1, offset: -1 })).toThrow();
  }),
);

it.effect('rejects cross-tenant PrincipalRef assignments and revocations before producing graph updates', () =>
  Effect.gen(function* foreignPrincipal() {
    for (const operation of ['assign', 'revoke'] as const) {
      const error = yield* buildScopedRoleMembershipUpdates({
        operation,
        principal,
        role: { roleKey: 'ordinary-reader', tenantId: '71000000-0000-4000-8000-000000000002' },
      }).pipe(Effect.flip);
      expect(Predicate.isTagged(error, 'ScopedRoleScopeMismatch')).toBe(true);
    }
  }),
);
