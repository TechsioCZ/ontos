import { v1 } from '@authzed/authzed-node';
import { Array as EffectArray, Effect, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { agentGrantRelationships } from '../../packages/core-runtime/src/install/agent-entity-grants.ts';
import { toSpiceDbActionGrantObjectId } from '../../packages/core-runtime/src/permissions/service.ts';
import { agentScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import {
  AgentPolicyEvidenceSchema,
  agentPolicyFingerprint,
  validateDeclaredAgentRepair,
} from '../demo/agent-policies-stage-model.mts';
import { demoLegalEntityId, demoTenantId } from '../demo/fixture-ids.mts';
import { isExactAdditiveAgentPolicy } from '../demo/agent-profile-setup.mts';

const principalId = '3619acbd-a1bf-50f9-a8d5-d56df7096e0f';
const scope = { legalEntityId: demoLegalEntityId, principalId, tenantId: demoTenantId };
const input = {
  ...scope,
  description: 'Návrhy ke schválení',
  displayName: 'AI agent C',
  modules: [{ access: 'write' as const, moduleId: 'demo.sales-pipeline' }],
  operation: 'configure-agent' as const,
  ownerPrincipalId: '493dafec-c9b1-5a84-89cb-bee630de3c34',
  writePolicy: 'approval' as const,
};
const lifecycle = 'core.identity.mutate-agent-proposals';
const sourcePolicy = () =>
  agentGrantRelationships({
    ...scope,
    actions: [
      { actionKey: lifecycle, legalEntityScope: 'required', owningModuleKey: 'core.identity' },
      {
        actionKey: 'demo.sales-pipeline.apply-command',
        legalEntityScope: 'required',
        owningModuleKey: 'demo.sales-pipeline',
      },
    ],
    legalEntityWriteRelations: new Map(),
    modules: input.modules,
    template: [],
    writePolicy: input.writePolicy,
  });
const missingLifecycle = v1.Relationship.toJsonString(
  v1.Relationship.create({
    relation: 'role',
    resource: {
      objectId: toSpiceDbActionGrantObjectId({ ...scope, actionKey: lifecycle }),
      objectType: 'action_grant',
    },
    subject: {
      object: { objectId: agentScopedRoleObjectId(scope), objectType: 'scoped_role' },
      optionalRelation: 'member',
    },
  }),
);
const sample = () => ({
  expected: EffectArray.sort(
    sourcePolicy().map((edge) => v1.Relationship.toJsonString(edge)),
    Order.String,
  ),
  input,
  missing: [missingLifecycle],
  profileMatches: true,
  unexpected: [],
});
it.effect('permits only the exact lifecycle grant the shared native source declares for the same agent/company', () =>
  Effect.gen(function* declaredRepair() {
    const evidence = sample();
    expect(evidence.expected).toContain(missingLifecycle);
    yield* validateDeclaredAgentRepair(evidence);
    expect(
      sourcePolicy().some(
        (edge) =>
          edge.resource?.objectId ===
            toSpiceDbActionGrantObjectId({ ...scope, actionKey: 'demo.sales-pipeline.apply-command' }) &&
          edge.relation === 'role',
      ),
    ).toBe(false);
  }),
);
it.effect('refuses any undeclared, destructive, profile-changing, creation or duplicate repair', () =>
  Effect.gen(function* boundedRepair() {
    const evidence = sample();
    for (const changed of [
      { ...evidence, missing: ['undeclared'] },
      { ...evidence, unexpected: ['extra-live-permission'] },
      { ...evidence, profileMatches: false },
      { ...evidence, input: { ...input, operation: 'create-agent' as const } },
      { ...evidence, expected: [...evidence.expected, missingLifecycle] },
      { ...evidence, missing: [missingLifecycle, missingLifecycle] },
    ]) {
      expect((yield* Effect.exit(validateDeclaredAgentRepair(changed)))._tag).toBe('Failure');
    }
  }),
);
it.effect('binds review to exact profile, scope, desired tuples and observed missing policy', () =>
  Effect.gen(function* reviewedFingerprint() {
    const evidence = sample();
    const before = yield* agentPolicyFingerprint(AgentPolicyEvidenceSchema, evidence);
    expect(yield* agentPolicyFingerprint(AgentPolicyEvidenceSchema, evidence)).toBe(before);
    for (const changed of [
      { ...evidence, missing: [] },
      { ...evidence, input: { ...input, writePolicy: 'direct' as const } },
      { ...evidence, input: { ...input, legalEntityId: principalId } },
      { ...evidence, input: { ...input, principalId: demoTenantId } },
      { ...evidence, expected: [] },
    ]) {
      expect(yield* agentPolicyFingerprint(AgentPolicyEvidenceSchema, changed)).not.toBe(before);
    }
  }),
);
it('uses source lifecycle provisioning only for declared business writers, never read-only or wrong-owned descriptors', () => {
  for (const writePolicy of ['read_only', 'approval', 'direct'] as const) {
    const tuples = agentGrantRelationships({
      ...scope,
      actions: [{ actionKey: lifecycle, legalEntityScope: 'required', owningModuleKey: 'core.identity' }],
      legalEntityWriteRelations: new Map(),
      modules: input.modules,
      template: [],
      writePolicy,
    }).map((edge) => v1.Relationship.toJsonString(edge));
    expect(tuples).not.toContain(missingLifecycle);
  }
  expect(Schema.is(AgentPolicyEvidenceSchema)(sample())).toBe(true);
});
it('the native seed path rejects any fresh deletion, extra, duplicate or different tuple before Actions', () => {
  const relationship = v1.Relationship.fromJsonString(missingLifecycle);
  const touch = v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.TOUCH, relationship });
  expect(isExactAdditiveAgentPolicy([missingLifecycle], [touch])).toBe(true);
  expect(isExactAdditiveAgentPolicy([], [touch])).toBe(false);
  expect(isExactAdditiveAgentPolicy([missingLifecycle], [])).toBe(false);
  expect(
    isExactAdditiveAgentPolicy(
      [missingLifecycle],
      [v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.DELETE, relationship })],
    ),
  ).toBe(false);
  expect(isExactAdditiveAgentPolicy([missingLifecycle, missingLifecycle], [touch, touch])).toBe(false);
  expect(isExactAdditiveAgentPolicy([missingLifecycle, 'different'], [touch, touch])).toBe(false);
});
