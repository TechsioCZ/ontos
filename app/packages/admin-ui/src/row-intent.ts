import { Duration, Effect } from 'effect';

/**
 * Row events that announce an opening, for lists whose rows open a detail kept in a strict page-data store.
 *
 * A list warms only its first `LIST_WARM_ROWS` rows' details, once per batch (list revision and page of rows), not
 * again each time the 20 s freshness window passes. Every other row is warmed by these events instead: pointing at it
 * (touch included) or moving keyboard focus to it reads that row's detail, which a fresh store entry answers without a
 * request. Pass the result as the ui-kit DataTable's `slotProps.row`.
 */

/**
 * How many leading rows of a shown page a list warms on open. Warming the whole page sent one detail (up to four
 * owner reads, each behind its own gateway context) per row, about a hundred reads on opening a 30-row list.
 */
export const LIST_WARM_ROWS = 5;

/** Intent reads one list may have in flight, as many as its batch warm-up. */
export const INTENT_READ_CONCURRENCY = 2;

/**
 * Bounds the reads that row intent starts. A pointer swept across many stale rows started one read per row at once;
 * now at most `concurrency` run, and while they do only the newest intent waits: an older waiting row is dropped,
 * since the pointer has already left it. `start` receives `done`, which it must call once its read settles (it may
 * call it at once when nothing needs reading). Calling `done` more than once is harmless.
 */
export const makeIntentLimiter = (concurrency: number = INTENT_READ_CONCURRENCY) => {
  let running = 0;
  let waiting: (() => void) | null = null;
  const run = (start: (done: () => void) => void) => {
    running += 1;
    let settled = false;
    const done = () => {
      if (settled) {
        return;
      }
      settled = true;
      running -= 1;
      const next = waiting;
      waiting = null;
      next?.();
    };
    try {
      start(done);
    } catch (error) {
      // A read that could not even start must not hold its slot for the rest of the session.
      done();
      throw error;
    }
  };
  return (start: (done: () => void) => void): void => {
    if (running < concurrency) {
      run(start);
    } else {
      waiting = () => run(start);
    }
  };
};

export interface RowIntentProps {
  readonly onFocus: (event: { readonly currentTarget: HTMLElement }) => void;
  readonly onPointerDown: (event: { readonly currentTarget: HTMLElement }) => void;
  readonly onPointerEnter: (event: { readonly currentTarget: HTMLElement }) => void;
}

/**
 * How long the pointer must rest on a row before it counts as intent. A pointer on its way to a row passes over the
 * rows above it; reading each of them filled the intent slots, so the row actually opened could wait for a free one.
 * Still well inside the time from pointing to clicking.
 */
export const POINTER_INTENT_DWELL = Duration.millis(60);

/** A forked dwell: only interruption is needed. */
interface DwellFiber {
  readonly interruptUnsafe: () => void;
}

/** The pending pointer intent of one list: entering another row, focus or a press replaces it. */
export interface PointerDwell {
  readonly after: (then: () => void) => void;
  readonly cancel: () => void;
}

/** One list's pointer dwell, run on the caller's runtime (`browserRuntime.runFork`). */
export const makePointerDwell = (runFork: (effect: Effect.Effect<void>) => DwellFiber): PointerDwell => {
  let pending: DwellFiber | null = null;
  const cancel = () => {
    const fiber = pending;
    pending = null;
    fiber?.interruptUnsafe();
  };
  return {
    after: (then) => {
      cancel();
      const fiber = runFork(
        Effect.sleep(POINTER_INTENT_DWELL).pipe(
          Effect.andThen(
            Effect.sync(() => {
              pending = null;
              then();
            }),
          ),
        ),
      );
      pending = fiber;
    },
    cancel,
  };
};

/**
 * The DataTable row props that report the pointed or focused row by its position in the row model (`data-index`).
 * Focus and a press (touch included) report at once; with a `dwell`, the pointer entering a row reports once it rests
 * there, so the rows a pointer only passes over are not read.
 */
export const rowIntentProps = (onIntent: (index: number) => void, dwell?: PointerDwell): RowIntentProps => {
  const report = (currentTarget: HTMLElement) => {
    const index = Number(currentTarget.dataset['index']);
    if (Number.isInteger(index) && index >= 0) {
      onIntent(index);
    }
  };
  const intent = ({ currentTarget }: { readonly currentTarget: HTMLElement }) => {
    dwell?.cancel();
    report(currentTarget);
  };
  const pointerEnter = ({ currentTarget }: { readonly currentTarget: HTMLElement }) => {
    if (dwell === undefined) {
      report(currentTarget);
      return;
    }
    dwell.after(() => report(currentTarget));
  };
  return { onFocus: intent, onPointerDown: intent, onPointerEnter: pointerEnter };
};
