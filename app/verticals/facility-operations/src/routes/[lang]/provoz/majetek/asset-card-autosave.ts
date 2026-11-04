// Autosave of the asset card in edit mode: one governed update per draft, its refusals on the inline status line.
import { useAutosave } from '@app/admin-ui';
import type { AutosaveOptions, AutosaveOutcome, AutosaveState } from '@app/admin-ui';
import { DateTime, Effect, Option } from 'effect';
import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type { Asset } from '../../../../../shared/domain/assets.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { facilityAutosaveOutcome } from '../../../../ui/facility-autosave.ts';
import type { CommandOutcome } from '../../../../ui/use-agenda.ts';
import { assetCardDraftOf, assetCardUpdateCommandOf, sameAssetCardDraft } from './asset-card-draft.ts';
import type { AssetCardDraft } from './asset-card-draft.ts';
import { assetPlacementOf, usePropertyTree } from './property-tree.ts';

/** The page's governed runner of one asset command. */
export type RunAssetCommand = (command: OpsCommand) => Effect.Effect<CommandOutcome>;

/** What an edited asset card renders in the panel footer instead of its save button. */
export interface AssetCardAutosave {
  /** The card's draft: the user's edits, or the version of the record a settled draft follows. */
  readonly draft: AssetCardDraft;
  readonly flush: () => void;
  readonly pending: boolean;
  readonly reloadLatest: () => void;
  readonly retry: () => void;
  readonly setDraft: Dispatch<SetStateAction<AssetCardDraft>>;
  readonly status: AutosaveState;
}

/**
 * The base of one draft generation: the asset snapshot its draft was read from and the page runner that read it.
 * Saves run through this base, so the agenda sees the revision the draft was actually built on: someone else's change
 * to the asset refuses the save (the per-record conflict the status line offers to resolve), while a change elsewhere
 * in the agenda still goes through.
 */
export interface AssetCardBase {
  readonly assetId: string;
  readonly run: RunAssetCommand;
  /** `updatedAt` of the asset snapshot the draft was read from. */
  readonly snapshot: string;
}

/** What a fresh read means for the draft: the values to adopt (`null` while the draft already matches), and the base. */
export interface AssetCardRefresh {
  readonly adopt: AssetCardDraft | null;
  readonly base: AssetCardBase;
}

/** The base of a draft read from `asset` through `run`. */
export const assetCardBaseOf = (run: RunAssetCommand, asset: Asset): AssetCardBase => ({
  assetId: asset.id,
  run,
  snapshot: DateTime.formatIso(asset.updatedAt),
});

/**
 * What a fresh read means for the draft: `adopt` when it replaces the draft with `asset`'s values, and the base to
 * continue on. A draft the user is still editing keeps its edits and its base — a refresh must not rebase its save
 * onto state the draft never saw — and only a settled draft follows a newer snapshot of the same record.
 */
export const assetCardRefreshOf = (input: {
  readonly asset: Asset;
  readonly base: AssetCardBase;
  readonly draft: AssetCardDraft;
  readonly pending: boolean;
  readonly run: RunAssetCommand;
}): AssetCardRefresh => {
  const sameRecord = input.base.assetId === input.asset.id;
  const changed = !sameRecord || input.base.snapshot !== DateTime.formatIso(input.asset.updatedAt);
  if (!changed || (sameRecord && input.pending)) {
    return { adopt: null, base: input.base };
  }
  const stored = assetCardDraftOf(input.asset);
  return {
    adopt: sameAssetCardDraft(stored, input.draft) ? null : stored,
    base: assetCardBaseOf(input.run, input.asset),
  };
};

/** The autosave of one draft generation: every save runs through the generation's own base runner. */
export const assetCardAutosaveOf = (input: {
  readonly base: () => AssetCardBase;
  readonly commandOf: (value: AssetCardDraft) => Option.Option<OpsCommand>;
}): AutosaveOptions<AssetCardDraft, never> => ({
  equals: sameAssetCardDraft,
  isValid: (value) => Option.isSome(input.commandOf(value)),
  save: (value) =>
    Option.match(input.commandOf(value), {
      onNone: () => Effect.succeed<AutosaveOutcome>('failed'),
      onSome: (command) => facilityAutosaveOutcome(input.base().run(command)),
    }),
});

/**
 * Autosave of one asset card: the draft's location resolves against the property read (the stored one while it is not
 * ready). A settled draft follows a fresh read of its record while rendering; a draft the user is still editing keeps
 * its edits and the base of the read it was built on, so a change to that record ends in the conflict the status line
 * offers to resolve instead of overwriting the change.
 */
export const useAssetCardAutosave = ({
  asset,
  run,
}: {
  readonly asset: Asset;
  readonly run: RunAssetCommand;
}): AssetCardAutosave => {
  const tree = usePropertyTree();
  const commandOf = (value: AssetCardDraft) =>
    assetCardUpdateCommandOf(value, asset, assetPlacementOf(tree, value, asset));
  const [draft, setDraft] = useState(() => assetCardDraftOf(asset));
  const [confirmed, setConfirmed] = useState(draft);
  // The base of the draft generation: a fresh read never moves it while the user has unsaved work.
  const [base, setBase] = useState(() => assetCardBaseOf(run, asset));
  const options = assetCardAutosaveOf({ base: () => base, commandOf });
  const autosave = useAutosave<AssetCardDraft, never>({
    ...options,
    runtime: browserRuntime,
    save: (value) =>
      options.save(value).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            if (outcome === 'saved') {
              setConfirmed(value);
            }
          }),
        ),
      ),
    value: draft,
  });
  const { adopt, flush, pending, retry, status } = autosave;
  // The controller receives edits after commit; compare the draft too so a batched refresh cannot erase an edit.
  const unsettled = pending || !sameAssetCardDraft(draft, confirmed);
  // Reconsider the current read when a save settles, even if that read arrived while the save was pending.
  const refresh = assetCardRefreshOf({ asset, base, draft, pending: unsettled, run });
  if (refresh.base !== base) {
    setBase(refresh.base);
  }
  if (refresh.adopt !== null) {
    setDraft(refresh.adopt);
    setConfirmed(refresh.adopt);
    adopt(refresh.adopt);
  }
  return {
    draft,
    flush,
    pending: unsettled,
    reloadLatest: () => {
      const stored = assetCardDraftOf(asset);
      setBase(assetCardBaseOf(run, asset));
      setDraft(stored);
      setConfirmed(stored);
      adopt(stored);
    },
    retry,
    setDraft,
    status,
  };
};
