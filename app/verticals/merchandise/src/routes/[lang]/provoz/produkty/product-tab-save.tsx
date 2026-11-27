// Explicit save of one tab form of the product editor (variants, e-shop settings, e-shop content): the form keeps its
// own draft, the one Save button sends it as one product command, and leaving with unsaved changes asks first.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { SaveBar, UnsavedChangesDialog, saveLabelsFor, useDraftSave, useUnsavedChangesGuard } from '@app/admin-ui';
import type { DraftSave, DraftSaveOutcome, KeptDraft, PartlySaved, UnsavedChangesGuard } from '@app/admin-ui';
import { keepDraftOnReload, keptDraft, reloadKeepingDrafts } from '@app/shared-contracts';
import { Array as Arr, Effect, Equal, Option } from 'effect';
import { useEffect, useRef, useState } from 'react';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { productCommandOutcome, versionedCommand } from './products-api.ts';
import type { CommandOutcome, ProductCommand } from './products-api.ts';
import { mergeDraft } from './product-draft-merge.ts';
import type { DraftMerge } from './product-draft-merge.ts';
import { refusedSave, useDraftRebase } from './product-draft-rebase.ts';
import type { Refusal } from './product-draft-rebase.ts';
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

/** How far one save got: the commands that went through, the product version they left and how the last one ended. */
interface CommandsRun {
  /** The product version the commands that went through left (the base when none did). */
  readonly committed: number;
  readonly outcome: CommandOutcome;
  /** The command the server refused, when one was. */
  readonly refused: ProductCommand | null;
  readonly sent: readonly ProductCommand[];
}

/**
 * Sends `commands` one after another, each naming the product version the previous one left; stops at the first
 * refusal. `revision` is the catalogue revision sent along, which the server checks only for a command naming no
 * version.
 */
const runCommands = (
  commands: readonly ProductCommand[],
  version: number,
  revision: number,
  sent: readonly ProductCommand[] = [],
): Effect.Effect<CommandsRun> => {
  const [first, ...rest] = commands;
  if (first === undefined) {
    return Effect.succeed({ committed: version, outcome: { ok: true, revision }, refused: null, sent });
  }
  return productCommandOutcome(versionedCommand(first, version), revision).pipe(
    Effect.flatMap((outcome) => {
      if (!outcome.ok) {
        return Effect.succeed({ committed: version, outcome, refused: first, sent });
      }
      // A command that wrote nothing of the product (a market offer) leaves its version as it was.
      const committed = outcome.version ?? version;
      return rest.length > 0
        ? runCommands(rest, committed, outcome.revision, [...sent, first])
        : Effect.succeed({ committed, outcome, refused: null, sent: [...sent, first] });
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
  /** The catalogue revision the page read, sent with every command; a product edit is checked by `version` instead. */
  readonly revision: number;
  /**
   * The product as the page has it now, in the form's shape (recomputed on every render is fine). A clean draft
   * takes a newer version; a draft with unsaved changes keeps them, and its save stays based on the version it
   * started from.
   */
  readonly server: V;
  /** The form's current draft. */
  readonly value: V;
  /**
   * The product's version as the page read it (`productVersionOf`). A save names the version its draft is based on,
   * so the server refuses it only when this product changed since, not when another write in the company did.
   */
  readonly version: number;
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
  // The draft a reload kept for this form: it comes back unsaved, based on the product version it had.
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
  // The product version the next save is based on. A clean draft follows the page's version, and so does a pending one
  // while the server still has the form's part of the version it builds on; otherwise it keeps the one it started from,
  // so the server refuses a save over someone else's change. A saved draft moves it to the version the server returned.
  const base = useRef(kept?.revision ?? options.version);
  // The product version the last save of this form committed. A product read older than it (one that started before
  // the save and landed after it) still shows the version before the save: it must not replace the saved draft.
  const [committedVersion, setCommittedVersion] = useState(0);
  // The confirmed version as of the last render, which a save compares its draft with.
  const confirmedNow = useRef(kept?.confirmed ?? options.value);
  // A save someone else's change refused, until the draft is rebased on the version they saved.
  const refusal = useRef<Refusal<V> | undefined>(undefined);
  const draft = useDraftSave<V, never>({
    initial: kept?.confirmed,
    isValid: (value) => options.isValid(value),
    runtime: browserRuntime,
    save: (value) =>
      runCommands(Arr.ensure(options.commandOf(value, confirmedNow.current)), base.current, options.revision).pipe(
        Effect.map(({ committed, outcome, refused, sent }): DraftSaveOutcome | PartlySaved<V, Exclude<DraftSaveOutcome, 'saved'>> => {
          // Commands that went through before a refused one moved the version; a retry starts after them.
          base.current = Math.max(base.current, committed);
          if (outcome.ok) {
            base.current = committed;
            setCommittedVersion(committed);
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
            refusal.current = refusedSave(confirmedNow.current, base.current);
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
    // A kept draft about to be put back stays on the version it was based on. Any other draft follows the page's
    // version while the server still has the form's part of the version it builds on: a newer product version that
    // left this form's fields alone is no conflict.
    if (restoring.current === undefined && (!pending || Equal.equals(serverNow, confirmedNow.current))) {
      base.current = Math.max(base.current, options.version);
    }
  }, [options.version, pending, serverNow]);
  useEffect(() => {
    const restored = restoring.current;
    if (restored === undefined) {
      return;
    }
    restoring.current = undefined;
    // The server still has the version the draft builds on: newer versions changed something else.
    if (sameKept(serverNow, restored.confirmed)) {
      base.current = Math.max(base.current, options.version);
    }
    putBack(restored.value);
  }, [options.version, putBack, serverNow]);
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
  const staleRead = options.version < committedVersion;
  const { onReload, version: shownVersion } = options;
  const reloadedFor = useRef<number | null>(null);
  useEffect(() => {
    if (staleRead && reloadedFor.current !== shownVersion) {
      reloadedFor.current = shownVersion;
      onReload();
    }
  }, [onReload, shownVersion, staleRead]);
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
  const reloadLatest = useDraftRebase({
    current: () => ({ base: confirmed, from: base.current }),
    merge: options.merge ?? mergeDraft,
    onReload,
    refusal,
    revision: shownVersion,
    save: draft.save,
    server,
    stale: staleRead,
    status: draft.status,
    take: (fresh, merged) => {
      base.current = Math.max(base.current, shownVersion);
      setPassedOver(Option.none());
      adopt(fresh);
      reset(merged);
    },
    value,
  });
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
    reloadLatest,
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
