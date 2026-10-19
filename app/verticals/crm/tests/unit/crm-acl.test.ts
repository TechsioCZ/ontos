import { describe, expect, it } from '@rstest/core';
import { Effect, Exit } from 'effect';
import { dispatchCrmCommand } from '../../shared/commands/index.ts';
import type { CrmViewer } from '../../shared/domain/access.ts';
import type { CrmState } from '../../shared/domain/state.ts';
import { initialCrmState, projectCrmState } from '../../shared/domain/state.ts';

const at = '2026-10-20T00:00:00.000Z';
const client = (id: string, owner?: string) => ({
  createdAt: at,
  createdBy: 'p-admin',
  id,
  kind: 'organization' as const,
  name: id,
  status: 'active' as const,
  updatedAt: at,
  ...(owner === undefined ? {} : { ownerSalespersonId: owner }),
});
const state: CrmState = {
  ...initialCrmState,
  clients: { assignmentHistory: [], contacts: [], items: [client('x', 'a'), client('y', 'b'), client('z')] },
  salespeople: [
    { active: true, id: 'a', name: 'A', principalId: 'p-a' },
    { active: true, id: 'b', name: 'B', principalId: 'p-b' },
  ],
};
const rep: CrmViewer = {
  assign: false,
  principalId: 'p-a',
  readAll: false,
  readAssigned: true,
  salespersonId: 'a',
  writeAll: false,
  writeAssigned: true,
};
const leadViewer: CrmViewer = {
  assign: true,
  principalId: 'p-lead',
  readAll: true,
  readAssigned: false,
  writeAll: true,
  writeAssigned: false,
};

describe('CRM ACL', () => {
  it('a salesperson sees only own clients; the lead sees all', () => {
    expect(projectCrmState(state, rep).clients.items.map((entry) => entry.id)).toEqual(['x']);
    expect(projectCrmState(state, leadViewer).clients.items.map((entry) => entry.id)).toEqual(['x', 'y', 'z']);
  });
  it('a salesperson cannot write a foreign client (not found, no leak)', () => {
    const exit = Effect.runSyncExit(
      dispatchCrmCommand(
        state,
        { _tag: 'RecordVisit', clientId: 'y', kind: 'visit', occurredAt: at, result: 'ok' },
        { invocationId: 'i1', now: at, viewer: rep },
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
  it('reassignment keeps history and the old visit author', () => {
    const visited = Effect.runSync(
      dispatchCrmCommand(
        state,
        { _tag: 'RecordVisit', clientId: 'x', kind: 'visit', occurredAt: at, result: 'ok' },
        { invocationId: 'i1', now: at, viewer: rep },
      ),
    );
    const moved = Effect.runSync(
      dispatchCrmCommand(
        visited.state,
        { _tag: 'AssignClient', clientId: 'x', toSalespersonId: 'b' },
        {
          invocationId: 'i2',
          now: at,
          viewer: leadViewer,
        },
      ),
    );
    expect(moved.state.clients.assignmentHistory).toHaveLength(1);
    expect(moved.state.visits.items[0]?.salespersonId).toBe('a');
    expect(projectCrmState(moved.state, rep).clients.items).toHaveLength(0);
  });
});
