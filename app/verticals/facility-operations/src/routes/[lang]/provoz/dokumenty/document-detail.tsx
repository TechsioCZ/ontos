// Document detail side panel (S12): metadata, contract terms, links, amendments, preview, version history with
// authorised download, new version upload, manual signature record and the comment thread (S14).
import {
  DetailList,
  SectionCard,
  SidePanel,
  UnsavedChangesBoundary,
  requiredLabelFor,
  surfaceTileClassName,
  useUnsavedChangesScope,
} from '@app/admin-ui';
import {
  ChoiceField,
  FileField,
  FormBuilder,
  FormReact,
  FormRoot,
  TextField,
  useAtomSet,
  useAtomSubscribe,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect, Option, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import { useRef, useState } from 'react';
import { optionalField } from '../../../../../shared/domain/common.ts';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type {
  ContractTerms,
  DocumentRecord,
  StoredFileRef,
  SubjectRef,
} from '../../../../../shared/domain/documents.ts';
import { documentLinks } from '../../../../../shared/domain/documents.ts';
import { CommentThread } from '../../../../ui/comment-thread.tsx';
import { ChangeHistory } from '../../../../ui/change-history.tsx';
import {
  CategoryBadge,
  FileTypeIcon,
  formatBytes,
  formatIsoDate,
  formatWhen,
  SubjectChip,
} from '../../../../ui/documents-kit.tsx';
import { canPreview, DownloadButton, FilePreviewBody, FilePreviewDialog } from '../../../../ui/file-preview.tsx';
import type { CommandOutcome, FailureReason, useAgendaRecords } from '../../../../ui/use-agenda.ts';
import { MAX_UPLOAD_BYTES, uploadFile } from '../../../../ui/use-agenda.ts';
import { ContractStatusBadge } from './documents-model.tsx';
import { FormSaveFooter, commandResult, useFormSave } from '../../../../ui/form-save.tsx';
import type { FormSubmitResult } from '../../../../ui/form-save.tsx';
import { useFormValues } from '../../../../ui/form-values.tsx';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';

/** Detail actions: a full-width half of the phone grid with a compact label, their own width from `sm`. */
const detailActionClassName = 'w-full min-w-0 whitespace-nowrap px-2 text-sm sm:w-auto sm:px-5 sm:text-md';
const k = 'facility-operations.documents';
const notProvidedKey = 'facility-operations.common.notProvided';

const documentSubjectOpener = (onOpenDocument: (id: string) => void) => (subject: SubjectRef) => {
  if (subject.kind === 'document') {
    onOpenDocument(subject.id);
  }
};

const uploadDocumentVersion = Effect.fn('Documents.uploadVersion')(function* uploadDocumentVersion({
  document,
  file,
  note,
  onBusy,
  onFailure,
  onPersisted,
  run,
}: {
  readonly document: DocumentRecord;
  readonly file: File | undefined;
  readonly note: string;
  readonly onBusy: (busy?: 'upload' | 'save') => void;
  readonly onFailure: (failure?: FailureReason | 'upload') => void;
  readonly onPersisted: (version: number) => void;
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
}) {
  if (file === undefined) {
    return 'failed' as const;
  }
  onFailure();
  onBusy('upload');
  const uploaded = yield* uploadFile(file);
  if (!uploaded.ok) {
    onBusy();
    onFailure(uploaded.reason === 'forbidden' ? 'forbidden' : 'upload');
    return 'failed' as const;
  }
  onBusy('save');
  const outcome = yield* run({
    _tag: 'DocumentVersionAdd',
    documentId: document.id,
    file: uploaded.file,
    ...optionalField('note', note.trim() === '' ? undefined : note.trim()),
  });
  onBusy();
  return commandResult(
    outcome,
    () => {
      let highest = 0;
      for (const entry of document.versions) {
        highest = Math.max(highest, entry.version);
      }
      onPersisted(highest + 1);
    },
    onFailure,
  );
});

const recordDocumentSignature = Effect.fn('Documents.recordSignature')(function* recordDocumentSignature({
  documentId,
  onClear,
  onDone,
  onFailure,
  onPersisted,
  run,
  signedBy,
  signedOnInput,
  version,
}: {
  readonly documentId: DocumentRecord['id'];
  readonly onClear: () => void;
  readonly onDone: () => void;
  readonly onFailure: (failure: FailureReason | 'required') => void;
  readonly onPersisted: () => void;
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
  readonly signedBy: string;
  readonly signedOnInput: string;
  readonly version: string;
}) {
  if (signedBy.trim() === '' || signedOnInput === '') {
    onFailure('required');
    return 'failed' as const;
  }
  onClear();
  const outcome = yield* run({
    _tag: 'DocumentSignatureRecord',
    documentId,
    signedBy: signedBy.trim(),
    signedOn: signedOnInput,
    version: Number(version),
  });
  return commandResult(
    outcome,
    () => {
      onPersisted();
      onDone();
    },
    onFailure,
  );
});

/** The draft of a new version: its file and note. */
interface VersionDraft {
  readonly file?: File | undefined;
  readonly note: string;
}

/** A new version before a file is picked. */
const emptyVersionDraft: VersionDraft = { note: '' };

/** A new version's file and note; Uložit sends them through the form save, so Enter sends nothing. */
const versionForm = FormReact.make(
  FormBuilder.empty.addField('file', Schema.OptionFromNullOr(Schema.instanceOf(File))).addField('note', Schema.String),
  { fields: { file: FileField, note: TextField }, onSubmit: () => Effect.void, runtime: browserAtomRuntime },
);
const noVersion = { file: null, note: '' };
/** The picked file, which changes only when the pick does. */
const pickedVersionFile = versionForm
  .getFieldAtoms(versionForm.fields.file)
  .value.pipe(Atom.map(Option.getOrElse((): File | null => null)));

/** A manual signature; Uložit sends it through the form save, so Enter sends nothing. */
const signatureForm = FormReact.make(
  FormBuilder.empty
    .addField('signedBy', Schema.String)
    .addField('signedOn', Schema.String)
    .addField('version', Schema.String),
  {
    fields: { signedBy: TextField, signedOn: TextField, version: ChoiceField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

/** The new-version form of the version history (exported for its mounted test). */
export const VersionUpload = ({
  document,
  run,
}: {
  readonly document: DocumentRecord;
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
}) => {
  const { t } = useModernI18n();
  const toast = useToast();
  const { ready, values } = useFormValues(versionForm, noVersion);
  const file = values.file ?? undefined;
  const { note } = values;
  const setValues = useAtomSet(versionForm.setValues);
  const setFile = useAtomSet(versionForm.getFieldAtoms(versionForm.fields.file).setValue);
  const [busy, setBusy] = useState<'upload' | 'save' | undefined>();
  const [error, setError] = useState<string | undefined>();
  const newVersionLabel = t(`${k}.detail.newVersion`);
  // A picked file that is too large is refused and the file before it stays.
  const accepted = useRef<File | null>(null);
  useAtomSubscribe(
    pickedVersionFile,
    (picked) => {
      if (picked !== null && picked !== accepted.current && picked.size > MAX_UPLOAD_BYTES) {
        setError(t(`${k}.tooLarge`));
        setFile(accepted.current);
        return;
      }
      if (picked !== accepted.current) {
        setError(undefined);
      }
      accepted.current = picked;
    },
    { immediate: false },
  );

  // A new version is sent on Uložit only, with its file and note.
  const form = useFormSave<VersionDraft>({
    isValid: (value) => value.file !== undefined,
    onDiscard: () => {
      setValues(noVersion);
      setError(undefined);
    },
    onStartOver: () => {
      setValues(noVersion);
      return emptyVersionDraft;
    },
    submit: () =>
      uploadDocumentVersion({
        document,
        file,
        note,
        onBusy: setBusy,
        onFailure: (failure) => {
          if (failure === undefined) {
            setError(undefined);
          } else if (failure === 'upload') {
            setError(t(`${k}.uploadFailed`));
          } else {
            setError(t(`facility-operations.common.errors.${failure}`));
          }
        },
        onPersisted: (next) => {
          toast.create({ title: t(`${k}.detail.versionSaved`, { version: next }), type: 'success' });
        },
        run,
      }).pipe(
        Effect.catchTag('FileReadFailed', () =>
          Effect.sync((): FormSubmitResult => {
            setBusy(undefined);
            setError(t(`${k}.uploadFailed`));
            return 'failed';
          }),
        ),
      ),
    value: { file, note },
  });

  return (
    <FormRoot
      className="flex flex-col gap-100 rounded-lg border border-border-primary border-dashed p-150"
      defaultValues={noVersion}
      form={versionForm}
      translateMessage={(message) => t(message)}
    >
      {ready}
      {error !== undefined && (
        <StatusText showIcon status="error">
          {error}
        </StatusText>
      )}
      <div className="flex flex-wrap items-center gap-150">
        <label className="cursor-pointer">
          <versionForm.file data-testid="version-file-input" />
          <span className="inline-flex items-center gap-100 rounded-md border border-border-primary bg-surface px-150 py-100 font-medium text-sm hover:bg-highlight">
            ⇪ {file === undefined ? `${newVersionLabel}…` : t(`${k}.create.replace`)}
          </span>
        </label>
        {file !== undefined && (
          <span className="text-sm">
            {file.name} <span className="text-fg-secondary">· {formatBytes(file.size)}</span>
          </span>
        )}
      </div>
      {file !== undefined && (
        <versionForm.note
          id="version-note"
          label={t(`${k}.detail.versionNote`)}
          maxLength={4000}
          placeholder={t(`${k}.detail.versionNotePlaceholder`)}
        />
      )}
      <FormSaveFooter error={error} form={form}>
        {busy === 'upload' && <StatusText size="sm">{t(`${k}.uploading`)}</StatusText>}
      </FormSaveFooter>
    </FormRoot>
  );
};

/** The manual signature form of the signature card (exported for its mounted test). */
export const SignatureForm = ({
  document,
  onDone,
  run,
}: {
  readonly document: DocumentRecord;
  readonly onDone: () => void;
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
}) => {
  const { language, t } = useModernI18n();
  const toast = useToast();
  const latest = document.versions.at(-1)?.version ?? 1;
  const opened = { signedBy: '', signedOn: '', version: String(latest) };
  const { ready, values } = useFormValues(signatureForm, opened);
  const { signedBy, signedOn } = values;
  // No choice reads as the latest version, as the picker did.
  const version = values.version === '' ? String(latest) : values.version;
  const setValues = useAtomSet(signatureForm.setValues);
  const requiredLabel = requiredLabelFor(language);
  const [error, setError] = useState<FailureReason | 'required' | undefined>();
  const errorText =
    error === undefined
      ? undefined
      : t(error === 'required' ? 'facility-operations.common.required' : `facility-operations.common.errors.${error}`);
  // The signature is recorded on Uložit only; the version it opens with is not typed input.
  const form = useFormSave({
    onDiscard: () => {
      setValues({ signedBy: '', signedOn: '', version: String(latest) });
      setError(undefined);
    },
    submit: () =>
      recordDocumentSignature({
        documentId: document.id,
        onClear: () => setError(undefined),
        onDone,
        onFailure: setError,
        onPersisted: () => {
          toast.create({ title: t(`${k}.signature.saved`), type: 'success' });
        },
        run,
        signedBy,
        signedOnInput: signedOn,
        version,
      }),
    value: { signedBy, signedOn, version },
  });

  return (
    <FormRoot
      className={`${surfaceTileClassName} flex flex-col gap-150 p-150`}
      defaultValues={opened}
      form={signatureForm}
      translateMessage={(message) => t(message)}
    >
      {ready}
      {errorText !== undefined && (
        <StatusText showIcon status="error">
          {errorText}
        </StatusText>
      )}
      <div className="grid grid-cols-1 gap-150 sm:grid-cols-3">
        <signatureForm.signedBy
          id="signature-by"
          label={t(`${k}.signature.signedBy`)}
          maxLength={300}
          required
          requiredLabel={requiredLabel}
        />
        <signatureForm.signedOn
          id="signature-on"
          label={t(`${k}.signature.signedOn`)}
          required
          requiredLabel={requiredLabel}
          type="date"
        />
        <signatureForm.version
          items={document.versions.map((entry) => ({
            label: t(`${k}.detail.versionLabel`, { version: entry.version }),
            value: String(entry.version),
          }))}
          label={t(`${k}.signature.version`)}
        />
      </div>
      <span className="text-fg-secondary text-xs">{t(`${k}.signature.manualNote`)}</span>
      <FormSaveFooter
        cancelLabel={t('facility-operations.common.cancel')}
        error={errorText}
        form={form}
        onCancel={onDone}
      />
    </FormRoot>
  );
};

const DocumentMetadata = ({
  document,
  onOpenDocument,
}: {
  readonly document: DocumentRecord;
  readonly onOpenDocument: (id: string) => void;
}) => {
  const { t } = useModernI18n();
  const current = document.versions.at(-1);
  const links = documentLinks(document);
  const openSubject = documentSubjectOpener(onOpenDocument);
  return (
    <SectionCard title={t(`${k}.detail.info`)}>
      <DetailList
        items={[
          { label: t(`${k}.fields.category`), value: <CategoryBadge category={document.category} /> },
          {
            label: t(`${k}.fields.currentVersion`),
            value:
              current === undefined
                ? t(`${k}.noFileYet`)
                : `v${current.version} · ${current.file.name} · ${formatBytes(current.file.size)}`,
          },
          {
            label: t('facility-operations.common.createdAt'),
            value: formatWhen(document.createdAt),
          },
          {
            label: t(`${k}.fields.lastChange`),
            value: formatWhen(document.updatedAt),
          },
          ...(document.description === undefined
            ? []
            : [{ label: t(`${k}.fields.description`), value: document.description }]),
        ]}
      />
      {links.length > 0 && (
        <div className="flex flex-col gap-100">
          <span className="text-fg-secondary text-xs">{t(`${k}.fields.links`)}</span>
          <div className="flex flex-wrap gap-100">
            {links.map((link) =>
              link.kind === 'document' ? (
                <Button
                  composition
                  key={`${link.kind}:${link.id}`}
                  onClick={() => openSubject(link)}
                  size="current"
                  unstyled
                >
                  <SubjectChip subject={link} />
                </Button>
              ) : (
                <SubjectChip key={`${link.kind}:${link.id}`} subject={link} />
              ),
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
};

const DocumentContractInfo = ({ contract }: { readonly contract: ContractTerms }) => {
  const { t } = useModernI18n();
  const notProvided = t(notProvidedKey);
  const validityLabel = [
    formatIsoDate(contract.validFrom, notProvided),
    contract.validTo === undefined ? t(`${k}.contract.indefinite`) : formatIsoDate(contract.validTo, notProvided),
  ].join(' – ');
  return (
    <SectionCard title={t(`${k}.contract.section`)}>
      <DetailList
        items={[
          { label: t(`${k}.contract.contractType`), value: contract.contractType },
          { label: t(`${k}.contract.status`), value: <ContractStatusBadge status={contract.status} /> },
          { label: t(`${k}.contract.parties`), value: contract.parties.join(' · ') },
          { label: t(`${k}.contract.subject`), value: contract.subject ?? notProvided },
          {
            label: t(`${k}.contract.validity`),
            value: validityLabel,
          },
          { label: t(`${k}.contract.amountTerms`), value: contract.amountTerms ?? notProvided },
          { label: t(`${k}.contract.noticePeriod`), value: contract.noticePeriod ?? notProvided },
          { label: t(`${k}.contract.noticeDate`), value: formatIsoDate(contract.noticeDate, notProvided) },
          { label: t(`${k}.contract.owner`), value: contract.owner },
        ]}
      />
    </SectionCard>
  );
};

const DocumentAmendments = ({
  amendments,
  canWrite,
  document,
  onAmend,
  onOpenDocument,
}: {
  readonly amendments: readonly DocumentRecord[];
  readonly canWrite: boolean;
  readonly document: DocumentRecord;
  readonly onAmend: (document: DocumentRecord) => void;
  readonly onOpenDocument: (id: string) => void;
}) => {
  const { t } = useModernI18n();
  const notProvided = t(notProvidedKey);
  return (
    <SectionCard
      actions={
        canWrite && document.category === 'contract' ? (
          <Button appearance="outline" onClick={() => onAmend(document)} severity="secondary" size="sm">
            {t(`${k}.contract.createAmendment`)}
          </Button>
        ) : undefined
      }
      title={t(`${k}.contract.amendments`)}
    >
      {amendments.length === 0 ? (
        <p className="text-fg-secondary text-sm">{t(`${k}.contract.noAmendments`)}</p>
      ) : (
        <ul className="flex flex-col gap-100">
          {amendments.map((amendment) => (
            <li className="flex items-center justify-between gap-100" key={amendment.id}>
              <Button
                className="justify-start text-left font-medium text-sm hover:underline"
                composition
                onClick={() => onOpenDocument(amendment.id)}
                size="current"
                unstyled
              >
                {amendment.title}
              </Button>
              <span className="flex items-center gap-100">
                {amendment.contract?.validFrom !== undefined && (
                  <span className="text-fg-secondary text-xs">
                    {t(`${k}.contract.validFrom`)} {formatIsoDate(amendment.contract.validFrom, notProvided)}
                  </span>
                )}
                <CategoryBadge category={amendment.category} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
};

const DocumentVersionHistory = ({
  canWrite,
  document,
  onPreview,
  run,
}: {
  readonly canWrite: boolean;
  readonly document: DocumentRecord;
  readonly onPreview: (file: StoredFileRef) => void;
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
}) => {
  const { t } = useModernI18n();
  const historyLabel = t(`${k}.detail.history`);
  const versionsNewestFirst = document.versions.toReversed();
  return (
    <SectionCard title={`${historyLabel} (${document.versions.length})`}>
      {canWrite && <VersionUpload document={document} key={document.id} run={run} />}
      {versionsNewestFirst.length === 0 ? (
        <p className="text-fg-secondary text-sm">{t(`${k}.detail.noVersions`)}</p>
      ) : (
        <ol className="flex flex-col" data-testid="version-history">
          {versionsNewestFirst.map((version, index) => (
            <li
              className="flex flex-wrap items-center gap-150 border-border-primary border-b py-150 last:border-b-0"
              key={version.version}
            >
              <FileTypeIcon mime={version.file.mime} name={version.file.name} />
              <div className="flex min-w-0 flex-1 flex-col gap-50">
                <span className="flex flex-wrap items-center gap-100">
                  <span className="font-semibold text-sm">
                    {t(`${k}.detail.versionLabel`, { version: version.version })}
                  </span>
                  {index === 0 && (
                    <Badge severity="info" size="sm">
                      {t(`${k}.detail.current`)}
                    </Badge>
                  )}
                  {document.signature?.version === version.version && (
                    <Badge severity="success" size="sm">
                      {t(`${k}.signature.signedVersion`)}
                    </Badge>
                  )}
                </span>
                <span className="truncate text-sm">
                  {version.file.name} <span className="text-fg-secondary">· {formatBytes(version.file.size)}</span>
                </span>
                <span className="text-fg-secondary text-xs">
                  {t(`${k}.detail.uploadedLine`, {
                    when: formatWhen(version.uploadedAt),
                  })}
                </span>
                {version.note !== undefined && <span className="text-xs italic">„{version.note}“</span>}
              </div>
              <span className="flex gap-100">
                {canPreview(version.file) && (
                  <Button appearance="ghost" onClick={() => onPreview(version.file)} severity="secondary" size="sm">
                    {t(`${k}.preview`)}
                  </Button>
                )}
                <DownloadButton file={version.file} />
              </span>
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
};

const DocumentSignatureCard = ({
  canWrite,
  document,
  run,
}: {
  readonly canWrite: boolean;
  readonly document: DocumentRecord;
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
}) => {
  const { t } = useModernI18n();
  const notProvided = t(notProvidedKey);
  const [signing, setSigning] = useState(false);
  return (
    <SectionCard
      actions={
        canWrite && document.versions.length > 0 && !signing ? (
          <Button appearance="outline" onClick={() => setSigning(true)} severity="secondary" size="sm">
            {t(`${k}.signature.record`)}
          </Button>
        ) : undefined
      }
      title={t(`${k}.signature.section`)}
    >
      {document.signature === undefined ? (
        <p className="text-fg-secondary text-sm">
          {document.versions.length === 0 ? t(`${k}.signature.needVersion`) : t(`${k}.signature.none`)}
        </p>
      ) : (
        <DetailList
          items={[
            { label: t(`${k}.signature.signedBy`), value: document.signature.signedBy },
            { label: t(`${k}.signature.signedOn`), value: formatIsoDate(document.signature.signedOn, notProvided) },
            {
              label: t(`${k}.signature.version`),
              value: t(`${k}.detail.versionLabel`, { version: document.signature.version }),
            },
            {
              label: t('facility-operations.common.createdAt'),
              value: t(`${k}.signature.recordedAt`, {
                when: formatWhen(document.signature.recordedAt),
              }),
            },
          ]}
        />
      )}
      {signing && <SignatureForm document={document} key={document.id} onDone={() => setSigning(false)} run={run} />}
    </SectionCard>
  );
};

export const DocumentDetailPanel = ({
  amendments,
  canWrite,
  document,
  onAmend,
  onClose,
  onEdit,
  onOpenDocument,
  original,
  records,
  run,
}: {
  readonly amendments: readonly DocumentRecord[];
  readonly canWrite: boolean;
  readonly document: DocumentRecord | undefined;
  readonly onAmend: (original: DocumentRecord) => void;
  readonly onClose: () => void;
  readonly onEdit: (document: DocumentRecord) => void;
  readonly onOpenDocument: (documentId: string) => void;
  readonly original: DocumentRecord | undefined;
  readonly records: ReturnType<typeof useAgendaRecords>;
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
}) => {
  const { t } = useModernI18n();
  const [preview, setPreview] = useState<StoredFileRef | undefined>();
  const notProvided = t(notProvidedKey);
  // Every way out of the detail asks the forms inside it (new version, signature) before their input is lost.
  const scope = useUnsavedChangesScope();

  if (document === undefined) {
    return null;
  }
  const current = document.versions.at(-1);
  const { contract } = document;
  const leaveTo = (leave: () => void) => () => scope.request(leave);
  const openDocument = (documentId: string) => scope.request(() => onOpenDocument(documentId));
  const openSubject = documentSubjectOpener(openDocument);

  return (
    <UnsavedChangesBoundary scope={scope}>
      <SidePanel
        actions={
          // Keep full Czech action labels inside their outlines at 390px: two columns, a third action on its own row.
          <div className="grid w-full grid-cols-2 gap-3 sm:flex sm:justify-end">
            {canWrite && (
              <Button
                appearance="outline"
                className={detailActionClassName}
                onClick={leaveTo(() => onEdit(document))}
                severity="secondary"
              >
                {t(`${k}.detail.edit`)}
              </Button>
            )}
            {canWrite && document.category === 'contract' && (
              <Button
                appearance="outline"
                className={detailActionClassName}
                onClick={leaveTo(() => onAmend(document))}
                severity="secondary"
              >
                {t(`${k}.contract.createAmendment`)}
              </Button>
            )}
            <Button
              className={`${detailActionClassName}${canWrite && document.category === 'contract' ? ' col-span-2' : ''}`}
              onClick={leaveTo(onClose)}
              severity="primary"
            >
              {t('facility-operations.common.close')}
            </Button>
          </div>
        }
        description={
          <span className="flex flex-wrap items-center gap-100">
            <CategoryBadge category={document.category} />
            {contract !== undefined && <ContractStatusBadge status={contract.status} />}
            {document.signature !== undefined && (
              <Badge severity="success" size="sm">
                {t(`${k}.signature.signed`, { date: formatIsoDate(document.signature.signedOn, notProvided) })}
              </Badge>
            )}
            <span className="text-fg-secondary text-xs">
              {t(`${k}.fields.lastChange`)}: {formatWhen(document.updatedAt)}
            </span>
          </span>
        }
        onOpenChange={(next) => {
          if (!next) {
            onClose();
          }
        }}
        open
        resizeLabel={t('facility-operations.common.close')}
        size="xl"
        title={document.title}
      >
        <div className="flex flex-col gap-250 py-200" data-testid="document-detail">
          {original !== undefined && (
            <Button
              className="w-fit justify-start rounded-md bg-info-light px-150 py-100 text-left text-sm hover:underline"
              composition
              onClick={() => openDocument(original.id)}
              size="current"
              unstyled
            >
              ↳ {t(`${k}.contract.amendmentOf`, { title: original.title })}
            </Button>
          )}
          {current !== undefined && canPreview(current.file) && (
            <SectionCard
              actions={<DownloadButton file={current.file} />}
              title={[t(`${k}.preview`), t(`${k}.detail.versionLabel`, { version: current.version })].join(' · ')}
            >
              <FilePreviewBody file={current.file} height="panel" />
            </SectionCard>
          )}

          <DocumentMetadata document={document} onOpenDocument={openDocument} />

          {contract !== undefined && <DocumentContractInfo contract={contract} />}

          {(document.category === 'contract' || amendments.length > 0) && (
            <DocumentAmendments
              amendments={amendments}
              canWrite={canWrite}
              document={document}
              onAmend={(amended) => scope.request(() => onAmend(amended))}
              onOpenDocument={openDocument}
            />
          )}

          <DocumentVersionHistory canWrite={canWrite} document={document} onPreview={setPreview} run={run} />

          <DocumentSignatureCard canWrite={canWrite} document={document} run={run} />

          <SectionCard>
            <CommentThread
              onOpenAttachment={openSubject}
              records={records}
              subject={{ id: document.id, kind: 'document', label: document.title }}
              title={t(`${k}.detail.comments`)}
            />
          </SectionCard>

          <SectionCard>
            <ChangeHistory entityId={document.id} refreshKey={document.updatedAt} />
          </SectionCard>
        </div>
        <FilePreviewDialog file={preview} onClose={() => setPreview(undefined)} />
      </SidePanel>
    </UnsavedChangesBoundary>
  );
};
