import { v1 } from '@authzed/authzed-node';
import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AgentActionMigrationIssueSchema,
  foldAgentActionMigrationProfiles,
  planAgentActionPolicyMigration,
} from '../../src/install/agent-action-policy-migration.ts';
import type {
  AgentActionMigrationAuditEvent,
  AgentActionMigrationProfile,
  AgentActionPolicyMigrationInput,
} from '../../src/install/agent-action-policy-migration.ts';
import { toLegalEntityAccessObjectId, toModuleAccessObjectId } from '../../src/permissions/context-access.ts';
import { agentScopedRoleObjectId } from '../../src/permissions/scoped-role.ts';
import { toSpiceDbActionGrantObjectId } from '../../src/permissions/service.ts';

const scope = { legalEntityId: 'company-a', principalId: 'agent-a', tenantId: 'tenant-a' };
const moduleId = 'work.tasks';
const profile: AgentActionMigrationProfile = {
  ...scope,
  auditEventId: 'audit-a',
  modules: [{ access: 'write', moduleId }],
  writePolicy: 'direct',
};
const relationship = (
  resourceType: string,
  resourceId: string,
  relation: string,
  subjectType = 'principal',
  subjectId = scope.principalId,
  userset = '',
) =>
  v1.Relationship.create({
    relation,
    resource: { objectId: resourceId, objectType: resourceType },
    subject: { object: { objectId: subjectId, objectType: subjectType }, optionalRelation: userset },
  });
const companyMembership = (legalEntityId = scope.legalEntityId) =>
  relationship('legal_entity', toLegalEntityAccessObjectId(scope.tenantId, legalEntityId) ?? '', 'member');
const moduleAccess = (legalEntityId = scope.legalEntityId) =>
  relationship('module_access', toModuleAccessObjectId(scope.tenantId, legalEntityId, moduleId) ?? '', 'accessor');
const executor = (actionKey: string) =>
  relationship('action', `ak_${Buffer.from(actionKey).toString('base64url')}`, 'executor');
const input: AgentActionPolicyMigrationInput = {
  actions: [
    { actionKey: 'unrelated.apply', legalEntityScope: 'required', owningModuleKey: moduleId, provisioning: 'explicit' },
    {
      actionKey: 'work.tasks.misleading-owner',
      legalEntityScope: 'required',
      owningModuleKey: 'other.module',
      provisioning: 'explicit',
    },
    {
      actionKey: 'unrelated.second',
      legalEntityScope: 'optional',
      owningModuleKey: moduleId,
      provisioning: 'explicit',
    },
    {
      actionKey: 'unrelated.tenant-only',
      legalEntityScope: 'forbidden',
      owningModuleKey: moduleId,
      provisioning: 'explicit',
    },
  ],
  agents: [{ principalId: scope.principalId, tenantId: scope.tenantId }],
  companies: [{ legalEntityId: scope.legalEntityId, tenantId: scope.tenantId }],
  profiles: [profile],
  relationships: [
    relationship('tenant', scope.tenantId, 'member'),
    companyMembership(),
    moduleAccess(),
    executor('unrelated.apply'),
  ],
};
const issueCodes = (value: AgentActionPolicyMigrationInput) => {
  const result = planAgentActionPolicyMigration(value);
  expect(Result.isFailure(result)).toBe(true);
  return Result.isFailure(result) ? result.failure.map(({ code }) => code) : [];
};

it('migrates direct policy only from actual old executors, not all audited write-module Actions', () => {
  const plan = Result.getOrThrow(planAgentActionPolicyMigration(input));
  expect(plan.relationships).toHaveLength(1);
  expect(plan.relationships[0]).toEqual(
    relationship(
      'action_grant',
      toSpiceDbActionGrantObjectId({ ...scope, actionKey: 'unrelated.apply' }),
      'role',
      'scoped_role',
      agentScopedRoleObjectId(scope),
      'member',
    ),
  );
  expect(plan.reports).toEqual([
    {
      ...scope,
      actionDerivations: [{ actionKey: 'unrelated.apply', permission: 'execute', source: 'legacy_executor' }],
      actualModuleIds: [moduleId],
      auditEventId: profile.auditEventId,
      selectedWriteModuleIds: [moduleId],
      writePolicy: 'direct',
    },
  ]);
});

it('derives approval proposals from audited write modules, actual company access and published owner only', () => {
  const plan = Result.getOrThrow(
    planAgentActionPolicyMigration({
      ...input,
      profiles: [{ ...profile, writePolicy: 'approval' }],
      relationships: input.relationships.filter((item) => item.resource?.objectType !== 'action'),
    }),
  );
  expect(plan.reports[0]?.actionDerivations).toEqual([
    { actionKey: 'unrelated.apply', permission: 'propose', source: 'audited_write_module' },
    { actionKey: 'unrelated.second', permission: 'propose', source: 'audited_write_module' },
  ]);
  expect(plan.relationships.every((item) => item.relation === 'proposer_role')).toBe(true);
});

it('gives read-only profiles no Action execution or proposal policy', () => {
  const plan = Result.getOrThrow(
    planAgentActionPolicyMigration({
      ...input,
      profiles: [{ ...profile, writePolicy: 'read_only' }],
      relationships: input.relationships.filter((item) => item.resource?.objectType !== 'action'),
    }),
  );
  expect(plan.relationships).toEqual([]);
  expect(plan.reports[0]?.actionDerivations).toEqual([]);
});

it('rejects missing and ambiguous explicit profiles rather than filling runtime defaults', () => {
  expect(issueCodes({ ...input, profiles: [] })).toContain('missing_profile');
  expect(issueCodes({ ...input, profiles: [profile, { ...profile, auditEventId: 'another-audit' }] })).toContain(
    'ambiguous_profile',
  );
});

it('rejects graph/profile policy disagreement for approval and read-only agents with executors', () => {
  for (const writePolicy of ['approval', 'read_only'] as const) {
    expect(issueCodes({ ...input, profiles: [{ ...profile, writePolicy }] })).toContain('policy_graph_disagreement');
  }
});

it('rejects missing or extra company module access and missing tenant membership', () => {
  expect(
    issueCodes({
      ...input,
      relationships: input.relationships.filter((item) => item.resource?.objectType !== 'module_access'),
    }),
  ).toContain('policy_graph_disagreement');
  expect(issueCodes({ ...input, profiles: [{ ...profile, modules: [] }] })).toContain('policy_graph_disagreement');
  expect(
    issueCodes({
      ...input,
      relationships: input.relationships.filter((item) => item.resource?.objectType !== 'tenant'),
    }),
  ).toContain('missing_tenant_membership');
});

it('rejects unknown old Actions and never infers an owner from their key prefix', () => {
  expect(issueCodes({ ...input, relationships: [...input.relationships, executor('work.tasks.unknown')] })).toContain(
    'unknown_legacy_action',
  );
  expect(
    issueCodes({ ...input, relationships: [...input.relationships, executor('work.tasks.misleading-owner')] }),
  ).toContain('policy_graph_disagreement');
  expect(
    issueCodes({ ...input, relationships: [...input.relationships, executor('unrelated.tenant-only')] }),
  ).toContain('policy_graph_disagreement');
});

it('rejects a global executor that cannot be attributed unambiguously to one company', () => {
  const second = { ...profile, auditEventId: 'audit-b', legalEntityId: 'company-b' };
  expect(
    issueCodes({
      ...input,
      companies: [...input.companies, { legalEntityId: second.legalEntityId, tenantId: second.tenantId }],
      profiles: [profile, second],
      relationships: [
        ...input.relationships,
        companyMembership(second.legalEntityId),
        moduleAccess(second.legalEntityId),
      ],
    }),
  ).toContain('ambiguous_action_scope');
});

it('recovers direct evidence from exact durable own-role policy after old executors were deleted', () => {
  const first = Result.getOrThrow(planAgentActionPolicyMigration(input));
  const roleId = agentScopedRoleObjectId(scope);
  const plan = Result.getOrThrow(
    planAgentActionPolicyMigration({
      ...input,
      relationships: [
        relationship('tenant', scope.tenantId, 'member'),
        companyMembership(),
        relationship('scoped_role', roleId, 'member'),
        relationship(
          'module_access',
          toModuleAccessObjectId(scope.tenantId, scope.legalEntityId, moduleId) ?? '',
          'accessor_role',
          'scoped_role',
          roleId,
          'member',
        ),
        ...first.relationships,
      ],
    }),
  );
  expect(plan.relationships).toEqual(first.relationships);
  expect(plan.reports[0]?.actionDerivations[0]?.source).toBe('scoped_policy');
});

it('rejects scoped execute policy for approval agents and foreign-company durable grants', () => {
  const roleId = agentScopedRoleObjectId(scope);
  const roleMember = relationship('scoped_role', roleId, 'member');
  const grants = Result.getOrThrow(planAgentActionPolicyMigration(input)).relationships;
  expect(
    issueCodes({
      ...input,
      profiles: [{ ...profile, writePolicy: 'approval' }],
      relationships: [
        ...input.relationships.filter((item) => item.resource?.objectType !== 'action'),
        roleMember,
        ...grants,
      ],
    }),
  ).toContain('policy_graph_disagreement');
  expect(
    issueCodes({
      ...input,
      relationships: [
        ...input.relationships,
        roleMember,
        relationship(
          'action_grant',
          toSpiceDbActionGrantObjectId({ ...scope, actionKey: 'unrelated.apply', legalEntityId: 'company-b' }),
          'role',
          'scoped_role',
          roleId,
          'member',
        ),
      ],
    }),
  ).toContain('policy_graph_disagreement');
});

it('rejects incomplete graph evidence and duplicate inventories without returning a partial plan', () => {
  expect(issueCodes({ ...input, relationships: [...input.relationships, v1.Relationship.create()] })).toContain(
    'invalid_graph_evidence',
  );
  expect(issueCodes({ ...input, actions: [...input.actions, ...input.actions] })).toContain('invalid_inventory');
  expect(issueCodes({ ...input, agents: [...input.agents, ...input.agents] })).toContain('invalid_inventory');
});

it('does not turn old tenant-membership default executors into per-agent explicit policy', () => {
  const plan = Result.getOrThrow(
    planAgentActionPolicyMigration({
      ...input,
      relationships: [
        ...input.relationships.filter((item) => item.resource?.objectType !== 'action'),
        relationship(
          'action',
          `ak_${Buffer.from('unrelated.apply').toString('base64url')}`,
          'executor',
          'tenant',
          scope.tenantId,
          'member',
        ),
      ],
    }),
  );
  expect(plan.relationships).toEqual([]);
});

const auditRow = (auditEventId: string, occurredAtEpochMicroseconds: number, writePolicy = 'direct') =>
  ({
    auditEventId,
    eventType: 'action.executed',
    evidenceJson: {
      actionKey: 'core.identity.manage-demo-account',
      modulesJson: '[{"access":"write","moduleId":"work.tasks"}]',
      operation: 'configure-agent',
      targetPrincipalId: scope.principalId,
      writePolicy,
    },
    legalEntityId: scope.legalEntityId,
    occurredAtEpochMicroseconds,
    outcome: 'succeeded',
    tenantId: scope.tenantId,
  }) satisfies AgentActionMigrationAuditEvent;

it('folds explicit successful authority evidence independently per company and in event order', () => {
  const profiles = Result.getOrThrow(
    foldAgentActionMigrationProfiles(input.agents, [
      auditRow('audit-new', 200, 'approval'),
      auditRow('audit-old', 100),
      { ...auditRow('audit-other-company', 150), legalEntityId: 'company-b' },
    ]),
  );
  expect(profiles).toHaveLength(2);
  expect(profiles.find((value) => value.legalEntityId === scope.legalEntityId)).toEqual({
    ...profile,
    auditEventId: 'audit-new',
    writePolicy: 'approval',
  });
  expect(profiles.find((value) => value.legalEntityId === 'company-b')?.auditEventId).toBe('audit-other-company');
});

it('does not seed or default missing migration authority profiles', () => {
  expect(Result.getOrThrow(foldAgentActionMigrationProfiles(input.agents, []))).toEqual([]);
});

it('rejects malformed latest evidence instead of silently using an earlier valid profile', () => {
  const invalid = auditRow('audit-invalid', 200);
  const result = foldAgentActionMigrationProfiles(input.agents, [
    auditRow('audit-valid', 100),
    {
      ...invalid,
      evidenceJson: { ...invalid.evidenceJson, modulesJson: 'not JSON' },
    },
  ]);
  expect(Result.isFailure(result) ? result.failure : []).toContainEqual({
    ...scope,
    auditEventId: 'audit-invalid',
    code: 'invalid_audit_evidence',
  });
});

it('rejects authority disagreement at an indistinguishable audit timestamp', () => {
  const result = foldAgentActionMigrationProfiles(input.agents, [
    auditRow('audit-a', 100),
    auditRow('audit-b', 100, 'approval'),
  ]);
  expect(Result.isFailure(result) ? result.failure.map(({ code }) => code) : []).toContain('ambiguous_profile');
  expect(
    Result.isSuccess(
      foldAgentActionMigrationProfiles(input.agents, [auditRow('audit-a', 100), auditRow('audit-b', 100)]),
    ),
  ).toBe(true);
});

it('ignores failed, unrelated and other-principal audit events without inferring a profile', () => {
  const row = auditRow('audit-ignored', 100);
  expect(
    Result.getOrThrow(
      foldAgentActionMigrationProfiles(input.agents, [
        { ...row, outcome: 'failed' },
        { ...row, evidenceJson: { ...row.evidenceJson, actionKey: 'unrelated.action' } },
        { ...row, evidenceJson: { ...row.evidenceJson, targetPrincipalId: 'someone-else' } },
      ]),
    ),
  ).toEqual([]);
});

it('rejects unscoped audit evidence and duplicate module selections', () => {
  const row = auditRow('audit-invalid', 100);
  const unscoped: AgentActionMigrationAuditEvent = {
    auditEventId: row.auditEventId,
    eventType: row.eventType,
    evidenceJson: row.evidenceJson,
    occurredAtEpochMicroseconds: row.occurredAtEpochMicroseconds,
    outcome: row.outcome,
    tenantId: row.tenantId,
  };
  for (const value of [
    unscoped,
    {
      ...row,
      evidenceJson: {
        ...row.evidenceJson,
        modulesJson: '[{"access":"read","moduleId":"work.tasks"},{"access":"write","moduleId":"work.tasks"}]',
      },
    },
  ]) {
    const result = foldAgentActionMigrationProfiles(input.agents, [value]);
    expect(Result.isFailure(result) ? result.failure.map(({ code }) => code) : []).toContain('invalid_audit_evidence');
  }
});

it('reports empty audit IDs without producing an unencodable issue and rejects unsafe timestamp precision', () => {
  for (const row of [auditRow('', 100), auditRow('audit-unsafe-time', Number.MAX_SAFE_INTEGER + 1)]) {
    const result = foldAgentActionMigrationProfiles(input.agents, [row]);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure[0]?.code).toBe('invalid_audit_evidence');
      expect(
        Result.isSuccess(Schema.decodeUnknownResult(Schema.Array(AgentActionMigrationIssueSchema))(result.failure)),
      ).toBe(true);
    }
  }
});
