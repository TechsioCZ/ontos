import { Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { getActionHandler, getActionServiceFactory } from '../../src/actions/definition.ts';
import {
  InvitePersonAuditEvidenceSchema,
  InvitePersonPayloadSchema,
  InvitePersonResultSchema,
} from '../../src/auth/person-invitation.ts';
import { PrincipalManagementErrorSchema } from '../../src/auth/principal-management-errors.ts';
import { invitePersonAction } from '../../src/modules/actions/invite-person.action.ts';
import {
  ManageAgentStatusAuditEvidenceSchema,
  ManageAgentStatusPayloadSchema,
  ManageAgentStatusResultSchema,
  manageAgentStatusAction,
} from '../../src/modules/actions/manage-agent-status.action.ts';
import { principalLifecycleDomainEvents } from '../../src/modules/actions/principal-lifecycle-event.ts';
import { setCompanyMembershipAction } from '../../src/modules/actions/set-company-membership.action.ts';
import { setScopedRoleMembershipAction } from '../../src/modules/actions/set-scoped-role-membership.action.ts';
import {
  OutboxPayloadSchema,
  ScopedRoleMembershipAuditEvidenceSchema,
  outboxTopic,
} from '../../src/outbox/core-identity-scoped-role-membership-changed-v1.ts';
import { CompanyMembershipSchema } from '../../src/permissions/company-membership.ts';

const principalId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const principalRef = { principalId, tenantId };

for (const { action, legalEntityScope, slug } of [
  { action: invitePersonAction, legalEntityScope: 'required', slug: 'invite-person' },
  { action: manageAgentStatusAction, legalEntityScope: 'required', slug: 'manage-agent-status' },
  { action: setCompanyMembershipAction, legalEntityScope: 'required', slug: 'set-company-membership' },
  { action: setScopedRoleMembershipAction, legalEntityScope: 'optional', slug: 'set-scoped-role-membership' },
]) {
  it(`${slug} retains its native identity, explicit authority and sensitive evidence contract`, () => {
    const { descriptor } = action;
    expect(descriptor.actionKey).toBe(`core.identity.${slug}`);
    expect(descriptor.entrypoint).toMatchObject({
      access: 'write',
      authorization: { kind: 'action_execution', provisioning: 'explicit' },
      entrypointKey: `core.identity.${slug}`,
      moduleKey: 'core.identity',
      role: 'action',
      scope: 'system',
    });
    expect(descriptor.accessEvidencePolicy).toEqual({
      captureMode: 'metadata_only',
      policyKey: `core.identity.${slug}.access.v1`,
    });
    expect(descriptor.owningModuleKey).toBe('core.identity');
    expect(descriptor.idempotency).toBe('required');
    expect(descriptor.legalEntityScope).toBe(legalEntityScope);
    expect(descriptor.auditProfile).toBe('sensitive');
    expect(descriptor.auditEvidenceSchema).toBeDefined();
    expect(descriptor.domainErrorSchema).toBe(PrincipalManagementErrorSchema);
    expect(descriptor.policies).toEqual([]);
    expect(descriptor.schemaVersion).toBe('1');
    expect(Object.isFrozen(action)).toBe(true);
  });
}

it('retains native domain handlers and transaction service factories', () => {
  for (const implementation of [
    getActionHandler(invitePersonAction),
    getActionHandler(manageAgentStatusAction),
    getActionHandler(setCompanyMembershipAction),
    getActionHandler(setScopedRoleMembershipAction),
    getActionServiceFactory(invitePersonAction),
    getActionServiceFactory(manageAgentStatusAction),
    getActionServiceFactory(setCompanyMembershipAction),
    getActionServiceFactory(setScopedRoleMembershipAction),
  ]) {
    expect(implementation).toBeTypeOf('function');
  }
});

it('retains the domain-owned codecs and lifecycle or scoped-role outbox declarations', () => {
  expect(invitePersonAction.descriptor.payloadSchema).toBe(InvitePersonPayloadSchema);
  expect(invitePersonAction.descriptor.resultSchema).toBe(InvitePersonResultSchema);
  expect(invitePersonAction.descriptor.auditEvidenceSchema).toBe(InvitePersonAuditEvidenceSchema);
  expect(manageAgentStatusAction.descriptor.payloadSchema).toBe(ManageAgentStatusPayloadSchema);
  expect(manageAgentStatusAction.descriptor.resultSchema).toBe(ManageAgentStatusResultSchema);
  expect(manageAgentStatusAction.descriptor.auditEvidenceSchema).toBe(ManageAgentStatusAuditEvidenceSchema);
  expect(setCompanyMembershipAction.descriptor.resultSchema).toBe(CompanyMembershipSchema);
  for (const action of [invitePersonAction, manageAgentStatusAction, setCompanyMembershipAction]) {
    expect(Object.keys(action.descriptor.domainEvents)).toEqual(Object.keys(principalLifecycleDomainEvents));
    for (const [eventType, schema] of Object.entries(principalLifecycleDomainEvents)) {
      expect(Object.entries(action.descriptor.domainEvents).find(([key]) => key === eventType)?.[1]).toBe(schema);
    }
  }
  expect(setScopedRoleMembershipAction.descriptor.auditEvidenceSchema).toBe(ScopedRoleMembershipAuditEvidenceSchema);
  expect(setScopedRoleMembershipAction.descriptor.domainEvents).toEqual({ [outboxTopic]: OutboxPayloadSchema });
});

it('retains agent status concurrency expectations and mandatory archive reasons', () => {
  const decode = Schema.decodeUnknownSync(ManageAgentStatusPayloadSchema, { onExcessProperty: 'error' });
  const change = { expectedStatus: 'active', newStatus: 'disabled', operation: 'change-status', principalId };
  const archive = { expectedStatus: 'disabled', operation: 'archive-agent', principalId, reason: 'Retired' };
  expect(decode(change)).toEqual(change);
  expect(decode(archive)).toEqual(archive);
  for (const invalid of [
    Object.fromEntries(Object.entries(change).filter(([key]) => key !== 'expectedStatus')),
    { ...change, expectedStatus: 'archived' },
    { ...change, principalId: 'invalid' },
    { ...change, legalEntityId: tenantId },
    Object.fromEntries(Object.entries(archive).filter(([key]) => key !== 'reason')),
    { ...archive, reason: ' ' },
  ]) {
    expect(() => decode(invalid)).toThrow();
  }
});

it('retains company membership revisions and derives scoped-role authority outside the payload', () => {
  const decodeMembership = Schema.decodeUnknownSync(setCompanyMembershipAction.descriptor.payloadSchema, {
    onExcessProperty: 'error',
  });
  const membership = {
    affiliation: null,
    expectedRevision: 0,
    principalRef,
    reason: 'Explicit membership',
    status: 'active',
  };
  expect(decodeMembership(membership)).toEqual({ ...membership, affiliation: Option.none() });
  expect(() => decodeMembership({ ...membership, expectedRevision: -1 })).toThrow();
  expect(() => decodeMembership({ ...membership, legalEntityId: tenantId })).toThrow();
  const decodeRole = Schema.decodeUnknownSync(setScopedRoleMembershipAction.descriptor.payloadSchema, {
    onExcessProperty: 'error',
  });
  const role = { operation: 'assign', principalRef, reason: 'Explicit scoped grant', roleKey: 'company-admin' };
  expect(decodeRole(role)).toEqual(role);
  expect(() => decodeRole({ ...role, scope: { tenantId } })).toThrow();
  expect(() => decodeRole({ ...role, legalEntityId: tenantId })).toThrow();
});
