import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { CalendarDateSchema } from '@app/shared-contracts';
import { Option, Schema } from 'effect';
import { useState } from 'react';
import { OpportunityNoteSchema, OpportunityTitleSchema } from '../../../../../shared/model/opportunity.ts';
import { PartyIdSchema } from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import type { PipelineCommand } from './pipeline-api.ts';
import type { EmployeeId, OpportunityStage } from './pipeline-model.ts';
import { employeeOptions, findEmployee, isOpportunityStage, opportunityStages } from './pipeline-model.ts';

const NONE = '__none__';
const isValidTitle = Schema.is(OpportunityTitleSchema);
const isValidNote = Schema.is(OpportunityNoteSchema);

export type CreateCommand = Extract<PipelineCommand, { _tag: 'CreateOpportunity' }>;

type Translate = (key: string) => string;

/** Raw form text; each field is validated by the schema that owns its domain type. */
const CreateDraftSchema = Schema.Struct({
  closeInput: Schema.String,
  note: Schema.String,
  partyInput: Schema.String,
  title: Schema.String,
});
type CreateDraft = typeof CreateDraftSchema.Type;

const createErrors = (draft: CreateDraft, t: Translate) => ({
  closeInput: Option.isNone(Schema.decodeOption(CalendarDateSchema)(draft.closeInput))
    ? t('sales-pipeline.pages.records.create.errors.dateRequired')
    : undefined,
  note: isValidNote(draft.note.trim()) ? undefined : t('sales-pipeline.pages.records.create.errors.noteTooLong'),
  partyInput: Option.isNone(Schema.decodeOption(PartyIdSchema)(draft.partyInput.trim()))
    ? t('sales-pipeline.pages.records.create.errors.customerInvalid')
    : undefined,
  title: isValidTitle(draft.title.trim()) ? undefined : t('sales-pipeline.pages.records.create.errors.titleRequired'),
});

const statusOf = (message: string | undefined) => (message === undefined ? 'default' : 'error');

interface CreateDialogProps {
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (command: CreateCommand) => void;
  serverError?: string | undefined;
}

/** Create opportunity. Lines stay empty until the product-line editor exists. */
export const CreateOpportunityDialog = ({ busy, onOpenChange, onSubmit, serverError }: CreateDialogProps) => {
  const { t } = useModernI18n();
  const [draft, setDraft] = useState<CreateDraft>({ closeInput: '', note: '', partyInput: '', title: '' });
  const [submitted, setSubmitted] = useState(false);
  const errors = createErrors(draft, t);
  const visible = (message: string | undefined) => (submitted ? message : undefined);
  const shown = {
    closeInput: visible(errors.closeInput),
    note: visible(errors.note),
    partyInput: visible(errors.partyInput),
    title: visible(errors.title),
  };
  const patch = (next: Partial<CreateDraft>) => setDraft((current) => ({ ...current, ...next }));

  const submit = () => {
    setSubmitted(true);
    const partyOption = Schema.decodeOption(PartyIdSchema)(draft.partyInput.trim());
    const dateOption = Schema.decodeOption(CalendarDateSchema)(draft.closeInput);
    if (Object.values(errors).some((error) => error !== undefined)) {
      return;
    }
    if (Option.isNone(partyOption) || Option.isNone(dateOption)) {
      return;
    }
    const noteText = draft.note.trim();
    const base: CreateCommand = {
      _tag: 'CreateOpportunity',
      expectedCloseDate: dateOption.value,
      lines: [],
      partyId: partyOption.value,
      title: draft.title.trim(),
    };
    onSubmit(noteText === '' ? base : { ...base, note: noteText });
  };

  return (
    <Dialog
      actions={
        <>
          <Button onClick={() => onOpenChange(false)} theme="outlined" variant="secondary">
            {t('sales-pipeline.pages.records.create.cancel')}
          </Button>
          <Button
            isLoading={busy}
            loadingText={t('sales-pipeline.pages.records.create.submitting')}
            onClick={submit}
            variant="primary"
          >
            {t('sales-pipeline.pages.records.create.submit')}
          </Button>
        </>
      }
      customTrigger
      description={t('sales-pipeline.pages.records.create.description')}
      onOpenChange={(details) => onOpenChange(details.open)}
      open
      placement="right"
      size="md"
      title={t('sales-pipeline.pages.records.create.title')}
    >
      <form
        className="flex flex-col gap-200 py-200"
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
        <FormInput
          helpText={shown.title}
          id="opportunity-title"
          label={t('sales-pipeline.pages.records.create.fields.title')}
          name="title"
          onChange={(event) => patch({ title: event.target.value })}
          required
          validateStatus={statusOf(shown.title)}
          value={draft.title}
        />
        <FormInput
          helpText={shown.partyInput ?? t('sales-pipeline.pages.records.create.customerHint')}
          id="opportunity-customer"
          label={t('sales-pipeline.pages.records.create.fields.customer')}
          name="partyId"
          onChange={(event) => patch({ partyInput: event.target.value })}
          required
          validateStatus={statusOf(shown.partyInput)}
          value={draft.partyInput}
        />
        <FormInput
          helpText={shown.closeInput}
          id="opportunity-close-date"
          label={t('sales-pipeline.pages.records.create.fields.expectedClose')}
          name="expectedCloseDate"
          onChange={(event) => patch({ closeInput: event.target.value })}
          required
          type="date"
          validateStatus={statusOf(shown.closeInput)}
          value={draft.closeInput}
        />
        <FormTextarea
          helpText={shown.note}
          id="opportunity-note"
          label={t('sales-pipeline.pages.records.create.fields.note')}
          name="note"
          onChange={(event) => patch({ note: event.target.value })}
          rows={4}
          validateStatus={statusOf(shown.note)}
          value={draft.note}
        />
      </form>
    </Dialog>
  );
};

interface StageDialogProps {
  busy: boolean;
  currentStage?: OpportunityStage | undefined;
  description: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (stage: OpportunityStage, note: string | undefined) => void;
  serverError?: string | undefined;
  showNote: boolean;
}

/** Change stage for one opportunity (with note) or for a bulk selection (stage only). */
export const StageDialog = ({
  busy,
  currentStage,
  description,
  onOpenChange,
  onSubmit,
  serverError,
  showNote,
}: StageDialogProps) => {
  const { t } = useModernI18n();
  const [stage, setStage] = useState<OpportunityStage | ''>('');
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const items = opportunityStages.flatMap((candidate) =>
    candidate === currentStage
      ? []
      : [{ label: t(`sales-pipeline.status.opportunity.${candidate}`), value: candidate }],
  );
  const noteText = note.trim();
  const noteError = isValidNote(noteText) ? undefined : t('sales-pipeline.pages.records.create.errors.noteTooLong');

  const submit = () => {
    setSubmitted(true);
    if (stage === '' || noteError !== undefined) {
      return;
    }
    onSubmit(stage, showNote && noteText !== '' ? noteText : undefined);
  };

  return (
    <Dialog
      actions={
        <>
          <Button onClick={() => onOpenChange(false)} theme="outlined" variant="secondary">
            {t('sales-pipeline.pages.records.stageDialog.cancel')}
          </Button>
          <Button
            isLoading={busy}
            loadingText={t('sales-pipeline.pages.records.stageDialog.submitting')}
            onClick={submit}
            variant="primary"
          >
            {t('sales-pipeline.pages.records.stageDialog.submit')}
          </Button>
        </>
      }
      customTrigger
      description={description}
      onOpenChange={(details) => onOpenChange(details.open)}
      open
      placement="right"
      size="md"
      title={t('sales-pipeline.pages.records.stageDialog.title')}
    >
      <form
        className="flex flex-col gap-200 py-200"
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
          label={t('sales-pipeline.pages.records.stageDialog.stage')}
          name="stage"
          onValueChange={(details) => {
            const [next] = details.value;
            setStage(isOpportunityStage(next) ? next : '');
          }}
          size="md"
          value={stage === '' ? [] : [stage]}
        />
        {submitted && stage === '' && (
          <StatusText showIcon status="error">
            {t('sales-pipeline.pages.records.stageDialog.stageRequired')}
          </StatusText>
        )}
        {stage === 'WON' && (
          <StatusText showIcon status="warning">
            {t('sales-pipeline.pages.records.stageDialog.wonWarning')}
          </StatusText>
        )}
        {showNote && (
          <FormTextarea
            helpText={submitted ? noteError : undefined}
            id="stage-note"
            label={t('sales-pipeline.pages.records.stageDialog.note')}
            name="note"
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            validateStatus={statusOf(submitted ? noteError : undefined)}
            value={note}
          />
        )}
      </form>
    </Dialog>
  );
};

interface OwnerDialogProps {
  busy: boolean;
  currentOwner?: EmployeeId | undefined;
  description: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (owner: EmployeeId | null) => void;
  serverError?: string | undefined;
}

/** Assign or clear the owner (`Nepřiřazeno` clears it). */
export const OwnerDialog = ({
  busy,
  currentOwner,
  description,
  onOpenChange,
  onSubmit,
  serverError,
}: OwnerDialogProps) => {
  const { t } = useModernI18n();
  const [owner, setOwner] = useState<string>(currentOwner ?? NONE);
  const items = [
    { label: t('sales-pipeline.pages.records.owner.none'), value: NONE },
    ...employeeOptions().map((employee) => ({ label: employee.fullName, value: employee.id })),
  ];

  return (
    <Dialog
      actions={
        <>
          <Button onClick={() => onOpenChange(false)} theme="outlined" variant="secondary">
            {t('sales-pipeline.pages.records.owner.cancel')}
          </Button>
          <Button
            isLoading={busy}
            loadingText={t('sales-pipeline.pages.records.owner.submitting')}
            onClick={() => onSubmit(owner === NONE ? null : findEmployee(owner))}
            variant="primary"
          >
            {t('sales-pipeline.pages.records.owner.submit')}
          </Button>
        </>
      }
      customTrigger
      description={description}
      onOpenChange={(details) => onOpenChange(details.open)}
      open
      placement="right"
      size="md"
      title={t('sales-pipeline.pages.records.owner.title')}
    >
      <form className="flex flex-col gap-200 py-200" onSubmit={(event) => event.preventDefault()}>
        {serverError !== undefined && (
          <StatusText showIcon status="error">
            {serverError}
          </StatusText>
        )}
        <SelectTemplate
          items={items}
          label={t('sales-pipeline.pages.records.owner.label')}
          name="owner"
          onValueChange={(details) => {
            const [next] = details.value;
            setOwner(next ?? NONE);
          }}
          size="md"
          value={[owner]}
        />
      </form>
    </Dialog>
  );
};
