import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// Create / edit / amendment form for the documents agenda (S12). Upload goes through the governed FileUpload command
// first; the returned file snapshot becomes version 1 of the new document.
import { SidePanel, surfaceTileClassName } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { Effect, Option, Result, Schema } from 'effect';
import { useRef, useState } from 'react';
import { OpsCommandSchema } from '../../../../../shared/agendas.ts';
import { optionalField } from '../../../../../shared/domain/common.ts';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type {
  ContractStatus,
  ContractTerms,
  DocumentRecord,
  SubjectRef,
  StoredFileRef,
} from '../../../../../shared/domain/documents.ts';
import { ContractStatusSchema, documentLinks, sameSubject } from '../../../../../shared/domain/documents.ts';
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
const NONE = '__none__';
const statuses: readonly ContractStatus[] = ['draft', 'active', 'terminated', 'expired'];

export type DocumentFormMode =
  | { readonly kind: 'create' }
  | { readonly document: DocumentRecord; readonly kind: 'edit' }
  | { readonly kind: 'amend'; readonly original: DocumentRecord };

interface ContractDraft {
  readonly amountTerms: string;
  readonly contractType: string;
  readonly noticeDateInput: string;
  readonly noticePeriod: string;
  readonly owner: string;
  readonly parties: string;
  readonly status: ContractStatus;
  readonly subject: string;
  readonly validFromInput: string;
  readonly validToInput: string;
}

const emptyContract: ContractDraft = {
  amountTerms: '',
  contractType: '',
  noticeDateInput: '',
  noticePeriod: '',
  owner: '',
  parties: '',
  status: 'draft',
  subject: '',
  validFromInput: '',
  validToInput: '',
};

const contractDraftOf = (terms: ContractTerms | undefined): ContractDraft =>
  terms === undefined
    ? emptyContract
    : {
        amountTerms: terms.amountTerms ?? '',
        contractType: terms.contractType,
        noticeDateInput: terms.noticeDate ?? '',
        noticePeriod: terms.noticePeriod ?? '',
        owner: terms.owner,
        parties: terms.parties.join('\n'),
        status: terms.status,
        subject: terms.subject ?? '',
        validFromInput: terms.validFrom ?? '',
        validToInput: terms.validTo ?? '',
      };

const contractOf = (draft: ContractDraft): ContractTerms | undefined => {
  const parties = draft.parties
    .split('\n')
    .map((party) => party.trim())
    .filter((party) => party !== '');
  if (draft.contractType.trim() === '' || draft.owner.trim() === '' || parties.length === 0) {
    return undefined;
  }
  return {
    contractType: draft.contractType.trim(),
    owner: draft.owner.trim(),
    parties,
    status: draft.status,
    ...optionalField('subject', draft.subject.trim() === '' ? undefined : draft.subject.trim()),
    ...optionalField('validFrom', draft.validFromInput.trim() === '' ? undefined : draft.validFromInput.trim()),
    ...optionalField('validTo', draft.validToInput.trim() === '' ? undefined : draft.validToInput.trim()),
    ...optionalField('amountTerms', draft.amountTerms.trim() === '' ? undefined : draft.amountTerms.trim()),
    ...optionalField('noticePeriod', draft.noticePeriod.trim() === '' ? undefined : draft.noticePeriod.trim()),
    ...optionalField('noticeDate', draft.noticeDateInput.trim() === '' ? undefined : draft.noticeDateInput.trim()),
  };
};

const isContractCategory = (category: string) => category === 'contract' || category === 'amendment';

export const documentFormKey = (mode: DocumentFormMode): string => {
  if (mode.kind === 'edit') {
    return `edit:${mode.document.id}`;
  }
  if (mode.kind === 'amend') {
    return `amend:${mode.original.id}`;
  }
  return 'create';
};
const initialDocumentForm = (mode: DocumentFormMode, contracts: readonly DocumentRecord[]) => {
  if (mode.kind === 'edit') {
    return {
      amends: mode.document.amendsDocumentId ?? NONE,
      category: mode.document.category,
      contract: contractDraftOf(mode.document.contract),
      description: mode.document.description ?? '',
      links: documentLinks(mode.document),
      title: mode.document.title,
    };
  }
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
  mode,
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
  readonly mode: DocumentFormMode;
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
  if (mode.kind === 'edit') {
    onBusy('save');
    const outcome = yield* run({ _tag: 'DocumentUpdate', documentId: mode.document.id, ...common });
    onBusy();
    if (outcome.ok) {
      onPersisted(mode.document.id, 'updated');
    } else {
      onFailure(outcome.reason);
    }
    return;
  }
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
  category,
  contract,
  contracts,
  onAmendsChange,
  onStatusChange,
  onTermChange,
}: {
  readonly amends: string;
  readonly category: string;
  readonly contract: ContractDraft;
  readonly contracts: readonly DocumentRecord[];
  readonly onAmendsChange: (value: string) => void;
  readonly onStatusChange: (status: ContractStatus) => void;
  readonly onTermChange: (key: keyof ContractDraft) => (value: string) => void;
}) => {
  const { t } = useModernI18n();
  return (
    <fieldset className={`${surfaceTileClassName} facility-document-fieldset flex flex-col gap-150 p-200`}>
      <legend className="px-50 font-semibold text-sm">{t(`${k}.contract.section`)}</legend>
      {category === 'amendment' && (
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
          placeholder="Nájemní smlouva"
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
}) => {
  const { t } = useModernI18n();
  const toast = useToast();
  const categoryLabel = useCategoryLabel();
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
    mode,
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
  const linkableContracts = contracts.filter((entry) => !(mode.kind === 'edit' && entry.id === mode.document.id));

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
            {mode.kind === 'edit' ? t(`${k}.create.editSubmit`) : t(`${k}.create.submit`)}
          </Button>
        </>
      }
      closeOnInteractOutside={false}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open={open}
      resizeLabel={t('facility-operations.common.close')}
      size="lg"
      title={heading}
    >
      <div className="flex flex-col gap-250 py-200">
        {errorText !== undefined && (
          <StatusText showIcon status="error">
            {errorText}
          </StatusText>
        )}
        {mode.kind !== 'edit' && <DocumentFilePicker file={file} onFilePicked={pickFile} />}
        {mode.kind !== 'edit' && file === undefined && (
          <p className="-mt-150 text-fg-secondary text-xs">{t(`${k}.create.noFile`)}</p>
        )}
        <FormInput
          autoComplete="off"
          id="document-title"
          label={t(`${k}.fields.title`)}
          maxLength={300}
          onChange={(event) => setTitle(event.target.value)}
          required
          value={title}
        />
        <Select
          items={documentCategories.map((value) => ({
            displayValue: categoryLabel(value),
            label: categoryLabel(value),
            value,
          }))}
          label={t(`${k}.fields.category`)}
          name="document-category"
          onValueChange={({ value }) => setCategory(value[0] ?? 'other')}
          size="md"
          value={[category]}
        />
        <FormTextarea
          id="document-description"
          label={t(`${k}.fields.description`)}
          maxLength={4000}
          onChange={(event) => setDescription(event.target.value)}
          rows={2}
          value={description}
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
