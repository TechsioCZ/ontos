import { DateTime, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CrmCommandSchema, dispatchCrmCommand } from '../../shared/commands/index.ts';
import type { CrmCommandInput } from '../../shared/commands/index.ts';
import { CrmViewerSchema } from '../../shared/domain/access.ts';
import { AiOperationSchema } from '../../shared/domain/ai-changes.ts';
import { CrmStateSchema, initialCrmState, projectCrmState } from '../../shared/domain/state.ts';
import { lastVisitOf } from '../../shared/domain/visits.ts';

const at = '2026-11-02T12:00:00.000Z';
const fixture = Effect.gen(function* archiveFixture() {
  const state = yield* Schema.decodeUnknownEffect(CrmStateSchema)({
    ...initialCrmState,
    clients: {
      assignmentHistory: [],
      contacts: [],
      items: [
        {
          createdAt: at,
          createdBy: 'lead',
          id: 'client',
          kind: 'organization',
          name: 'Klient',
          ownerSalespersonId: 'salesperson',
          status: 'active',
          updatedAt: at,
        },
      ],
    },
    salespeople: [{ active: true, id: 'salesperson', name: 'Obchodník', principalId: 'rep' }],
    visits: {
      items: [
        {
          authorPrincipalId: 'lead',
          clientId: 'client',
          corrections: [{ at, by: 'lead', field: 'Výsledek', next: 'QA ověření', previous: 'Původní text' }],
          createdAt: at,
          id: 'qa-visit',
          kind: 'visit',
          occurredAt: at,
          result: 'QA ověření',
          updatedAt: at,
        },
      ],
      plan: [],
    },
  });
  const lead = yield* Schema.decodeUnknownEffect(CrmViewerSchema)({
    assign: true,
    principalId: 'lead',
    readAll: true,
    readAssigned: false,
    writeAll: true,
    writeAssigned: false,
  });
  const rep = yield* Schema.decodeUnknownEffect(CrmViewerSchema)({
    assign: false,
    principalId: 'rep',
    readAll: false,
    readAssigned: true,
    salespersonId: 'salesperson',
    writeAll: false,
    writeAssigned: true,
  });
  return { lead, rep, state };
});
const command = {
  _tag: 'ArchiveVisit',
  reason: 'Odstranění testovacího záznamu z ukázky',
  visitId: 'qa-visit',
} as const satisfies CrmCommandInput;

it.effect('archives the visit without deleting its original content, author or correction history', () =>
  Effect.gen(function* retainedArchive() {
    const { lead, state } = yield* fixture;
    const decoded = yield* Schema.decodeUnknownEffect(CrmCommandSchema)(command);
    const result = yield* dispatchCrmCommand(state, decoded, {
      invocationId: 'archive',
      now: DateTime.makeUnsafe(at),
      viewer: lead,
    });
    const [visit] = result.state.visits.items;
    expect(result.state.visits.items).toHaveLength(1);
    expect(visit?.result).toBe('QA ověření');
    expect(visit?.authorPrincipalId).toBe('lead');
    expect(visit?.corrections).toEqual(state.visits.items[0]?.corrections);
    expect(visit?.archive?.by).toBe('lead');
    expect(visit?.archive?.reason).toBe(command.reason);
    expect(projectCrmState(result.state, lead).visits.items).toHaveLength(0);
    expect(lastVisitOf(result.state.visits.items, 'client')).toBeUndefined();
    expect(
      (yield* dispatchCrmCommand(result.state, decoded, {
        invocationId: 'again',
        now: DateTime.makeUnsafe('2026-11-03T12:00:00Z'),
        viewer: lead,
      })).state,
    ).toBe(result.state);
    const correction = yield* Schema.decodeUnknownEffect(CrmCommandSchema)({
      _tag: 'CorrectVisit',
      result: 'Přepsání archivovaného záznamu',
      visitId: 'qa-visit',
    });
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          dispatchCrmCommand(result.state, correction, {
            invocationId: 'correction',
            now: DateTime.makeUnsafe(at),
            viewer: lead,
          }),
        ),
      ),
    ).toBe(true);
  }),
);
it.effect('does not widen an assigned salesperson’s existing permissions', () =>
  Effect.gen(function* managerOnly() {
    const { rep, state } = yield* fixture;
    const decoded = yield* Schema.decodeUnknownEffect(CrmCommandSchema)(command);
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          dispatchCrmCommand(state, decoded, { invocationId: 'denied', now: DateTime.makeUnsafe(at), viewer: rep }),
        ),
      ),
    ).toBe(true);
    expect(state.visits.items[0]?.archive).toBeUndefined();
  }),
);
it.effect('keeps the AI contact-plan operation at its original tuple position and archive outside AI proposals', () =>
  Effect.gen(function* unchangedAiCommands() {
    yield* Schema.decodeUnknownEffect(AiOperationSchema)({
      _tag: 'PlanContact',
      clientId: 'client',
      dueDate: '2026-11-03',
    });
    expect(Exit.isFailure(yield* Effect.exit(Schema.decodeUnknownEffect(AiOperationSchema)(command)))).toBe(true);
    expect(
      Exit.isFailure(yield* Effect.exit(Schema.decodeUnknownEffect(CrmCommandSchema)({ ...command, reason: '' }))),
    ).toBe(true);
  }),
);
