import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Exit, Schema } from 'effect';
import { CrmCommandSchema, dispatchCrmCommand } from '../../shared/commands/index.ts';
import type { ClientSchema } from '../../shared/domain/clients.ts';
import { CrmViewerSchema } from '../../shared/domain/access.ts';
import { CrmStateSchema, initialCrmState, projectCrmState } from '../../shared/domain/state.ts';

const decodeCommand = Schema.decodeUnknownSync(CrmCommandSchema);

const at = '2026-10-20T00:00:00.000Z';
const client = (id: string, owner?: string): typeof ClientSchema.Encoded => {
  const value = {
    createdAt: at,
    createdBy: 'p-admin',
    id,
    kind: 'organization' as const,
    name: id,
    status: 'active' as const,
    updatedAt: at,
  };
  if (owner === undefined) {
    return value;
  }
  return { ...value, ownerSalespersonId: owner };
};
const state = Schema.decodeUnknownSync(CrmStateSchema)({
  ...Schema.encodeSync(CrmStateSchema)(initialCrmState),
  clients: { assignmentHistory: [], contacts: [], items: [client('x', 'a'), client('y', 'b'), client('z')] },
  salespeople: [
    { active: true, id: 'a', name: 'A', principalId: 'p-a' },
    { active: true, id: 'b', name: 'B', principalId: 'p-b' },
  ],
});
const rep = Schema.decodeUnknownSync(CrmViewerSchema)({
  assign: false,
  principalId: 'p-a',
  readAll: false,
  readAssigned: true,
  salespersonId: 'a',
  writeAll: false,
  writeAssigned: true,
});
const leadViewer = Schema.decodeUnknownSync(CrmViewerSchema)({
  assign: true,
  principalId: 'p-lead',
  readAll: true,
  readAssigned: false,
  writeAll: true,
  writeAssigned: false,
});

describe('CRM ACL', () => {
  it('a salesperson sees only own clients; the lead sees all', () => {
    expect(projectCrmState(state, rep).clients.items.map((entry) => entry.id)).toEqual(['x']);
    expect(projectCrmState(state, leadViewer).clients.items.map((entry) => entry.id)).toEqual(['x', 'y', 'z']);
  });
  it.effect('a salesperson cannot write a foreign client (not found, no leak)', () =>
    Effect.gen(function* foreignClientAccess() {
      const exit = yield* Effect.exit(
        dispatchCrmCommand(
          state,
          decodeCommand({ _tag: 'RecordVisit', clientId: 'y', kind: 'visit', occurredAt: at, result: 'ok' }),
          { invocationId: 'i1', now: DateTime.makeUnsafe(at), viewer: rep },
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
  it.effect('reassignment keeps history and the old visit author', () =>
    Effect.gen(function* reassignmentHistory() {
      const visited = yield* dispatchCrmCommand(
        state,
        decodeCommand({ _tag: 'RecordVisit', clientId: 'x', kind: 'visit', occurredAt: at, result: 'ok' }),
        { invocationId: 'i1', now: DateTime.makeUnsafe(at), viewer: rep },
      );
      const moved = yield* dispatchCrmCommand(
        visited.state,
        decodeCommand({
          _tag: 'AssignClient',
          clientId: 'x',
          reason: 'Předání klienta při změně regionu',
          toSalespersonId: 'b',
        }),
        {
          invocationId: 'i2',
          now: DateTime.makeUnsafe(at),
          viewer: leadViewer,
        },
      );
      expect(moved.state.clients.assignmentHistory).toHaveLength(1);
      expect(moved.state.visits.items[0]?.salespersonId).toBe('a');
      expect(projectCrmState(moved.state, rep).clients.items).toHaveLength(0);
    }),
  );
});
