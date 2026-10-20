import { CalendarDateSchema } from '@app/shared-contracts';
import { SidePanel, formatNumber, statusPresentation } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { Option, Schema } from 'effect';
import { useEffect, useId, useRef, useState } from 'react';
import { OpportunityNoteSchema, OpportunityTitleSchema } from '../../../../../shared/model/opportunity.ts';
import type { Opportunity } from '../../../../../shared/model/opportunity.ts';
import {
  EmployeeIdSchema,
  PartyIdSchema,
} from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import type { PipelineCommand } from './pipeline-api.ts';
import {
  MAX_LINE_QUANTITY,
  isSafeOpportunityAmount,
  filterItemsByQuery,
  firstValue,
  isOpportunityStage,
  opportunityStages,
  permittedStageTransitions,
} from './pipeline-model.ts';
import type { EmployeeId, OpportunityStage } from './pipeline-model.ts';
import { PickerCombobox } from './pipeline-combobox.tsx';
import { LinesEditor } from './pipeline-line-editor.tsx';
import type { LineEntry } from './pipeline-line-editor.tsx';
import type { CustomerOption, EmployeeOption, LoadState, ProductOption } from './pipeline-references.ts';

const RESIZE_LABEL_KEY = 'sales-pipeline.sidePanel.resize';

const SELECT_PLACEHOLDER = 'sales-pipeline.selectPlaceholder';

const K = 'sales-pipeline.pages.records';
const NONE = '__none__';
const isValidTitle = Schema.is(OpportunityTitleSchema);
const isValidNote = Schema.is(OpportunityNoteSchema);

export type CreateCommand = Extract<PipelineCommand, { _tag: 'CreateOpportunity' }>;
export type UpdateCommand = Extract<PipelineCommand, { _tag: 'UpdateOpportunity' }>;
export type FormCommand = CreateCommand | UpdateCommand;

type Translate = ReturnType<typeof useModernI18n>['t'];

const statusOf = (message: string | undefined) => (message === undefined ? 'default' : 'error');

/** ui-kit's Select label takes no size, so it is set here to match the FormInput and Combobox labels. */
const formLabelProps = { className: 'text-label-md' } as const;

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
  /** A line quantity field holds an invalid value; the line itself shows the message. */
  readonly lines: string | undefined;
  readonly note: string | undefined;
  readonly title: string | undefined;
}

const formErrors = (draft: FormDraft, closeText: string, t: Translate): FormErrors => {
  let lines: string | undefined;
  if (
    draft.lines.some((entry) => entry.invalidAmount === true) ||
    !isSafeOpportunityAmount(draft.lines.map((entry) => entry.line))
  ) {
    lines = t(`${K}.create.errors.amountRange`);
  } else if (draft.lines.some((entry) => entry.invalidQuantity !== undefined)) {
    lines = t(`${K}.create.errors.quantityRange`, { max: formatNumber(MAX_LINE_QUANTITY) });
  }
  return {
    close: Option.isNone(Schema.decodeOption(CalendarDateSchema)(closeText))
      ? t(`${K}.create.errors.dateRequired`)
      : undefined,
    customer:
      draft.customerId === null || Option.isNone(Schema.decodeOption(PartyIdSchema)(draft.customerId))
        ? t(`${K}.create.errors.customerRequired`)
        : undefined,
    lines,
    note: isValidNote(draft.note.trim()) ? undefined : t(`${K}.create.errors.noteTooLong`),
    title: isValidTitle(draft.title.trim()) ? undefined : t(`${K}.create.errors.titleRequired`),
  };
};

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
  const [customerQuery, setCustomerQuery] = useState('');
  /** Set on the first edit. A dirty form asks before Escape, the close button or Zrušit drops the draft. */
  const dirty = useRef(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  /** Bumped on a rejected submit, so the first invalid field takes focus. */
  const [invalidAttempt, setInvalidAttempt] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const formId = useId();

  const errors = formErrors(draft, closeText, t);
  const visible = (message: string | undefined) => (submitted ? message : undefined);
  const patch = (next: Partial<FormDraft>) => {
    dirty.current = true;
    setDraft((current) => ({ ...current, ...next }));
  };
  const requestClose = (open: boolean) => {
    if (open) {
      return;
    }
    if (dirty.current) {
      setDiscardOpen(true);
      return;
    }
    onOpenChange(false);
  };
  useEffect(() => {
    if (invalidAttempt > 0) {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    }
  }, [invalidAttempt]);
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

  // The list filters on the typed text here, not inside Combobox, so it always follows the input.
  const shownCustomerItems = filterItemsByQuery(
    customerItems,
    customerQuery,
    customerItems.find((item) => item.value === draft.customerId)?.label,
  );

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
    // Enter in a field submits the form even while the save button shows its spinner.
    if (busy) {
      return;
    }
    setSubmitted(true);
    const partyOption =
      draft.customerId === null ? Option.none() : Schema.decodeOption(PartyIdSchema)(draft.customerId);
    const dateOption = Schema.decodeOption(CalendarDateSchema)(closeText);
    if (Object.values(errors).some((error) => error !== undefined)) {
      setInvalidAttempt((count) => count + 1);
      return;
    }
    if (Option.isNone(partyOption) || Option.isNone(dateOption)) {
      setInvalidAttempt((count) => count + 1);
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
    <>
      <SidePanel
        actions={
          <>
            <Button onClick={() => requestClose(false)} theme="outlined" type="button" variant="secondary">
              {t(`${K}.create.cancel`)}
            </Button>
            {/* Submits the form below, so Enter in a text field saves the opportunity too. */}
            <Button
              form={formId}
              isLoading={busy}
              loadingText={t(`${K}.create.submitting`)}
              type="submit"
              variant="primary"
            >
              {isEdit ? t(`${K}.edit.submit`) : t(`${K}.create.submit`)}
            </Button>
          </>
        }
        // The form holds unsaved input, and the date control opens a picker layered outside the drawer. A stray
        // pointer or focus move outside must not discard the draft; Escape, the close button and Zrušit still close.
        closeOnInteractOutside={false}
        description={isEdit ? t(`${K}.edit.description`) : t(`${K}.create.description`)}
        onOpenChange={requestClose}
        open
        resizeLabel={t(RESIZE_LABEL_KEY)}
        size="xl"
        title={isEdit ? t(`${K}.edit.title`) : t(`${K}.create.title`)}
      >
        {/* The form scrolls on its own, so the footer with Zrušit and the submit button stays at the panel bottom.
            The small inline padding keeps focus rings from being clipped by the scroll edge. */}
        <form
          className="-mx-100 flex min-h-0 flex-1 flex-col gap-200 overflow-y-auto px-100 py-200"
          id={formId}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          ref={formRef}
        >
          {serverError !== undefined && (
            <StatusText showIcon status="error">
              {serverError}
            </StatusText>
          )}
          <PickerCombobox
            error={customers.status === 'error' ? t(`${K}.create.customersFailed`) : undefined}
            filterBehavior="external"
            helpText={visible(errors.customer) ?? ''}
            items={shownCustomerItems}
            label={t(`${K}.create.fields.customer`)}
            loading={customers.status === 'loading'}
            loadingMessage={t('sales-pipeline.loading')}
            name="partyId"
            noResultsMessage={t(`${K}.create.noCustomerMatch`)}
            onChange={(values) => {
              const next = firstValue(values);
              patch({ customerId: next === undefined || next === '' ? null : next });
            }}
            onInputValueChange={setCustomerQuery}
            placeholder={t(`${K}.create.customerPlaceholder`)}
            required
            validateStatus={statusOf(visible(errors.customer))}
            value={draft.customerId === null ? [] : [draft.customerId]}
          />
          <FormInput
            autoComplete="off"
            helpText={visible(errors.title)}
            id="opportunity-title"
            label={t(`${K}.create.fields.title`)}
            name="title"
            onChange={(event) => patch({ title: event.target.value })}
            required
            validateStatus={statusOf(visible(errors.title))}
            value={draft.title}
          />
          {/* A Select, like the Obchodník filter, so a click anywhere on the field opens the list. */}
          <div className="flex flex-col gap-50">
            <SelectTemplate
              disabled={isEdit}
              items={ownerItems}
              label={t(`${K}.create.fields.assignee`)}
              labelProps={formLabelProps}
              name="ownerEmployeeId"
              onValueChange={({ value: [next] }) => {
                patch({ ownerId: next === undefined || next === NONE ? null : next });
              }}
              placeholder={t(SELECT_PLACEHOLDER)}
              size="md"
              value={[draft.ownerId ?? NONE]}
            />
            {isEdit && <p className="text-fg-secondary text-xs">{t(`${K}.create.ownerEditHint`)}</p>}
          </div>
          <FormInput
            helpText={visible(errors.close)}
            id="opportunity-close-date"
            label={t(`${K}.create.fields.expectedClose`)}
            name="expectedCloseDate"
            onChange={(event) => {
              dirty.current = true;
              setCloseText(event.target.value);
            }}
            required
            type="date"
            validateStatus={statusOf(visible(errors.close))}
            value={closeText}
          />
          <FormTextarea
            autoComplete="off"
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
      </SidePanel>
      <Dialog
        actions={
          <>
            <Button onClick={() => setDiscardOpen(false)} theme="outlined" type="button" variant="secondary">
              {t(`${K}.create.discard.keep`)}
            </Button>
            <Button onClick={() => onOpenChange(false)} type="button" variant="danger">
              {t(`${K}.create.discard.confirm`)}
            </Button>
          </>
        }
        customTrigger
        description={t(`${K}.create.discard.description`)}
        hideCloseButton
        onOpenChange={(details) => setDiscardOpen(details.open)}
        open={discardOpen}
        role="alertdialog"
        size="sm"
        title={t(`${K}.create.discard.title`)}
      />
    </>
  );
};

interface StageDialogProps {
  readonly busy: boolean;
  readonly currentStage?: OpportunityStage | undefined;
  readonly selectedStages?: readonly OpportunityStage[] | undefined;
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
  selectedStages,
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
      closeOnInteractOutside={false}
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
      closeOnInteractOutside={false}
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
