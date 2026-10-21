// @effect-diagnostics asyncFunction:off
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
import { useEffect, useState } from 'react';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type {
  ContractStatus,
  ContractTerms,
  DocumentRecord,
  SubjectRef,
} from '../../../../../shared/domain/documents.ts';
import { documentLinks, sameSubject } from '../../../../../shared/domain/documents.ts';
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
  | { readonly kind: 'edit'; readonly document: DocumentRecord }
  | { readonly kind: 'amend'; readonly original: DocumentRecord };

interface ContractDraft {
  readonly contractType: string;
  readonly parties: string;
  readonly subject: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly amountTerms: string;
  readonly noticePeriod: string;
  readonly noticeDate: string;
  readonly owner: string;
  readonly status: ContractStatus;
}

const emptyContract: ContractDraft = {
  amountTerms: '',
  contractType: '',
  noticeDate: '',
  noticePeriod: '',
  owner: '',
  parties: '',
  status: 'draft',
  subject: '',
  validFrom: '',
  validTo: '',
};

const contractDraftOf = (terms: ContractTerms | undefined): ContractDraft =>
  terms === undefined
    ? emptyContract
    : {
        amountTerms: terms.amountTerms ?? '',
        contractType: terms.contractType,
        noticeDate: terms.noticeDate ?? '',
        noticePeriod: terms.noticePeriod ?? '',
        owner: terms.owner,
        parties: terms.parties.join('\n'),
        status: terms.status,
        subject: terms.subject ?? '',
        validFrom: terms.validFrom ?? '',
        validTo: terms.validTo ?? '',
      };

const optional = <Key extends string>(key: Key, value: string) =>
  (value.trim() === '' ? {} : { [key]: value.trim() }) as Partial<Record<Key, string>>;

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
    ...optional('subject', draft.subject),
    ...optional('validFrom', draft.validFrom),
    ...optional('validTo', draft.validTo),
    ...optional('amountTerms', draft.amountTerms),
    ...optional('noticePeriod', draft.noticePeriod),
    ...optional('noticeDate', draft.noticeDate),
  };
};

const isContractCategory = (category: string) => category === 'contract' || category === 'amendment';

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
  readonly tasks: TaskOptionsState;
  readonly mode: DocumentFormMode;
  readonly onClose: () => void;
  readonly onSaved: (documentId: string | undefined) => void;
  readonly open: boolean;
  readonly run: (command: OpsCommand) => Promise<CommandOutcome>;
}) => {
  const { t } = useModernI18n();
  const toast = useToast();
  const categoryLabel = useCategoryLabel();
  const properties = usePropertyOptions();
  const contacts = useContactOptions();
  const invoices = useInvoiceOptions();
  const [file, setFile] = useState<File | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('other');
  const [description, setDescription] = useState('');
  const [links, setLinks] = useState<readonly SubjectRef[]>([]);
  const [amends, setAmends] = useState(NONE);
  const [contract, setContract] = useState<ContractDraft>(emptyContract);
  const [busy, setBusy] = useState<'upload' | 'save' | undefined>(undefined);
  const [error, setError] = useState<FailureReason | 'required' | 'tooLarge' | 'upload' | undefined>(undefined);

  const modeKey =
    mode.kind === 'create' ? 'create' : mode.kind === 'edit' ? `edit:${mode.document.id}` : `amend:${mode.original.id}`;
  // Reset only when the panel opens or switches record (parent arrays are recreated on every render).
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by open + modeKey on purpose.
  useEffect(() => {
    if (!open) {
      return;
    }
    setFile(undefined);
    setError(undefined);
    if (mode.kind === 'edit') {
      setTitle(mode.document.title);
      setCategory(mode.document.category);
      setDescription(mode.document.description ?? '');
      setLinks(documentLinks(mode.document));
      setAmends(mode.document.amendsDocumentId ?? NONE);
      setContract(contractDraftOf(mode.document.contract));
    } else if (mode.kind === 'amend') {
      const count = contracts.filter((entry) => entry.amendsDocumentId === mode.original.id).length;
      setTitle(`Dodatek č. ${count + 1} – ${mode.original.title}`);
      setCategory('amendment');
      setDescription('');
      setLinks(documentLinks(mode.original).filter((link) => link.kind !== 'contract'));
      setAmends(mode.original.id);
      const base = contractDraftOf(mode.original.contract);
      setContract({ ...base, contractType: 'Dodatek ke smlouvě', status: 'draft', subject: '' });
    } else {
      setTitle('');
      setCategory('other');
      setDescription('');
      setLinks([]);
      setAmends(NONE);
      setContract(emptyContract);
    }
  }, [open, modeKey]);

  const addLink = (link: SubjectRef) =>
    setLinks((current) => (current.some((entry) => sameSubject(entry, link)) ? current : [...current, link]));

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
      setTitle(picked.name.replace(/\.[^.]+$/, '').replaceAll(/[_-]+/g, ' '));
    }
    if (category === 'other' && picked.type.startsWith('image/')) {
      setCategory('photo');
    }
  };

  const submit = async () => {
    const terms = isContractCategory(category) ? contractOf(contract) : undefined;
    if (
      title.trim() === '' ||
      (isContractCategory(category) && terms === undefined) ||
      (category === 'amendment' && amends === NONE)
    ) {
      setError('required');
      return;
    }
    setError(undefined);
    const common = {
      category,
      links: [...links],
      title: title.trim(),
      ...(description.trim() === '' ? {} : { description: description.trim() }),
      ...(terms === undefined ? {} : { contract: terms }),
    };
    if (mode.kind === 'edit') {
      setBusy('save');
      const outcome = await run({ _tag: 'DocumentUpdate', documentId: mode.document.id, ...common });
      setBusy(undefined);
      if (outcome.ok) {
        toast.create({ title: t(`${k}.updated`), type: 'success' });
        onSaved(mode.document.id);
      } else {
        setError(outcome.reason);
      }
      return;
    }
    let stored: Extract<Awaited<ReturnType<typeof uploadFile>>, { ok: true }>['file'] | undefined;
    if (file !== undefined) {
      setBusy('upload');
      const uploaded = await uploadFile(file);
      if (!uploaded.ok) {
        setBusy(undefined);
        setError(uploaded.reason === 'forbidden' ? 'forbidden' : 'upload');
        return;
      }
      stored = uploaded.file;
    }
    setBusy('save');
    const outcome = await run({
      _tag: 'DocumentCreate',
      ...common,
      ...(category === 'amendment' && amends !== NONE ? { amendsDocumentId: amends } : {}),
      ...(stored === undefined ? {} : { file: stored }),
    } as unknown as OpsCommand);
    setBusy(undefined);
    if (outcome.ok) {
      toast.create({ title: t(`${k}.created`), type: 'success' });
      onSaved(outcome.result.entityIds[0]);
    } else {
      setError(outcome.reason);
    }
  };

  const errorText = (() => {
    if (error === undefined) {
      return undefined;
    }
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
  })();

  const heading =
    mode.kind === 'edit'
      ? t(`${k}.create.editTitle`)
      : mode.kind === 'amend'
        ? t(`${k}.create.amendmentTitle`)
        : t(`${k}.create.title`);
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
            onClick={() => void submit()}
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
        {mode.kind !== 'edit' && (
          <label
            className={`flex cursor-pointer flex-col items-center gap-100 rounded-lg border-2 border-dashed px-200 py-300 text-center transition-colors ${dragging ? 'border-primary bg-primary-light' : 'border-border-primary bg-highlight hover:bg-surface'}`}
            data-testid="document-dropzone"
            onDragLeave={() => setDragging(false)}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              pickFile(event.dataTransfer.files[0]);
            }}
          >
            <input
              className="sr-only"
              data-testid="document-file-input"
              onChange={(event) => pickFile(event.target.files?.[0])}
              type="file"
            />
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
          </label>
        )}
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

        <fieldset className={`${surfaceTileClassName} facility-document-fieldset flex flex-col gap-150 p-200`}>
          <legend className="px-50 font-semibold text-sm">{t(`${k}.fields.links`)}</legend>
          <p className="text-fg-secondary text-xs">{t(`${k}.create.linksHelp`)}</p>
          {links.length > 0 && (
            <div className="flex flex-wrap gap-100">
              {links.map((link) => (
                <SubjectChip
                  key={`${link.kind}:${link.id}`}
                  onRemove={() => setLinks((current) => current.filter((entry) => !sameSubject(entry, link)))}
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
              placeholder={t('facility-operations.property.pick')}
              onValueChange={({ value }) => {
                const picked = properties.options.find((option) => option.value === value[0]);
                if (picked !== undefined) {
                  addLink(picked.ref);
                }
              }}
              size="md"
              value={[]}
            />
          )}
          {tasks.status === 'ready' && tasks.options.length > 0 && (
            <Select
              items={tasks.options.map((task) => ({ displayValue: task.label, label: task.label, value: task.id }))}
              label={t(`${k}.create.taskLink`)}
              name="document-link-task"
              placeholder={t(`${k}.create.pickTask`)}
              onValueChange={({ value }) => {
                const picked = tasks.options.find((task) => task.id === value[0]);
                if (picked !== undefined) addLink(picked);
              }}
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
              placeholder={t(`${k}.contract.pickOriginal`)}
              onValueChange={({ value }) => {
                const picked = linkableContracts.find((entry) => entry.id === value[0]);
                if (picked !== undefined) {
                  addLink({ id: picked.id, kind: 'document', label: picked.title });
                }
              }}
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
              placeholder={t(`${k}.create.pickContact`)}
              onValueChange={({ value }) => {
                const picked = contacts.options.find((option) => option.id === value[0]);
                if (picked !== undefined) addLink(picked);
              }}
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
              placeholder={t(`${k}.create.pickInvoice`)}
              onValueChange={({ value }) => {
                const picked = invoices.options.find((option) => option.id === value[0]);
                if (picked !== undefined) addLink(picked);
              }}
              size="md"
              value={[]}
            />
          )}
        </fieldset>

        {isContractCategory(category) && (
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
                  ...contracts
                    .filter((entry) => entry.category === 'contract')
                    .map((entry) => ({ displayValue: entry.title, label: entry.title, value: entry.id })),
                ]}
                label={t(`${k}.contract.amends`)}
                name="document-amends"
                onValueChange={({ value }) => setAmends(value[0] ?? NONE)}
                size="md"
                value={[amends]}
              />
            )}
            <div className="grid grid-cols-1 gap-150 sm:grid-cols-2">
              <FormInput
                id="contract-type"
                label={t(`${k}.contract.contractType`)}
                maxLength={120}
                onChange={(event) => setTerm('contractType')(event.target.value)}
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
                onValueChange={({ value }) => setTerm('status')((value[0] as ContractStatus | undefined) ?? 'draft')}
                size="md"
                value={[contract.status]}
              />
            </div>
            <FormTextarea
              helpText={t(`${k}.contract.partiesHelp`)}
              id="contract-parties"
              label={t(`${k}.contract.parties`)}
              onChange={(event) => setTerm('parties')(event.target.value)}
              required
              rows={2}
              value={contract.parties}
            />
            <FormInput
              id="contract-subject"
              label={t(`${k}.contract.subject`)}
              maxLength={1000}
              onChange={(event) => setTerm('subject')(event.target.value)}
              value={contract.subject}
            />
            <div className="grid grid-cols-1 gap-150 sm:grid-cols-2">
              <FormInput
                id="contract-valid-from"
                label={t(`${k}.contract.validFrom`)}
                onChange={(event) => setTerm('validFrom')(event.target.value)}
                type="date"
                value={contract.validFrom}
              />
              <FormInput
                id="contract-valid-to"
                label={t(`${k}.contract.validTo`)}
                onChange={(event) => setTerm('validTo')(event.target.value)}
                type="date"
                value={contract.validTo}
              />
              <FormInput
                id="contract-amount"
                label={t(`${k}.contract.amountTerms`)}
                maxLength={500}
                onChange={(event) => setTerm('amountTerms')(event.target.value)}
                value={contract.amountTerms}
              />
              <FormInput
                id="contract-owner"
                label={t(`${k}.contract.owner`)}
                maxLength={200}
                onChange={(event) => setTerm('owner')(event.target.value)}
                required
                value={contract.owner}
              />
              <FormInput
                id="contract-notice-period"
                label={t(`${k}.contract.noticePeriod`)}
                maxLength={300}
                onChange={(event) => setTerm('noticePeriod')(event.target.value)}
                value={contract.noticePeriod}
              />
              <FormInput
                id="contract-notice-date"
                label={t(`${k}.contract.noticeDate`)}
                onChange={(event) => setTerm('noticeDate')(event.target.value)}
                type="date"
                value={contract.noticeDate}
              />
            </div>
          </fieldset>
        )}
      </div>
    </SidePanel>
  );
};
