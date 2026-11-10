// Leave guard for the typed input of a one-click command (a stock movement): the command keeps its own button, but
// leaving with half-filled input asks Zahodit změny / Zůstat first instead of losing it silently. Uložit stays
// disabled in that question: the input is sent only by the command's own button.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { UnsavedChangesDialog, saveLabelsFor, useUnsavedChangesGuard } from '@app/admin-ui';
import type { SavableDraft } from '@app/admin-ui';
import { constVoid } from 'effect/Function';

/** A draft the guard can ask about, which never saves: Save is the command's own button. */
const commandDraft: SavableDraft = {
  afterSave: (done) => {
    done('idle');
  },
  canSave: false,
  dirty: false,
  save: constVoid,
  status: 'idle',
};

export const useCommandInputGuard = (dirty: boolean, onDiscard: () => void) => {
  const { language } = useModernI18n();
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({
    draft: commandDraft,
    // Only a form holding input answers a blocked navigation.
    navigation: dirty ? blocker : undefined,
    onDiscard,
    otherChanges: dirty,
  });
  const dialog = <UnsavedChangesDialog labels={saveLabelsFor(language)} prompt={guard.prompt} />;
  return { dialog, guard };
};
