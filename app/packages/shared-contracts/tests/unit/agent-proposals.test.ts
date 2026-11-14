import { DateTime, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AGENT_PAGE_SIZE,
  AgentActivityEntrySchema,
  AgentActivityRequestSchema,
  AgentPageCursorSchema,
  AgentQueueBatchSchema,
} from '../../src/agent-proposals.ts';

const decodeCursor = Schema.decodeUnknownResult(AgentPageCursorSchema);
const decodeActivity = Schema.decodeUnknownResult(AgentActivityRequestSchema);

it('accepts only real canonical UTC millisecond positions for stable SQL and wire ordering', () => {
  const id = 'proposal:example';
  expect(Result.isSuccess(decodeCursor({ at: '2026-10-23T10:00:00.000Z', id }))).toBe(true);
  for (const at of [
    '2026-10-23T10:00:00Z',
    '2026-10-23T12:00:00.000+02:00',
    'not-a-date',
    '2026-99-99T10:00:00.000Z',
  ]) {
    expect(Result.isFailure(decodeCursor({ at, id }))).toBe(true);
  }
});

it('never accepts an activity page larger than the bounded source lookahead', () => {
  expect(Result.isSuccess(decodeActivity({ limit: AGENT_PAGE_SIZE }))).toBe(true);
  expect(Result.isFailure(decodeActivity({ limit: AGENT_PAGE_SIZE + 1 }))).toBe(true);
  expect(Result.isFailure(decodeActivity({ limit: 0 }))).toBe(true);
});

it('decodes activity dates and nullable modules while preserving the encoded activity shape', () => {
  const wire = {
    actionLabel: 'Denied',
    agentName: 'Agent',
    agentPrincipalId: 'legacy-agent',
    id: 'audit:event',
    kind: 'denied',
    moduleKey: null,
    moduleLabel: 'Platforma',
    occurredAt: '2026-10-23T10:00:00.000Z',
    outcomeCode: 'forbidden',
  };
  const entry = Schema.decodeUnknownSync(AgentActivityEntrySchema)(wire);
  expect(Option.isNone(entry.moduleKey)).toBe(true);
  expect(DateTime.formatIso(entry.occurredAt)).toBe(wire.occurredAt);
  expect(Schema.encodeSync(AgentActivityEntrySchema)(entry)).toEqual(wire);
  const moduleWire = {
    ...wire,
    moduleKey: 'demo.crm',
    proposal: { batchKey: 'core:batch', itemKey: 'core:item' },
    recordReference: { resourceId: 'record-1', resourceType: 'demo.client' },
  };
  const moduleEntry = Schema.decodeUnknownSync(AgentActivityEntrySchema)(moduleWire);
  expect(Option.getOrThrow(moduleEntry.moduleKey)).toBe('demo.crm');
  expect(Schema.encodeSync(AgentActivityEntrySchema)(moduleEntry)).toEqual(moduleWire);
});

it('encodes queue dates and optional decisions without adding absent fields', () => {
  const wire = {
    agentLabel: 'Agent',
    agentPrincipalId: 'legacy-agent',
    batchId: 'legacy-batch',
    canRevertAll: false,
    createdAt: '2026-10-23T10:00:00.000Z',
    instruction: 'Change a record',
    items: [
      {
        appId: 'crm',
        canDecide: true,
        diff: [],
        key: 'core:item',
        moduleKey: 'demo.crm',
        moduleLabel: 'CRM',
        proposedAt: '2026-10-23T10:00:00.000Z',
        reason: 'Requested',
        risk: 'low',
        status: 'pending',
        summary: 'Change',
        targetLabel: 'Record',
      },
    ],
    key: 'core:batch',
    moduleLabels: ['CRM'],
    source: 'core',
  };
  const batch = Schema.decodeUnknownSync(AgentQueueBatchSchema)(wire);
  expect(DateTime.formatIso(batch.createdAt)).toBe(wire.createdAt);
  expect(Schema.encodeSync(AgentQueueBatchSchema)(batch)).toEqual(wire);
});
