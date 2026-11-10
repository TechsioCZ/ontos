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
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { Effect, Option, Predicate } from 'effect';
import { useEffect, useId, useRef, useState } from 'react';
import type { Opportunity } from '../../../../../shared/model/opportunity.ts';
import { isOpportunityStage, opportunityStages, permittedStageTransitions } from './pipeline-model.ts';
import type { EmployeeId, OpportunityStage } from './pipeline-model.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { draftFrom, opportunityUnchangedSince, sameOpportunityDraft, updateCommandOf } from './opportunity-draft.ts';
import type { FormDraft, UpdateCommand } from './opportunity-draft.ts';
import type { EmployeeOption } from './pipeline-references.ts';
import { OpportunityCreatePanel } from './opportunity-create-panel.tsx';
import type { OpportunityCreate } from './opportunity-create-panel.tsx';
import {
  K,
  NONE,
  OpportunityFields,
  RESIZE_LABEL_KEY,
  SELECT_PLACEHOLDER,
  formClassName,
  formLabelProps,
  isValidNote,
  statusOf,
} from './opportunity-fields.tsx';
import type { OpportunityReferences } from './opportunity-fields.tsx';

export type { CreateCommand } from './opportunity-fields.tsx';

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
  const handleChange = (next: Partial<FormDraft>) => record.setDraft((current) => ({ ...current, ...next }));
  const handleReloadLatest = record.reloadLatest;
  const handleSave = record.save;
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
        <form
          className={formClassName}
          noValidate
          // Enter never saves the edit: only Uložit does.
          onSubmit={(event) => event.preventDefault()}
        >
          {serverError !== undefined && (
            <StatusText showIcon status="error">
              {serverError}
            </StatusText>
          )}
          <OpportunityFields {...references} draft={record.draft} isEdit onChange={handleChange} showErrors />
        </form>
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

/** Change stage for one opportunity (with note) or for a bulk selection (stage only). */
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
  const [stage, setStage] = useState<OpportunityStage | ''>('');
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const formId = useId();
  const allowedStages = permittedStageTransitions(
    selectedStages ?? (currentStage === undefined ? opportunityStages : [currentStage]),
  );
  const items = allowedStages.map((candidate) => ({
    label: statusPresentation('opportunity', candidate).label,
    value: candidate,
  }));
  const noteText = note.trim();
  const noteError = isValidNote(noteText) ? undefined : t(`${K}.create.errors.noteTooLong`);

  const submit = () => {
    if (busy) {
      return;
    }
    setSubmitted(true);
    if (stage === '' || !allowedStages.includes(stage) || noteError !== undefined) {
      return;
    }
    onSubmit(stage, showNote && noteText !== '' ? noteText : undefined);
  };

  return (
    <SidePanel
      actions={
        <>
          <Button onClick={() => onOpenChange(false)} theme="outlined" type="button" variant="secondary">
            {t(`${K}.stageDialog.cancel`)}
          </Button>
          <Button
            disabled={items.length === 0}
            form={formId}
            isLoading={busy}
            loadingText={t(`${K}.stageDialog.submitting`)}
            type="submit"
            variant="primary"
          >
            {t(`${K}.stageDialog.submit`)}
          </Button>
        </>
      }
      description={description}
      onOpenChange={onOpenChange}
      open
      resizeLabel={t(RESIZE_LABEL_KEY)}
      size="lg"
      title={t(`${K}.stageDialog.title`)}
    >
      <form
        className="flex flex-col gap-200 py-200"
        id={formId}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {serverError !== undefined && (
          <StatusText showIcon status="error">
            {serverError}
          </StatusText>
        )}
        {items.length === 0 && <StatusText status="warning">{t(`${K}.errors.closed`)}</StatusText>}
        <SelectTemplate
          items={items}
          label={t(`${K}.stageDialog.stage`)}
          labelProps={formLabelProps}
          name="stage"
          onValueChange={(details) => {
            const [next] = details.value;
            setStage(isOpportunityStage(next) ? next : '');
          }}
          placeholder={t(SELECT_PLACEHOLDER)}
          size="md"
          value={stage === '' ? [] : [stage]}
        />
        {submitted && stage === '' && (
          <StatusText showIcon status="error">
            {t(`${K}.stageDialog.stageRequired`)}
          </StatusText>
        )}
        {stage === 'WON' && (
          <StatusText showIcon status="warning">
            {t(`${K}.stageDialog.wonWarning`)}
          </StatusText>
        )}
        {showNote && (
          <FormTextarea
            autoComplete="off"
            helpText={submitted ? noteError : undefined}
            id="stage-note"
            label={t(`${K}.stageDialog.note`)}
            name="note"
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            validateStatus={statusOf(submitted ? noteError : undefined)}
            value={note}
          />
        )}
      </form>
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
  const [owner, setOwner] = useState<string>(currentOwner ?? NONE);
  const formId = useId();
  const items = [
    { label: t(`${K}.owner.none`), value: NONE },
    ...employees.map((employee) => ({ label: employee.fullName, value: employee.id })),
  ];
  const submit = () => {
    if (busy) {
      return;
    }
    if (owner === NONE) {
      onSubmit(null);
      return;
    }
    onSubmit(employees.find((item) => item.id === owner)?.id ?? null);
  };

  return (
    <SidePanel
      actions={
        <>
          <Button onClick={() => onOpenChange(false)} theme="outlined" type="button" variant="secondary">
            {t(`${K}.owner.cancel`)}
          </Button>
          <Button
            form={formId}
            isLoading={busy}
            loadingText={t(`${K}.owner.submitting`)}
            type="submit"
            variant="primary"
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
      <form
        className="flex flex-col gap-200 py-200"
        id={formId}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {serverError !== undefined && (
          <StatusText showIcon status="error">
            {serverError}
          </StatusText>
        )}
        <SelectTemplate
          items={items}
          label={t(`${K}.owner.label`)}
          labelProps={formLabelProps}
          name="owner"
          onValueChange={(details) => {
            const [next] = details.value;
            setOwner(next ?? NONE);
          }}
          placeholder={t(SELECT_PLACEHOLDER)}
          size="md"
          value={[owner]}
        />
      </form>
    </SidePanel>
  );
};
