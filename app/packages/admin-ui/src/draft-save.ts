// Explicit save for edit forms of existing records: the form keeps its draft and nothing is sent until `save()`.
import { Effect, Equal, Exit, Option, Predicate, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import type { Fiber, ManagedRuntime } from 'effect';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/**
 * What the save bar shows. `dirty` is a changed draft that can be saved, `invalid` a changed draft the form's own
 * validation holds back; `proposed` means the draft was accepted for approval and is not saved yet.
 */
export const SaveStateSchema = Schema.Literals([
  'idle',
  'dirty',
  'invalid',
  'saving',
  'saved',
  'proposed',
  'error',
  'conflict',
]);
export type SaveState = typeof SaveStateSchema.Type;

/**
 * Result of one save. `conflict` is the action's optimistic-concurrency refusal (the record changed since the
 * revision the draft was based on); `proposed` is a change parked for approval, which saved nothing; every other
 * failure is `failed`.
 */
export const SaveOutcomeSchema = Schema.Literals(['saved', 'proposed', 'conflict', 'failed']);
export type SaveOutcome = typeof SaveOutcomeSchema.Type;

export interface DraftSaveOptions<V, R> {
  /** Whether two drafts are the same. Defaults to structural equality. */
  readonly equals?: (left: V, right: V) => boolean;
  /**
   * The form's own validation; an invalid draft is never sent. `confirmed` is the version the server last confirmed
   * (`DraftSaveController.confirmed`), for a rule that depends on what the save would send, such as a part that is
   * sent whole, and so has to be complete, once it differs from that version.
   */
  readonly isValid: (value: V, confirmed: V) => boolean;
  /**
   * Sends one draft. Map every typed failure to an outcome; a defect or interruption counts as `failed`.
   * Keep the draft's base revision in a ref that `save` reads and updates with the revision the server returns.
   */
  readonly save: (value: V) => Effect.Effect<SaveOutcome, never, R>;
}

/** Statuses in which the draft differs from what the server has confirmed. Live data must not replace it then. */
export const draftPending = (status: SaveState): boolean => status !== 'idle' && status !== 'saved';

/**
 * Statuses in which leaving the form would lose something typed. A draft parked for approval is not one of them:
 * it was handed over and is never sent again.
 */
export const draftUnsaved = (status: SaveState): boolean => draftPending(status) && status !== 'proposed';

/** Statuses in which the Save button sends the draft: a changed, valid draft, or one whose last save failed. */
export const draftSavable = (status: SaveState): boolean => status === 'dirty' || status === 'error';

type Fork<R> = <A>(effect: Effect.Effect<A, never, R>) => Fiber.Fiber<A>;

/**
 * Draft, single in-flight save and status of one edit form. It never sends anything by itself: no timer, no blur,
 * no unmount. `save()` is the only way a draft leaves the form.
 */
export class DraftSaveController<V, R = never> {
  /** Set once the form replaced this controller or went away for good: nothing is sent any more. */
  private disposed = false;
  private readonly fork: Fork<R>;
  private inFlight = false;
  private latest: V;
  private readonly listeners = new Set<() => void>();
  private options: DraftSaveOptions<V, R>;
  /** Callers of `afterSave` that wait for the running save. */
  private readonly waiting = new Set<(status: SaveState) => void>();
  /** The draft last accepted for approval. It is not saved, and it is never sent again. */
  private proposed: Option.Option<V> = Option.none();
  private saved: V;
  private state: SaveState = 'idle';

  constructor(initial: V, options: DraftSaveOptions<V, R>, fork: Fork<R>) {
    this.saved = initial;
    this.latest = initial;
    this.options = options;
    this.fork = fork;
  }

  /** The form's current draft. It only moves the status; a changed draft waits for `save()`. */
  readonly change = (value: V): void => {
    if (this.same(value, this.latest)) {
      return;
    }
    this.latest = value;
    // A running save decides the status when it ends.
    if (this.disposed || this.inFlight) {
      return;
    }
    // A conflict holds until the server version is adopted or the draft is back at the confirmed version.
    if (this.state === 'conflict' && !this.same(value, this.saved)) {
      return;
    }
    this.setState(this.restingState());
  };

  /** Replaces the callbacks with the newest render's closures. */
  readonly configure = (options: DraftSaveOptions<V, R>): void => {
    this.options = options;
  };

  /** Stops for good: a running save no longer decides anything. */
  readonly dispose = (): void => {
    this.disposed = true;
    this.release();
  };

  /**
   * Runs `done` once the running save has ended, with the status it left; at once when no save runs. For whoever
   * started a save and has to act on its result, such as leaving the form after it.
   */
  readonly afterSave = (done: (status: SaveState) => void): void => {
    if (this.inFlight && !this.disposed) {
      this.waiting.add(done);
      return;
    }
    done(this.state);
  };

  /**
   * The Save button: sends a changed, valid draft once. Does nothing while a save runs, on a conflict, for an
   * unchanged or invalid draft and for a draft already parked for approval. After a failed save it sends the draft
   * again.
   */
  readonly save = (): void => {
    if (this.disposed || this.state === 'conflict' || this.inFlight) {
      return;
    }
    const resting = this.restingState();
    if (resting === 'dirty') {
      this.start(this.latest);
      return;
    }
    // An unchanged draft keeps its "saved" line.
    if (resting !== 'idle' || this.state !== 'saved') {
      this.setState(resting);
    }
  };

  /**
   * Drops the draft: the controller continues from the confirmed version, without an error or a conflict. The form
   * puts the same version back on screen.
   */
  readonly discard = (): void => {
    this.latest = this.saved;
    if (this.disposed || this.inFlight) {
      return;
    }
    this.setState('idle');
  };

  /**
   * A save that sends several commands wrote part of its draft before it failed: `value` is what the server has now.
   * The draft stays unsaved; from here on it is compared with `value`, so taking a written field back is a change.
   */
  readonly confirm = (value: V): void => {
    this.saved = value;
  };

  /** The draft the server last confirmed (or the version this controller started from). */
  readonly confirmed = (): V => this.saved;

  readonly status = (): SaveState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private finish(value: V, outcome: SaveOutcome): void {
    this.inFlight = false;
    if (this.disposed) {
      return;
    }
    if (outcome === 'saved' || outcome === 'proposed') {
      if (outcome === 'saved') {
        this.saved = value;
        this.proposed = Option.none();
      } else {
        // Parked for approval: the confirmed version stays, and this draft is never sent again.
        this.proposed = Option.some(value);
      }
      // Edits made while this save ran stay an unsaved draft: they wait for the next click.
      this.setState(this.same(this.latest, value) ? outcome : this.restingState());
    } else {
      this.setState(outcome === 'conflict' ? 'conflict' : 'error');
    }
    this.release();
  }

  private isProposed(value: V): boolean {
    return Option.isSome(this.proposed) && this.same(value, this.proposed.value);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** Answers everyone who waits for the running save with the status the draft has now. */
  private release(): void {
    const waiting = [...this.waiting];
    this.waiting.clear();
    for (const done of waiting) {
      done(this.state);
    }
  }

  /** The status of the current draft while nothing runs and nothing failed. */
  private restingState(): 'dirty' | 'idle' | 'invalid' | 'proposed' {
    if (this.same(this.latest, this.saved)) {
      return 'idle';
    }
    if (this.isProposed(this.latest)) {
      return 'proposed';
    }
    return this.options.isValid(this.latest, this.saved) ? 'dirty' : 'invalid';
  }

  private same(left: V, right: V): boolean {
    return (this.options.equals ?? Equal.equals)(left, right);
  }

  private setState(next: SaveState): void {
    if (this.state !== next) {
      this.state = next;
      this.notify();
    }
  }

  private start(value: V): void {
    this.inFlight = true;
    this.setState('saving');
    this.fork(
      Effect.exit(Effect.suspend(() => this.options.save(value))).pipe(
        Effect.map((exit) => (Exit.isSuccess(exit) ? exit.value : 'failed')),
        Effect.flatMap((outcome) => Effect.sync(() => this.finish(value, outcome))),
      ),
    );
  }
}

/** A controller whose saves run in the calling context, so tests answer them step by step. */
export const startDraftSave = <V, R>(initial: V, options: DraftSaveOptions<V, R>) =>
  Effect.map(
    Effect.context<R>(),
    (context): DraftSaveController<V, R> => new DraftSaveController(initial, options, Effect.runForkWith(context)),
  );

/** What the save bar and the unsaved-changes guard need from a draft, whatever its value is. */
export interface SavableDraft {
  /**
   * Runs `done` once the running save has ended, with the status it left; at once when no save runs. For whoever
   * started a save and has to act on its result, such as leaving the form after it.
   */
  readonly afterSave: (done: (status: SaveState) => void) => void;
  /** The Save button is enabled: the draft is changed and valid, or its last save failed. */
  readonly canSave: boolean;
  /** Leaving the form now would lose something typed (changed, invalid, saving, failed or in conflict). */
  readonly dirty: boolean;
  /** The Save button: sends the whole draft once. Never call it from a change, blur, close or unmount. */
  readonly save: () => void;
  readonly status: SaveState;
}

export interface DraftSave<V> extends SavableDraft {
  /**
   * The form replaced its draft with `value` from the server ("Načíst aktuální verzi", or revalidated data while
   * nothing was pending): the draft starts over from it, dropping an unsaved change, error or conflict.
   */
  readonly adopt: (value: V) => void;
  /**
   * The version the server last confirmed, as of this render: what a save compares the draft with, and what
   * discarding the draft goes back to. Field messages that follow the `isValid` rule read it, so they name the same
   * fields the rule holds the draft back for.
   */
  readonly confirmed: V;
  /**
   * The draft differs from the confirmed server state (`dirty`, or parked for approval). While it does, the form
   * keeps its draft and base revision instead of taking revalidated page data.
   */
  readonly pending: boolean;
}

export interface UseDraftSaveOptions<V, R> extends DraftSaveOptions<V, R> {
  /**
   * The version the draft starts from, when it is not the first render's draft: a create form passes its empty form,
   * so the values it opens with already count as a draft the Save button sends.
   */
  readonly initial?: V;
  /** The host's browser runtime; saves run in it. */
  readonly runtime: ManagedRuntime.ManagedRuntime<R, never>;
  /** The form's draft. Without `initial`, the first render's value is taken as saved. */
  readonly value: V;
}

/** The revision a draft generation is based on; a successful save moves it to the revision the server returns. */
interface BaseRevision {
  /** Moves the base to a newer revision; an older one is ignored. */
  readonly advance: (revision: number) => void;
  readonly current: () => number;
}

const baseRevision = (initial: number): BaseRevision => {
  let revision = initial;
  return {
    advance: (next) => {
      revision = Math.max(revision, next);
    },
    current: () => revision,
  };
};

interface Generation<V, R> {
  readonly base: BaseRevision;
  readonly controller: DraftSaveController<V, R>;
}

/**
 * Result of a save that knows revisions: the new revision of the record when it was saved, otherwise `proposed`,
 * `conflict` or `failed` (`saved` when the save returns no revision). `proposed` keeps the base revision.
 */
export type RevisionedSaveResult = SaveOutcome | number;

/**
 * Result of a save that sends several commands and stopped part-way: the server took `confirmed` and left it at
 * `revision`, and the rest of the draft ended as `outcome`. The draft stays unsaved. `confirmed` becomes the version
 * later saves are compared with and `revision` their base, so the next save sends only what is still missing, and a
 * field taken back to its value before the save is sent as the change it now is.
 */
export interface PartlySaved<V> {
  readonly confirmed: V;
  readonly outcome: Exclude<SaveOutcome, 'saved'>;
  readonly revision: number;
}

/** What a draft save answers: a `RevisionedSaveResult`, or how far a save of several commands got. */
export type DraftSaveResult<V> = RevisionedSaveResult | PartlySaved<V>;

interface GenerationOptions<V, R> extends Omit<DraftSaveOptions<V, R>, 'save'> {
  /** The confirmed version of the first generation; `value` when absent. */
  readonly initial?: V;
  readonly revision: number;
  readonly runtime: ManagedRuntime.ManagedRuntime<R, never>;
  readonly save: (value: V, expectedRevision: number, confirmed: V) => Effect.Effect<DraftSaveResult<V>, never, R>;
  readonly value: V;
}

const isOutcome = Schema.is(SaveOutcomeSchema);

/** The confirmed version of one draft generation: read when a save starts, moved by a save that got part-way. */
interface ConfirmedVersion<V> {
  readonly confirm: (value: V) => void;
  readonly confirmed: () => V;
}

const boundTo = <V, R>(
  options: GenerationOptions<V, R>,
  base: BaseRevision,
  version: ConfirmedVersion<V>,
): DraftSaveOptions<V, R> => ({
  ...options,
  save: (value) =>
    options.save(value, base.current(), version.confirmed()).pipe(
      Effect.map((result): SaveOutcome => {
        if (isOutcome(result)) {
          return result;
        }
        if (Predicate.isNumber(result)) {
          base.advance(result);
          return 'saved';
        }
        base.advance(result.revision);
        version.confirm(result.confirmed);
        return result.outcome;
      }),
    ),
});

/** The controller of the current draft generation. A new generation starts from a server version (`adopt`). */
const useGeneration = <V, R>(options: GenerationOptions<V, R>) => {
  const { runtime } = options;
  const begin = (from: V, revision: number): Generation<V, R> => {
    const base = baseRevision(revision);
    // Nothing is saved yet, so `from` is the confirmed version; from here on the controller knows it.
    const startedFrom: ConfirmedVersion<V> = { confirm: constVoid, confirmed: () => from };
    const controller = runtime.runSync(startDraftSave(from, boundTo(options, base, startedFrom)));
    controller.configure(boundTo(options, base, controller));
    return { base, controller };
  };
  const [generation, setGeneration] = useState(() =>
    begin('initial' in options && options.initial !== undefined ? options.initial : options.value, options.revision),
  );
  const { base, controller } = generation;
  useEffect(() => {
    controller.configure(boundTo(options, base, controller));
  }, [base, controller, options]);
  // The draft only moves the status. Nothing is sent here, and nothing is sent when the form unmounts.
  useEffect(() => {
    controller.change(options.value);
  }, [controller, options.value]);
  const status = useSyncExternalStore(controller.subscribe, controller.status, controller.status);
  const restart = (value: V, revision: number) => {
    controller.dispose();
    setGeneration(begin(value, revision));
  };
  return { base, begin, controller, restart, setGeneration, status };
};

const draftSaveOf = <V, R>(
  controller: DraftSaveController<V, R>,
  status: SaveState,
  adopt: (value: V) => void,
): DraftSave<V> => ({
  adopt,
  afterSave: controller.afterSave,
  canSave: draftSavable(status),
  confirmed: controller.confirmed(),
  dirty: draftUnsaved(status),
  pending: draftPending(status),
  save: controller.save,
  status,
});

/**
 * Explicit save for an edit form that keeps its own draft state. The draft is sent on `save()` only. To drop the
 * draft, put `confirmed` back into the form's state.
 */
export const useDraftSave = <V, R>(options: UseDraftSaveOptions<V, R>): DraftSave<V> => {
  const { controller, restart, status } = useGeneration({ ...options, revision: 0, save: options.save });
  return draftSaveOf(controller, status, (value) => restart(value, 0));
};

export interface UseRecordDraftOptions<V, R> extends Omit<DraftSaveOptions<V, R>, 'save'> {
  /** Re-reads the record (e.g. a page-data refresh); `reloadLatest` runs it after dropping the draft. */
  readonly refresh?: Effect.Effect<void, never, R>;
  /**
   * Revision of `server` (often the owner's snapshot revision). A save gets the revision its draft is based on as
   * `expectedRevision`; while the server still has the last confirmed version of this record, the base follows newer
   * revisions, so unrelated changes elsewhere cause no conflict.
   */
  readonly revision?: number;
  /** The host's browser runtime; saves run in it. */
  readonly runtime: ManagedRuntime.ManagedRuntime<R, never>;
  /**
   * Sends one draft. Return the record's new revision (or `saved`), `proposed` when the change was parked for
   * approval, `conflict` for the action's revision conflict and `failed` otherwise; a defect or interruption counts
   * as `failed`. A save of several commands that stopped after some of them went through returns `PartlySaved`.
   *
   * `confirmed` is the version the server last confirmed for this draft: the server version the draft started from,
   * then the draft of every successful save (or what a partly successful one wrote). A save that sends only what
   * changed compares the draft with it, never with page data, which still shows the version before that save until
   * its reload lands.
   */
  readonly save: (value: V, expectedRevision: number, confirmed: V) => Effect.Effect<DraftSaveResult<V>, never, R>;
  /** The record as the server has it now, in the draft's shape (recomputed on every render is fine). */
  readonly server: V;
  /**
   * What a draft with nothing pending becomes when it takes a newer server version; the server version by default.
   * For a field the server does not store, such as a note that goes out with the next save: return the server
   * version with that field of `draft`. The result is a draft over that server version like any typed one.
   */
  readonly takeServer?: (server: V, draft: V) => V;
}

export interface RecordDraft<V> extends DraftSave<V> {
  /**
   * "Zahodit změny": the draft goes back to the confirmed version, without an error or a conflict. When a newer
   * server version arrived while the draft was unsaved, the form continues from that one.
   */
  readonly discard: () => void;
  readonly draft: V;
  /** "Načíst aktuální verzi": drop the draft, continue from the server version and re-read it. */
  readonly reloadLatest: () => void;
  readonly setDraft: Dispatch<SetStateAction<V>>;
}

/**
 * `useDraftSave` plus the draft state of an edit form. When the server version changes (live revalidation, someone
 * else's save) and nothing is pending, the draft follows it; while something is pending the draft stays, and a save
 * based on an outdated revision ends in `conflict`.
 */
export const useRecordDraft = <V, R>(options: UseRecordDraftOptions<V, R>): RecordDraft<V> => {
  const { refresh, runtime, server } = options;
  const revision = options.revision ?? 0;
  const same = options.equals ?? Equal.equals;
  const [draft, setDraft] = useState(server);
  const [seen, setSeen] = useState(server);
  // The confirmed version at the moment a newer server version was not taken, because the draft was pending.
  const [passedOver, setPassedOver] = useState<Option.Option<V>>(() => Option.none());
  const { base, begin, controller, restart, setGeneration, status } = useGeneration({
    ...options,
    revision,
    value: draft,
  });
  const settled = !draftPending(status) && same(draft, controller.confirmed());
  const takeServerVersion = () => {
    setDraft(options.takeServer?.(server, draft) ?? server);
    setGeneration(begin(server, revision));
  };
  if (!same(seen, server)) {
    setSeen(server);
    if (settled) {
      setPassedOver(Option.none());
      if (!same(server, draft)) {
        takeServerVersion();
      }
    } else if (status === 'proposed' && same(server, draft)) {
      // The proposal was approved: the server now has this draft, so it is confirmed from that version on.
      setPassedOver(Option.none());
      setGeneration(begin(server, revision));
    } else {
      setPassedOver(Option.some(controller.confirmed()));
    }
  } else if (settled && Option.isSome(passedOver)) {
    // The draft is clean again (discarded, or typed back). It takes the version that was passed over, unless a
    // save of this form confirmed a newer one in the meantime: then the page data is the older of the two.
    setPassedOver(Option.none());
    if (same(controller.confirmed(), passedOver.value) && !same(server, draft)) {
      takeServerVersion();
    }
  }
  useEffect(() => {
    // The server still has the version this draft builds on: newer revisions changed something else.
    if (same(server, controller.confirmed())) {
      base.advance(revision);
    }
  }, [base, controller, revision, same, server]);
  const adopt = (value: V) => {
    setDraft(value);
    setPassedOver(Option.none());
    restart(value, revision);
  };
  return {
    ...draftSaveOf(controller, status, adopt),
    discard: () => {
      setDraft(controller.confirmed());
      controller.discard();
    },
    draft,
    reloadLatest: () => {
      adopt(seen);
      if (refresh !== undefined) {
        runtime.runFork(refresh);
      }
    },
    setDraft,
  };
};
