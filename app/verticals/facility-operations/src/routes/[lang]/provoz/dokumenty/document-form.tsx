import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// Create / edit / amendment form for the documents agenda (S12). Upload goes through the governed FileUpload command
// first; the returned file snapshot becomes version 1 of the new document.
import {
  SaveBar,
  SidePanel,
  UnsavedChangesDialog,
  saveLabelsFor,
  surfaceTileClassName,
  useDraftSave,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate as Select } from '@app/admin-ui/select-template';
import { Effect, Option, Result, Schema } from 'effect';
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
import { ContractStatusSchema, documentLinks, sameSubject } from '../../../../../shared/domain/documents.ts';
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
    return;
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
      return;
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
    return;
  }
  const outcome = yield* run(command.success);
  onBusy();
  if (outcome.ok) {
    onPersisted(outcome.result.entityIds[0], 'created');
  } else {
    onFailure(outcome.reason);
  }
});

const DocumentFilePicker = ({
  file,
  onFilePicked,
}: {
  readonly file: File | undefined;
  readonly onFilePicked: (file: File | undefined) => void;
}) => {
  const { t } = useModernI18n();
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <>
      <input
        aria-label={t(`${k}.create.dropTitle`)}
        className="sr-only"
        data-testid="document-file-input"
        onChange={(event) => onFilePicked(event.target.files?.[0])}
        ref={fileInput}
        tabIndex={-1}
        type="file"
      />
      <button
        className={`flex cursor-pointer flex-col items-center gap-100 rounded-lg border-2 border-dashed px-200 py-300 text-center transition-colors ${dragging ? 'border-primary bg-primary-light' : 'border-border-primary bg-highlight hover:bg-surface'}`}
        data-testid="document-dropzone"
        onClick={() => fileInput.current?.click()}
        onDragLeave={() => setDragging(false)}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          onFilePicked(event.dataTransfer.files[0]);
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
    </>
  );
};

const DocumentLinkFields = ({
  category,
  contacts,
  invoices,
  linkableContracts,
  links,
  onAddLink,
  onRemoveLink,
  properties,
  tasks,
}: {
  readonly category: string;
  readonly contacts: ReturnType<typeof useContactOptions>;
  readonly invoices: ReturnType<typeof useInvoiceOptions>;
  readonly linkableContracts: readonly DocumentRecord[];
  readonly links: readonly SubjectRef[];
  readonly onAddLink: (link: SubjectRef) => void;
  readonly onRemoveLink: (link: SubjectRef) => void;
  readonly properties: ReturnType<typeof usePropertyOptions>;
  readonly tasks: TaskOptionsState;
}) => {
  const { t } = useModernI18n();
  return (
    <fieldset className={`${surfaceTileClassName} facility-document-fieldset flex flex-col gap-150 p-200`}>
      <legend className="px-50 font-semibold text-sm">{t(`${k}.fields.links`)}</legend>
      <p className="text-fg-secondary text-xs">{t(`${k}.create.linksHelp`)}</p>
      {links.length > 0 && (
        <div className="flex flex-wrap gap-100">
          {links.map((link) => (
            <SubjectChip
              key={`${link.kind}:${link.id}`}
              onRemove={() => onRemoveLink(link)}
              removeLabel={t(`${k}.create.removeLink`, { label: link.label })}
              subject={link}
            />
          ))}
        </div>
      )}
      {properties.status === 'ready' && (
        <Select
          items={properties.options.map((option) => ({
            displayValue: option.ref.label,
            label: option.ref.label,
            value: option.value,
          }))}
          label={t('facility-operations.property.pick')}
          name="document-link-property"
          onValueChange={({ value }) => {
            const picked = properties.options.find((option) => option.value === value[0]);
            if (picked !== undefined) {
              onAddLink(picked.ref);
            }
          }}
          placeholder={t('facility-operations.property.pick')}
          size="md"
          value={[]}
        />
      )}
      {tasks.status === 'ready' && tasks.options.length > 0 && (
        <Select
          items={tasks.options.map((task) => ({ displayValue: task.label, label: task.label, value: task.id }))}
          label={t(`${k}.create.taskLink`)}
          name="document-link-task"
          onValueChange={({ value }) => {
            const picked = tasks.options.find((task) => task.id === value[0]);
            if (picked !== undefined) {
              onAddLink(picked);
            }
          }}
          placeholder={t(`${k}.create.pickTask`)}
          size="md"
          value={[]}
        />
      )}
      {tasks.status !== 'ready' && (
        <p className="text-fg-secondary text-xs">
          {t(`${k}.create.${tasks.status === 'loading' ? 'tasksLoading' : 'tasksUnavailable'}`)}
        </p>
      )}
      {linkableContracts.length > 0 && category !== 'amendment' && (
        <Select
          items={linkableContracts.map((entry) => ({
            displayValue: entry.title,
            label: entry.title,
            value: entry.id,
          }))}
          label={t(`${k}.create.contractLink`)}
          name="document-link-contract"
          onValueChange={({ value }) => {
            const picked = linkableContracts.find((entry) => entry.id === value[0]);
            if (picked !== undefined) {
              onAddLink({ id: picked.id, kind: 'document', label: picked.title });
            }
          }}
          placeholder={t(`${k}.contract.pickOriginal`)}
          size="md"
          value={[]}
        />
      )}
      {contacts.status === 'ready' && (
        <Select
          items={contacts.options.map((option) => ({
            displayValue: option.label,
            label: option.label,
            value: option.id,
          }))}
          label={t(`${k}.create.tenant`)}
          name="document-link-contact"
          onValueChange={({ value }) => {
            const picked = contacts.options.find((option) => option.id === value[0]);
            if (picked !== undefined) {
              onAddLink(picked);
            }
          }}
          placeholder={t(`${k}.create.pickContact`)}
          size="md"
          value={[]}
        />
      )}
      {contacts.status !== 'ready' && (
        <p className="text-fg-secondary text-xs">
          {t(`${k}.create.${contacts.status === 'loading' ? 'contactsLoading' : 'contactsUnavailable'}`)}
        </p>
      )}
      {invoices.status === 'ready' && invoices.options.length > 0 && (
        <Select
          items={invoices.options.map((option) => ({
            displayValue: option.label,
            label: option.label,
            value: option.id,
          }))}
          label={t(`${k}.create.invoiceLink`)}
          name="document-link-invoice"
          onValueChange={({ value }) => {
            const picked = invoices.options.find((option) => option.id === value[0]);
            if (picked !== undefined) {
              onAddLink(picked);
            }
          }}
          placeholder={t(`${k}.create.pickInvoice`)}
          size="md"
          value={[]}
        />
      )}
    </fieldset>
  );
};

const DocumentContractFields = ({
  amends,
  amendsLocked,
  category,
  contract,
  contracts,
  onAmendsChange,
  onStatusChange,
  onTermChange,
}: {
  readonly amends: string;
  /** An existing document keeps the document it amends: the picker only belongs to a new amendment. */
  readonly amendsLocked?: boolean | undefined;
  readonly category: string;
  readonly contract: ContractDraft;
  readonly contracts: readonly DocumentRecord[];
  /** Given only when the picker is shown; a stored document keeps the document it amends. */
  readonly onAmendsChange?: ((value: string) => void) | undefined;
  readonly onStatusChange: (status: ContractStatus) => void;
  readonly onTermChange: (key: keyof ContractDraft) => (value: string) => void;
}) => {
  const { t } = useModernI18n();
  return (
    <fieldset className={`${surfaceTileClassName} facility-document-fieldset flex flex-col gap-150 p-200`}>
      <legend className="px-50 font-semibold text-sm">{t(`${k}.contract.section`)}</legend>
      {category === 'amendment' && amendsLocked !== true && onAmendsChange !== undefined && (
        <Select
          items={[
            {
              displayValue: t(`${k}.contract.pickOriginal`),
              label: t(`${k}.contract.pickOriginal`),
              value: NONE,
            },
            ...contracts.flatMap((entry) =>
              entry.category === 'contract' ? [{ displayValue: entry.title, label: entry.title, value: entry.id }] : [],
            ),
          ]}
          label={t(`${k}.contract.amends`)}
          name="document-amends"
          onValueChange={({ value }) => onAmendsChange(value[0] ?? NONE)}
          size="md"
          value={[amends]}
        />
      )}
      <div className="grid grid-cols-1 gap-150 sm:grid-cols-2">
        <FormInput
          id="contract-type"
          label={t(`${k}.contract.contractType`)}
          maxLength={120}
          onChange={(event) => onTermChange('contractType')(event.target.value)}
          placeholder={t('facility-operations.ui.leaseAgreement')}
          required
          value={contract.contractType}
        />
        <Select
          items={statuses.map((value) => ({
            displayValue: t(`${k}.contractStatus.${value}`),
            label: t(`${k}.contractStatus.${value}`),
            value,
          }))}
          label={t(`${k}.contract.status`)}
          name="contract-status"
          onValueChange={({ value }) => {
            const status = Schema.decodeUnknownOption(ContractStatusSchema)(value[0]);
            onStatusChange(Option.getOrElse(status, () => 'draft' as const));
          }}
          size="md"
          value={[contract.status]}
        />
      </div>
      <FormTextarea
        helpText={t(`${k}.contract.partiesHelp`)}
        id="contract-parties"
        label={t(`${k}.contract.parties`)}
        onChange={(event) => onTermChange('parties')(event.target.value)}
        required
        rows={2}
        value={contract.parties}
      />
      <FormInput
        id="contract-subject"
        label={t(`${k}.contract.subject`)}
        maxLength={1000}
        onChange={(event) => onTermChange('subject')(event.target.value)}
        value={contract.subject}
      />
      <div className="grid grid-cols-1 gap-150 sm:grid-cols-2">
        <FormInput
          id="contract-valid-from"
          label={t(`${k}.contract.validFrom`)}
          onChange={(event) => onTermChange('validFromInput')(event.target.value)}
          type="date"
          value={contract.validFromInput}
        />
        <FormInput
          id="contract-valid-to"
          label={t(`${k}.contract.validTo`)}
          onChange={(event) => onTermChange('validToInput')(event.target.value)}
          type="date"
          value={contract.validToInput}
        />
        <FormInput
          id="contract-amount"
          label={t(`${k}.contract.amountTerms`)}
          maxLength={500}
          onChange={(event) => onTermChange('amountTerms')(event.target.value)}
          value={contract.amountTerms}
        />
        <FormInput
          id="contract-owner"
          label={t(`${k}.contract.owner`)}
          maxLength={200}
          onChange={(event) => onTermChange('owner')(event.target.value)}
          required
          value={contract.owner}
        />
        <FormInput
          id="contract-notice-period"
          label={t(`${k}.contract.noticePeriod`)}
          maxLength={300}
          onChange={(event) => onTermChange('noticePeriod')(event.target.value)}
          value={contract.noticePeriod}
        />
        <FormInput
          id="contract-notice-date"
          label={t(`${k}.contract.noticeDate`)}
          onChange={(event) => onTermChange('noticeDateInput')(event.target.value)}
          type="date"
          value={contract.noticeDateInput}
        />
      </div>
    </fieldset>
  );
};

/** The fields both panels share: title, category and description. */
const DocumentTextFields = ({
  category,
  description,
  onCategoryChange,
  onDescriptionChange,
  onTitleChange,
  problems,
  title,
}: {
  readonly category: string;
  readonly description: string;
  readonly onCategoryChange: (category: string) => void;
  readonly onDescriptionChange: (description: string) => void;
  readonly onTitleChange: (title: string) => void;
  readonly problems: { readonly title: boolean } | undefined;
  readonly title: string;
}) => {
  const { t } = useModernI18n();
  const categoryLabel = useCategoryLabel();
  return (
    <>
      <FormInput
        autoComplete="off"
        id="document-title"
        label={t(`${k}.fields.title`)}
        maxLength={300}
        onChange={(event) => onTitleChange(event.target.value)}
        required
        value={title}
        {...(problems?.title === true
          ? { helpText: t('facility-operations.common.required'), validateStatus: 'error' as const }
          : {})}
      />
      <Select
        items={documentCategories.map((value) => ({
          displayValue: categoryLabel(value),
          label: categoryLabel(value),
          value,
        }))}
        label={t(`${k}.fields.category`)}
        name="document-category"
        onValueChange={({ value }) => onCategoryChange(value[0] ?? 'other')}
        size="md"
        value={[category]}
      />
      <FormTextarea
        id="document-description"
        label={t(`${k}.fields.description`)}
        maxLength={4000}
        onChange={(event) => onDescriptionChange(event.target.value)}
        rows={2}
        value={description}
      />
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
  const [draft, setDraft] = useState<DocumentEditDraft>(() => documentEditDraftOf(document));
  const problems = documentEditProblems(draft);
  const record = useDraftSave<DocumentEditDraft, never>({
    equals: sameDocumentEditDraft,
    isValid: (value) => Option.isSome(documentUpdateCommandOf(document.id, value)),
    runtime: browserRuntime,
    save: (value) =>
      Option.match(documentUpdateCommandOf(document.id, value), {
        onNone: () => Effect.succeed<SaveOutcome>('failed'),
        onSome: (command) => facilitySaveOutcome(run(command)),
      }),
    value: draft,
  });
  const update = (patch: Partial<DocumentEditDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const setTerm = (key: keyof ContractDraft) => (value: string) =>
    setDraft((current) => ({ ...current, contract: { ...current.contract, [key]: value } }));
  const addLink = (link: SubjectRef) =>
    setDraft((current) =>
      current.links.some((entry) => sameSubject(entry, link))
        ? current
        : { ...current, links: [...current.links, link] },
    );
  const removeLink = (link: SubjectRef) =>
    setDraft((current) => ({ ...current, links: current.links.filter((entry) => !sameSubject(entry, link)) }));
  const guard = useEditGuard(record, () => {
    setDraft(record.confirmed);
  });
  const labels = saveLabelsFor(language);
  const close = () => {
    guard.request(onClose);
  };
  const handleSave = record.save;
  const handleReloadLatest = () => {
    const current = documentEditDraftOf(document);
    record.adopt(current);
    setDraft(current);
  };
  const showErrors = record.status === 'invalid';
  const linkableContracts = contracts.filter((entry) => entry.id !== document.id);
  return (
    <>
      <SidePanel
        actions={
          <>
            <Button onClick={close} theme="outlined" variant="secondary">
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
        <div className="flex flex-col gap-250 py-200">
          {problems.contract && showErrors && (
            <StatusText showIcon status="error">
              {t(`${k}.contract.required`)}
            </StatusText>
          )}
          <DocumentTextFields
            category={draft.category}
            description={draft.description}
            onCategoryChange={(category) => update({ category })}
            onDescriptionChange={(description) => update({ description })}
            onTitleChange={(title) => update({ title })}
            problems={showErrors ? problems : undefined}
            title={draft.title}
          />
          <DocumentLinkFields
            category={draft.category}
            contacts={contacts}
            invoices={invoices}
            linkableContracts={linkableContracts}
            links={draft.links}
            onAddLink={addLink}
            onRemoveLink={removeLink}
            properties={properties}
            tasks={tasks}
          />
          {isContractCategory(draft.category) && (
            <DocumentContractFields
              amends={NONE}
              amendsLocked
              category={draft.category}
              contract={draft.contract}
              contracts={contracts}
              onStatusChange={(status) =>
                setDraft((current) => ({ ...current, contract: { ...current.contract, status } }))
              }
              onTermChange={setTerm}
            />
          )}
        </div>
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
  const [file, setFile] = useState<File | undefined>();
  const initial = initialDocumentForm(mode, contracts);
  const [title, setTitle] = useState(initial.title);
  const [category, setCategory] = useState(initial.category);
  const [description, setDescription] = useState(initial.description);
  const [links, setLinks] = useState<readonly SubjectRef[]>(initial.links);
  const [amends, setAmends] = useState(initial.amends);
  const [contract, setContract] = useState<ContractDraft>(initial.contract);
  const [busy, setBusy] = useState<'upload' | 'save' | undefined>();
  const [error, setError] = useState<FailureReason | 'required' | 'tooLarge' | 'upload' | undefined>();

  const addLink = (link: SubjectRef) =>
    setLinks((current) => (current.some((entry) => sameSubject(entry, link)) ? current : [...current, link]));

  const removeLink = (link: SubjectRef) => setLinks((current) => current.filter((entry) => !sameSubject(entry, link)));

  const pickFile = (picked: File | undefined) => {
    if (picked === undefined) {
      return;
    }
    if (picked.size > MAX_UPLOAD_BYTES) {
      setError('tooLarge');
      return;
    }
    setError(undefined);
    setFile(picked);
    if (title.trim() === '') {
      setTitle(picked.name.replace(/\.[^.]+$/u, '').replaceAll(/[_-]+/gu, ' '));
    }
    if (category === 'other' && picked.type.startsWith('image/')) {
      setCategory('photo');
    }
  };

  const submit = persistDocument({
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
  });

  const errorText = error === undefined ? undefined : documentErrorText(error, t);
  const heading = t(documentHeadingKey(mode));
  const setTerm = (key: keyof ContractDraft) => (value: string) =>
    setContract((current) => ({ ...current, [key]: value }));
  const linkableContracts = contracts;

  return (
    <SidePanel
      actions={
        <>
          <Button onClick={onClose} theme="outlined" variant="secondary">
            {t('facility-operations.common.cancel')}
          </Button>
          <Button
            isLoading={busy !== undefined}
            loadingText={busy === 'upload' ? t(`${k}.uploading`) : t('facility-operations.common.saving')}
            onClick={() => {
              browserRuntime.runFork(submit);
            }}
            variant="primary"
          >
            {t(`${k}.create.submit`)}
          </Button>
        </>
      }
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
      <div className="flex flex-col gap-250 py-200">
        {errorText !== undefined && (
          <StatusText showIcon status="error">
            {errorText}
          </StatusText>
        )}
        <DocumentFilePicker file={file} onFilePicked={pickFile} />
        {file === undefined && <p className="-mt-150 text-fg-secondary text-xs">{t(`${k}.create.noFile`)}</p>}
        <DocumentTextFields
          category={category}
          description={description}
          onCategoryChange={setCategory}
          onDescriptionChange={setDescription}
          onTitleChange={setTitle}
          problems={undefined}
          title={title}
        />
        <DocumentLinkFields
          category={category}
          contacts={contacts}
          invoices={invoices}
          linkableContracts={linkableContracts}
          links={links}
          onAddLink={addLink}
          onRemoveLink={removeLink}
          properties={properties}
          tasks={tasks}
        />
        {isContractCategory(category) && (
          <DocumentContractFields
            amends={amends}
            category={category}
            contract={contract}
            contracts={contracts}
            onAmendsChange={setAmends}
            onStatusChange={(status) => setContract((current) => ({ ...current, status }))}
            onTermChange={setTerm}
          />
        )}
      </div>
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
