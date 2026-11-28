import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  saveLabelsFor,
  useDraftSave,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { useAtomSet, useAtomSubscribe, useAtomValue } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect, Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { pendingProposalMessage } from '../../../../tags/action-result.ts';
import { applyTaggingCommand } from '../../../../tags/records-commands.ts';
import { refreshTagCatalog } from '../../../../tags/tag-catalog.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { createTagCommand, tagDraftOf, validTagDraft } from './tag-draft.ts';
import type { TagDraft } from './tag-draft.ts';
import { TagForm, tagCreateState, tagDraftOfValues, tagValuesOf } from './tag-fields.tsx';

const resizeKey = 'tagging.sidePanel.resize';
const emptyDraft = tagDraftOf(null);
const emptyValues = tagValuesOf(emptyDraft);

/** Sends the new tag once. A change parked for approval is `proposed`; any other failure is `failed`. */
const createOutcome = (value: TagDraft) =>
  applyTaggingCommand(createTagCommand(value)).pipe(
    Effect.match({
      onFailure: (error): SaveOutcome => (pendingProposalMessage(error) === undefined ? 'failed' : 'proposed'),
      onSuccess: (): SaveOutcome => 'saved',
    }),
  );

/**
 * Create one tag. Typing changes only the form; Uložit (or Enter) sends it once and closes the panel when the tag is
 * created. Every way out asks first while something is typed.
 */
export const TagCreatePanel = ({ onClose }: { readonly onClose: () => void }) => {
  const { language, t } = useModernI18n();
  const toaster = useToast();
  const values = useAtomValue(tagCreateState.values);
  const setValues = useAtomSet(tagCreateState.setValues);
  const validate = useAtomSet(tagCreateState.validate);
  const draft = Option.match(values, {
    onNone: () => emptyDraft,
    onSome: (shown) => tagDraftOfValues(shown, emptyDraft),
  });
  const record = useDraftSave<TagDraft, never>({
    isValid: validTagDraft,
    runtime: browserRuntime,
    save: createOutcome,
    value: draft,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const startOver = () => setValues(emptyValues);
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: startOver });
  const labels = saveLabelsFor(language);
  const handleSave = () => {
    // From the first attempt to send on, the fields show what keeps the tag from being created.
    validate();
    record.save();
    record.afterSave((status) => {
      if (status === 'saved') {
        refreshTagCatalog();
        toaster.create({ title: t('tagging.tags.created'), type: 'success' });
        onClose();
      }
    });
  };
  // Enter checks the fields and, when they hold a tag, is Uložit.
  useAtomSubscribe(
    tagCreateState.submit,
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
            <Button appearance="outline" onClick={() => guard.request(onClose)} severity="secondary" type="button">
              {t('tagging.tags.form.cancel')}
            </Button>
            <SaveBar
              error={t('tagging.tags.failure')}
              labels={labels}
              onReloadLatest={startOver}
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
        <TagForm defaultValues={emptyValues} kind="create" />
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
