// Create an opportunity; the owner is chosen here. Typing changes only the draft; the shared Save button ("Uložit",
// last in the footer) sends one CreateOpportunity, and leaving with unsaved input asks Uložit / Zahodit změny /
// Zůstat. An untouched panel closes without asking.
import { CalendarDateSchema } from '@app/shared-contracts';
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
import { Effect, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { useState } from 'react';
import {
  EmployeeIdSchema,
  PartyIdSchema,
} from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { emptyDraft, sameOpportunityDraft } from './opportunity-draft.ts';
import type { FormDraft } from './opportunity-draft.ts';
import {
  K,
  OpportunityFields,
  RESIZE_LABEL_KEY,
  formClassName,
  formErrors,
  hasFormErrors,
} from './opportunity-fields.tsx';
import type { CreateCommand, OpportunityReferences, Translate } from './opportunity-fields.tsx';

/** Sends one CreateOpportunity; `failed` keeps the draft and the host's message shows in the save bar. */
export type OpportunityCreate = (command: CreateCommand) => Effect.Effect<SaveOutcome>;

/** The CreateOpportunity of a complete, valid draft; none while a field is missing or invalid. */
export const createCommandOf = (draft: FormDraft, t: Translate): Option.Option<CreateCommand> => {
  const partyOption = draft.customerId === null ? Option.none() : Schema.decodeOption(PartyIdSchema)(draft.customerId);
  const dateOption = Schema.decodeOption(CalendarDateSchema)(draft.closeText);
  if (hasFormErrors(formErrors(draft, t)) || Option.isNone(partyOption) || Option.isNone(dateOption)) {
    return Option.none();
  }
  const base: CreateCommand = {
    _tag: 'CreateOpportunity',
    expectedCloseDate: dateOption.value,
    lines: draft.lines.map((entry) => entry.line),
    note: draft.note.trim(),
    partyId: partyOption.value,
    title: draft.title.trim(),
  };
  const owner = draft.ownerId === null ? Option.none() : Schema.decodeOption(EmployeeIdSchema)(draft.ownerId);
  return Option.some(Option.isSome(owner) ? { ...base, ownerEmployeeId: owner.value } : base);
};

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
  const [draft, setDraft] = useState<FormDraft>(emptyDraft);
  const record = useDraftSave<FormDraft, never>({
    equals: sameOpportunityDraft,
    initial: emptyDraft,
    isValid: (value) => Option.isSome(createCommandOf(value, t)),
    runtime: browserRuntime,
    save: (value) =>
      Option.match(createCommandOf(value, t), {
        onNone: () => Effect.succeed<SaveOutcome>('failed'),
        onSome: onCreate,
      }),
    value: draft,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: constVoid });
  const labels = saveLabelsFor(language);
  const handleChange = (next: Partial<FormDraft>) => setDraft((current) => ({ ...current, ...next }));
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
              onClick={() => guard.request(() => onOpenChange(false))}
              theme="outlined"
              type="button"
              variant="secondary"
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
        {/* Enter never creates the opportunity: only Uložit does. */}
        <form className={formClassName} noValidate onSubmit={(event) => event.preventDefault()}>
          <OpportunityFields
            {...references}
            draft={draft}
            isEdit={false}
            onChange={handleChange}
            showErrors={record.status === 'invalid'}
          />
        </form>
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};
