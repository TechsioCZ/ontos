// Explicit save of one tab form of the product editor (variants, e-shop settings, e-shop content): the form keeps its
// own draft, the one Save button sends it as one product command, and leaving with unsaved changes asks first.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import type { DraftSave, SaveOutcome, UnsavedChangesGuard } from '@app/admin-ui';
import { Effect } from 'effect';
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

export interface ProductTabSaveOptions<V> {
  /** The product command that saves `value`. */
  readonly commandOf: (value: V) => ProductCommand;
  /** Text of a refused save; the general failure text when it returns undefined. */
  readonly failureText?: (outcome: Extract<CommandOutcome, { readonly ok: false }>, value: V) => string | undefined;
  /** The form's own validation; an invalid draft is never sent and keeps the Save button disabled. */
  readonly isValid: (value: V) => boolean;
  /** Re-reads the product, after "Načíst aktuální verzi". */
  readonly onReload: () => void;
  /** The saved draft was committed (the page re-reads the product). */
  readonly onSaved: () => void;
  /** Puts `value` (the confirmed version) back into the form's state. */
  readonly reset: (value: V) => void;
  /** The catalog revision the command is sent against. */
  readonly revision: number;
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
  const draft = useDraftSave<V, never>({
    isValid: (value) => options.isValid(value),
    runtime: browserRuntime,
    save: (value) =>
      productCommandOutcome(options.commandOf(value), base.current).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            if (outcome.ok) {
              base.current = outcome.revision;
              setError(null);
              options.onSaved();
              return;
            }
            setError(
              options.failureText?.(outcome, value) ??
                (outcome.reason === 'rejected' ? label('messages.rejected') : label('messages.failed')),
            );
          }),
        ),
        Effect.map(tabSaveOutcome),
      ),
    value: options.value,
  });
  const { pending } = draft;
  useEffect(() => {
    if (!pending) {
      base.current = Math.max(base.current, options.revision);
    }
  }, [options.revision, pending]);
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
