import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  saveLabelsFor,
  useRecordDraft,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Effect } from 'effect';
import { applyTaggingCommandIfUnchanged } from '../../../../tags/records-commands.ts';
import { refreshTagCatalog } from '../../../../tags/tag-catalog.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { TagWithCounts } from '../../../../../shared/apis/records.ts';
import {
  sameTagDraft,
  tagDraftOf,
  tagSaveResult,
  tagUnchangedSince,
  updateTagCommand,
  validTagDraft,
} from './tag-draft.ts';
import type { TagDraft } from './tag-draft.ts';
import { TagFields } from './tag-fields.tsx';

const refreshCatalog = Effect.sync(refreshTagCatalog);

/**
 * Edit one existing tag. Editing changes only the draft on screen; the Save button sends it, and only while the
 * owner still has the tag as the draft's confirmed version. When someone else changed it, the panel offers the
 * current version instead. Every way out of the panel asks first while something is unsaved.
 */
export const TagEditPanel = ({ onClose, tag }: { readonly onClose: () => void; readonly tag: TagWithCounts }) => {
  const { language, t } = useModernI18n();
  const record = useRecordDraft<TagDraft, never>({
    equals: sameTagDraft,
    isValid: validTagDraft,
    refresh: refreshCatalog,
    runtime: browserRuntime,
    // The confirmed version is the tag as this draft started from it (or last saved it): a save over someone
    // else's change of the tag is refused.
    save: (value, _expectedRevision, confirmed) =>
      tagSaveResult(
        applyTaggingCommandIfUnchanged(updateTagCommand(tag.id, value), tagUnchangedSince(tag.id, confirmed)),
      ),
    server: tagDraftOf(tag),
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: record.discard });
  const labels = saveLabelsFor(language);
  const handleClose = () => {
    guard.request(onClose);
  };
  const handleSave = record.save;
  const handleReloadLatest = record.reloadLatest;
  const handleDraftChange = record.setDraft;
  return (
    <>
      <SidePanel
        actions={
          <>
            <Button onClick={handleClose} theme="outlined" type="button" variant="secondary">
              {t('tagging.tags.form.close')}
            </Button>
            <SaveBar labels={labels} onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />
          </>
        }
        guard={guard}
        onOpenChange={(next) => {
          if (!next) {
            onClose();
          }
        }}
        open
        resizeLabel={t('tagging.sidePanel.resize')}
        size="md"
        title={t('tagging.tags.edit')}
      >
        <form
          className="flex flex-col gap-200 py-200"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            handleSave();
          }}
        >
          <TagFields draft={record.draft} onChange={handleDraftChange} showErrors />
        </form>
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
