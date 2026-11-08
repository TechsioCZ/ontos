import { Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { ProjectSchema } from '../../shared/apis/records.ts';
import type { WorkProject } from '../../shared/apis/records.ts';
import {
  PlanCommittedSchema,
  PlanFailedSchema,
  PlanProposedSchema,
  pendingProposal,
  planAnswer,
} from '../../src/routes/[lang]/ukoly/planning-proposal.ts';

type Plan = Pick<WorkProject, 'milestones' | 'title'>;

const milestones = Schema.decodeUnknownSync(ProjectSchema.fields.milestones)([
  { completed: false, dueDate: '2026-12-01', title: 'Předání' },
]);
const plan = (title: string): Plan => ({ milestones, title });
const waiting = 'Návrh čeká na schválení. Změna zatím nebyla provedena.';

describe('planning panel proposals', () => {
  it('tells a committed plan, a parked plan and a refusal apart', () => {
    expect(planAnswer({ ok: true })).toEqual(PlanCommittedSchema.make({}));
    expect(planAnswer({ message: waiting, ok: false, proposed: true })).toEqual(
      PlanProposedSchema.make({ message: waiting }),
    );
    expect(planAnswer({ message: 'Konflikt', ok: false, proposed: false })).toEqual(
      PlanFailedSchema.make({ message: 'Konflikt' }),
    );
  });

  it('holds back exactly the plan that waits for approval, and only that one', () => {
    const proposed = Option.some({ command: plan('Rekonstrukce'), message: waiting });
    // The same plan, rebuilt from the draft on the next render or after reopening the panel, is pending.
    expect(pendingProposal(proposed, Option.some(plan('Rekonstrukce')))).toEqual(proposed);
    expect(pendingProposal(proposed, Option.some(plan('Rekonstrukce 2')))).toEqual(Option.none());
    expect(pendingProposal(proposed, Option.some({ ...plan('Rekonstrukce'), milestones: [] }))).toEqual(Option.none());
    expect(pendingProposal(proposed, Option.none())).toEqual(Option.none());
    const nothingProposed = Option.none<{ readonly command: Plan; readonly message: string }>();
    expect(pendingProposal(nothingProposed, Option.some(plan('Rekonstrukce')))).toEqual(Option.none());
  });
});
