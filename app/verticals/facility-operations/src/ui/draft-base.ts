// The read an edit draft is built on: its save carries that read's agenda revision, never a newer one.
import type { SaveOutcome } from '@app/admin-ui';
import { DateTime, Effect } from 'effect';
import { useState } from 'react';
import type { OpsCommand } from '../../shared/agendas.ts';
import type { CommandOutcome } from './use-agenda.ts';

/** The page's governed runner of one command; it sends the agenda revision of the read it was rendered with. */
export type RunDraftCommand = (command: OpsCommand) => Effect.Effect<CommandOutcome>;

/** The edited record as a read sees it: what tells one snapshot of it from the next. */
export interface StampedRecord {
  readonly id: string;
  readonly updatedAt: DateTime.Utc;
}

/**
 * The base of one draft generation: the record snapshot the draft was read from and the page runner of that read.
 * A save runs through `run`, so the agenda sees the revision the draft was built on: someone else's later change to
 * the record refuses the save (the conflict the save bar offers to resolve), while a change elsewhere in the agenda
 * still goes through. `follow` is set by this form's own confirmed save: the next snapshot of the record is the one
 * that save produced, so it becomes the base even while the user types on.
 */
export interface DraftBase {
  readonly follow: boolean;
  readonly recordId: string;
  readonly run: RunDraftCommand;
  /** `updatedAt` of the record snapshot the draft was read from. */
  readonly snapshot: string;
}

/** The base of a draft read from `record` through `run`. */
export const draftBaseOf = (run: RunDraftCommand, record: StampedRecord): DraftBase => ({
  follow: false,
  recordId: record.id,
  run,
  snapshot: DateTime.formatIso(record.updatedAt),
});

/** What a fresh read means for the draft: whether the draft takes the record's stored values, and the base. */
export interface DraftBaseStep {
  readonly adopt: boolean;
  readonly base: DraftBase;
}

/**
 * The decision behind `useDraftBase`. An unchanged snapshot keeps everything. A settled draft (nothing typed, nothing
 * saving) takes the new snapshot with its base; another record starts over. After this form's own confirmed save the
 * next snapshot becomes the base and the draft stays. A draft with unsaved input keeps the base it was built on, so
 * a refresh never rebases its save onto state the draft never saw.
 */
export const draftBaseStepOf = (input: {
  readonly base: DraftBase;
  readonly record: StampedRecord;
  readonly run: RunDraftCommand;
  readonly settled: boolean;
}): DraftBaseStep => {
  const { base, record, run, settled } = input;
  const sameRecord = base.recordId === record.id;
  if (sameRecord && base.snapshot === DateTime.formatIso(record.updatedAt)) {
    // The read after this form's own save brought no newer snapshot: later snapshots are someone else's again.
    return { adopt: false, base: base.follow ? { ...base, follow: false } : base };
  }
  if (!sameRecord || settled) {
    return { adopt: true, base: draftBaseOf(run, record) };
  }
  return { adopt: false, base: base.follow ? draftBaseOf(run, record) : base };
};

/** A draft base in a form: the runner its save goes through, and the moves the form makes on it. */
export interface DraftBaseRun {
  /** Passes a save outcome through; a confirmed save lets the next snapshot of the record become the base. */
  readonly confirm: (outcome: Effect.Effect<SaveOutcome>) => Effect.Effect<SaveOutcome>;
  /** "Načíst nejnovější": the draft is replaced by the current read, which becomes the base. */
  readonly rebase: () => void;
  /** The runner of the read the draft is built on. */
  readonly run: RunDraftCommand;
  /**
   * Call once per render after the draft save: a settled draft takes a newer snapshot of the record (`onAdopt`), an
   * unsaved one keeps its base.
   */
  readonly sync: (input: { readonly onAdopt: () => void; readonly settled: boolean }) => void;
}

/**
 * Pins the saves of an edit draft to the read it was built on. `record` is the edited record in the current read
 * (`undefined` for a create form, whose saves go through the current runner).
 */
export const useDraftBase = (record: StampedRecord | undefined, run: RunDraftCommand): DraftBaseRun => {
  const [base, setBase] = useState<DraftBase | undefined>(() =>
    record === undefined ? undefined : draftBaseOf(run, record),
  );
  const markSaved = (result: SaveOutcome) => {
    if (result === 'saved') {
      setBase((current) => (current === undefined ? current : { ...current, follow: true }));
    }
  };
  return {
    confirm: (outcome) => Effect.tap(outcome, (result) => Effect.sync(() => markSaved(result))),
    rebase: () => {
      if (record !== undefined) {
        setBase(draftBaseOf(run, record));
      }
    },
    run: base?.run ?? run,
    sync: ({ onAdopt, settled }) => {
      if (record === undefined) {
        return;
      }
      if (base === undefined) {
        setBase(draftBaseOf(run, record));
        return;
      }
      const step = draftBaseStepOf({ base, record, run, settled });
      if (step.base !== base) {
        setBase(step.base);
      }
      if (step.adopt) {
        onAdopt();
      }
    },
  };
};
