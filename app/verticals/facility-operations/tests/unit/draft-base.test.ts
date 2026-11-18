// The base of a facility edit draft: which read's revision its save carries when the page refreshes underneath it.
import { DateTime, Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import type { OpsCommand } from '../../shared/agendas.ts';
import { draftBaseOf, draftBaseStepOf } from '../../src/ui/draft-base.ts';
import type { RunDraftCommand } from '../../src/ui/draft-base.ts';
import type { CommandOutcome } from '../../src/ui/use-agenda.ts';

const runnerAt =
  (revision: number): RunDraftCommand =>
  (_command: OpsCommand) =>
    Effect.succeed<CommandOutcome>({ ok: true, result: { entityIds: [], revision } });
const recordAt = (id: string, updatedAt: string) => ({ id, updatedAt: DateTime.makeUnsafe(updatedAt) });

const first = recordAt('meter-1', '2026-10-20T08:00:00Z');
const newer = recordAt('meter-1', '2026-10-21T09:30:00Z');
const runFirst = runnerAt(3);
const runNewer = runnerAt(4);

describe('facility draft base', () => {
  it('keeps the base of a dirty draft when someone else changed the record', () => {
    const base = draftBaseOf(runFirst, first);
    const step = draftBaseStepOf({ base, record: newer, run: runNewer, settled: false });
    expect(step.adopt).toBe(false);
    expect(step.base.run).toBe(runFirst);
  });

  it('moves a settled draft onto the newer read', () => {
    const step = draftBaseStepOf({ base: draftBaseOf(runFirst, first), record: newer, run: runNewer, settled: true });
    expect(step.adopt).toBe(true);
    expect(step.base.run).toBe(runNewer);
  });

  it('keeps the base when only the agenda moved, not the record', () => {
    const base = draftBaseOf(runFirst, first);
    const step = draftBaseStepOf({ base, record: first, run: runNewer, settled: true });
    expect(step).toEqual({ adopt: false, base });
  });

  it('after its own save, takes the next snapshot as the base even while the user types on', () => {
    const saved = { ...draftBaseOf(runFirst, first), follow: true };
    const step = draftBaseStepOf({ base: saved, record: newer, run: runNewer, settled: false });
    expect(step.adopt).toBe(false);
    expect(step.base.run).toBe(runNewer);
    expect(step.base.follow).toBe(false);
    // The snapshot after that is someone else's again.
    const later = recordAt('meter-1', '2026-10-22T10:00:00Z');
    const next = draftBaseStepOf({ base: step.base, record: later, run: runnerAt(5), settled: false });
    expect(next.base.run).toBe(runNewer);
  });

  it('starts over on another record', () => {
    const step = draftBaseStepOf({
      base: draftBaseOf(runFirst, first),
      record: recordAt('meter-2', '2026-10-20T08:00:00Z'),
      run: runNewer,
      settled: false,
    });
    expect(step.adopt).toBe(true);
    expect(step.base.recordId).toBe('meter-2');
  });
});
