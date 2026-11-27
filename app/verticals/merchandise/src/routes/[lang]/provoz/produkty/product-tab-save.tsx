// Explicit save of one tab form of the product editor (variants, e-shop settings, e-shop content): the form keeps its
// own draft, the one Save button sends it as one product command, and leaving with unsaved changes asks first.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import type { DraftSave, DraftSaveOutcome, KeptDraft, PartlySaved, UnsavedChangesGuard } from '@app/admin-ui';
import { keepDraftOnReload, keptDraft, reloadKeepingDrafts } from '@app/shared-contracts';
import { Array as Arr, Effect, Equal, Option } from 'effect';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { productCommandOutcome } from './products-api.ts';
import type { CommandOutcome, ProductCommand } from './products-api.ts';
import { mergeDraft } from './product-draft-merge.ts';
import type { DraftMerge } from './product-draft-merge.ts';
import { useProductLabel } from './product-form-labels.ts';

/** How a product command ended, as the save bar shows it. */
const tabSaveOutcome = (outcome: CommandOutcome): DraftSaveOutcome => {
  if (outcome.ok) {
    return 'saved';
  }
  if (outcome.proposal !== undefined || outcome.reason === 'approval-required') {
    return 'proposed';
  }
  if (outcome.reason === 'reload-required') {
    return 'reload-required';
  }
  return outcome.reason === 'conflict' ? 'conflict' : 'failed';
};

/**
 * A kept draft over this release's draft shape: fields a new release added take the server's values, so the form
 * never reads a field the draft from before the reload did not have.
 */
const overServer = <V,>(server: V, kept: V): V =>
  typeof server === 'object' && server !== null && !Array.isArray(server) && typeof kept === 'object' && kept !== null
    ? { ...server, ...kept }
    : kept;

/** Two drafts as JSON keeps them: a kept draft lost its undefined fields on the way through the reload. */
const sameKept = (left: unknown, right: unknown): boolean => {
  const asKept = (value: unknown): unknown => JSON.parse(JSON.stringify(value) ?? 'null');
  return Equal.equals(asKept(left), asKept(right));
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

/** Rebased saves of one draft that go out by themselves; a catalogue that keeps changing leaves it to the operator. */
const AUTOMATIC_REBASES = 3;

/**
 * A save refused because the catalogue moved past the revision it expected: the version the draft was based on and
 * that revision. Once the page has read a newer revision, the draft's own changes go over it. `save` came from a save
 * and saves the rebased draft at once when it overlaps nothing someone else changed; `keep` came from "Načíst
 * aktuální verzi" and only puts the draft back; `held` overlaps someone else's change and waits for that button.
 */
interface Refusal<V> {
  readonly base: V;
  readonly from: number;
  readonly mode: 'held' | 'keep' | 'save';
}

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
  /**
   * Names this form's draft among the drafts "Načíst novou verzi a obnovit úpravy" keeps across the page reload, such
   * as `variants:${product.id}`. After that reload the form opens with the kept draft, unsaved, through `reset`.
   */
  readonly keepAs: string;
  /**
   * Puts the operator's draft over a newer server version after a conflict; `base` is the version the draft was
   * based on. `mergeDraft` (field by field) by default.
   */
  readonly merge?: (base: V, mine: V, theirs: V) => DraftMerge<V>;
  /** Re-reads the product: after a save someone else's change refused, and on "Načíst aktuální verzi". */
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
  /** "Načíst aktuální verzi": the draft's own changes go over the current version, unsaved, for the operator to check. */
  readonly reloadLatest: () => void;
}

/**
 * Draft, save and unsaved-changes guard of one product tab form. Nothing is sent on change, blur, tab switch or
 * unmount; `draft.save()` (the Save button) sends one command. A save refused over someone else's change re-reads the
 * product and puts the draft's own changes over the fresh version: saved again at once when they touch nothing the
 * other change did, otherwise kept unsaved behind the conflict message until "Načíst aktuální verzi". A change parked
 * for approval saved nothing.
 */
export const useProductTabSave = <V,>(options: ProductTabSaveOptions<V>): ProductTabSave<V> => {
  const label = useProductLabel();
  const [error, setError] = useState<string | null>(null);
  // The draft a reload kept for this form: it comes back unsaved, based on the revision it had.
  const keepKey = `merchandise:product-tab:${options.keepAs}`;
  const [kept] = useState(() => {
    const draft = keptDraft<KeptDraft<V>>(keepKey);
    return draft === undefined
      ? undefined
      : {
          confirmed: overServer(options.server, draft.confirmed),
          revision: draft.revision,
          value: overServer(options.server, draft.value),
        };
  });
  const restoring = useRef(kept);
  // The revision the next save is based on. A clean draft follows the page's revision; a pending draft keeps the one
  // it started from, so the server refuses a save over someone else's change. A saved draft moves it to the revision
  // the server returned.
  const base = useRef(kept?.revision ?? options.revision);
  // The revision the last save of this form committed. A product read older than it (one that started before the save
  // and landed after it) still shows the version before the save: it must not replace the saved draft.
  const [committedRevision, setCommittedRevision] = useState(0);
  // The confirmed version as of the last render, which a save compares its draft with.
  const confirmedNow = useRef(kept?.confirmed ?? options.value);
  // A save someone else's change refused, until the draft is rebased on the version they saved.
  const refusal = useRef<Refusal<V> | undefined>(undefined);
  // Rebased saves that went out by themselves since the operator last saved or reloaded.
  const rebases = useRef(0);
  const [retry, setRetry] = useState(false);
  const draft = useDraftSave<V, never>({
    initial: kept?.confirmed,
    isValid: (value) => options.isValid(value),
    runtime: browserRuntime,
    save: (value) =>
      runCommands(Arr.ensure(options.commandOf(value, confirmedNow.current)), base.current).pipe(
        Effect.map(({ committed, outcome, refused, sent }): DraftSaveOutcome | PartlySaved<V, Exclude<DraftSaveOutcome, 'saved'>> => {
          // Commands that went through before a refused one moved the revision; a retry starts after them.
          base.current = Math.max(base.current, committed);
          if (outcome.ok) {
            base.current = outcome.revision;
            rebases.current = 0;
            setCommittedRevision(outcome.revision);
            setError(null);
            options.onSaved();
            return 'saved';
          }
          setError(
            (refused === null ? undefined : options.failureText?.(outcome, value, refused)) ??
              (outcome.reason === 'rejected' ? label('messages.rejected') : label('messages.failed')),
          );
          const result = tabSaveOutcome(outcome);
          const { partlyConfirmed } = options;
          if (sent.length > 0 && partlyConfirmed !== undefined) {
            confirmedNow.current = partlyConfirmed(value, confirmedNow.current, sent);
          }
          if (result === 'conflict') {
            // Read the version someone else saved; the draft's own changes then go over it.
            refusal.current = { base: confirmedNow.current, from: base.current, mode: 'save' };
            options.onReload();
          }
          if (sent.length === 0 || partlyConfirmed === undefined || result === 'saved') {
            return result;
          }
          return { confirmed: confirmedNow.current, outcome: result, revision: committed };
        }),
      ),
    value: options.value,
  });
  const { confirmed: confirmedValue } = draft;
  useEffect(() => {
    confirmedNow.current = confirmedValue;
  }, [confirmedValue]);
  const { pending } = draft;
  const { reset: putBack, server: serverNow } = options;
  useEffect(() => {
    // A kept draft about to be put back stays on the revision it was based on. Any other draft follows the page's
    // revision while the server still has the version it builds on: the revision counts every write to the company's
    // catalogue, and a newer one that left this form's fields alone is no conflict.
    if (restoring.current === undefined && (!pending || Equal.equals(serverNow, confirmedNow.current))) {
      base.current = Math.max(base.current, options.revision);
    }
  }, [options.revision, pending, serverNow]);
  useEffect(() => {
    const restored = restoring.current;
    if (restored === undefined) {
      return;
    }
    restoring.current = undefined;
    // The server still has the version the draft builds on: newer revisions changed something else.
    if (sameKept(serverNow, restored.confirmed)) {
      base.current = Math.max(base.current, options.revision);
    }
    putBack(restored.value);
  }, [options.revision, putBack, serverNow]);
  const { confirmed: keptBase, dirty: unsaved } = draft;
  const { value: shown } = options;
  useEffect(
    () =>
      keepDraftOnReload(keepKey, () =>
        unsaved ? ({ confirmed: keptBase, revision: base.current, value: shown } satisfies KeptDraft<V>) : undefined,
      ),
    [keepKey, keptBase, shown, unsaved],
  );
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
  const staleRead = options.revision < committedRevision;
  const { onReload, revision: shownRevision } = options;
  const reloadedFor = useRef<number | null>(null);
  useEffect(() => {
    if (staleRead && reloadedFor.current !== shownRevision) {
      reloadedFor.current = shownRevision;
      onReload();
    }
  }, [onReload, shownRevision, staleRead]);
  if (staleRead) {
    // Wait for the read that includes this form's last save.
  } else if (!Equal.equals(seen, server)) {
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
  const merge = options.merge ?? mergeDraft;
  const { status } = draft;
  /**
   * Puts the draft's own changes since the refused save's base over the version the page has now. After a save that
   * overlaps nothing someone else changed, the rebased draft is saved at once; one that does waits behind the
   * conflict message, and "Načíst aktuální verzi" puts the operator's values over the fresh version for them to check.
   */
  const rebase = (conflict: Refusal<V>, mode: Refusal<V>['mode']) => {
    const { merged, overlap } = merge(conflict.base, value, server);
    const automatic = mode === 'save';
    if (automatic && (overlap || rebases.current >= AUTOMATIC_REBASES)) {
      refusal.current = { ...conflict, mode: 'held' };
      return;
    }
    refusal.current = undefined;
    base.current = Math.max(base.current, shownRevision);
    setPassedOver(Option.none());
    adopt(server);
    reset(merged);
    if (automatic) {
      rebases.current += 1;
      setRetry(true);
    }
  };
  // The read after a refused save landed (or the refusal found a newer read already on the page).
  const rebaseOnRead = useEffectEvent(() => {
    const conflict = refusal.current;
    if (conflict === undefined || conflict.mode === 'held' || staleRead || shownRevision <= conflict.from) {
      return;
    }
    if (status === 'conflict') {
      rebase(conflict, conflict.mode);
    } else {
      // Discarded, or typed back to the confirmed version: nothing is left to put over the fresh version.
      refusal.current = undefined;
    }
  });
  useEffect(() => {
    rebaseOnRead();
  }, [shownRevision, staleRead, status]);
  // The rebased draft is the form's draft by now (the draft controller took it in its own effect): send it.
  const saveRebased = useEffectEvent(() => {
    setRetry(false);
    draft.save();
  });
  useEffect(() => {
    if (retry) {
      saveRebased();
    }
  }, [retry]);
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
      // The operator asked: a later conflict may save again by itself.
      rebases.current = 0;
      const conflict: Refusal<V> = refusal.current ?? { base: draft.confirmed, from: base.current, mode: 'keep' };
      if (!staleRead && shownRevision > conflict.from) {
        rebase(conflict, 'keep');
        return;
      }
      refusal.current = { ...conflict, mode: 'keep' };
      onReload();
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
          onReloadKeepingDrafts={reloadKeepingDrafts}
          onReloadLatest={handleReloadLatest}
          onSave={handleSave}
          status={save.draft.status}
        />
      )}
      <UnsavedChangesDialog labels={labels} prompt={save.guard.prompt} />
    </>
  );
};
