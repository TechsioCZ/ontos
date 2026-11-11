// Explicit save of one tab form of the product editor (variants, e-shop settings, e-shop content): the form keeps its
// own draft, the one Save button sends it as one product command, and leaving with unsaved changes asks first.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import type { DraftSave, PartlySaved, SaveOutcome, UnsavedChangesGuard } from '@app/admin-ui';
import { Array as Arr, Effect, Equal, Option } from 'effect';
import { useEffect, useRef, useState } from 'react';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { productCommandOutcome } from './products-api.ts';
import type { CommandOutcome, ProductCommand } from './products-api.ts';
import { useProductLabel } from './product-form-labels.ts';

/** How a product command ended, as the save bar shows it. */
const tabSaveOutcome = (outcome: CommandOutcome): SaveOutcome => {
  if (outcome.ok) {
    return 'saved';
  }
  if (outcome.proposal !== undefined || outcome.reason === 'approval-required') {
    return 'proposed';
  }
  return outcome.reason === 'conflict' ? 'conflict' : 'failed';
};

/** How far one save got: the commands that went through, the revision they left and how the last one ended. */
interface CommandsRun {
  /** The revision the commands that went through left (the base when none did). */
  readonly committed: number;
  readonly outcome: CommandOutcome;
  /** The command the server refused, when one was. */
  readonly refused: ProductCommand | null;
  readonly sent: readonly ProductCommand[];
}

/** Sends `commands` one after another, each against the revision the previous one left; stops at the first refusal. */
const runCommands = (
  commands: readonly ProductCommand[],
  revision: number,
  sent: readonly ProductCommand[] = [],
): Effect.Effect<CommandsRun> => {
  const [first, ...rest] = commands;
  if (first === undefined) {
    return Effect.succeed({ committed: revision, outcome: { ok: true, revision }, refused: null, sent });
  }
  return productCommandOutcome(first, revision).pipe(
    Effect.flatMap((outcome) => {
      if (!outcome.ok) {
        return Effect.succeed({ committed: revision, outcome, refused: first, sent });
      }
      return rest.length > 0
        ? runCommands(rest, outcome.revision, [...sent, first])
        : Effect.succeed({ committed: outcome.revision, outcome, refused: null, sent: [...sent, first] });
    }),
  );
};

export interface ProductTabSaveOptions<V> {
  /**
   * The product command that saves `value`, or several sent one after another (one per changed market). `confirmed`
   * is the version the server last confirmed, so only what changed since has to be sent.
   */
  readonly commandOf: (value: V, confirmed: V) => ProductCommand | readonly ProductCommand[];
  /**
   * Text of a refused save; the general failure text when it returns undefined. `refused` is the command the server
   * refused, so the text names that part of the draft, not one that went through before it.
   */
  readonly failureText?: (
    outcome: Extract<CommandOutcome, { readonly ok: false }>,
    value: V,
    refused: ProductCommand,
  ) => string | undefined;
  /** The form's own validation; an invalid draft is never sent and keeps the Save button disabled. */
  readonly isValid: (value: V) => boolean;
  /** Re-reads the product, after "Načíst aktuální verzi". */
  readonly onReload: () => void;
  /** The saved draft was committed (the page re-reads the product). */
  readonly onSaved: () => void;
  /**
   * What the server has after `sent` went through and a later command of the same save was refused: the draft's
   * parts those commands wrote, the confirmed version's others. The next save then sends only what is still missing,
   * and "Zahodit změny" goes back to it. Without it, such a save is reported as a plain failure.
   */
  readonly partlyConfirmed?: (value: V, confirmed: V, sent: readonly ProductCommand[]) => V;
  /** Puts `value` (the confirmed version) back into the form's state. */
  readonly reset: (value: V) => void;
  /** The catalog revision the command is sent against. */
  readonly revision: number;
  /**
   * The product as the page has it now, in the form's shape (recomputed on every render is fine). A clean draft
   * takes a newer version; a draft with unsaved changes keeps them, and its save stays based on the revision it
   * started from.
   */
  readonly server: V;
  /** The form's current draft. */
  readonly value: V;
}

export interface ProductTabSave<V> {
  readonly draft: DraftSave<V>;
  readonly error: string | null;
  readonly guard: UnsavedChangesGuard;
  readonly reloadLatest: () => void;
}

/**
 * Draft, save and unsaved-changes guard of one product tab form. Nothing is sent on change, blur, tab switch or
 * unmount; `draft.save()` (the Save button) sends one command. A conflict keeps the draft and offers the current
 * version; a change parked for approval saved nothing.
 */
export const useProductTabSave = <V,>(options: ProductTabSaveOptions<V>): ProductTabSave<V> => {
  const label = useProductLabel();
  const [error, setError] = useState<string | null>(null);
  // The revision the next save is based on. A clean draft follows the page's revision; a pending draft keeps the one
  // it started from, so the server refuses a save over someone else's change. A saved draft moves it to the revision
  // the server returned.
  const base = useRef(options.revision);
  // The confirmed version as of the last render, which a save compares its draft with.
  const confirmedNow = useRef(options.value);
  const draft = useDraftSave<V, never>({
    isValid: (value) => options.isValid(value),
    runtime: browserRuntime,
    save: (value) =>
      runCommands(Arr.ensure(options.commandOf(value, confirmedNow.current)), base.current).pipe(
        Effect.map(({ committed, outcome, refused, sent }): SaveOutcome | PartlySaved<V> => {
          // Commands that went through before a refused one moved the revision; a retry starts after them.
          base.current = Math.max(base.current, committed);
          if (outcome.ok) {
            base.current = outcome.revision;
            setError(null);
            options.onSaved();
            return 'saved';
          }
          setError(
            (refused === null ? undefined : options.failureText?.(outcome, value, refused)) ??
              (outcome.reason === 'rejected' ? label('messages.rejected') : label('messages.failed')),
          );
          const result = tabSaveOutcome(outcome);
          if (sent.length === 0 || options.partlyConfirmed === undefined || result === 'saved') {
            return result;
          }
          const confirmed = options.partlyConfirmed(value, confirmedNow.current, sent);
          confirmedNow.current = confirmed;
          return { confirmed, outcome: result, revision: committed };
        }),
      ),
    value: options.value,
  });
  const { confirmed: confirmedValue } = draft;
  useEffect(() => {
    confirmedNow.current = confirmedValue;
  }, [confirmedValue]);
  const { pending } = draft;
  useEffect(() => {
    if (!pending) {
      base.current = Math.max(base.current, options.revision);
    }
  }, [options.revision, pending]);
  // A reloaded product (after a save of another tab, a photo change or live revalidation) replaces a clean draft
  // only. A draft with unsaved changes stays; once it is clean again it takes the version that was passed over,
  // unless a save of this form confirmed a newer one in the meantime.
  const [seen, setSeen] = useState(options.server);
  const [passedOver, setPassedOver] = useState<Option.Option<V>>(Option.none);
  const { adopt, confirmed } = draft;
  const { reset, server, value } = options;
  const clean = !pending && Equal.equals(value, confirmed);
  const takeServer = () => {
    reset(server);
    adopt(server);
  };
  if (!Equal.equals(seen, server)) {
    setSeen(server);
    if (clean) {
      setPassedOver(Option.none());
      if (!Equal.equals(value, server)) {
        takeServer();
      }
    } else {
      setPassedOver(Option.some(confirmed));
    }
  } else if (clean && Option.isSome(passedOver)) {
    setPassedOver(Option.none());
    if (Equal.equals(confirmed, passedOver.value) && !Equal.equals(value, server)) {
      takeServer();
    }
  }
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => draft.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft,
    // Every tab form has its own blocker; only the one holding unsaved changes answers a blocked navigation.
    navigation: draft.dirty ? blocker : undefined,
    onDiscard: () => {
      options.reset(draft.confirmed);
    },
  });
  return {
    draft,
    error,
    guard,
    reloadLatest: () => {
      options.reset(draft.confirmed);
      draft.adopt(draft.confirmed);
      options.onReload();
    },
  };
};

/**
 * The form's footer: the one Save button with the draft's status, and the question asked before leaving. The tab
 * contents of the product editor all stay mounted, so a tab that is not shown renders no Save button (`active`).
 */
export const ProductTabSaveBar = <V,>({
  active = true,
  save,
}: {
  readonly active?: boolean;
  readonly save: ProductTabSave<V>;
}) => {
  const { language } = useModernI18n();
  const labels = saveLabelsFor(language);
  // The question stays mounted on a hidden tab: its unsaved changes still ask before the editor is left.
  const handleReloadLatest = save.reloadLatest;
  const handleSave = save.draft.save;
  return (
    <>
      {active && (
        <SaveBar
          error={save.error}
          labels={labels}
          onReloadLatest={handleReloadLatest}
          onSave={handleSave}
          status={save.draft.status}
        />
      )}
      <UnsavedChangesDialog labels={labels} prompt={save.guard.prompt} />
    </>
  );
};
