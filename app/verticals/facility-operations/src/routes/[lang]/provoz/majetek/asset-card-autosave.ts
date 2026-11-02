// Autosave of the asset card in edit mode: one governed update per draft, its refusals on the inline status line.
import { useAutosave } from '@app/admin-ui';
import type { AutosaveOutcome, AutosaveState } from '@app/admin-ui';
import { Effect, Option } from 'effect';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type { Asset } from '../../../../../shared/domain/assets.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { facilityAutosaveOutcome } from '../../../../ui/facility-autosave.ts';
import type { CommandOutcome } from '../../../../ui/use-agenda.ts';
import { assetCardDraftOf, assetCardUpdateCommandOf, sameAssetCardDraft } from './asset-card-draft.ts';
import type { AssetCardDraft } from './asset-card-draft.ts';
import { assetPlacementOf, usePropertyTree } from './property-tree.ts';

/** What an edited asset card renders in the panel footer instead of its save button. */
export interface AssetCardAutosave {
  readonly flush: () => void;
  readonly pending: boolean;
  readonly reloadLatest: () => void;
  readonly retry: () => void;
  readonly status: AutosaveState;
}

/**
 * Autosave of one asset card: the draft's location resolves against the property read (the stored one while it is not
 * ready), and `applyStored` puts the server version back into the card when someone else changed the asset.
 */
export const useAssetCardAutosave = ({
  applyStored,
  asset,
  draft,
  run,
}: {
  readonly applyStored: (value: AssetCardDraft) => void;
  readonly asset: Asset;
  readonly draft: AssetCardDraft;
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
}): AssetCardAutosave => {
  const tree = usePropertyTree();
  const commandOf = (value: AssetCardDraft) =>
    assetCardUpdateCommandOf(value, asset, assetPlacementOf(tree, value, asset));
  const autosave = useAutosave<AssetCardDraft, never>({
    equals: sameAssetCardDraft,
    isValid: (value) => Option.isSome(commandOf(value)),
    runtime: browserRuntime,
    save: (value) =>
      Option.match(commandOf(value), {
        onNone: () => Effect.succeed<AutosaveOutcome>('failed'),
        onSome: (command) => facilityAutosaveOutcome(run(command)),
      }),
    value: draft,
  });
  return {
    flush: autosave.flush,
    pending: autosave.pending,
    reloadLatest: () => {
      const stored = assetCardDraftOf(asset);
      autosave.adopt(stored);
      applyStored(stored);
    },
    retry: autosave.retry,
    status: autosave.status,
  };
};
