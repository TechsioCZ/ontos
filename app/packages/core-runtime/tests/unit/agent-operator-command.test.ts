import { Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { createActionCollector } from '../../src/actions/collector.ts';
import {
  decodeCommittedAgentOperatorCommand,
  replaceAgentOperatorsActionKey,
  ReplaceAgentOperatorsAuditEvidenceSchema,
  ReplaceAgentOperatorsPayloadSchema,
  ReplaceAgentOperatorsResultSchema,
} from '../../src/modules/actions/agent-operator-command.ts';
import {
  principalLifecycleDomainEvents,
  recordPrincipalLifecycleChange,
} from '../../src/modules/actions/principal-lifecycle-event.ts';
import { replaceAgentOperatorsAction } from '../../src/modules/actions/replace-agent-operators.action.ts';
import { deriveCurrentAgentOperatorSet } from '../../src/permissions/action-authorization-lifecycle.ts';

const agentPrincipalId = '20000000-0000-4000-8000-000000000001';
const humanId = '20000000-0000-4000-8000-000000000002';
const otherHumanId = '20000000-0000-4000-8000-000000000003';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const payload = {
  agentPrincipalId,
  context: 'operators-edited' as const,
  expectedRevision: 0,
  operatorPrincipalIds: [humanId],
  revokedConnections: 0,
};
const command = {
  agentPrincipalId,
  context: payload.context,
  desiredOperatorPrincipalIds: [humanId, otherHumanId],
  legalEntityId,
  previousRevision: 0,
  revision: 1,
  revokedConnections: 2,
};
const committed = {
  agentPrincipalId,
  auditCompanyId: legalEntityId,
  eventCompanyId: legalEntityId,
  evidence: { ...command, actionKey: replaceAgentOperatorsActionKey },
  invocationActionKey: replaceAgentOperatorsActionKey,
  invocationCompanyId: legalEntityId,
  payload: { data: { principalId: agentPrincipalId } },
};

it('defines an explicitly provisioned sensitive native Action with required company scope and idempotency', () => {
  const { descriptor } = replaceAgentOperatorsAction;
  expect(descriptor.actionKey).toBe(replaceAgentOperatorsActionKey);
  expect(descriptor.auditProfile).toBe('sensitive');
  expect(descriptor.idempotency).toBe('required');
  expect(descriptor.legalEntityScope).toBe('required');
  expect(descriptor.entrypoint.authorization).toEqual({ kind: 'action_execution', provisioning: 'explicit' });
  expect(descriptor.domainEvents).toEqual(principalLifecycleDomainEvents);
  expect(Schema.is(ReplaceAgentOperatorsResultSchema)({ agentPrincipalId, projection: 'pending', revision: 1 })).toBe(
    true,
  );
  expect(Schema.is(ReplaceAgentOperatorsResultSchema)({ agentPrincipalId, projection: 'applied', revision: 1 })).toBe(
    false,
  );
});

it('accepts only bounded business input, never actor/authentication or deletion context', () => {
  expect(Schema.is(ReplaceAgentOperatorsPayloadSchema)(payload)).toBe(true);
  const decode = Schema.decodeUnknownResult(ReplaceAgentOperatorsPayloadSchema, { onExcessProperty: 'error' });
  for (const extra of [
    { actorPrincipalId: humanId },
    { tenantId: legalEntityId },
    { legalEntityId },
    { authMethod: 'session' },
    { principal: { principalId: humanId } },
  ]) {
    expect(Result.isFailure(decode({ ...payload, ...extra }))).toBe(true);
  }
  for (const change of [
    { context: 'agent-deleted' },
    { expectedRevision: -1 },
    { expectedRevision: 0.5 },
    { expectedRevision: Number.MAX_SAFE_INTEGER },
    { revokedConnections: -1 },
    { agentPrincipalId: 'not-an-id' },
    { operatorPrincipalIds: ['not-an-id'] },
    { operatorPrincipalIds: [humanId, humanId] },
    {
      operatorPrincipalIds: Array.from(
        { length: 65 },
        (_, index) => `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      ),
    },
  ]) {
    expect(Result.isFailure(decode({ ...payload, ...change }))).toBe(true);
  }
});

it.effect('decodes only exact successful native-command evidence and its identity-only lifecycle wakeup', () =>
  Effect.gen(function* decodeExactCommand() {
    expect(yield* decodeCommittedAgentOperatorCommand(committed)).toEqual(command);
    for (const change of [
      { invocationActionKey: 'core.identity.configure-agent' },
      { invocationCompanyId: otherHumanId },
      { eventCompanyId: null },
      { auditCompanyId: otherHumanId },
      { agentPrincipalId: otherHumanId },
      { payload: { data: { principalId: otherHumanId } } },
      { payload: { data: { operatorPrincipalIds: [humanId], principalId: agentPrincipalId } } },
      { evidence: null },
      { evidence: { ...committed.evidence, desiredOperatorPrincipalIds: [humanId, humanId] } },
      { evidence: { ...committed.evidence, previousRevision: 5 } },
      { evidence: { ...committed.evidence, actionKey: 'identity.agent_operators_changed' } },
    ]) {
      const result = yield* Effect.result(decodeCommittedAgentOperatorCommand({ ...committed, ...change }));
      expect(Result.isFailure(result)).toBe(true);
    }
  }),
);

it.effect('collects the desired set and existing principal wakeup together without graph-shaped event authority', () =>
  Effect.gen(function* collectNativeEvidence() {
    const collector = createActionCollector(
      principalLifecycleDomainEvents,
      'core.identity',
      replaceAgentOperatorsAction.descriptor.accessEvidencePolicy,
      ReplaceAgentOperatorsAuditEvidenceSchema,
    );
    const maximal = {
      ...command,
      desiredOperatorPrincipalIds: Array.from(
        { length: 64 },
        (_, index) => `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      ),
    };
    yield* collector.recordAuditEvidence(maximal);
    yield* recordPrincipalLifecycleChange(collector, agentPrincipalId);
    const evidence = collector.snapshot();
    expect(evidence.auditEvidence).toEqual(maximal);
    const auditJson = yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          ...ReplaceAgentOperatorsAuditEvidenceSchema.fields,
          actionKey: Schema.Literal(replaceAgentOperatorsActionKey),
          resultHash: Schema.String,
        }),
      ),
    )({ ...maximal, actionKey: replaceAgentOperatorsActionKey, resultHash: 'a'.repeat(64) });
    expect(Buffer.byteLength(auditJson, 'utf-8')).toBeLessThan(4096);
    expect(evidence.domainEvents).toHaveLength(1);
    expect(evidence.outboxMessages).toHaveLength(1);
    expect(evidence.domainEvents[0]).toMatchObject({
      eventType: 'core.identity.principal-lifecycle-changed.v1',
      payloadJson: { data: { principalId: agentPrincipalId } },
      subjectResourceId: agentPrincipalId,
      subjectResourceType: 'principal',
    });
  }),
);

const projection = {
  activeHumanIds: [humanId, otherHumanId],
  command,
  companyActive: true,
  companyMemberIds: [agentPrincipalId, humanId, otherHumanId],
  status: 'active',
  tenantActive: true,
};

it('keeps pre-native operators untouched without a command but always clears archived agents', () => {
  expect(deriveCurrentAgentOperatorSet({ ...projection, command: null })).toBeNull();
  expect(deriveCurrentAgentOperatorSet({ ...projection, command: null, status: 'disabled' })).toBeNull();
  expect(deriveCurrentAgentOperatorSet({ ...projection, command: null, status: 'archived' })).toEqual([]);
  expect(deriveCurrentAgentOperatorSet({ ...projection, status: 'archived' })).toEqual([]);
});

it('projects only the latest desired set intersected with live company membership and active tenant-local humans', () => {
  expect(deriveCurrentAgentOperatorSet(projection)).toEqual([humanId, otherHumanId]);
  expect(deriveCurrentAgentOperatorSet({ ...projection, activeHumanIds: [humanId] })).toEqual([humanId]);
  expect(deriveCurrentAgentOperatorSet({ ...projection, companyMemberIds: [agentPrincipalId, otherHumanId] })).toEqual([
    otherHumanId,
  ]);
  expect(deriveCurrentAgentOperatorSet({ ...projection, companyMemberIds: [humanId, otherHumanId] })).toEqual([]);
  for (const change of [{ tenantActive: false }, { companyActive: false }, { status: 'disabled' }]) {
    expect(deriveCurrentAgentOperatorSet({ ...projection, ...change })).toEqual([]);
  }
  const newer = { ...command, desiredOperatorPrincipalIds: [otherHumanId], previousRevision: 1, revision: 2 };
  const current = { ...projection, command: newer };
  expect(deriveCurrentAgentOperatorSet(current)).toEqual([otherHumanId]);
  expect(deriveCurrentAgentOperatorSet(current)).toEqual([otherHumanId]);
  expect(deriveCurrentAgentOperatorSet({ ...current, status: 'archived' })).toEqual([]);
});
