import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Exit, Schema } from 'effect';
import type { CrmCommandInput } from '../../shared/commands/index.ts';
import { CrmCommandSchema, dispatchCrmCommand } from '../../shared/commands/index.ts';
import type { ClientSchema } from '../../shared/domain/clients.ts';
import { CrmViewerSchema } from '../../shared/domain/access.ts';
import type { CrmViewer } from '../../shared/domain/access.ts';
import type { CrmState } from '../../shared/domain/state.ts';
import { CrmStateSchema, initialCrmState, projectCrmState } from '../../shared/domain/state.ts';
import { VisitCorrectionSchema, lastVisitOf, nextPlanItemOf } from '../../shared/domain/visits.ts';

const now = '2026-10-20T08:00:00.000Z';
const client = (id: string, owner?: string): typeof ClientSchema.Encoded => {
  const value = {
    createdAt: now,
    createdBy: 'p-admin',
    id,
    kind: 'organization' as const,
    name: id,
    status: 'active' as const,
    updatedAt: now,
  };
  if (owner === undefined) {
    return value;
  }
  return { ...value, ownerSalespersonId: owner };
};
const base = Schema.decodeUnknownSync(CrmStateSchema)({
  ...Schema.encodeSync(CrmStateSchema)(initialCrmState),
  clients: { assignmentHistory: [], contacts: [], items: [client('x', 'a'), client('y', 'b')] },
  salespeople: [
    { active: true, id: 'a', name: 'A', principalId: 'p-a' },
    { active: true, id: 'b', name: 'B', principalId: 'p-b' },
  ],
});
const repA = Schema.decodeUnknownSync(CrmViewerSchema)({
  assign: false,
  principalId: 'p-a',
  readAll: false,
  readAssigned: true,
  salespersonId: 'a',
  writeAll: false,
  writeAssigned: true,
});
const repB = Schema.decodeUnknownSync(CrmViewerSchema)({ ...repA, principalId: 'p-b', salespersonId: 'b' });
const lead = Schema.decodeUnknownSync(CrmViewerSchema)({
  assign: true,
  principalId: 'p-lead',
  readAll: true,
  readAssigned: false,
  writeAll: true,
  writeAssigned: false,
});

let sequence = 0;
const run = (state: CrmState, command: CrmCommandInput, viewer: CrmViewer) => {
  sequence += 1;
  const invocationId = `i${sequence}`;
  return Schema.decodeUnknownEffect(CrmCommandSchema)(command).pipe(
    Effect.flatMap((decoded) =>
      dispatchCrmCommand(state, decoded, { invocationId, now: DateTime.makeUnsafe(now), viewer }),
    ),
    Effect.exit,
  );
};
const ok = (state: CrmState, command: CrmCommandInput, viewer: CrmViewer) =>
  Effect.gen(function* effectGenerator1() {
    const exit = yield* run(state, command, viewer);
    if (Exit.isFailure(exit)) {
      throw new Error(`command failed: ${JSON.stringify(exit.cause)}`);
    }
    return exit.value;
  });

const visitX = {
  _tag: 'RecordVisit',
  clientId: 'x',
  kind: 'visit',
  note: 'Původní poznámka',
  occurredAt: '2026-10-19T09:30:00.000Z',
  result: 'Představena nabídka',
} as const;

describe('CRM visits (C02)', () => {
  it.effect('C02-01 a rep records a visit with author, date and result', () =>
    Effect.gen(function* effectGenerator2() {
      const change = yield* ok(base, visitX, repA);
      const [visit] = change.state.visits.items;
      expect(visit?.authorPrincipalId).toBe('p-a');
      expect(visit?.salespersonId).toBe('a');
      expect(visit?.occurredAt.pipe(DateTime.formatIso)).toBe(visitX.occurredAt);
      expect(visit?.result).toBe('Představena nabídka');
      expect(lastVisitOf(change.state.visits.items, 'x')?.id).toBe(change.entityIds[0]);
    }),
  );

  it.effect('C02-02 rep B neither writes nor reads visits of client X', () =>
    Effect.gen(function* effectGenerator3() {
      expect(Exit.isFailure(yield* run(base, visitX, repB))).toBe(true);
      const visited = (yield* ok(base, visitX, repA)).state;
      expect(projectCrmState(visited, repB).visits.items).toHaveLength(0);
      expect(projectCrmState(visited, lead).visits.items).toHaveLength(1);
    }),
  );

  it.effect('C02-03 a correction keeps previous value, author and time', () =>
    Effect.gen(function* effectGenerator4() {
      const visited = yield* ok(base, visitX, repA);
      const visitId = visited.entityIds[0] ?? '';
      const corrected = (yield* ok(
        visited.state,
        { _tag: 'CorrectVisit', note: 'Opravená poznámka', reason: 'Překlep', visitId },
        repA,
      )).state;
      const [visit] = corrected.visits.items;
      expect(visit?.note).toBe('Opravená poznámka');
      expect(visit?.corrections.map((entry) => Schema.encodeSync(VisitCorrectionSchema)(entry))).toEqual([
        {
          at: now,
          by: 'p-a',
          field: 'Poznámka',
          next: 'Opravená poznámka',
          previous: 'Původní poznámka',
          reason: 'Překlep',
        },
      ]);
      expect(visit?.authorPrincipalId).toBe('p-a');
    }),
  );

  it.effect('an unchanged correction is rejected and a foreign rep cannot correct', () =>
    Effect.gen(function* effectGenerator5() {
      const visited = yield* ok(base, visitX, repA);
      const visitId = visited.entityIds[0] ?? '';
      expect(
        Exit.isFailure(yield* run(visited.state, { _tag: 'CorrectVisit', note: 'Původní poznámka', visitId }, repA)),
      ).toBe(true);
      expect(Exit.isFailure(yield* run(visited.state, { _tag: 'CorrectVisit', note: 'cizí', visitId }, repB))).toBe(
        true,
      );
    }),
  );

  it.effect('a rep cannot record on behalf of another salesperson; the lead can', () =>
    Effect.gen(function* effectGenerator6() {
      expect(Exit.isFailure(yield* run(base, { ...visitX, salespersonId: 'b' }, repA))).toBe(true);
      const byLead = (yield* ok(base, { ...visitX, clientId: 'y', salespersonId: 'b' }, lead)).state;
      expect(byLead.visits.items[0]?.salespersonId).toBe('b');
      expect(byLead.visits.items[0]?.authorPrincipalId).toBe('p-lead');
    }),
  );

  it.effect('future contacts, including later today, belong in the plan rather than history', () =>
    Effect.gen(function* effectGenerator7() {
      yield* Effect.forEach(
        ['2026-10-20T08:01:00.000Z', '2026-10-21T07:00:00.000Z', '2026-11-15T09:00:00.000Z'],
        (occurredAt) =>
          Effect.gen(function* effectGenerator8() {
            expect(Exit.isFailure(yield* run(base, { ...visitX, occurredAt }, repA))).toBe(true);
          }),
      );
    }),
  );

  it.effect('impossible visit and next-step calendar dates are rejected', () =>
    Effect.gen(function* effectGenerator9() {
      expect(Exit.isFailure(yield* run(base, { ...visitX, occurredAt: '2026-02-30T09:00:00.000Z' }, repA))).toBe(true);
      expect(Exit.isFailure(yield* run(base, { ...visitX, addToPlan: true, nextStepDate: '2026-11-31' }, repA))).toBe(
        true,
      );
      const visited = yield* ok(base, visitX, repA);
      expect(
        Exit.isFailure(
          yield* run(
            visited.state,
            {
              _tag: 'CorrectVisit',
              nextStepDate: '2026-02-30',
              visitId: visited.entityIds[0] ?? '',
            },
            repA,
          ),
        ),
      ).toBe(true);
    }),
  );

  it.effect('a lead cannot attribute a new visit to an inactive salesperson', () =>
    Effect.gen(function* effectGenerator10() {
      const encoded = Schema.encodeSync(CrmStateSchema)(base);
      const inactive = Schema.decodeUnknownSync(CrmStateSchema)({
        ...encoded,
        salespeople: encoded.salespeople.map((person) => ({ ...person, active: false })),
      });
      expect(Exit.isFailure(yield* run(inactive, { ...visitX, salespersonId: 'a' }, lead))).toBe(true);
    }),
  );

  it.effect('next step can be added to the manual plan, linked to the visit', () =>
    Effect.gen(function* effectGenerator11() {
      const change = yield* ok(
        base,
        { ...visitX, addToPlan: true, nextStep: 'Poslat ceník', nextStepDate: '2026-11-15' },
        repA,
      );
      const [visitId, planId] = change.entityIds;
      const item = change.state.visits.plan.find((entry) => entry.id === planId);
      expect(item?.sourceVisitId).toBe(visitId);
      expect(item?.dueDate).toBe('2026-11-15');
      expect(item?.salespersonId).toBe('a');
    }),
  );
});

describe('CRM manual plan (C06)', () => {
  it.effect('rejects impossible plan dates on creation, rescheduling and completion', () =>
    Effect.gen(function* effectGenerator12() {
      expect(
        Exit.isFailure(yield* run(base, { _tag: 'PlanContact', clientId: 'x', dueDate: '2026-02-30' }, repA)),
      ).toBe(true);
      const planned = yield* ok(base, { _tag: 'PlanContact', clientId: 'x', dueDate: '2026-11-15' }, repA);
      const planItemId = planned.entityIds[0] ?? '';
      expect(
        Exit.isFailure(yield* run(planned.state, { _tag: 'UpdatePlanItem', dueDate: '2026-11-31', planItemId }, repA)),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* run(
            planned.state,
            {
              _tag: 'CompletePlanItem',
              planItemId,
              visit: { kind: 'call', nextStepDate: '2026-11-31', occurredAt: now, result: 'Domluveno' },
            },
            repA,
          ),
        ),
      ).toBe(true);
      expect(planned.state.visits.plan[0]?.status).toBe('open');
    }),
  );

  it.effect('C06-01 a planned contact appears in the rep plan; C06-03 completion keeps it as done', () =>
    Effect.gen(function* effectGenerator13() {
      const planned = yield* ok(
        base,
        { _tag: 'PlanContact', clientId: 'x', dueDate: '2026-11-15', note: 'Ozvat se' },
        repA,
      );
      const planItemId = planned.entityIds[0] ?? '';
      expect(nextPlanItemOf(planned.state.visits.plan, 'x')?.id).toBe(planItemId);
      expect(projectCrmState(planned.state, repB).visits.plan).toHaveLength(0);

      const done = yield* ok(
        planned.state,
        {
          _tag: 'CompletePlanItem',
          doneNote: 'Domluveno',
          planItemId,
          visit: { kind: 'call', occurredAt: '2026-10-20T07:00:00.000Z', result: 'Telefonát proběhl' },
        },
        repA,
      );
      const item = done.state.visits.plan.find((entry) => entry.id === planItemId);
      expect(item?.status).toBe('done');
      expect(item?.doneBy).toBe('p-a');
      expect(item?.doneVisitId).toBe(done.entityIds[1]);
      const visit = done.state.visits.items.find((entry) => entry.id === done.entityIds[1]);
      expect(visit?.kind).toBe('call');
      expect(visit?.planItemId).toBe(planItemId);
      expect(nextPlanItemOf(done.state.visits.plan, 'x')).toBeUndefined();
      expect(Exit.isFailure(yield* run(done.state, { _tag: 'CompletePlanItem', planItemId }, repA))).toBe(true);
    }),
  );

  it.effect('a rep cannot plan for a foreign client nor for another salesperson', () =>
    Effect.gen(function* effectGenerator14() {
      expect(
        Exit.isFailure(yield* run(base, { _tag: 'PlanContact', clientId: 'y', dueDate: '2026-11-15' }, repA)),
      ).toBe(true);
      expect(
        Exit.isFailure(
          yield* run(base, { _tag: 'PlanContact', clientId: 'x', dueDate: '2026-11-15', salespersonId: 'b' }, repA),
        ),
      ).toBe(true);
    }),
  );

  it.effect('the lead plans for a team member and can reschedule', () =>
    Effect.gen(function* effectGenerator15() {
      const planned = yield* ok(base, { _tag: 'PlanContact', clientId: 'y', dueDate: '2026-11-01' }, lead);
      const planItemId = planned.entityIds[0] ?? '';
      expect(planned.state.visits.plan[0]?.salespersonId).toBe('b');
      const moved = yield* ok(
        planned.state,
        { _tag: 'UpdatePlanItem', dueDate: '2026-11-03', note: 'Po dovolené', planItemId },
        repB,
      );
      expect(moved.state.visits.plan[0]?.dueDate).toBe('2026-11-03');
      expect(moved.state.visits.plan[0]?.note).toBe('Po dovolené');
    }),
  );
});
