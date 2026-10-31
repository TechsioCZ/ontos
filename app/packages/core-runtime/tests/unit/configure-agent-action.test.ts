import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { PrincipalManagementErrorSchema } from '../../src/auth/principal-management-errors.ts';
import {
  AgentProfileSchema,
  configureAgentAction,
  ConfigureAgentAuditEvidenceSchema,
  ConfigureAgentPayloadSchema,
  ConfigureAgentResultSchema,
} from '../../src/modules/actions/configure-agent.action.ts';
import { principalLifecycleDomainEvents } from '../../src/modules/actions/principal-lifecycle-event.ts';

const principalId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const profile = {
  description: null,
  displayName: 'Operations agent',
  modules: [{ access: 'write', moduleId: 'work.tasks' }],
  ownerPrincipalId: null,
  writePolicy: 'approval',
};

it('retains native explicit authorization and the persisted Action identity', () => {
  const { descriptor } = configureAgentAction;
  expect(descriptor.actionKey).toBe('core.identity.configure-agent');
  expect(descriptor.owningModuleKey).toBe('core.identity');
  expect(descriptor.entrypoint).toMatchObject({
    access: 'write',
    authorization: { kind: 'action_execution', provisioning: 'explicit' },
    entrypointKey: 'core.identity.configure-agent',
    moduleKey: 'core.identity',
    role: 'action',
    scope: 'system',
  });
  expect(descriptor.idempotency).toBe('required');
  expect(descriptor.legalEntityScope).toBe('required');
  expect(descriptor.schemaVersion).toBe('1');
});

it('retains the sensitive audit, lifecycle events and domain contracts', () => {
  const { descriptor } = configureAgentAction;
  expect(descriptor.accessEvidencePolicy).toEqual({
    captureMode: 'metadata_only',
    policyKey: 'core.identity.configure-agent.access.v1',
  });
  expect(descriptor.auditProfile).toBe('sensitive');
  expect(descriptor.auditEvidenceSchema).toBe(ConfigureAgentAuditEvidenceSchema);
  expect(descriptor.domainErrorSchema).toBe(PrincipalManagementErrorSchema);
  expect(descriptor.domainEvents).toEqual(principalLifecycleDomainEvents);
  expect(descriptor.payloadSchema).toBe(ConfigureAgentPayloadSchema);
  expect(descriptor.resultSchema).toBe(ConfigureAgentResultSchema);
  expect(descriptor.policies).toEqual([]);
});

it('accepts both native operations and explicit profile clearing without supplying defaults', () => {
  const decode = Schema.decodeUnknownSync(ConfigureAgentPayloadSchema);
  for (const operation of ['create-agent', 'configure-agent']) {
    const payload = { ...profile, operation, principalId };
    expect(decode(payload)).toEqual(payload);
  }
  const isProfile = Schema.is(AgentProfileSchema);
  expect(isProfile(profile)).toBe(true);
  for (const requiredField of ['description', 'ownerPrincipalId', 'writePolicy']) {
    const incomplete = Object.fromEntries(Object.entries(profile).filter(([key]) => key !== requiredField));
    expect(isProfile(incomplete)).toBe(false);
  }
});

it('preserves payload identity, display-name, module and write-policy validation', () => {
  const payload = { ...profile, operation: 'configure-agent', principalId };
  const decodePayload = Schema.decodeUnknownResult(ConfigureAgentPayloadSchema);
  for (const change of [
    { principalId: 'not-a-principal-id' },
    { ownerPrincipalId: 'not-an-owner-id' },
    { operation: 'disable-agent' },
    { displayName: '' },
    { displayName: ' Operations agent' },
    { displayName: 'Operations agent ' },
    { displayName: 'x'.repeat(201) },
    { description: '' },
    { description: 'x'.repeat(501) },
    { modules: [{ access: 'admin', moduleId: 'work.tasks' }] },
    { modules: [{ access: 'read', moduleId: '' }] },
    { modules: Array.from({ length: 101 }, () => ({ access: 'read', moduleId: 'work.tasks' })) },
    { writePolicy: 'unrestricted' },
  ]) {
    expect(Result.isFailure(decodePayload({ ...payload, ...change }))).toBe(true);
  }
});

it('retains previous audited profiles and positive revisions for committed results', () => {
  const evidence = {
    ...profile,
    legalEntityId,
    operation: 'configure-agent',
    previousProfile: { ...profile, displayName: 'Previous agent name' },
    revision: 2,
    targetPrincipalId: principalId,
  };
  expect(Schema.decodeUnknownSync(ConfigureAgentAuditEvidenceSchema)(evidence)).toEqual(evidence);
  expect(Schema.is(ConfigureAgentAuditEvidenceSchema)({ ...evidence, previousProfile: null })).toBe(true);
  expect(Schema.is(ConfigureAgentAuditEvidenceSchema)({ ...evidence, revision: 0 })).toBe(false);
  const isResult = Schema.is(ConfigureAgentResultSchema);
  for (const status of ['active', 'disabled']) {
    expect(isResult({ operation: 'configure-agent', principalId, revision: 2, status })).toBe(true);
  }
  expect(isResult({ operation: 'configure-agent', principalId, revision: 0, status: 'active' })).toBe(false);
  expect(isResult({ operation: 'configure-agent', principalId, revision: 2, status: 'archived' })).toBe(false);
});
