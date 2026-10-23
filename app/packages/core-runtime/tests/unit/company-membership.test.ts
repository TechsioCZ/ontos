import { v1 } from '@authzed/authzed-node';
import { Effect, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CompanyMembershipSchema,
  buildCompanyMembershipUpdates,
  companyActorKind,
  isCompanyAffiliationValid,
} from '../../src/permissions/company-membership.ts';
import {
  buildScopedRoleMembershipUpdates,
  fromScopedRoleObjectId,
  toScopedRoleObjectId,
} from '../../src/permissions/scoped-role.ts';
import { PeopleDirectoryInputSchema, PeopleDirectoryResultSchema } from '../../src/auth/people-directory-read.ts';
import { toLegalEntityAccessObjectId } from '../../src/permissions/context-access.ts';
import { createActionCollector } from '../../src/actions/collector.ts';
import {
  OutboxPayloadSchema,
  ScopedRoleMembershipAuditEvidenceSchema,
  ScopedRoleMembershipRoleSchema,
  outboxTopic,
  scopedRoleIdentity,
  scopedRoleMembershipSubjectId,
} from '../../src/outbox/core-identity-scoped-role-membership-changed-v1.ts';

const tenantId = '71000000-0000-4000-8000-000000000001';
const legalEntityId = '72000000-0000-4000-8000-000000000001';
const principalId = '73000000-0000-4000-8000-000000000001';
const principal = { principalId, tenantId };
const activeMembership = {
  affiliation: 'employee' as const,
  companyActive: true,
  kind: 'human',
  legalEntityId,
  principalId,
  principalStatus: 'active',
  status: 'active' as const,
  tenantActive: true,
  tenantId,
};

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
    Effect.sync(() => {
      const member = Schema.decodeUnknownSync(CompanyMembershipSchema)({
        affiliation: null,
        legalEntityId,
        principalRef: principal,
        revision: 1,
        status: 'invited',
      });
      expect(Option.isNone(member.affiliation)).toBe(true);
      expect(member.principalRef).toEqual(principal);
      expect(Schema.encodeSync(CompanyMembershipSchema)(member).affiliation).toBeNull();
      expect(() =>
        Schema.decodeUnknownSync(CompanyMembershipSchema)({ ...member, affiliation: null, revision: 0 }),
      ).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(CompanyMembershipSchema)({ ...member, affiliation: 'salesperson' }),
      ).toThrow();
    }),
);

it.effect('projects only exact company membership, never affiliation-derived authority, roles, or tenant context', () =>
  Effect.sync(() => {
    const [employee] = buildCompanyMembershipUpdates(activeMembership);
    const [external] = buildCompanyMembershipUpdates({ ...activeMembership, affiliation: 'external' });
    const [agent] = buildCompanyMembershipUpdates({ ...activeMembership, affiliation: null, kind: 'agent' });
    expect(employee).toEqual(external);
    expect(employee).toEqual(agent);
    expect(employee?.operation).toBe(v1.RelationshipUpdate_Operation.TOUCH);
    expect(employee?.relationship?.resource).toEqual({
      objectId: toLegalEntityAccessObjectId(tenantId, legalEntityId),
      objectType: 'legal_entity',
    });
    expect(employee?.relationship?.resource?.objectId).not.toBe(legalEntityId);
    expect(employee?.relationship?.relation).toBe('member');
    expect(employee?.relationship?.subject?.object).toEqual({ objectId: principalId, objectType: 'principal' });
    expect(buildCompanyMembershipUpdates(activeMembership)).toHaveLength(1);
  }),
);

it.effect('removes company access for every inactive state without deleting principal identity or history', () =>
  Effect.sync(() => {
    for (const input of [
      { ...activeMembership, status: 'invited' as const },
      { ...activeMembership, status: 'disabled' as const },
      { ...activeMembership, status: 'departed' as const },
      { ...activeMembership, principalStatus: 'disabled' },
      { ...activeMembership, principalStatus: 'archived' },
      { ...activeMembership, companyActive: false },
      { ...activeMembership, tenantActive: false },
      { ...activeMembership, affiliation: null },
      { ...activeMembership, kind: 'agent' },
      { ...activeMembership, affiliation: null, kind: 'service' },
    ]) {
      const updates = buildCompanyMembershipUpdates(input);
      expect(updates).toHaveLength(1);
      expect(updates[0]?.operation).toBe(v1.RelationshipUpdate_Operation.DELETE);
      expect(updates[0]?.relationship?.resource?.objectType).toBe('legal_entity');
      expect(updates[0]?.relationship?.resource?.objectId).toBe(toLegalEntityAccessObjectId(tenantId, legalEntityId));
      expect(updates[0]?.relationship?.subject?.object?.objectId).toBe(principalId);
    }
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
    for (const invalid of [
      'superadmin',
      'sr_not-json',
      `${toScopedRoleObjectId(tenantRole)}=`,
      toScopedRoleObjectId({ roleKey: '', tenantId }),
      toScopedRoleObjectId({ roleKey: 'reader', tenantId: '' }),
      toScopedRoleObjectId({ legalEntityId: '', roleKey: 'reader', tenantId }),
      `sr_${Buffer.from(JSON.stringify([tenantId, null, 'reader', 'extra'])).toString('base64url')}`,
    ]) {
      expect(Option.isNone(fromScopedRoleObjectId(invalid))).toBe(true);
    }
  }),
);

it.effect('keeps selected company membership and observed graph projection distinct in directory wire results', () =>
  Effect.sync(() => {
    const wire = {
      items: [
        {
          displayName: 'Retained person',
          kind: 'human',
          principalRef: principal,
          principalStatus: 'disabled',
          roleAssignments: [],
          selectedCompanyMembership: {
            affiliation: 'employee',
            legalEntityId,
            principalRef: principal,
            revision: 3,
            status: 'departed',
          },
          selectedCompanyMembershipProjection: { expectedMember: false, observedMember: true },
        },
      ],
      nextOffset: null,
      scope: { _tag: 'company', legalEntityId },
      tenantId,
    };
    const decoded = Schema.decodeUnknownSync(PeopleDirectoryResultSchema)(wire);
    expect(decoded.items[0]?.selectedCompanyMembershipProjection).toEqual(
      Option.some({ expectedMember: false, observedMember: true }),
    );
    expect(Schema.encodeSync(PeopleDirectoryResultSchema)(decoded)).toEqual(wire);
    expect(() => Schema.decodeUnknownSync(PeopleDirectoryInputSchema)({ limit: 101, offset: 0 })).toThrow();
    expect(() => Schema.decodeUnknownSync(PeopleDirectoryInputSchema)({ limit: 1, offset: -1 })).toThrow();
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

it.effect(
  'collects JSON-safe tenant and company role evidence and identity-only wakeups through the real Action collector',
  () =>
    Effect.gen(function* collectScopedRoleCommands() {
      const scopes = [{ _tag: 'tenant' }, { _tag: 'company', legalEntityId }] as const;
      for (const scope of scopes) {
        const role = Schema.decodeUnknownSync(ScopedRoleMembershipRoleSchema)({ roleKey: 'reader', scope, tenantId });
        const collector = createActionCollector(
          { [outboxTopic]: OutboxPayloadSchema },
          'core.identity',
          { captureMode: 'metadata_only', policyKey: 'role-command-test' },
          ScopedRoleMembershipAuditEvidenceSchema,
        );
        const wakeup = { data: { principalId, roleKey: role.roleKey, scope: role.scope } };
        yield* collector.recordAuditEvidence({
          operation: 'assign',
          principalRef: principal,
          reason: 'Explicit assignment',
          role,
        });
        const event = yield* collector.addDomainEvent({
          eventType: outboxTopic,
          payloadJson: wakeup,
          producerModuleKey: 'core.identity',
          subjectModuleKey: 'core.identity',
          subjectResourceId: scopedRoleMembershipSubjectId(scopedRoleIdentity(role), principalId),
          subjectResourceType: 'scoped_role_membership',
        });
        yield* collector.addOutboxMessage(event, {
          payloadJson: wakeup,
          producerModuleKey: 'core.identity',
          topic: outboxTopic,
        });
        const snapshot = collector.snapshot();
        expect(Schema.is(Schema.Json)(snapshot.auditEvidence)).toBe(true);
        expect(snapshot.domainEvents[0]?.payloadJson).toEqual(wakeup);
        expect(snapshot.outboxMessages[0]?.message.payloadJson).toEqual(wakeup);
        expect(Object.hasOwn(wakeup.data, 'operation')).toBe(false);
      }
      expect(() =>
        Schema.decodeUnknownSync(OutboxPayloadSchema, { onExcessProperty: 'error' })({
          data: { operation: 'assign', principalId, roleKey: 'reader', scope: { _tag: 'tenant' } },
        }),
      ).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(OutboxPayloadSchema)({
          data: { principalId, roleKey: 'reader', scope: { _tag: 'company' } },
        }),
      ).toThrow();
    }),
);
