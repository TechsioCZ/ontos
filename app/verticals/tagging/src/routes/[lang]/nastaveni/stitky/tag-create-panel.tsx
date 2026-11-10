import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  saveLabelsFor,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect } from 'effect';
import { useState } from 'react';
import { pendingProposalMessage } from '../../../../api/action-result.ts';
import { applyTaggingCommand } from '../../../../api/records-commands.ts';
import { refreshTagCatalog } from '../../../../components/tag-controls.tsx';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { createTagCommand, tagDraftOf, validTagDraft } from './tag-draft.ts';
import type { TagDraft } from './tag-draft.ts';
import { TagFields } from './tag-fields.tsx';

const resizeKey = 'tagging.sidePanel.resize';

/** Sends the new tag once. A change parked for approval is `proposed`; any other failure is `failed`. */
const createOutcome = (value: TagDraft) =>
  applyTaggingCommand(createTagCommand(value)).pipe(
    Effect.match({
      onFailure: (error): SaveOutcome => (pendingProposalMessage(error) === undefined ? 'failed' : 'proposed'),
      onSuccess: (): SaveOutcome => 'saved',
    }),
  );

/**
 * Create one tag. Typing changes only the draft; Uložit sends it once and closes the panel when the tag is created.
 * Every way out asks first while something is typed.
 */
export const TagCreatePanel = ({ onClose }: { readonly onClose: () => void }) => {
  const { language, t } = useModernI18n();
  const toaster = useToast();
  const initial = tagDraftOf(null);
  const [draft, setDraft] = useState<TagDraft>(initial);
  const [submitted, setSubmitted] = useState(false);
  const record = useDraftSave<TagDraft, never>({
    isValid: validTagDraft,
    runtime: browserRuntime,
    save: createOutcome,
    value: draft,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: () => setDraft(initial) });
  const labels = saveLabelsFor(language);
  const handleSave = () => {
    setSubmitted(true);
    record.save();
    record.afterSave((status) => {
      if (status === 'saved') {
        refreshTagCatalog();
        toaster.create({ title: t('tagging.tags.created'), type: 'success' });
        onClose();
      }
    });
  };
  return (
    <>
      <SidePanel
        actions={
          <>
            <Button onClick={() => guard.request(onClose)} theme="outlined" type="button" variant="secondary">
              {t('tagging.tags.form.cancel')}
            </Button>
            <SaveBar
              error={t('tagging.tags.failure')}
              labels={labels}
              onReloadLatest={() => setDraft(initial)}
              onSave={handleSave}
              status={record.status}
            />
          </>
        }
        guard={guard}
        onOpenChange={(next) => {
          if (!next) {
            onClose();
          }
        }}
        open
        resizeLabel={t(resizeKey)}
        size="md"
        title={t('tagging.tags.new')}
      >
        <form
          className="flex flex-col gap-200 py-200"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            handleSave();
          }}
        >
          <TagFields draft={draft} onChange={setDraft} showErrors={submitted} />
        </form>
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
