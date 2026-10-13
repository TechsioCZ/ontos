import { CalendarDateSchema } from '@app/shared-contracts';
import { statusPresentation } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { Option, Schema } from 'effect';
import { useState } from 'react';
import { OpportunityNoteSchema, OpportunityTitleSchema } from '../../../../../shared/model/opportunity.ts';
import type { Opportunity } from '../../../../../shared/model/opportunity.ts';
import {
  EmployeeIdSchema,
  PartyIdSchema,
} from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import type { PipelineCommand } from './pipeline-api.ts';
import { firstValue, isOpportunityStage, opportunityStages } from './pipeline-model.ts';
import type { EmployeeId, OpportunityStage } from './pipeline-model.ts';
import { LinesEditor } from './pipeline-line-editor.tsx';
import type { LineEntry } from './pipeline-line-editor.tsx';
import type { CustomerOption, EmployeeOption, LoadState, ProductOption } from './pipeline-references.ts';

const K = 'sales-pipeline.pages.records';
const NONE = '__none__';
const isValidTitle = Schema.is(OpportunityTitleSchema);
const isValidNote = Schema.is(OpportunityNoteSchema);

export type CreateCommand = Extract<PipelineCommand, { _tag: 'CreateOpportunity' }>;
export type UpdateCommand = Extract<PipelineCommand, { _tag: 'UpdateOpportunity' }>;
export type FormCommand = CreateCommand | UpdateCommand;

type Translate = ReturnType<typeof useModernI18n>['t'];

const statusOf = (message: string | undefined) => (message === undefined ? 'default' : 'error');

interface FormDraft {
  readonly customerId: string | null;
  readonly lines: readonly LineEntry[];
  readonly note: string;
  readonly ownerId: string | null;
  readonly title: string;
}

interface FormErrors {
  readonly close: string | undefined;
  readonly customer: string | undefined;
  readonly note: string | undefined;
  readonly title: string | undefined;
}

const formErrors = (draft: FormDraft, closeText: string, t: Translate): FormErrors => ({
  close: Option.isNone(Schema.decodeOption(CalendarDateSchema)(closeText))
    ? t(`${K}.create.errors.dateRequired`)
    : undefined,
  customer:
    draft.customerId === null || Option.isNone(Schema.decodeOption(PartyIdSchema)(draft.customerId))
      ? t(`${K}.create.errors.customerRequired`)
      : undefined,
  note: isValidNote(draft.note.trim()) ? undefined : t(`${K}.create.errors.noteTooLong`),
  title: isValidTitle(draft.title.trim()) ? undefined : t(`${K}.create.errors.titleRequired`),
});

const emptyDraft: FormDraft = { customerId: null, lines: [], note: '', ownerId: null, title: '' };

const draftFrom = (opportunity: Opportunity): FormDraft => ({
  customerId: opportunity.partyId,
  lines: opportunity.lines.map((line, index) => ({ key: `init-${index}`, line })),
  note: opportunity.note ?? '',
  ownerId: opportunity.ownerEmployeeId ?? null,
  title: opportunity.title,
});

const customerLabel = (customer: CustomerOption, unknownName: string): string => {
  const name = customer.name ?? unknownName;
  return customer.companyId === null ? name : `${name} (IČO ${customer.companyId})`;
};

interface OpportunityFormDialogProps {
  readonly busy: boolean;
  readonly customers: LoadState<readonly CustomerOption[]>;
  readonly employees: LoadState<readonly EmployeeOption[]>;
  /** Present for edit; absent for create. */
  readonly initial?: Opportunity | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (command: FormCommand) => void;
  readonly products: LoadState<readonly ProductOption[]>;
  readonly serverError?: string | undefined;
}

/** Create or edit an opportunity. The owner is set on create; on edit it changes through the owner action. */
export const OpportunityFormDialog = ({
  busy,
  customers,
  employees,
  initial,
  onOpenChange,
  onSubmit,
  products,
  serverError,
}: OpportunityFormDialogProps) => {
  const { t } = useModernI18n();
  const isEdit = initial !== undefined;
  const [draft, setDraft] = useState<FormDraft>(() => (initial === undefined ? emptyDraft : draftFrom(initial)));
  /** Calendar date as typed; decoded to a CalendarDate only on submit. */
  const [closeText, setCloseText] = useState<string>(() => initial?.expectedCloseDate ?? '');
  const [submitted, setSubmitted] = useState(false);

  const errors = formErrors(draft, closeText, t);
  const visible = (message: string | undefined) => (submitted ? message : undefined);
  const patch = (next: Partial<FormDraft>) => setDraft((current) => ({ ...current, ...next }));
  const unknownCustomer = t(`${K}.create.unknownCustomer`);
  const unknownOwner = t(`${K}.unknownOwner`);

  const customerItems =
    customers.status === 'ready'
      ? customers.items.flatMap((customer) =>
          customer.archived && customer.id !== draft.customerId
            ? []
            : [{ id: customer.id, label: customerLabel(customer, unknownCustomer), value: customer.id }],
        )
      : [];

  const ownerItems = [
    { label: t(`${K}.owner.none`), value: NONE },
    ...(employees.status === 'ready'
      ? employees.items.flatMap((employee) =>
          employee.active || employee.id === draft.ownerId
            ? [{ label: employee.fullName || unknownOwner, value: employee.id }]
            : [],
        )
      : []),
  ];

  const submit = () => {
    setSubmitted(true);
    const partyOption =
      draft.customerId === null ? Option.none() : Schema.decodeOption(PartyIdSchema)(draft.customerId);
    const dateOption = Schema.decodeOption(CalendarDateSchema)(closeText);
    if (Object.values(errors).some((error) => error !== undefined)) {
      return;
    }
    if (Option.isNone(partyOption) || Option.isNone(dateOption)) {
      return;
    }
    const title = draft.title.trim();
    const note = draft.note.trim();
    const lines = draft.lines.map((entry) => entry.line);
    if (initial !== undefined) {
      onSubmit({
        _tag: 'UpdateOpportunity',
        id: initial.id,
        patch: { expectedCloseDate: dateOption.value, lines, note, partyId: partyOption.value, title },
      });
      return;
    }
    const base: CreateCommand = {
      _tag: 'CreateOpportunity',
      expectedCloseDate: dateOption.value,
      lines,
      note,
      partyId: partyOption.value,
      title,
    };
    const owner = draft.ownerId === null ? Option.none() : Schema.decodeOption(EmployeeIdSchema)(draft.ownerId);
    onSubmit(Option.isSome(owner) ? { ...base, ownerEmployeeId: owner.value } : base);
  };

  return (
    <Dialog
      actions={
        <>
          <Button onClick={() => onOpenChange(false)} theme="outlined" variant="secondary">
            {t(`${K}.create.cancel`)}
          </Button>
          <Button isLoading={busy} loadingText={t(`${K}.create.submitting`)} onClick={submit} variant="primary">
            {isEdit ? t(`${K}.edit.submit`) : t(`${K}.create.submit`)}
          </Button>
        </>
      }
      customTrigger
      description={isEdit ? t(`${K}.edit.description`) : t(`${K}.create.description`)}
      onOpenChange={(details) => onOpenChange(details.open)}
      open
      placement="right"
      size="lg"
      title={isEdit ? t(`${K}.edit.title`) : t(`${K}.create.title`)}
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
        <Combobox
          error={customers.status === 'error' ? t(`${K}.create.customersFailed`) : undefined}
          helpText={visible(errors.customer) ?? ''}
          items={customerItems}
          label={t(`${K}.create.fields.customer`)}
          loading={customers.status === 'loading'}
          name="partyId"
          noResultsMessage={t(`${K}.create.noCustomerMatch`)}
          onChange={(values) => {
            const next = firstValue(values);
            patch({ customerId: next === undefined || next === '' ? null : next });
          }}
          placeholder={t(`${K}.create.customerPlaceholder`)}
          required
          validateStatus={statusOf(visible(errors.customer))}
          value={draft.customerId === null ? [] : [draft.customerId]}
        />
        <FormInput
          helpText={visible(errors.title)}
          id="opportunity-title"
          label={t(`${K}.create.fields.title`)}
          name="title"
          onChange={(event) => patch({ title: event.target.value })}
          required
          validateStatus={statusOf(visible(errors.title))}
          value={draft.title}
        />
        <Combobox
          disabled={isEdit}
          helpText={isEdit ? t(`${K}.create.ownerEditHint`) : ''}
          items={ownerItems}
          label={t(`${K}.create.fields.assignee`)}
          name="ownerEmployeeId"
          onChange={(values) => {
            const next = firstValue(values);
            patch({ ownerId: next === undefined || next === NONE ? null : next });
          }}
          value={[draft.ownerId ?? NONE]}
        />
        <FormInput
          helpText={visible(errors.close)}
          id="opportunity-close-date"
          label={t(`${K}.create.fields.expectedClose`)}
          name="expectedCloseDate"
          onChange={(event) => setCloseText(event.target.value)}
          required
          type="date"
          validateStatus={statusOf(visible(errors.close))}
          value={closeText}
        />
        <FormTextarea
          helpText={visible(errors.note)}
          id="opportunity-note"
          label={t(`${K}.create.fields.note`)}
          name="note"
          onChange={(event) => patch({ note: event.target.value })}
          rows={3}
          validateStatus={statusOf(visible(errors.note))}
          value={draft.note}
        />
        <LinesEditor lines={draft.lines} onChange={(lines) => patch({ lines })} products={products} />
      </form>
    </Dialog>
  );
};

interface StageDialogProps {
  readonly busy: boolean;
  readonly currentStage?: OpportunityStage | undefined;
  readonly description: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (stage: OpportunityStage, note: string | undefined) => void;
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
  serverError,
  showNote,
}: StageDialogProps) => {
  const { t } = useModernI18n();
  const [stage, setStage] = useState<OpportunityStage | ''>('');
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const items = opportunityStages.flatMap((candidate) =>
    candidate === currentStage ? [] : [{ label: statusPresentation('opportunity', candidate).label, value: candidate }],
  );
  const noteText = note.trim();
  const noteError = isValidNote(noteText) ? undefined : t(`${K}.create.errors.noteTooLong`);

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
            {t(`${K}.stageDialog.cancel`)}
          </Button>
          <Button isLoading={busy} loadingText={t(`${K}.stageDialog.submitting`)} onClick={submit} variant="primary">
            {t(`${K}.stageDialog.submit`)}
          </Button>
        </>
      }
      customTrigger
      description={description}
      onOpenChange={(details) => onOpenChange(details.open)}
      open
      placement="right"
      size="md"
      title={t(`${K}.stageDialog.title`)}
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
          label={t(`${K}.stageDialog.stage`)}
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
    </Dialog>
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
  const items = [
    { label: t(`${K}.owner.none`), value: NONE },
    ...employees.map((employee) => ({ label: employee.fullName, value: employee.id })),
  ];
  const submit = () => {
    if (owner === NONE) {
      onSubmit(null);
      return;
    }
    onSubmit(employees.find((item) => item.id === owner)?.id ?? null);
  };

  return (
    <Dialog
      actions={
        <>
          <Button onClick={() => onOpenChange(false)} theme="outlined" variant="secondary">
            {t(`${K}.owner.cancel`)}
          </Button>
          <Button isLoading={busy} loadingText={t(`${K}.owner.submitting`)} onClick={submit} variant="primary">
            {t(`${K}.owner.submit`)}
          </Button>
        </>
      }
      customTrigger
      description={description}
      onOpenChange={(details) => onOpenChange(details.open)}
      open
      placement="right"
      size="md"
      title={t(`${K}.owner.title`)}
    >
      <form className="flex flex-col gap-200 py-200" onSubmit={(event) => event.preventDefault()}>
        {serverError !== undefined && (
          <StatusText showIcon status="error">
            {serverError}
          </StatusText>
        )}
        <SelectTemplate
          items={items}
          label={t(`${K}.owner.label`)}
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
