import { AGENT_PAGE_SIZE, AgentCommandSchema } from '@app/shared-contracts/agent-proposals';
import type { AgentProposalInput } from '@app/shared-contracts/agent-proposals';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AgentProposalRow } from '../../../api/agent-platform/mappers.ts';
import { rowsToQueueBatches } from '../../../api/agent-platform/mappers.ts';
import { findPendingDuplicateBatch, paginateAgentQueue } from '../../../api/agent-platform/service-queue.ts';

const row: AgentProposalRow = {
  actionSlug: 'apply-command',
  agentLabel: 'Agent',
  agentPrincipalId: 'agent',
  appId: 'crm',
  appliedAt: null,
  applyResult: null,
  batchId: 'batch',
  batchInstruction: 'Update the contact',
  batchRevertedAt: null,
  batchRevertedByPrincipalId: null,
  batchRevertNote: null,
  command: { _tag: 'UpdateContact', contact: { name: 'Jana', phones: ['123', '456'] } },
  createdAt: new Date('2026-10-25T00:00:00.000Z'),
  decidedAt: null,
  decidedByPrincipalId: null,
  decisionNote: null,
  diff: [],
  failure: null,
  legalEntityId: 'company',
  moduleKey: 'crm',
  position: 0,
  proposalId: 'proposal',
  reason: 'Contact changed',
  referenceAudiences: [],
  revert: null,
  revertedAt: null,
  revertedByPrincipalId: null,
  risk: 'low',
  runId: null,
  status: 'pending',
  summary: 'Update contact',
  targetLabel: 'Jana',
  tenantId: 'tenant',
};

const proposal: AgentProposalInput = {
  appId: row.appId,
  command: row.command,
  diff: [],
  reason: row.reason,
  risk: row.risk,
  summary: row.summary,
  targetLabel: row.targetLabel,
};

it('recognizes a pending retry despite nested object key order and presentation metadata', () => {
  const retry = {
    ...proposal,
    command: Schema.decodeUnknownSync(Schema.fromJsonString(AgentCommandSchema))(
      '{"contact":{"phones":["123","456"],"name":"Jana"},"_tag":"UpdateContact"}',
    ),
    summary: 'Another label for the same command',
  };
  expect(findPendingDuplicateBatch([row], [retry])).toEqual([row]);
  expect(findPendingDuplicateBatch([row], [{ ...retry, actionSlug: row.actionSlug }])).toEqual([row]);
});

it('compares all JSON command values structurally, including null, escaped keys and numeric keys', () => {
  const stored = {
    ...row,
    command: {
      _tag: 'UpdateContact',
      'quoted"key': { '10': null, '2': [false, true, 12, 'text'], nested: { a: 2, z: 1 } },
    },
  };
  const retry = {
    ...proposal,
    command: Schema.decodeUnknownSync(Schema.fromJsonString(AgentCommandSchema))(
      String.raw`{"quoted\"key":{"nested":{"z":1,"a":2},"2":[false,true,12,"text"],"10":null},"_tag":"UpdateContact"}`,
    ),
  };
  expect(findPendingDuplicateBatch([stored], [retry])).toEqual([stored]);
});

it('does not equate a different command value, array order, module or Action', () => {
  const changed = [
    { ...proposal, command: { ...row.command, extra: null } },
    { ...proposal, command: { _tag: 'UpdateContact', contact: { name: 'Jana', phones: ['456', '123'] } } },
    { ...proposal, appId: 'sales' },
    { ...proposal, actionSlug: 'update-contact' },
  ];
  for (const candidate of changed) {
    expect(findPendingDuplicateBatch([row], [candidate])).toBeUndefined();
  }
});

it('orders stored proposals by position but preserves the submitted command order', () => {
  const second = { ...row, command: { _tag: 'UpdateContact', name: 'Petr' }, position: 1, proposalId: 'second' };
  const submitted = { ...proposal, command: second.command };
  expect(findPendingDuplicateBatch([second, row], [proposal, submitted])).toEqual([row, second]);
  expect(findPendingDuplicateBatch([second, row], [submitted, proposal])).toBeUndefined();
});

it('retains the 31st native candidate even when private visibility removes every proposal', () => {
  const candidates = Array.from({ length: AGENT_PAGE_SIZE + 1 }, (_, index) => ({
    at: new Date(Date.UTC(2026, 9, 25, 0, 0, AGENT_PAGE_SIZE - index)).toISOString(),
    id: `core:batch-${index}`,
  }));
  const page = paginateAgentQueue(candidates, [], []);
  expect(page.batches).toEqual([]);
  expect(page.nextCursor).toEqual(candidates.at(AGENT_PAGE_SIZE - 1));
  expect(paginateAgentQueue(candidates.slice(0, AGENT_PAGE_SIZE), [], []).nextCursor).toBeUndefined();
});

it('merges native candidates and legacy batches without rebuilding candidates from visible rows', () => {
  const [batch] = rowsToQueueBatches([row], {
    canDecide: () => ({ allowed: false }),
    modules: { commandFieldLabelsOf: () => ({}), hasOwnProposalEngine: () => false, labelOf: () => 'Module' },
    names: new Map(),
  });
  if (batch === undefined) {
    throw new Error('Expected the real queue mapper to produce a batch');
  }
  const legacy = { ...batch, createdAt: '2026-10-24T23:59:59.000Z', key: 'legacy:crm:batch' };
  const visible = { at: batch.createdAt, id: batch.key };
  const hidden = { at: '2026-10-25T00:00:01.000Z', id: 'core:hidden' };
  const page = paginateAgentQueue([hidden, visible], [batch], [legacy]);
  expect(page.batches.map((entry) => entry.key)).toEqual([batch.key, legacy.key]);
  expect(page.nextCursor).toBeUndefined();
});

it('does not replay a decided, mixed-status, reverted or incomplete batch', () => {
  const applied = { ...row, status: 'applied' } as const;
  const reverted = { ...row, batchRevertedAt: row.createdAt };
  const second = { ...row, position: 1, proposalId: 'second' };
  expect(findPendingDuplicateBatch([applied], [proposal])).toBeUndefined();
  expect(findPendingDuplicateBatch([row, { ...applied, position: 1 }], [proposal, proposal])).toBeUndefined();
  expect(findPendingDuplicateBatch([reverted], [proposal])).toBeUndefined();
  expect(findPendingDuplicateBatch([row, second], [proposal])).toBeUndefined();
});
