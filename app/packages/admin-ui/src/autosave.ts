// Autosave for edit forms of existing records: the form keeps its draft, the controller decides when to send it.
import { Duration, Effect, Equal, Exit, Option, Schema } from 'effect';
import type { Fiber, ManagedRuntime } from 'effect';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/** What the inline status line shows. `invalid` means a draft exists but is not sent until the form is valid. */
export const AutosaveStateSchema = Schema.Literals([
  'idle',
  'dirty',
  'invalid',
  'saving',
  'saved',
  'error',
  'conflict',
]);
export type AutosaveState = typeof AutosaveStateSchema.Type;

/**
 * Result of one save. `conflict` is the action's optimistic-concurrency refusal (the record changed since the
 * revision the draft was based on); every other failure is `failed`.
 */
export const AutosaveOutcomeSchema = Schema.Literals(['saved', 'conflict', 'failed']);
export type AutosaveOutcome = typeof AutosaveOutcomeSchema.Type;

export interface AutosaveOptions<V, R> {
  /** Quiet time after the last change before the draft is sent. */
  readonly delayMs?: number;
  /** Whether two drafts are the same. Defaults to structural equality. */
  readonly equals?: (left: V, right: V) => boolean;
  /** The form's own validation; an invalid draft is never sent. */
  readonly isValid: (value: V) => boolean;
  /**
   * Sends one draft. Map every typed failure to an outcome; a defect or interruption counts as `failed`.
   * A follow-up save can start before React re-renders, so keep the draft's base revision in a ref that `save`
   * reads and updates with the revision the server returns.
   */
  readonly save: (value: V) => Effect.Effect<AutosaveOutcome, never, R>;
}

export const AUTOSAVE_DELAY_MS = 800;
/** How long "Uloženo" stays before the line goes quiet again. */
const SAVED_VISIBLE = Duration.seconds(3);

/** Statuses in which the draft differs from what the server has confirmed. Live data must not replace it then. */
export const autosavePending = (status: AutosaveState): boolean => status !== 'idle' && status !== 'saved';

type Fork<R> = <A>(effect: Effect.Effect<A, never, R>) => Fiber.Fiber<A>;

/** Debounce, single in-flight save and status of one edit form. */
export class AutosaveController<V, R = never> {
  private decay: Option.Option<Fiber.Fiber<void>> = Option.none();
  /** Set once the form replaced this controller or went away for good: nothing is sent any more. */
  private disposed = false;
  private readonly fork: Fork<R>;
  private inFlight = false;
  private latest: V;
  private readonly listeners = new Set<() => void>();
  private options: AutosaveOptions<V, R>;
  private saved: V;
  private state: AutosaveState = 'idle';
  private timer: Option.Option<Fiber.Fiber<void>> = Option.none();

  constructor(initial: V, options: AutosaveOptions<V, R>, fork: Fork<R>) {
    this.saved = initial;
    this.latest = initial;
    this.options = options;
    this.fork = fork;
  }

  /** The form's current draft. An unchanged draft is ignored; a changed one is sent after the quiet time. */
  readonly change = (value: V): void => {
    if (this.same(value, this.latest)) {
      return;
    }
    this.latest = value;
    if (this.disposed) {
      return;
    }
    // A conflict holds until the server version is adopted; a running save re-checks the newest draft when it ends.
    if (this.state === 'conflict' || this.inFlight) {
      return;
    }
    this.cancelTimer();
    if (this.same(value, this.saved)) {
      this.setState('idle');
      return;
    }
    if (!this.options.isValid(value)) {
      this.setState('invalid');
      return;
    }
    this.setState('dirty');
    const delay = Duration.millis(this.options.delayMs ?? AUTOSAVE_DELAY_MS);
    this.timer = Option.some(this.fork(Effect.sleep(delay).pipe(Effect.andThen(Effect.sync(this.flush)))));
  };

  /** Replaces the callbacks with the newest render's closures. */
  readonly configure = (options: AutosaveOptions<V, R>): void => {
    this.options = options;
  };

  /** Stops for good: a pending change is dropped and a running save no longer decides anything. */
  readonly dispose = (): void => {
    this.disposed = true;
    this.cancelTimer();
  };

  /** Sends a changed, valid draft now (blur, closing a panel). */
  readonly flush = (): void => {
    this.cancelTimer();
    if (this.disposed || this.state === 'conflict' || this.inFlight) {
      return;
    }
    if (this.same(this.latest, this.saved)) {
      if (this.state !== 'saved') {
        this.setState('idle');
      }
      return;
    }
    if (!this.options.isValid(this.latest)) {
      this.setState('invalid');
      return;
    }
    this.start(this.latest);
  };

  /** Sends the draft again after a failed save. */
  readonly retry = (): void => {
    if (this.state === 'error') {
      this.flush();
    }
  };

  /** The draft the server last confirmed (or the version this controller started from). */
  readonly confirmed = (): V => this.saved;

  readonly status = (): AutosaveState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private cancelTimer(): void {
    if (Option.isSome(this.timer)) {
      this.timer.value.interruptUnsafe();
      this.timer = Option.none();
    }
  }

  private finish(value: V, outcome: AutosaveOutcome): void {
    this.inFlight = false;
    if (this.disposed) {
      return;
    }
    if (outcome === 'saved') {
      this.saved = value;
      if (this.same(this.latest, value)) {
        this.setState('saved');
      } else {
        // Edits made while this save ran: exactly one follow-up save with the newest draft.
        this.flush();
      }
      return;
    }
    this.cancelTimer();
    this.setState(outcome === 'conflict' ? 'conflict' : 'error');
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private same(left: V, right: V): boolean {
    return (this.options.equals ?? Equal.equals)(left, right);
  }

  private setState(next: AutosaveState): void {
    if (Option.isSome(this.decay)) {
      this.decay.value.interruptUnsafe();
      this.decay = Option.none();
    }
    if (next === 'saved') {
      this.decay = Option.some(this.fork(Effect.sleep(SAVED_VISIBLE).pipe(Effect.andThen(Effect.sync(this.quiet)))));
    }
    if (this.state !== next) {
      this.state = next;
      this.notify();
    }
  }

  private readonly quiet = (): void => {
    this.decay = Option.none();
    if (this.state === 'saved') {
      this.state = 'idle';
      this.notify();
    }
  };

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

/** A controller whose timers and saves run in the calling context, so tests drive it with `TestClock`. */
export const startAutosave = <V, R>(initial: V, options: AutosaveOptions<V, R>) =>
  Effect.map(
    Effect.context<R>(),
    (context): AutosaveController<V, R> => new AutosaveController(initial, options, Effect.runForkWith(context)),
  );

export interface Autosave<V> {
  /**
   * The form replaced its draft with `value` from the server ("Načíst aktuální verzi", or revalidated data while
   * nothing was pending): autosave starts over from it, dropping a pending change, error or conflict.
   */
  readonly adopt: (value: V) => void;
  /** Send pending changes now: call on blur and before closing a dialog or panel. */
  readonly flush: () => void;
  /**
   * The draft differs from the confirmed server state (changed, invalid, saving, failed or in conflict). While it
   * does, the form keeps its draft and base revision instead of taking revalidated page data.
   */
  readonly pending: boolean;
  readonly retry: () => void;
  readonly status: AutosaveState;
}

export interface UseAutosaveOptions<V, R> extends AutosaveOptions<V, R> {
  /** The host's browser runtime; saves and timers run in it. */
  readonly runtime: ManagedRuntime.ManagedRuntime<R, never>;
  /** The form's draft. The first render's value is taken as saved. */
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
  readonly controller: AutosaveController<V, R>;
}

/**
 * Result of a save that knows revisions: the new revision of the record when it was saved, otherwise `conflict` or
 * `failed` (`saved` when the save returns no revision).
 */
export type RevisionedSaveResult = AutosaveOutcome | number;

interface GenerationOptions<V, R> extends Omit<AutosaveOptions<V, R>, 'save'> {
  readonly revision: number;
  readonly runtime: ManagedRuntime.ManagedRuntime<R, never>;
  readonly save: (value: V, expectedRevision: number) => Effect.Effect<RevisionedSaveResult, never, R>;
  readonly value: V;
}

const isOutcome = Schema.is(AutosaveOutcomeSchema);

const boundTo = <V, R>(options: GenerationOptions<V, R>, base: BaseRevision): AutosaveOptions<V, R> => ({
  ...options,
  save: (value) =>
    options.save(value, base.current()).pipe(
      Effect.map((result): AutosaveOutcome => {
        if (isOutcome(result)) {
          return result;
        }
        base.advance(result);
        return 'saved';
      }),
    ),
});

/** The controller of the current draft generation. A new generation starts from a server version (`adopt`). */
const useGeneration = <V, R>(options: GenerationOptions<V, R>) => {
  const { runtime } = options;
  const begin = (from: V, revision: number): Generation<V, R> => {
    const base = baseRevision(revision);
    return { base, controller: runtime.runSync(startAutosave(from, boundTo(options, base))) };
  };
  const [generation, setGeneration] = useState(() => begin(options.value, options.revision));
  const { base, controller } = generation;
  useEffect(() => {
    controller.configure(boundTo(options, base));
  }, [base, controller, options]);
  useEffect(() => {
    controller.change(options.value);
  }, [controller, options.value]);
  // Unmount (or a newer generation): send what is still pending. Nothing is pending when a generation is replaced.
  useEffect(() => controller.flush, [controller]);
  const status = useSyncExternalStore(controller.subscribe, controller.status, controller.status);
  const restart = (value: V, revision: number) => {
    controller.dispose();
    setGeneration(begin(value, revision));
  };
  return { base, begin, controller, restart, setGeneration, status };
};

const autosaveOf = <V, R>(
  controller: AutosaveController<V, R>,
  status: AutosaveState,
  adopt: (value: V) => void,
): Autosave<V> => ({
  adopt,
  flush: controller.flush,
  pending: autosavePending(status),
  retry: controller.retry,
  status,
});

/**
 * Autosave for an edit form of an existing record. The draft is sent `delayMs` after the last change, on `flush()`,
 * and once more when the form unmounts.
 */
export const useAutosave = <V, R>(options: UseAutosaveOptions<V, R>): Autosave<V> => {
  const { controller, restart, status } = useGeneration({ ...options, revision: 0, save: options.save });
  return autosaveOf(controller, status, (value) => restart(value, 0));
};

export interface UseAutosaveDraftOptions<V, R> extends Omit<AutosaveOptions<V, R>, 'save'> {
  /** Re-reads the record (e.g. a page-data refresh); `reloadLatest` runs it after dropping the draft. */
  readonly refresh?: Effect.Effect<void, never, R>;
  /**
   * Revision of `server` (often the owner's snapshot revision). A save gets the revision its draft is based on as
   * `expectedRevision`; while the server still has the last confirmed version of this record, the base follows newer
   * revisions, so unrelated changes elsewhere cause no conflict.
   */
  readonly revision?: number;
  /** The host's browser runtime; saves and timers run in it. */
  readonly runtime: ManagedRuntime.ManagedRuntime<R, never>;
  /**
   * Sends one draft. Return the record's new revision (or `saved`), `conflict` for the action's revision conflict
   * and `failed` otherwise; a defect or interruption counts as `failed`.
   */
  readonly save: (value: V, expectedRevision: number) => Effect.Effect<RevisionedSaveResult, never, R>;
  /** The record as the server has it now, in the draft's shape (recomputed on every render is fine). */
  readonly server: V;
}

export interface AutosaveDraft<V> extends Autosave<V> {
  readonly draft: V;
  /** "Načíst aktuální verzi": drop the draft, continue from the server version and re-read it. */
  readonly reloadLatest: () => void;
  readonly setDraft: Dispatch<SetStateAction<V>>;
}

/**
 * `useAutosave` plus the draft state of an edit form. When the server version changes (live revalidation, someone
 * else's save) and nothing is pending, the draft follows it; while something is pending the draft stays, and a save
 * based on an outdated revision ends in `conflict`.
 */
export const useAutosaveDraft = <V, R>(options: UseAutosaveDraftOptions<V, R>): AutosaveDraft<V> => {
  const { refresh, runtime, server } = options;
  const revision = options.revision ?? 0;
  const same = options.equals ?? Equal.equals;
  const [draft, setDraft] = useState(server);
  const [seen, setSeen] = useState(server);
  const { base, begin, controller, restart, setGeneration, status } = useGeneration({
    ...options,
    revision,
    value: draft,
  });
  if (!same(seen, server)) {
    setSeen(server);
    const settled = !autosavePending(status) && same(draft, controller.confirmed());
    if (settled && !same(server, draft)) {
      setDraft(server);
      setGeneration(begin(server, revision));
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
    restart(value, revision);
  };
  return {
    ...autosaveOf(controller, status, adopt),
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
