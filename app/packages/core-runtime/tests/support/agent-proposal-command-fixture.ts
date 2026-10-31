import { DateTime, Record, Schema } from 'effect';
import { getTableColumns } from 'drizzle-orm';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { AgentProposalCommandAudit } from '../../src/auth/agent-proposal-command-contract.ts';
import { agentProposals } from '../../src/db/schema.ts';

export const tenantId = '10000000-0000-4000-8000-000000000001';
export const legalEntityId = '20000000-0000-4000-8000-000000000001';
export const humanId = '30000000-0000-4000-8000-000000000001';
export const agentId = '30000000-0000-4000-8000-000000000002';
export const otherHumanId = '30000000-0000-4000-8000-000000000003';
export const batchId = '50000000-0000-4000-8000-000000000001';
export const proposalId = '60000000-0000-4000-8000-000000000001';
export const reservationId = '70000000-0000-4000-8000-000000000001';
export const nextInvocationId = '70000000-0000-4000-8000-000000000002';
export const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-25T12:00:00.000Z'));
export const laterTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-25T12:10:00.000Z'));
export const scope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:proposal-command',
    authMethod: 'session',
    legalEntityId,
    principalId: humanId,
    tenantId,
  }),
  correlationId: 'original-proposal-request',
};
export type Proposal = typeof agentProposals.$inferSelect;
export const proposalRow = (patch: Partial<Proposal> = {}): Proposal => ({
  actionSlug: 'update',
  agentLabel: 'Agent',
  agentPrincipalId: agentId,
  appId: 'tasks',
  appliedAt: null,
  applyResultJson: null,
  batchId,
  batchInstruction: 'Update tasks',
  batchRevertedAt: null,
  batchRevertedByPrincipalId: null,
  batchRevertNote: null,
  commandJson: { title: 'New' },
  createdAt: operationTime,
  decidedAt: null,
  decidedByPrincipalId: null,
  decisionNote: null,
  diffJson: [{ after: 'New', before: 'Old', field: 'title', label: 'Title' }],
  failure: null,
  legalEntityId,
  moduleKey: 'work.tasks',
  position: 0,
  proposalId,
  reason: 'Requested',
  referenceAudiencesJson: [],
  revertedAt: null,
  revertedByPrincipalId: null,
  revertJson: null,
  risk: 'low',
  runId: null,
  status: 'pending',
  summary: 'Update',
  targetLabel: 'Task',
  tenantId,
  ...patch,
});
/** Scripted SQL returns fields in Drizzle's selected table order, not fixture property order. */
export const proposalSqlRow = (row: Proposal) =>
  Object.fromEntries(Record.keys(getTableColumns(agentProposals)).map((key) => [key, row[key]]));
export const reservationAudit = (
  operation: AgentProposalCommandAudit['operation'] = 'claim-approval',
): AgentProposalCommandAudit => ({
  affectedProposalIds: [proposalId],
  batchId,
  operation,
  outcome: 'changed',
  proposalIds: [proposalId],
  proposerPrincipalId: agentId,
  reservationId,
  revision: 1,
});
export const transitionInput = (rows: readonly Proposal[], claim = reservationAudit()) => ({
  actorPrincipalId: humanId,
  claim,
  invocationId: nextInvocationId,
  now: laterTime,
  rows,
});
