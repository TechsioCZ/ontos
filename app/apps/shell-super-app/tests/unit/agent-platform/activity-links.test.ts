import { AgentActivityEntrySchema, AgentRecordReferenceSchema } from '@app/shared-contracts/agent-proposals';
import { Schema } from 'effect';
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
  commands: [{ idField: 'noteId', tag: 'UpdateNote' }],
  idField: 'id',
  labelField: 'title',
  path: '/notes',
  queryParam: 'note',
  recordsPath: 'state.notes',
  resourceType: 'fixture.note',
};
const entry = Schema.decodeUnknownSync(AgentActivityEntrySchema)({
  actionLabel: 'Návrh: Upravit poznámku',
  agentName: 'Agent',
  agentPrincipalId: 'agent-1',
  id: 'proposal:p1',
  kind: 'proposal',
  moduleKey: 'fixture.notes',
  moduleLabel: 'Poznámky',
  occurredAt: '2026-10-23T10:00:00Z',
  outcomeCode: 'proposed',
  proposal: { batchKey: 'core:batch', itemKey: 'core:proposal' },
  recordReference: { resourceId: 'a /&?', resourceType: 'fixture.note' },
});
const absentDestinations: Partial<Pick<ActivityLinkAccess, 'identityPage' | 'module'>> = {};
const [module] = buildMcpModules(fixtureComposition).modules;
if (module === undefined) {
  throw new Error('Fixture module is missing');
}
const access: ActivityLinkAccess = {
  agentExists: true,
  canManageAgents: true,
  canOpenModule: true,
  canReviewProposals: true,
  grants: [
    {
      actingKind: 'agent',
      actingPrincipalId: 'agent-1',
      clientName: 'Aplikace',
      grantId: 'grant /1',
      writePolicy: 'approval',
    },
  ],
  identityPage: '/sprava/lide-a-role',
  module: { ...module, page: '/notes', recordLinks: [link] },
  personExists: false,
  records: { state: { notes: [{ id: 'a /&?', title: 'Poznámka zákazníka' }] } },
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
  expect(resolved.agentPath).toBe('/sprava/lide-a-role?agent=agent-1');
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
  expect(
    resolveActivityRecord(
      [link],
      Schema.decodeUnknownSync(AgentRecordReferenceSchema)({ resourceId: 'a /&?', resourceType: 'other' }),
      access.records,
    ),
  ).toBeUndefined();
});

it('keeps unknown modules, absent agents and grants, and audit entries with no detail destination as text', () => {
  const { proposal: _proposal, ...audit } = entry;
  const resolved = resolveActivityLinks(audit, {
    ...access,
    agentExists: false,
    grants: [],
    module: absentDestinations.module,
  });
  expect(resolved.actionPath).toBeUndefined();
  expect(resolved.agentPath).toBeUndefined();
  expect(resolved.modulePath).toBeUndefined();
  expect(resolved.record).toBeUndefined();
  expect(resolved.grants).toBeUndefined();
});

it('links human-delegated OAuth activity to its real person identity, not a fabricated agent', () => {
  const resolved = resolveActivityLinks(entry, {
    ...access,
    agentExists: false,
    grants: access.grants.map((grant) => ({ ...grant, actingKind: 'human' })),
    personExists: true,
  });
  expect(resolved.agentPath).toBe('/sprava/lide-a-role?person=agent-1');
  expect(resolved.grants?.[0]?.path).toBe('/sprava/pripojene-aplikace?grant=grant%20%2F1');
  expect(
    resolveActivityLinks(entry, { ...access, canManageAgents: false, personExists: true }).agentPath,
  ).toBeUndefined();
});

it('does not substitute a connections filter when the real identity destination is unavailable', () => {
  expect(
    resolveActivityLinks(entry, { ...access, identityPage: absentDestinations.identityPage }).agentPath,
  ).toBeUndefined();
  expect(resolveActivityLinks(entry, { ...access, agentExists: false }).agentPath).toBeUndefined();
});
