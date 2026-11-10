import { CalendarDateSchema } from '@app/shared-contracts';
import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  formatNumber,
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
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { Effect, Option, Predicate, Schema } from 'effect';
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
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import {
  draftFrom,
  emptyDraft,
  opportunityUnchangedSince,
  sameOpportunityDraft,
  updateCommandOf,
} from './opportunity-draft.ts';
import type { FormDraft, UpdateCommand } from './opportunity-draft.ts';
import type { CustomerOption, EmployeeOption, LoadState, ProductOption } from './pipeline-references.ts';

const RESIZE_LABEL_KEY = 'sales-pipeline.sidePanel.resize';

const SELECT_PLACEHOLDER = 'sales-pipeline.selectPlaceholder';

const K = 'sales-pipeline.pages.records';
const NONE = '__none__';
const isValidTitle = Schema.is(OpportunityTitleSchema);
const isValidNote = Schema.is(OpportunityNoteSchema);

export type CreateCommand = Extract<PipelineCommand, { _tag: 'CreateOpportunity' }>;

type Translate = ReturnType<typeof useModernI18n>['t'];

const statusOf = (message: string | undefined) => (message === undefined ? 'default' : 'error');

/** ui-kit's Select label takes no size, so it is set here to match the FormInput and Combobox labels. */
const formLabelProps = { className: 'text-label-md' } as const;

interface FormErrors {
  readonly close: string | undefined;
  readonly customer: string | undefined;
  /** A line quantity field holds an invalid value; the line itself shows the message. */
  readonly lines: string | undefined;
  readonly note: string | undefined;
  readonly title: string | undefined;
}

const formErrors = (draft: FormDraft, t: Translate): FormErrors => {
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
    close: Option.isNone(Schema.decodeOption(CalendarDateSchema)(draft.closeText))
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

const hasFormErrors = (errors: FormErrors) => Object.values(errors).some((error) => error !== undefined);

const customerLabel = (customer: CustomerOption, unknownName: string): string => {
  const name = customer.name ?? unknownName;
  return customer.companyId === null ? name : `${name} (IČO ${customer.companyId})`;
};

interface OpportunityReferences {
  readonly customers: LoadState<readonly CustomerOption[]>;
  readonly employees: LoadState<readonly EmployeeOption[]>;
  readonly products: LoadState<readonly ProductOption[]>;
}

/** The fields of one opportunity, shared by the create panel and the autosaving edit panel. */
const OpportunityFields = ({
  customers,
  draft,
  employees,
  isEdit,
  onChange,
  products,
  showErrors,
}: OpportunityReferences & {
  readonly draft: FormDraft;
  readonly isEdit: boolean;
  readonly onChange: (patch: Partial<FormDraft>) => void;
  /** Inline field errors show after the first create attempt and always while editing. */
  readonly showErrors: boolean;
}) => {
  const { t } = useModernI18n();
  const [customerQuery, setCustomerQuery] = useState('');
  const errors = formErrors(draft, t);
  const visible = (message: string | undefined) => (showErrors ? message : undefined);
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

  return (
    <>
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
          onChange({ customerId: next === undefined || next === '' ? null : next });
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
        onChange={(event) => onChange({ title: event.target.value })}
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
            onChange({ ownerId: next === undefined || next === NONE ? null : next });
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
        onChange={(event) => onChange({ closeText: event.target.value })}
        required
        type="date"
        validateStatus={statusOf(visible(errors.close))}
        value={draft.closeText}
      />
      <FormTextarea
        autoComplete="off"
        helpText={visible(errors.note)}
        id="opportunity-note"
        label={t(`${K}.create.fields.note`)}
        name="note"
        onChange={(event) => onChange({ note: event.target.value })}
        rows={3}
        validateStatus={statusOf(visible(errors.note))}
        value={draft.note}
      />
      <LinesEditor lines={draft.lines} onChange={(lines) => onChange({ lines })} products={products} />
    </>
  );
};

/** The scrolling form inside a panel. The small inline padding keeps focus rings from being clipped by its edge. */
const formClassName = '-mx-100 flex min-h-0 flex-1 flex-col gap-200 overflow-y-auto px-100 py-200';

interface CreatePanelProps extends OpportunityReferences {
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (command: CreateCommand) => void;
  readonly serverError?: string | undefined;
}

/** Create an opportunity; the owner is chosen here. Closing a dirty form asks before it drops the draft. */
const OpportunityCreatePanel = ({ busy, onOpenChange, onSubmit, serverError, ...references }: CreatePanelProps) => {
  const { t } = useModernI18n();
  const [draft, setDraft] = useState<FormDraft>(emptyDraft);
  const [submitted, setSubmitted] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  /** Bumped on a rejected submit, so the first invalid field takes focus. */
  const [invalidAttempt, setInvalidAttempt] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const formId = useId();
  const errors = formErrors(draft, t);
  const handleChange = (next: Partial<FormDraft>) => setDraft((current) => ({ ...current, ...next }));
  const requestClose = (open: boolean) => {
    if (open) {
      return;
    }
    if (!sameOpportunityDraft(draft, emptyDraft)) {
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

  const submit = () => {
    // Enter in a field submits the form even while the save button shows its spinner.
    if (busy) {
      return;
    }
    setSubmitted(true);
    const partyOption =
      draft.customerId === null ? Option.none() : Schema.decodeOption(PartyIdSchema)(draft.customerId);
    const dateOption = Schema.decodeOption(CalendarDateSchema)(draft.closeText);
    if (hasFormErrors(errors) || Option.isNone(partyOption) || Option.isNone(dateOption)) {
      setInvalidAttempt((count) => count + 1);
      return;
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
            {/* Submits the form below, so Enter in a text field creates the opportunity too. */}
            <Button
              form={formId}
              isLoading={busy}
              loadingText={t(`${K}.create.submitting`)}
              type="submit"
              variant="primary"
            >
              {t(`${K}.create.submit`)}
            </Button>
          </>
        }
        description={t(`${K}.create.description`)}
        onOpenChange={requestClose}
        open
        resizeLabel={t(RESIZE_LABEL_KEY)}
        size="xl"
        title={t(`${K}.create.title`)}
      >
        {/* The form scrolls on its own, so the footer with Zrušit and the submit button stays at the panel bottom. */}
        <form
          className={formClassName}
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
          <OpportunityFields
            {...references}
            draft={draft}
            isEdit={false}
            onChange={handleChange}
            showErrors={submitted}
          />
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
          onSubmit={(event) => {
            event.preventDefault();
            record.save();
          }}
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
  readonly busy: boolean;
  /** Present for edit; absent for create. */
  readonly initial?: Opportunity | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: OpportunitySave;
  readonly onSubmit: (command: CreateCommand) => void;
  /** Revision of the records the edited opportunity comes from. */
  readonly revision: number;
  readonly serverError?: string | undefined;
}

/** Create an opportunity, or edit one with an explicit Uložit. */
export const OpportunityFormDialog = ({
  busy,
  initial,
  onSave,
  onSubmit,
  revision,
  ...rest
}: OpportunityFormDialogProps) =>
  initial === undefined ? (
    <OpportunityCreatePanel {...rest} busy={busy} onSubmit={onSubmit} />
  ) : (
    <OpportunityEditPanel {...rest} onSave={onSave} opportunity={initial} revision={revision} />
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
