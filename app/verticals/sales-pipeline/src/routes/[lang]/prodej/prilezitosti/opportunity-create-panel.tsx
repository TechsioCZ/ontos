// Create an opportunity; the owner is chosen here. Typing changes only the form; the shared Save button ("Uložit",
// last in the footer) sends one CreateOpportunity, and leaving with unsaved input asks Uložit / Zahodit změny /
// Zůstat. An untouched panel closes without asking.
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
import { Effect, Option } from 'effect';
import { constVoid } from 'effect/Function';
import { useEffect } from 'react';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { createCommandOf, emptyDraft, sameOpportunityDraft } from './opportunity-draft.ts';
import type { CreateCommand, FormDraft } from './opportunity-draft.ts';
import {
  K,
  OpportunityForm,
  RESIZE_LABEL_KEY,
  useCheckOpportunity,
  useOpportunityDraft,
} from './opportunity-fields.tsx';
import type { OpportunityReferences } from './opportunity-fields.tsx';

/** Sends one CreateOpportunity; `failed` keeps the draft and the host's message shows in the save bar. */
export type OpportunityCreate = (command: CreateCommand) => Effect.Effect<SaveOutcome>;

interface CreatePanelProps extends OpportunityReferences {
  readonly onCreate: OpportunityCreate;
  /** The opportunity was created: the host closes the panel and shows its toast. */
  readonly onCreated: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly serverError?: string | undefined;
}

export const OpportunityCreatePanel = ({
  onCreate,
  onCreated,
  onOpenChange,
  serverError,
  ...references
}: CreatePanelProps) => {
  const { language, t } = useModernI18n();
  const draft = useOpportunityDraft(emptyDraft);
  const validate = useCheckOpportunity();
  const record = useDraftSave<FormDraft, never>({
    equals: sameOpportunityDraft,
    initial: emptyDraft,
    isValid: (value) => Option.isSome(createCommandOf(value)),
    runtime: browserRuntime,
    save: (value) =>
      Option.match(createCommandOf(value), {
        onNone: () => Effect.succeed<SaveOutcome>('failed'),
        onSome: onCreate,
      }),
    value: draft,
  });
  // Field messages show once the draft is changed and invalid, the same moment the save bar says so.
  const invalid = record.status === 'invalid';
  useEffect(() => {
    if (invalid) {
      validate();
    }
  }, [invalid, validate]);
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: constVoid });
  const labels = saveLabelsFor(language);
  const handleReloadLatest = constVoid;
  const handleSave = () => {
    record.save();
    record.afterSave((status) => {
      if (status === 'saved') {
        onCreated();
      }
    });
  };
  return (
    <>
      <SidePanel
        actions={
          <>
            <Button
              appearance="outline"
              onClick={() => guard.request(() => onOpenChange(false))}
              severity="secondary"
              type="button"
            >
              {t(`${K}.create.cancel`)}
            </Button>
            <SaveBar
              error={serverError}
              labels={labels}
              onReloadLatest={handleReloadLatest}
              onSave={handleSave}
              status={record.status}
            />
          </>
        }
        description={t(`${K}.create.description`)}
        guard={guard}
        onOpenChange={(open) => {
          if (!open) {
            onOpenChange(false);
          }
        }}
        open
        resizeLabel={t(RESIZE_LABEL_KEY)}
        size="xl"
        title={t(`${K}.create.title`)}
      >
        <OpportunityForm {...references} isEdit={false} opened={emptyDraft} />
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
