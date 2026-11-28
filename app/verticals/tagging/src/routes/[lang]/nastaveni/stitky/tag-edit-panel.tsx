import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  saveLabelsFor,
  useRecordDraft,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import { useAtomSet, useAtomSubscribe, useAtomValue } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Effect, Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { useEffect, useRef } from 'react';
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
import { TagForm, sameTagValues, tagDraftOfValues, tagEditState, tagValuesOf } from './tag-fields.tsx';

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
  const { draft, setDraft } = record;
  const values = useAtomValue(tagEditState.values);
  const setValues = useAtomSet(tagEditState.setValues);
  // The fields are the draft: a change of a field changes it at once.
  useAtomSubscribe(
    tagEditState.values,
    (next) => {
      if (Option.isSome(next)) {
        setDraft(tagDraftOfValues(next.value, draft));
      }
    },
    { immediate: false },
  );
  // The draft also moves without typing (Zahodit změny, the current version, a newer server version): the fields
  // follow it.
  const shownDraft = useRef(draft);
  useEffect(() => {
    if (shownDraft.current === draft) {
      return;
    }
    shownDraft.current = draft;
    const next = tagValuesOf(draft);
    if (Option.exists(values, (shown) => !sameTagValues(shown, next))) {
      setValues(next);
    }
  }, [draft, setValues, values]);
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: record.discard });
  const labels = saveLabelsFor(language);
  const handleClose = () => {
    guard.request(onClose);
  };
  const handleSave = record.save;
  const handleReloadLatest = record.reloadLatest;
  // Enter checks the fields and, when they hold a tag, is Save.
  useAtomSubscribe(
    tagEditState.submit,
    (result) => {
      if (AsyncResult.isSuccess(result) && !result.waiting) {
        handleSave();
      }
    },
    { immediate: false },
  );
  return (
    <>
      <SidePanel
        actions={
          <>
            <Button appearance="outline" onClick={handleClose} severity="secondary" type="button">
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
        <TagForm defaultValues={tagValuesOf(draft)} kind="edit" />
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
