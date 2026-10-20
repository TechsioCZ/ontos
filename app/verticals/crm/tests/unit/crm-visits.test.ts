import { describe, expect, it } from '@rstest/core';
import { Effect, Exit } from 'effect';
import type { CrmCommand } from '../../shared/actions/apply-command.ts';
import { dispatchCrmCommand } from '../../shared/commands/index.ts';
import type { CrmViewer } from '../../shared/domain/access.ts';
import type { CrmState } from '../../shared/domain/state.ts';
import { initialCrmState, projectCrmState } from '../../shared/domain/state.ts';
import { lastVisitOf, nextPlanItemOf } from '../../shared/domain/visits.ts';

const now = '2026-10-20T08:00:00.000Z';
const client = (id: string, owner?: string) => ({
  createdAt: now,
  createdBy: 'p-admin',
  id,
  kind: 'organization' as const,
  name: id,
  status: 'active' as const,
  updatedAt: now,
  ...(owner === undefined ? {} : { ownerSalespersonId: owner }),
});
const base: CrmState = {
  ...initialCrmState,
  clients: { assignmentHistory: [], contacts: [], items: [client('x', 'a'), client('y', 'b')] },
  salespeople: [
    { active: true, id: 'a', name: 'A', principalId: 'p-a' },
    { active: true, id: 'b', name: 'B', principalId: 'p-b' },
  ],
};
const repA: CrmViewer = {
  assign: false,
  principalId: 'p-a',
  readAll: false,
  readAssigned: true,
  salespersonId: 'a',
  writeAll: false,
  writeAssigned: true,
};
const repB: CrmViewer = { ...repA, principalId: 'p-b', salespersonId: 'b' };
const lead: CrmViewer = {
  assign: true,
  principalId: 'p-lead',
  readAll: true,
  readAssigned: false,
  writeAll: true,
  writeAssigned: false,
};

let sequence = 0;
const run = (state: CrmState, command: CrmCommand, viewer: CrmViewer) => {
  sequence += 1;
  return Effect.runSyncExit(dispatchCrmCommand(state, command, { invocationId: `i${sequence}`, now, viewer }));
};
const ok = (state: CrmState, command: CrmCommand, viewer: CrmViewer) => {
  const exit = run(state, command, viewer);
  if (Exit.isFailure(exit)) {
    throw new Error(`command failed: ${JSON.stringify(exit.cause)}`);
  }
  return exit.value;
};

const visitX = {
  _tag: 'RecordVisit',
  clientId: 'x',
  kind: 'visit',
  note: 'Původní poznámka',
  occurredAt: '2026-10-19T09:30:00.000Z',
  result: 'Představena nabídka',
} as const;

describe('CRM visits (C02)', () => {
  it('C02-01 a rep records a visit with author, date and result', () => {
    const change = ok(base, visitX, repA);
    const [visit] = change.state.visits.items;
    expect(visit?.authorPrincipalId).toBe('p-a');
    expect(visit?.salespersonId).toBe('a');
    expect(visit?.occurredAt).toBe(visitX.occurredAt);
    expect(visit?.result).toBe('Představena nabídka');
    expect(lastVisitOf(change.state.visits.items, 'x')?.id).toBe(change.entityIds[0]);
  });

  it('C02-02 rep B neither writes nor reads visits of client X', () => {
    expect(Exit.isFailure(run(base, visitX, repB))).toBe(true);
    const visited = ok(base, visitX, repA).state;
    expect(projectCrmState(visited, repB).visits.items).toHaveLength(0);
    expect(projectCrmState(visited, lead).visits.items).toHaveLength(1);
  });

  it('C02-03 a correction keeps previous value, author and time', () => {
    const visited = ok(base, visitX, repA);
    const visitId = visited.entityIds[0] ?? '';
    const corrected = ok(
      visited.state,
      { _tag: 'CorrectVisit', note: 'Opravená poznámka', reason: 'Překlep', visitId },
      repA,
    ).state;
    const [visit] = corrected.visits.items;
    expect(visit?.note).toBe('Opravená poznámka');
    expect(visit?.corrections).toEqual([
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
  });

  it('an unchanged correction is rejected and a foreign rep cannot correct', () => {
    const visited = ok(base, visitX, repA);
    const visitId = visited.entityIds[0] ?? '';
    expect(Exit.isFailure(run(visited.state, { _tag: 'CorrectVisit', note: 'Původní poznámka', visitId }, repA))).toBe(
      true,
    );
    expect(Exit.isFailure(run(visited.state, { _tag: 'CorrectVisit', note: 'cizí', visitId }, repB))).toBe(true);
  });

  it('a rep cannot record on behalf of another salesperson; the lead can', () => {
    expect(Exit.isFailure(run(base, { ...visitX, salespersonId: 'b' }, repA))).toBe(true);
    const byLead = ok(base, { ...visitX, clientId: 'y', salespersonId: 'b' }, lead).state;
    expect(byLead.visits.items[0]?.salespersonId).toBe('b');
    expect(byLead.visits.items[0]?.authorPrincipalId).toBe('p-lead');
  });

  it('a visit far in the future is rejected', () => {
    expect(Exit.isFailure(run(base, { ...visitX, occurredAt: '2026-11-15T09:00:00.000Z' }, repA))).toBe(true);
  });

  it('next step can be added to the manual plan, linked to the visit', () => {
    const change = ok(base, { ...visitX, addToPlan: true, nextStep: 'Poslat ceník', nextStepDate: '2026-11-15' }, repA);
    const [visitId, planId] = change.entityIds;
    const item = change.state.visits.plan.find((entry) => entry.id === planId);
    expect(item?.sourceVisitId).toBe(visitId);
    expect(item?.dueDate).toBe('2026-11-15');
    expect(item?.salespersonId).toBe('a');
  });
});

describe('CRM manual plan (C06)', () => {
  it('C06-01 a planned contact appears in the rep plan; C06-03 completion keeps it as done', () => {
    const planned = ok(base, { _tag: 'PlanContact', clientId: 'x', dueDate: '2026-11-15', note: 'Ozvat se' }, repA);
    const planItemId = planned.entityIds[0] ?? '';
    expect(nextPlanItemOf(planned.state.visits.plan, 'x')?.id).toBe(planItemId);
    expect(projectCrmState(planned.state, repB).visits.plan).toHaveLength(0);

    const done = ok(
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
    expect(Exit.isFailure(run(done.state, { _tag: 'CompletePlanItem', planItemId }, repA))).toBe(true);
  });

  it('a rep cannot plan for a foreign client nor for another salesperson', () => {
    expect(Exit.isFailure(run(base, { _tag: 'PlanContact', clientId: 'y', dueDate: '2026-11-15' }, repA))).toBe(true);
    expect(
      Exit.isFailure(
        run(base, { _tag: 'PlanContact', clientId: 'x', dueDate: '2026-11-15', salespersonId: 'b' }, repA),
      ),
    ).toBe(true);
  });

  it('the lead plans for a team member and can reschedule', () => {
    const planned = ok(base, { _tag: 'PlanContact', clientId: 'y', dueDate: '2026-11-01' }, lead);
    const planItemId = planned.entityIds[0] ?? '';
    expect(planned.state.visits.plan[0]?.salespersonId).toBe('b');
    const moved = ok(
      planned.state,
      { _tag: 'UpdatePlanItem', dueDate: '2026-11-03', note: 'Po dovolené', planItemId },
      repB,
    );
    expect(moved.state.visits.plan[0]?.dueDate).toBe('2026-11-03');
    expect(moved.state.visits.plan[0]?.note).toBe('Po dovolené');
  });
});
