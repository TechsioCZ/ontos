import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  saveLabelsFor,
  statusPresentation,
  useRecordDraft,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { RevisionedSaveResult } from '@app/admin-ui';
import {
  ChoiceField,
  FormBuilder,
  FormReact,
  FormRoot,
  TextAreaField,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Option, Predicate, Schema } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { useEffect, useId, useRef, useState } from 'react';
import type { Opportunity } from '../../../../../shared/model/opportunity.ts';
import { OpportunityNoteSchema } from '../../../../../shared/model/opportunity.ts';
import { isOpportunityStage, opportunityStages, permittedStageTransitions } from './pipeline-model.ts';
import type { EmployeeId, OpportunityStage } from './pipeline-model.ts';
import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { draftFrom, opportunityUnchangedSince, sameOpportunityDraft, updateCommandOf } from './opportunity-draft.ts';
import type { FormDraft, UpdateCommand } from './opportunity-draft.ts';
import type { EmployeeOption } from './pipeline-references.ts';
import { OpportunityCreatePanel } from './opportunity-create-panel.tsx';
import type { OpportunityCreate } from './opportunity-create-panel.tsx';
import {
  K,
  NONE,
  OpportunityForm,
  RESIZE_LABEL_KEY,
  SELECT_PLACEHOLDER,
  formLabelClassName,
  useCheckOpportunity,
  useOpportunityDraftSync,
} from './opportunity-fields.tsx';
import type { OpportunityReferences } from './opportunity-fields.tsx';
import { useCommandInputGuard } from './command-input-guard.tsx';

export type { CreateCommand } from './opportunity-fields.tsx';

const isValidNote = Schema.is(OpportunityNoteSchema);

/**
 * Rendered inside `FormRoot`, which renders its children only once this mount initialized the form: until then the
 * form's atoms can still hold what an earlier panel left, so the panel follows the form only after `onReady`.
 */
const FormReady = ({ onReady }: { readonly onReady: (ready: boolean) => void }) => {
  useEffect(() => onReady(true), [onReady]);
  return null;
};

/** Saves one edit against the revision its draft builds on; `unchanged` decides whether a revision race is resent. */
export type OpportunitySave = (
  command: UpdateCommand,
  expectedRevision: number,
  unchanged: (items: readonly Opportunity[]) => boolean,
) => Effect.Effect<RevisionedSaveResult>;

interface EditPanelProps extends OpportunityReferences {
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: OpportunitySave;
  readonly opportunity: Opportunity;
  readonly revision: number;
  readonly serverError?: string | undefined;
}

/**
 * Edit an existing opportunity; the owner changes through the owner action. Nothing is saved until Uložit, against the
 * revision the draft builds on; when someone else changed this opportunity, the save bar offers the current version
 * instead of overwriting it.
 */
const OpportunityEditPanel = ({
  onOpenChange,
  onSave,
  opportunity,
  revision,
  serverError,
  ...references
}: EditPanelProps) => {
  const { language, t } = useModernI18n();
  const server = draftFrom(opportunity);
  /** The version of the opportunity the draft builds on: what it opened with, last saved or reloaded. */
  const base = useRef(server);
  const sendCommand = (value: FormDraft, expectedRevision: number, command: UpdateCommand) =>
    onSave(command, expectedRevision, opportunityUnchangedSince(opportunity.id, base.current)).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          // Only an applied save moves the base; a proposal waits for approval and a conflict or failure changes nothing.
          if (Predicate.isNumber(result)) {
            base.current = value;
          }
        }),
      ),
    );
  const saveDraft = (value: FormDraft, expectedRevision: number) =>
    Option.match(updateCommandOf(opportunity.id, value), {
      onNone: () => Effect.succeed<RevisionedSaveResult>('failed'),
      onSome: (command) => sendCommand(value, expectedRevision, command),
    });
  const record = useRecordDraft<FormDraft, never>({
    equals: sameOpportunityDraft,
    isValid: (value) => Option.isSome(updateCommandOf(opportunity.id, value)),
    revision,
    runtime: browserRuntime,
    save: (value, expectedRevision) => saveDraft(value, expectedRevision),
    server,
  });
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: record.discard });
  const settledOnServer = !record.pending && sameOpportunityDraft(record.draft, server);
  useEffect(() => {
    if (settledOnServer) {
      base.current = server;
    }
  }, [base, server, settledOnServer]);
  const labels = saveLabelsFor(language);
  const [ready, setReady] = useState(false);
  const validate = useCheckOpportunity();
  const { draft, setDraft } = record;
  useOpportunityDraftSync({ draft, ready, setDraft });
  // While editing, every field shows its message from the start.
  useEffect(() => {
    if (ready) {
      validate();
    }
  }, [ready, validate]);
  const handleReloadLatest = record.reloadLatest;
  const handleSave = record.save;
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
              {t(`${K}.edit.close`)}
            </Button>
            <SaveBar labels={labels} onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />
          </>
        }
        description={t(`${K}.edit.description`)}
        guard={guard}
        onOpenChange={(open) => {
          if (!open) {
            onOpenChange(false);
          }
        }}
        open
        resizeLabel={t(RESIZE_LABEL_KEY)}
        size="xl"
        title={t(`${K}.edit.title`)}
      >
        <OpportunityForm {...references} isEdit opened={draft}>
          <FormReady onReady={setReady} />
          {serverError !== undefined && (
            <StatusText showIcon status="error">
              {serverError}
            </StatusText>
          )}
        </OpportunityForm>
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

interface OpportunityFormDialogProps extends OpportunityReferences {
  /** Present for edit; absent for create. */
  readonly initial?: Opportunity | undefined;
  readonly onCreate: OpportunityCreate;
  /** The opportunity was created: the host closes the panel and shows its toast. */
  readonly onCreated: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: OpportunitySave;
  /** Revision of the records the edited opportunity comes from. */
  readonly revision: number;
  readonly serverError?: string | undefined;
}

/** Create an opportunity, or edit one with an explicit Uložit. */
export const OpportunityFormDialog = ({
  initial,
  onCreate,
  onCreated,
  onSave,
  revision,
  serverError,
  ...rest
}: OpportunityFormDialogProps) =>
  initial === undefined ? (
    <OpportunityCreatePanel {...rest} onCreate={onCreate} onCreated={onCreated} serverError={serverError} />
  ) : (
    <OpportunityEditPanel
      {...rest}
      onSave={onSave}
      opportunity={initial}
      revision={revision}
      serverError={serverError}
    />
  );

interface StageDialogProps {
  readonly busy: boolean;
  readonly currentStage?: OpportunityStage | undefined;
  readonly description: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (stage: OpportunityStage, note: string | undefined) => void;
  readonly selectedStages?: readonly OpportunityStage[] | undefined;
  readonly serverError?: string | undefined;
  readonly showNote: boolean;
}

const stageOf = (value: string): OpportunityStage | '' => (isOpportunityStage(value) ? value : '');

/** The stage change: a stage the transition allows, and a note while one is asked for. */
const stageForm = FormReact.make(
  FormBuilder.empty
    .addField(
      'stage',
      Schema.String.check(
        Schema.makeFilter((value: string) => stageOf(value) !== '', { message: `${K}.stageDialog.stageRequired` }),
      ),
    )
    .addField(
      'note',
      Schema.String.check(
        Schema.makeFilter((value: string) => isValidNote(value.trim()), {
          message: `${K}.create.errors.noteTooLong`,
        }),
      ),
    ),
  {
    fields: { note: TextAreaField, stage: ChoiceField },
    onSubmit: (_submit, { decoded }) => Effect.succeed(decoded),
    runtime: browserAtomRuntime,
  },
);
const stageNote = stageForm.getFieldAtoms(stageForm.fields.note);
const openedStage = { note: '', stage: '' } satisfies typeof stageForm.schema.Encoded;

// A command, not a form: a stage change is a state transition with its own button, not an edit of stored fields.
/**
 * Change stage for one opportunity (with note) or for a bulk selection (stage only). Leaving with a typed note asks
 * first; closing without one leaves at once.
 */
export const StageDialog = ({
  busy,
  currentStage,
  description,
  onOpenChange,
  onSubmit,
  selectedStages,
  serverError,
  showNote,
}: StageDialogProps) => {
  const { t } = useModernI18n();
  const shown = Option.getOrElse(useAtomValue(stageForm.values), () => openedStage);
  const setNote = useAtomSet(stageNote.setValue);
  const formId = useId();
  const allowedStages = permittedStageTransitions(
    selectedStages ?? (currentStage === undefined ? opportunityStages : [currentStage]),
  );
  const items = allowedStages.map((candidate) => ({
    label: statusPresentation('opportunity', candidate).label,
    value: candidate,
  }));
  const noteText = shown.note.trim();
  const { dialog, guard } = useCommandInputGuard(showNote && noteText !== '', () => setNote(''));
  const close = () => guard.request(() => onOpenChange(false));

  // The form checked the stage and the note; the command takes an allowed stage only.
  useAtomSubscribe(
    stageForm.submit,
    (result) => {
      if (busy || !AsyncResult.isSuccess(result) || result.waiting) {
        return;
      }
      const stage = stageOf(result.value.stage);
      const note = result.value.note.trim();
      if (stage !== '' && allowedStages.includes(stage)) {
        onSubmit(stage, showNote && note !== '' ? note : undefined);
      }
    },
    { immediate: false },
  );

  return (
    <SidePanel
      actions={
        <>
          <Button appearance="outline" onClick={close} severity="secondary" type="button">
            {t(`${K}.stageDialog.cancel`)}
          </Button>
          <Button
            disabled={items.length === 0}
            form={formId}
            isLoading={busy}
            loadingText={t(`${K}.stageDialog.submitting`)}
            severity="primary"
            type="submit"
          >
            {t(`${K}.stageDialog.submit`)}
          </Button>
        </>
      }
      description={description}
      guard={guard}
      onOpenChange={(open) => {
        if (!open) {
          onOpenChange(false);
        }
      }}
      open
      resizeLabel={t(RESIZE_LABEL_KEY)}
      size="lg"
      title={t(`${K}.stageDialog.title`)}
    >
      <FormRoot
        className="flex flex-col gap-200 py-200"
        defaultValues={openedStage}
        form={stageForm}
        id={formId}
        translateMessage={(message) => t(message, { defaultValue: message })}
      >
        {serverError !== undefined && (
          <StatusText showIcon status="error">
            {serverError}
          </StatusText>
        )}
        {items.length === 0 && <StatusText status="warning">{t(`${K}.errors.closed`)}</StatusText>}
        <stageForm.stage
          items={items}
          label={<span className={formLabelClassName}>{t(`${K}.stageDialog.stage`)}</span>}
          placeholder={t(SELECT_PLACEHOLDER)}
        />
        {shown.stage === 'WON' && (
          <StatusText showIcon status="warning">
            {t(`${K}.stageDialog.wonWarning`)}
          </StatusText>
        )}
        {showNote && <stageForm.note autoComplete="off" id="stage-note" label={t(`${K}.stageDialog.note`)} rows={3} />}
      </FormRoot>
      {dialog}
    </SidePanel>
  );
};

interface OwnerDialogProps {
  readonly busy: boolean;
  readonly currentOwner?: EmployeeId | undefined;
  readonly description: string;
  /** Active employees only. */
  readonly employees: readonly EmployeeOption[];
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (owner: EmployeeId | null) => void;
  readonly serverError?: string | undefined;
}

/** The owner to assign; `NONE` clears it. */
const ownerForm = FormReact.make(FormBuilder.empty.addField('owner', Schema.String), {
  fields: { owner: ChoiceField },
  onSubmit: (_submit, { decoded }) => Effect.succeed(decoded.owner),
  runtime: browserAtomRuntime,
});

// A command, not a form: the owner action reassigns from one pick, with nothing typed that a draft would keep.
/** Assign or clear the owner (`Nepřiřazeno` clears it). */
export const OwnerDialog = ({
  busy,
  currentOwner,
  description,
  employees,
  onOpenChange,
  onSubmit,
  serverError,
}: OwnerDialogProps) => {
  const { t } = useModernI18n();
  const formId = useId();
  const items = [
    { label: t(`${K}.owner.none`), value: NONE },
    ...employees.map((employee) => ({ label: employee.fullName, value: employee.id })),
  ];
  useAtomSubscribe(
    ownerForm.submit,
    (result) => {
      if (busy || !AsyncResult.isSuccess(result) || result.waiting) {
        return;
      }
      const owner = result.value;
      onSubmit(owner === NONE || owner === '' ? null : (employees.find((item) => item.id === owner)?.id ?? null));
    },
    { immediate: false },
  );

  return (
    <SidePanel
      actions={
        <>
          <Button appearance="outline" onClick={() => onOpenChange(false)} severity="secondary" type="button">
            {t(`${K}.owner.cancel`)}
          </Button>
          <Button
            form={formId}
            isLoading={busy}
            loadingText={t(`${K}.owner.submitting`)}
            severity="primary"
            type="submit"
          >
            {t(`${K}.owner.submit`)}
          </Button>
        </>
      }
      description={description}
      onOpenChange={onOpenChange}
      open
      resizeLabel={t(RESIZE_LABEL_KEY)}
      size="lg"
      title={t(`${K}.owner.title`)}
    >
      <FormRoot
        className="flex flex-col gap-200 py-200"
        defaultValues={{ owner: currentOwner ?? NONE }}
        form={ownerForm}
        id={formId}
        translateMessage={(message) => t(message, { defaultValue: message })}
      >
        {serverError !== undefined && (
          <StatusText showIcon status="error">
            {serverError}
          </StatusText>
        )}
        <ownerForm.owner
          items={items}
          label={<span className={formLabelClassName}>{t(`${K}.owner.label`)}</span>}
          placeholder={t(SELECT_PLACEHOLDER)}
        />
      </FormRoot>
    </SidePanel>
  );
};
