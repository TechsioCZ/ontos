// The unsaved-changes guard of one facility edit panel: Close, the panel's dismissal, route navigation and closing
// the tab all ask Uložit / Zahodit změny / Zůstat while the draft is unsaved.
import { UnsavedChangesDialog, useUnsavedChangesGuard } from '@app/admin-ui';
import type { SavableDraft, SaveLabels, UnsavedChangesGuard } from '@app/admin-ui';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { constVoid } from 'effect/Function';
import type { ReactNode } from 'react';

/** The draft of a panel that has nothing to save (a create form, which submits on its own button). */
export const nothingToSave: SavableDraft = {
  afterSave: (done) => {
    done('idle');
  },
  canSave: false,
  dirty: false,
  save: constVoid,
  status: 'idle',
};

/**
 * Guard of an edit panel's draft. `onDiscard` puts the confirmed version back on screen. Render one
 * `UnsavedChangesDialog` with `guard.prompt` and route every way out of the panel through `guard.request`.
 */
export const useEditGuard = (draft: SavableDraft, onDiscard: () => void): UnsavedChangesGuard => {
  // The guard installs the tab-close prompt itself, so the router's own one stays off.
  const navigation = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => draft.dirty, withResolver: true });
  return useUnsavedChangesGuard({ draft, navigation, onDiscard });
};

/**
 * The guard and its one question for an edit footer that only exists while editing, such as the edit mode of a form
 * that also creates. Rendered inside a `SidePanel`, the panel asks it before every dismissal on its own.
 */
export const EditGuard = ({
  children,
  draft,
  labels,
  onDiscard,
}: {
  readonly children: (guard: UnsavedChangesGuard) => ReactNode;
  readonly draft: SavableDraft;
  readonly labels: SaveLabels;
  readonly onDiscard: () => void;
}) => {
  const guard = useEditGuard(draft, onDiscard);
  return (
    <>
      {children(guard)}
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
