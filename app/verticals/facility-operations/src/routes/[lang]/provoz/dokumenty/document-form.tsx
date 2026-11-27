import { browserAtomRuntime, browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// Create / edit / amendment form for the documents agenda (S12). Upload goes through the governed FileUpload command
// first; the returned file snapshot becomes version 1 of the new document.
import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  requiredLabelFor,
  saveLabelsFor,
  surfaceTileClassName,
  useDraftSave,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import {
  ChoiceField,
  FileField,
  FormBuilder,
  FormReact,
  FormRoot,
  RuledTextField,
  TemplateChoiceField,
  TextAreaField,
  TextField,
  useAtomSet,
  useAtomSubscribe,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect, Option, Result, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import { useRef, useState } from 'react';
import { OpsCommandSchema } from '../../../../../shared/agendas.ts';
import { optionalField } from '../../../../../shared/domain/common.ts';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type {
  ContractStatus,
  DocumentRecord,
  SubjectRef,
  StoredFileRef,
} from '../../../../../shared/domain/documents.ts';
import {
  ContractStatusSchema,
  SubjectRefSchema,
  documentLinks,
  sameSubject,
} from '../../../../../shared/domain/documents.ts';
import {
  NONE,
  contractDraftOf,
  contractOf,
  documentEditDraftOf,
  documentEditProblems,
  documentUpdateCommandOf,
  emptyContract,
  isContractCategory,
  sameDocumentEditDraft,
} from './document-draft.ts';
import type { ContractDraft, DocumentEditDraft } from './document-draft.ts';
import { useEditGuard } from '../../../../ui/edit-guard.tsx';
import { facilitySaveOutcome } from '../../../../ui/facility-save.ts';
import { useDraftBase } from '../../../../ui/draft-base.ts';
import { FormSaveFooter, commandResult, useFormSave } from '../../../../ui/form-save.tsx';
import type { FormSubmitResult } from '../../../../ui/form-save.tsx';
import { useFormValues } from '../../../../ui/form-values.tsx';
import {
  documentCategories,
  FileTypeIcon,
  formatBytes,
  SubjectChip,
  useCategoryLabel,
} from '../../../../ui/documents-kit.tsx';
import { usePropertyOptions } from '../../../../ui/property-options.ts';
import { useContactOptions, useInvoiceOptions } from '../../../../ui/party-invoice-options.ts';
import type { TaskOptionsState } from '../../../../ui/task-options.ts';
import type { CommandOutcome, FailureReason } from '../../../../ui/use-agenda.ts';
import { MAX_UPLOAD_BYTES, uploadFile } from '../../../../ui/use-agenda.ts';

const k = 'facility-operations.documents';
const closeLabelKey = 'facility-operations.common.close';
const statuses: readonly ContractStatus[] = ['draft', 'active', 'terminated', 'expired'];

export type DocumentFormMode =
  | { readonly kind: 'create' }
  | { readonly document: DocumentRecord; readonly kind: 'edit' }
  | { readonly kind: 'amend'; readonly original: DocumentRecord };
/** Modes the create panel handles; an edit is handled by the edit panel instead. */
type CreateDocumentFormMode = Exclude<DocumentFormMode, { readonly kind: 'edit' }>;

export const documentFormKey = (mode: DocumentFormMode): string => {
  if (mode.kind === 'edit') {
    return `edit:${mode.document.id}`;
  }
  if (mode.kind === 'amend') {
    return `amend:${mode.original.id}`;
  }
  return 'create';
};
const initialDocumentForm = (mode: CreateDocumentFormMode, contracts: readonly DocumentRecord[]) => {
  if (mode.kind === 'amend') {
    const count = contracts.filter((entry) => entry.amendsDocumentId === mode.original.id).length;
    return {
      amends: mode.original.id,
      category: 'amendment',
      contract: {
        ...contractDraftOf(mode.original.contract),
        contractType: 'Dodatek ke smlouvě',
        status: 'draft' as const,
        subject: '',
      },
      description: '',
      links: documentLinks(mode.original).filter((link) => link.kind !== 'contract'),
      title: `Dodatek č. ${count + 1} – ${mode.original.title}`,
    };
  }
  return { amends: NONE, category: 'other', contract: emptyContract, description: '', links: [], title: '' };
};
const documentHeadingKey = (mode: DocumentFormMode): string => {
  if (mode.kind === 'edit') {
    return `${k}.create.editTitle`;
  }
  if (mode.kind === 'amend') {
    return `${k}.create.amendmentTitle`;
  }
  return `${k}.create.title`;
};
const documentErrorText = (
  error: FailureReason | 'required' | 'tooLarge' | 'upload',
  t: ReturnType<typeof useModernI18n>['t'],
): string => {
  if (error === 'required') {
    return t('facility-operations.common.required');
  }
  if (error === 'tooLarge') {
    return t(`${k}.tooLarge`);
  }
  if (error === 'upload') {
    return t(`${k}.uploadFailed`);
  }
  return t(`facility-operations.common.errors.${error}`);
};

const persistDocument = Effect.fn('Documents.persist')(function* persistDocument({
  amends,
  category,
  contract,
  description,
  file,
  links,
  onBusy,
  onFailure,
  onPersisted,
  run,
  title,
}: {
  readonly amends: string;
  readonly category: string;
  readonly contract: ContractDraft;
  readonly description: string;
  readonly file: File | undefined;
  readonly links: readonly SubjectRef[];
  readonly onBusy: (busy?: 'upload' | 'save') => void;
  readonly onFailure: (failure?: FailureReason | 'required' | 'upload') => void;
  readonly onPersisted: (documentId: string | undefined, action: 'created' | 'updated') => void;
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
  readonly title: string;
}) {
  const terms = isContractCategory(category) ? contractOf(contract) : undefined;
  if (
    title.trim() === '' ||
    (isContractCategory(category) && terms === undefined) ||
    (category === 'amendment' && amends === NONE)
  ) {
    onFailure('required');
    return 'failed' as const;
  }
  onFailure();
  const common = {
    category,
    links: [...links],
    title: title.trim(),
    ...optionalField('description', description.trim() === '' ? undefined : description.trim()),
    ...optionalField('contract', terms),
  };
  let stored: StoredFileRef | undefined;
  if (file !== undefined) {
    onBusy('upload');
    const uploaded = yield* uploadFile(file);
    if (!uploaded.ok) {
      onBusy();
      onFailure(uploaded.reason === 'forbidden' ? 'forbidden' : 'upload');
      return 'failed' as const;
    }
    stored = uploaded.file;
  }
  onBusy('save');
  const command = yield* Schema.decodeEffect(OpsCommandSchema)({
    _tag: 'DocumentCreate',
    ...common,
    ...optionalField('amendsDocumentId', category === 'amendment' && amends !== NONE ? amends : undefined),
    ...optionalField('file', stored),
  }).pipe(Effect.result);
  if (Result.isFailure(command)) {
    onBusy();
    onFailure('invalid');
    return 'failed' as const;
  }
  const outcome = yield* run(command.success);
  onBusy();
  return commandResult(outcome, (result) => onPersisted(result.entityIds[0], 'created'), onFailure);
});

/** The links of a document as chips; removing a chip removes the link. */
const LinkChips: FormReact.FieldComponent<readonly SubjectRef[]> = ({ field }) => {
  const { t } = useModernI18n();
  return field.value.length > 0 ? (
    <div className="flex flex-wrap gap-100">
      {field.value.map((link) => (
        <SubjectChip
          key={`${link.kind}:${link.id}`}
          onRemove={() => field.onChange(field.value.filter((entry) => !sameSubject(entry, link)))}
          removeLabel={t(`${k}.create.removeLink`, { label: link.label })}
          subject={link}
        />
      ))}
    </div>
  ) : null;
};

/**
 * One document's values. The edit and the create panel each hold theirs in their own form; Uložit sends them through
 * the draft save or the form save, so Enter sends nothing.
 */
const makeDocumentForm = () =>
  FormReact.make(
    FormBuilder.empty
      .addField('amends', Schema.String)
      .addField('amountTerms', Schema.String)
      .addField('category', Schema.String)
      .addField('contractStatus', Schema.String)
      .addField('contractType', Schema.String)
      .addField('description', Schema.String)
      .addField('file', Schema.OptionFromNullOr(Schema.instanceOf(File)))
      .addField('links', Schema.Array(Schema.toType(SubjectRefSchema)))
      .addField('noticeDateInput', Schema.String)
      .addField('noticePeriod', Schema.String)
      .addField('owner', Schema.String)
      .addField('parties', Schema.String)
      .addField('pickContact', Schema.String)
      .addField('pickContract', Schema.String)
      .addField('pickInvoice', Schema.String)
      .addField('pickProperty', Schema.String)
      .addField('pickTask', Schema.String)
      .addField('subject', Schema.String)
      .addField('title', Schema.String)
      .addField('validFromInput', Schema.String)
      .addField('validToInput', Schema.String),
    {
      fields: {
        amends: ChoiceField,
        amountTerms: TextField,
        category: ChoiceField,
        contractStatus: ChoiceField,
        contractType: TextField,
        description: TextAreaField,
        file: FileField,
        links: LinkChips,
        noticeDateInput: TextField,
        noticePeriod: TextField,
        owner: TextField,
        parties: TextAreaField,
        pickContact: TemplateChoiceField,
        pickContract: TemplateChoiceField,
        pickInvoice: TemplateChoiceField,
        pickProperty: TemplateChoiceField,
        pickTask: TemplateChoiceField,
        subject: TextField,
        title: RuledTextField,
        validFromInput: TextField,
        validToInput: TextField,
      },
      onSubmit: () => Effect.void,
      runtime: browserAtomRuntime,
    },
  );

const documentCreateForm = makeDocumentForm();
const documentEditForm = makeDocumentForm();
type DocumentForm = typeof documentCreateForm;
type DocumentValues = DocumentForm['schema']['Encoded'];

/** The link pickers hold nothing: a pick adds its link at once and the picker is empty again. */
const noPicks = { pickContact: '', pickContract: '', pickInvoice: '', pickProperty: '', pickTask: '' };

const contractValuesOf = (contract: ContractDraft) => ({
  amountTerms: contract.amountTerms,
  contractStatus: contract.status,
  contractType: contract.contractType,
  noticeDateInput: contract.noticeDateInput,
  noticePeriod: contract.noticePeriod,
  owner: contract.owner,
  parties: contract.parties,
  subject: contract.subject,
  validFromInput: contract.validFromInput,
  validToInput: contract.validToInput,
});

/** The contract terms the form shows; a status that is not one of the choices is a draft. */
const contractFrom = (values: DocumentValues): ContractDraft => ({
  amountTerms: values.amountTerms,
  contractType: values.contractType,
  noticeDateInput: values.noticeDateInput,
  noticePeriod: values.noticePeriod,
  owner: values.owner,
  parties: values.parties,
  status: Schema.is(ContractStatusSchema)(values.contractStatus) ? values.contractStatus : 'draft',
  subject: values.subject,
  validFromInput: values.validFromInput,
  validToInput: values.validToInput,
});

const editValuesOf = (draft: DocumentEditDraft): DocumentValues => ({
  ...contractValuesOf(draft.contract),
  ...noPicks,
  amends: NONE,
  category: draft.category,
  description: draft.description,
  file: null,
  links: draft.links,
  title: draft.title,
});

const editDraftFrom = (values: DocumentValues): DocumentEditDraft => ({
  category: values.category,
  contract: contractFrom(values),
  description: values.description,
  links: values.links,
  title: values.title,
});

const createValuesOf = (initial: ReturnType<typeof initialDocumentForm>): DocumentValues => ({
  ...contractValuesOf(initial.contract),
  ...noPicks,
  amends: initial.amends,
  category: initial.category,
  description: initial.description,
  file: null,
  links: initial.links,
  title: initial.title,
});

/** The picked file of a new document, which changes only when the pick does. */
const pickedDocumentFile = documentCreateForm
  .getFieldAtoms(documentCreateForm.fields.file)
  .value.pipe(Atom.map(Option.getOrElse((): File | null => null)));

const DocumentFilePicker = ({ file }: { readonly file: File | undefined }) => {
  const { t } = useModernI18n();
  const [dragging, setDragging] = useState(false);
  const setFile = useAtomSet(documentCreateForm.getFieldAtoms(documentCreateForm.fields.file).setValue);
  return (
    <documentCreateForm.file
      aria-label={t(`${k}.create.dropTitle`)}
      className="sr-only"
      data-testid="document-file-input"
      tabIndex={-1}
    >
      {(pick) => (
        <button
          className={`flex cursor-pointer flex-col items-center gap-100 rounded-lg border-2 border-dashed px-200 py-300 text-center transition-colors ${dragging ? 'border-primary bg-primary-light' : 'border-border-primary bg-highlight hover:bg-surface'}`}
          data-testid="document-dropzone"
          onClick={pick}
          onDragLeave={() => setDragging(false)}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const [dropped] = event.dataTransfer.files;
            if (dropped !== undefined) {
              setFile(dropped);
            }
          }}
          type="button"
        >
          {file === undefined ? (
            <>
              <span aria-hidden="true" className="text-2xl">
                ⇪
              </span>
              <span className="font-semibold text-sm">{t(`${k}.create.dropTitle`)}</span>
              <span className="text-fg-secondary text-xs">{t(`${k}.create.dropHint`)}</span>
            </>
          ) : (
            <span className="flex items-center gap-150 text-left">
              <FileTypeIcon mime={file.type} name={file.name} />
              <span className="flex flex-col">
                <span className="font-semibold text-sm">{file.name}</span>
                <span className="text-fg-secondary text-xs">
                  {formatBytes(file.size)} · {t(`${k}.create.replace`)}
                </span>
              </span>
            </span>
          )}
        </button>
      )}
    </documentCreateForm.file>
  );
};

/**
 * The links of a document: its chips, and pickers that each add the picked subject as a link at once. A picker holds
 * no value of its own; the links live in the form.
 */
const DocumentLinkFields = ({
  category,
  contacts,
  form,
  invoices,
  linkableContracts,
  properties,
  tasks,
}: {
  readonly category: string;
  readonly contacts: ReturnType<typeof useContactOptions>;
  readonly form: DocumentForm;
  readonly invoices: ReturnType<typeof useInvoiceOptions>;
  readonly linkableContracts: readonly DocumentRecord[];
  readonly properties: ReturnType<typeof usePropertyOptions>;
  readonly tasks: TaskOptionsState;
}) => {
  const { t } = useModernI18n();
  const setValues = useAtomSet(form.setValues);
  /** The subject a picker's choice stands for, when it is still offered. */
  const subjectOf = (values: DocumentValues): SubjectRef | undefined => {
    if (values.pickProperty !== '' && properties.status === 'ready') {
      return properties.options.find((option) => option.value === values.pickProperty)?.ref;
    }
    if (values.pickTask !== '' && tasks.status === 'ready') {
      return tasks.options.find((task) => task.id === values.pickTask);
    }
    if (values.pickContract !== '') {
      const picked = linkableContracts.find((entry) => entry.id === values.pickContract);
      return picked === undefined ? undefined : { id: picked.id, kind: 'document', label: picked.title };
    }
    if (values.pickContact !== '' && contacts.status === 'ready') {
      return contacts.options.find((option) => option.id === values.pickContact);
    }
    if (values.pickInvoice !== '' && invoices.status === 'ready') {
      return invoices.options.find((option) => option.id === values.pickInvoice);
    }
    return undefined;
  };
  // A pick adds its subject as a link, once, and empties the picker again.
  useAtomSubscribe(form.values, (next) => {
    if (Option.isNone(next)) {
      return;
    }
    const values = next.value;
    if (
      values.pickContact === '' &&
      values.pickContract === '' &&
      values.pickInvoice === '' &&
      values.pickProperty === '' &&
      values.pickTask === ''
    ) {
      return;
    }
    const link = subjectOf(values);
    const links =
      link === undefined || values.links.some((entry) => sameSubject(entry, link))
        ? values.links
        : [...values.links, link];
    setValues({ ...values, ...noPicks, links });
  });
  return (
    <fieldset className={`${surfaceTileClassName} facility-document-fieldset flex flex-col gap-150 p-200`}>
      <legend className="px-50 font-semibold text-sm">{t(`${k}.fields.links`)}</legend>
      <p className="text-fg-secondary text-xs">{t(`${k}.create.linksHelp`)}</p>
      <form.links />
      {properties.status === 'ready' && (
        <form.pickProperty
          items={properties.options.map((option) => ({ label: option.ref.label, value: option.value }))}
          label={t('facility-operations.property.pick')}
          placeholder={t('facility-operations.property.pick')}
          size="md"
        />
      )}
      {tasks.status === 'ready' && tasks.options.length > 0 && (
        <form.pickTask
          items={tasks.options.map((task) => ({ label: task.label, value: task.id }))}
          label={t(`${k}.create.taskLink`)}
          placeholder={t(`${k}.create.pickTask`)}
          size="md"
        />
      )}
      {tasks.status !== 'ready' && (
        <p className="text-fg-secondary text-xs">
          {t(`${k}.create.${tasks.status === 'loading' ? 'tasksLoading' : 'tasksUnavailable'}`)}
        </p>
      )}
      {linkableContracts.length > 0 && category !== 'amendment' && (
        <form.pickContract
          items={linkableContracts.map((entry) => ({ label: entry.title, value: entry.id }))}
          label={t(`${k}.create.contractLink`)}
          placeholder={t(`${k}.contract.pickOriginal`)}
          size="md"
        />
      )}
      {contacts.status === 'ready' && (
        <form.pickContact
          items={contacts.options.map((option) => ({ label: option.label, value: option.id }))}
          label={t(`${k}.create.tenant`)}
          placeholder={t(`${k}.create.pickContact`)}
          size="md"
        />
      )}
      {contacts.status !== 'ready' && (
        <p className="text-fg-secondary text-xs">
          {t(`${k}.create.${contacts.status === 'loading' ? 'contactsLoading' : 'contactsUnavailable'}`)}
        </p>
      )}
      {invoices.status === 'ready' && invoices.options.length > 0 && (
        <form.pickInvoice
          items={invoices.options.map((option) => ({ label: option.label, value: option.id }))}
          label={t(`${k}.create.invoiceLink`)}
          placeholder={t(`${k}.create.pickInvoice`)}
          size="md"
        />
      )}
    </fieldset>
  );
};

const DocumentContractFields = ({
  amendsLocked,
  category,
  contracts,
  form,
}: {
  /** An existing document keeps the document it amends: the picker only belongs to a new amendment. */
  readonly amendsLocked?: boolean | undefined;
  readonly category: string;
  readonly contracts: readonly DocumentRecord[];
  readonly form: DocumentForm;
}) => {
  const { language, t } = useModernI18n();
  const requiredLabel = requiredLabelFor(language);
  return (
    <fieldset className={`${surfaceTileClassName} facility-document-fieldset flex flex-col gap-150 p-200`}>
      <legend className="px-50 font-semibold text-sm">{t(`${k}.contract.section`)}</legend>
      {category === 'amendment' && amendsLocked !== true && (
        <form.amends
          items={[
            { label: t(`${k}.contract.pickOriginal`), value: NONE },
            ...contracts.flatMap((entry) =>
              entry.category === 'contract' ? [{ label: entry.title, value: entry.id }] : [],
            ),
          ]}
          label={t(`${k}.contract.amends`)}
        />
      )}
      <div className="grid grid-cols-1 gap-150 sm:grid-cols-2">
        <form.contractType
          id="contract-type"
          label={t(`${k}.contract.contractType`)}
          maxLength={120}
          placeholder={t('facility-operations.ui.leaseAgreement')}
          required
          requiredLabel={requiredLabel}
        />
        <form.contractStatus
          items={statuses.map((value) => ({ label: t(`${k}.contractStatus.${value}`), value }))}
          label={t(`${k}.contract.status`)}
        />
      </div>
      <form.parties
        helpText={t(`${k}.contract.partiesHelp`)}
        id="contract-parties"
        label={t(`${k}.contract.parties`)}
        required
        requiredLabel={requiredLabel}
        rows={2}
      />
      <form.subject id="contract-subject" label={t(`${k}.contract.subject`)} maxLength={1000} />
      <div className="grid grid-cols-1 gap-150 sm:grid-cols-2">
        <form.validFromInput id="contract-valid-from" label={t(`${k}.contract.validFrom`)} type="date" />
        <form.validToInput id="contract-valid-to" label={t(`${k}.contract.validTo`)} type="date" />
        <form.amountTerms id="contract-amount" label={t(`${k}.contract.amountTerms`)} maxLength={500} />
        <form.owner
          id="contract-owner"
          label={t(`${k}.contract.owner`)}
          maxLength={200}
          required
          requiredLabel={requiredLabel}
        />
        <form.noticePeriod id="contract-notice-period" label={t(`${k}.contract.noticePeriod`)} maxLength={300} />
        <form.noticeDateInput id="contract-notice-date" label={t(`${k}.contract.noticeDate`)} type="date" />
      </div>
    </fieldset>
  );
};

/** The fields both panels share: title, category and description. */
const DocumentTextFields = ({
  form,
  problems,
}: {
  readonly form: DocumentForm;
  readonly problems: { readonly title: boolean } | undefined;
}) => {
  const { language, t } = useModernI18n();
  const categoryLabel = useCategoryLabel();
  return (
    <>
      <form.title
        autoComplete="off"
        id="document-title"
        invalid={problems?.title === true}
        label={t(`${k}.fields.title`)}
        maxLength={300}
        required
        requiredLabel={requiredLabelFor(language)}
        {...(problems?.title === true ? { helpText: t('facility-operations.common.required') } : {})}
      />
      <form.category
        items={documentCategories.map((value) => ({ label: categoryLabel(value), value }))}
        label={t(`${k}.fields.category`)}
      />
      <form.description id="document-description" label={t(`${k}.fields.description`)} maxLength={4000} rows={2} />
    </>
  );
};

/**
 * Edit one stored document: the title, the category, the description, the links and the contract terms. Nothing is
 * sent until Uložit, and a category without its required fields cannot be saved until it is valid.
 */
const DocumentEditPanel = ({
  contracts,
  document,
  onClose,
  open,
  run,
  tasks,
}: {
  readonly contracts: readonly DocumentRecord[];
  readonly document: DocumentRecord;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
  readonly tasks: TaskOptionsState;
}) => {
  const { language, t } = useModernI18n();
  const properties = usePropertyOptions();
  const contacts = useContactOptions();
  const invoices = useInvoiceOptions();
  const opened = documentEditDraftOf(document);
  const shown = useFormValues(documentEditForm, editValuesOf(opened));
  const draft = editDraftFrom(shown.values);
  const setValues = useAtomSet(documentEditForm.setValues);
  const problems = documentEditProblems(draft);
  // Saves carry the revision of the read the draft was built on, so someone else's newer change refuses them.
  const base = useDraftBase(document, run);
  const record = useDraftSave<DocumentEditDraft, never>({
    equals: sameDocumentEditDraft,
    isValid: (value) => Option.isSome(documentUpdateCommandOf(document.id, value)),
    // A closed panel holds nothing on screen: only the open panel asks before leaving.
    open,
    runtime: browserRuntime,
    save: (value) =>
      Option.match(documentUpdateCommandOf(document.id, value), {
        onNone: () => Effect.succeed<SaveOutcome>('failed'),
        onSome: (command) => base.confirm(facilitySaveOutcome(base.run(command))),
      }),
    value: draft,
  });
  base.sync({
    onAdopt: () => {
      const stored = documentEditDraftOf(document);
      if (!sameDocumentEditDraft(stored, draft)) {
        record.adopt(stored);
        setValues(editValuesOf(stored));
      }
    },
    settled: !record.pending && sameDocumentEditDraft(draft, record.confirmed),
  });
  const guard = useEditGuard(record, () => {
    setValues(editValuesOf(record.confirmed));
  });
  const labels = saveLabelsFor(language);
  const close = () => {
    guard.request(onClose);
  };
  const handleSave = record.save;
  const handleReloadLatest = () => {
    const current = documentEditDraftOf(document);
    base.rebase();
    record.adopt(current);
    setValues(editValuesOf(current));
  };
  const showErrors = record.status === 'invalid';
  const linkableContracts = contracts.filter((entry) => entry.id !== document.id);
  return (
    <>
      <SidePanel
        actions={
          <>
            <Button appearance="outline" onClick={close} severity="secondary">
              {t(closeLabelKey)}
            </Button>
            <SaveBar labels={labels} onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />
          </>
        }
        guard={guard}
        onOpenChange={(next) => {
          if (!next) {
            onClose();
          }
        }}
        open={open}
        resizeLabel={t(closeLabelKey)}
        size="lg"
        title={t(`${k}.create.editTitle`)}
      >
        <FormRoot
          className="flex flex-col gap-250 py-200"
          defaultValues={editValuesOf(opened)}
          form={documentEditForm}
          translateMessage={(message) => t(message)}
        >
          {shown.ready}
          {problems.contract && showErrors && (
            <StatusText showIcon status="error">
              {t(`${k}.contract.required`)}
            </StatusText>
          )}
          <DocumentTextFields form={documentEditForm} problems={showErrors ? problems : undefined} />
          <DocumentLinkFields
            category={draft.category}
            contacts={contacts}
            form={documentEditForm}
            invoices={invoices}
            linkableContracts={linkableContracts}
            properties={properties}
            tasks={tasks}
          />
          {isContractCategory(draft.category) && (
            <DocumentContractFields
              amendsLocked
              category={draft.category}
              contracts={contracts}
              form={documentEditForm}
            />
          )}
        </FormRoot>
      </SidePanel>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
  );
};

/** Create (or amend) one document: an explicit "Uložit" submits it once, together with its file. */
const DocumentCreatePanel = ({
  contracts,
  mode,
  onClose,
  onSaved,
  open,
  run,
  tasks,
}: {
  readonly contracts: readonly DocumentRecord[];
  readonly mode: CreateDocumentFormMode;
  readonly onClose: () => void;
  readonly onSaved: (documentId: string | undefined) => void;
  readonly open: boolean;
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
  readonly tasks: TaskOptionsState;
}) => {
  const { t } = useModernI18n();
  const toast = useToast();
  const properties = usePropertyOptions();
  const contacts = useContactOptions();
  const invoices = useInvoiceOptions();
  const initial = initialDocumentForm(mode, contracts);
  const shown = useFormValues(documentCreateForm, createValuesOf(initial));
  const { amends, category, description, links, title } = shown.values;
  const file = shown.values.file ?? undefined;
  const contract = contractFrom(shown.values);
  const fileAtoms = documentCreateForm.getFieldAtoms(documentCreateForm.fields.file);
  const setFile = useAtomSet(fileAtoms.setValue);
  const setTitle = useAtomSet(documentCreateForm.getFieldAtoms(documentCreateForm.fields.title).setValue);
  const setCategory = useAtomSet(documentCreateForm.getFieldAtoms(documentCreateForm.fields.category).setValue);
  const [busy, setBusy] = useState<'upload' | 'save' | undefined>();
  const [error, setError] = useState<FailureReason | 'required' | 'tooLarge' | 'upload' | undefined>();

  // A picked file that is too large is refused and the file before it stays; an accepted one names an untitled
  // document after itself and makes an image a photo.
  const accepted = useRef<File | null>(null);
  useAtomSubscribe(
    pickedDocumentFile,
    (picked) => {
      if (picked === null || picked === accepted.current) {
        accepted.current = picked;
        return;
      }
      if (picked.size > MAX_UPLOAD_BYTES) {
        setError('tooLarge');
        setFile(accepted.current);
        return;
      }
      setError(undefined);
      accepted.current = picked;
      setTitle((current: string) =>
        current.trim() === '' ? picked.name.replace(/\.[^.]+$/u, '').replaceAll(/[_-]+/gu, ' ') : current,
      );
      setCategory((current: string) => (current === 'other' && picked.type.startsWith('image/') ? 'photo' : current));
    },
    { immediate: false },
  );

  // The document and its file are sent on Uložit only; an amendment opens prefilled, which Uložit can send as it is.
  const form = useFormSave({
    // Zahodit změny closes the panel, which unmounts the form with its input.
    open,
    savableAtOnce: mode.kind === 'amend',
    submit: () =>
      persistDocument({
        amends,
        category,
        contract,
        description,
        file,
        links,
        onBusy: setBusy,
        onFailure: setError,
        onPersisted: (documentId, action) => {
          toast.create({ title: t(`${k}.${action}`), type: 'success' });
          onSaved(documentId);
        },
        run,
        title,
      }).pipe(
        // A file the browser could not read is an upload failure, said on the form.
        Effect.catchTag('FileReadFailed', () =>
          Effect.sync((): FormSubmitResult => {
            setBusy(undefined);
            setError('upload');
            return 'failed';
          }),
        ),
      ),
    value: { amends, category, contract, description, file, links, title },
  });

  const errorText = error === undefined ? undefined : documentErrorText(error, t);
  const heading = t(documentHeadingKey(mode));
  const linkableContracts = contracts;

  return (
    <SidePanel
      actions={
        <FormSaveFooter
          cancelLabel={t('facility-operations.common.cancel')}
          error={errorText}
          form={form}
          onCancel={onClose}
        >
          {busy === 'upload' && <StatusText size="sm">{t(`${k}.uploading`)}</StatusText>}
        </FormSaveFooter>
      }
      guard={form.guard}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open={open}
      resizeLabel={t(closeLabelKey)}
      size="lg"
      title={heading}
    >
      <FormRoot
        className="flex flex-col gap-250 py-200"
        defaultValues={createValuesOf(initial)}
        form={documentCreateForm}
        translateMessage={(message) => t(message)}
      >
        {shown.ready}
        {errorText !== undefined && (
          <StatusText showIcon status="error">
            {errorText}
          </StatusText>
        )}
        <DocumentFilePicker file={file} />
        {file === undefined && <p className="-mt-150 text-fg-secondary text-xs">{t(`${k}.create.noFile`)}</p>}
        <DocumentTextFields form={documentCreateForm} problems={undefined} />
        <DocumentLinkFields
          category={category}
          contacts={contacts}
          form={documentCreateForm}
          invoices={invoices}
          linkableContracts={linkableContracts}
          properties={properties}
          tasks={tasks}
        />
        {isContractCategory(category) && (
          <DocumentContractFields category={category} contracts={contracts} form={documentCreateForm} />
        )}
      </FormRoot>
    </SidePanel>
  );
};

/**
 * Create one document (and upload its file) or a new amendment on "Uložit", or edit a stored one, whose changes are
 * sent on Uložit as well.
 */
export const DocumentFormPanel = ({
  contracts,
  mode,
  onClose,
  onSaved,
  open,
  run,
  tasks,
}: {
  readonly contracts: readonly DocumentRecord[];
  readonly mode: DocumentFormMode;
  readonly onClose: () => void;
  readonly onSaved: (documentId: string | undefined) => void;
  readonly open: boolean;
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
  readonly tasks: TaskOptionsState;
}) =>
  mode.kind === 'edit' ? (
    <DocumentEditPanel
      contracts={contracts}
      document={mode.document}
      onClose={onClose}
      open={open}
      run={run}
      tasks={tasks}
    />
  ) : (
    <DocumentCreatePanel
      contracts={contracts}
      mode={mode}
      onClose={onClose}
      onSaved={onSaved}
      open={open}
      run={run}
      tasks={tasks}
    />
  );
