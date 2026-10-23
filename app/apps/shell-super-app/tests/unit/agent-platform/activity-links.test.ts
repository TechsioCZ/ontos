import type { AgentActivityEntry } from '@app/shared-contracts/agent-proposals';
import { expect, it } from 'effect-rstest';

import {
  commandRecordReference,
  resolveActivityLinks,
  resolveActivityRecord,
} from '../../../api/agent-platform/activity-links.ts';
import type { ActivityLinkAccess } from '../../../api/agent-platform/activity-links.ts';
import { buildMcpModules } from '../../../api/mcp/catalog.ts';
import { fixtureComposition } from '../mcp/fixture-vertical.ts';

const link = {
  commands: [{ tag: 'UpdateNote', idField: 'noteId' }],
  idField: 'id',
  labelField: 'title',
  path: '/notes',
  queryParam: 'note',
  recordsPath: 'state.notes',
  resourceType: 'fixture.note',
};
const entry: AgentActivityEntry = {
  actionLabel: 'Návrh: Upravit poznámku',
  agentName: 'Agent',
  agentPrincipalId: 'agent-1',
  id: 'proposal:p1',
  kind: 'proposal',
  moduleKey: 'fixture.notes',
  moduleLabel: 'Poznámky',
  occurredAt: '2026-10-23T10:00:00Z',
  outcomeCode: 'proposed',
  recordReference: { resourceId: 'a /&?', resourceType: 'fixture.note' },
  proposal: { batchKey: 'core:batch', itemKey: 'core:proposal' },
};
const module = buildMcpModules(fixtureComposition).modules[0];
if (module === undefined) throw new Error('Fixture module is missing');
const access: ActivityLinkAccess = {
  agentExists: true,
  canManageAgents: true,
  canOpenModule: true,
  canReviewProposals: true,
  identityPage: '/people',
  module: { ...module, page: '/notes', recordLinks: [link] },
  records: { state: { notes: [{ id: 'a /&?', title: 'Poznámka zákazníka' }] } },
  grants: [
    {
      actingKind: 'agent',
      actingPrincipalId: 'agent-1',
      clientName: 'Aplikace',
      grantId: 'grant /1',
      writePolicy: 'approval',
    },
  ],
};

it('resolves record references from module-declared commands, never by guessing command fields', () => {
  expect(commandRecordReference([link], { _tag: 'UpdateNote', noteId: 'n1' })).toEqual({
    resourceId: 'n1',
    resourceType: 'fixture.note',
  });
  expect(commandRecordReference([link], { _tag: 'Unknown', noteId: 'n1' })).toBeUndefined();
  expect(commandRecordReference([link], { _tag: 'UpdateNote' })).toBeUndefined();
});

it('links the exact proposal, record, module home, agent identity and each real grant', () => {
  const resolved = resolveActivityLinks(entry, access);
  expect(resolved.actionPath).toBe('/sprava/ke-schvaleni?davka=core%3Abatch&navrh=core%3Aproposal');
  expect(resolved.modulePath).toBe('/notes');
  expect(resolved.record).toEqual({ label: 'Poznámka zákazníka', path: '/notes?note=a+%2F%26%3F' });
  expect(resolved.agentPath).toBe('/people?agent=agent-1');
  expect(resolved.grants?.[0]?.path).toBe('/sprava/pripojene-aplikace?grant=grant%20%2F1');
});

it('does not link targets when the viewer lacks permission, even if all target data exists', () => {
  const resolved = resolveActivityLinks(entry, {
    ...access,
    canManageAgents: false,
    canOpenModule: false,
    canReviewProposals: false,
  });
  expect(resolved.actionPath).toBeUndefined();
  expect(resolved.modulePath).toBeUndefined();
  expect(resolved.record).toBeUndefined();
  expect(resolved.agentPath).toBeUndefined();
  expect(resolved.grants).toBeUndefined();
});

it('does not link a missing, deleted, invisible or unavailable record', () => {
  for (const records of [
    undefined,
    {},
    { state: { notes: [] } },
    { state: { notes: [{ id: 'other', title: 'Jiná' }] } },
  ]) {
    expect(resolveActivityLinks(entry, { ...access, records }).record).toBeUndefined();
  }
  expect(resolveActivityRecord([], entry.recordReference, access.records)).toBeUndefined();
  expect(resolveActivityRecord([link], undefined, access.records)).toBeUndefined();
  expect(resolveActivityRecord([link], { resourceId: 'a /&?', resourceType: 'other' }, access.records)).toBeUndefined();
});

it('keeps unknown modules, absent agents and grants, and audit entries with no detail destination as text', () => {
  const { proposal: _proposal, ...audit } = entry;
  const resolved = resolveActivityLinks(audit, { ...access, agentExists: false, grants: [], module: undefined });
  expect(resolved.actionPath).toBeUndefined();
  expect(resolved.agentPath).toBeUndefined();
  expect(resolved.modulePath).toBeUndefined();
  expect(resolved.record).toBeUndefined();
  expect(resolved.grants).toBeUndefined();
});

it('uses connected apps only when a real grant exists and the viewer can administer it', () => {
  expect(resolveActivityLinks(entry, { ...access, identityPage: undefined }).agentPath).toBe(
    '/sprava/pripojene-aplikace?agent=agent-1',
  );
  expect(
    resolveActivityLinks(entry, {
      ...access,
      grants: [{ ...access.grants[0]!, actingPrincipalId: 'other' }],
      identityPage: undefined,
    }).agentPath,
  ).toBeUndefined();
});
