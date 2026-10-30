import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
// Document detail side panel (S12): metadata, contract terms, links, amendments, preview, version history with
// authorised download, new version upload, manual signature record and the comment thread (S14).
import { DetailList, SectionCard, SidePanel, surfaceTileClassName } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { Effect } from 'effect';
import { useState } from 'react';
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
  onFileChange,
  onNoteChange,
  onPersisted,
  run,
}: {
  readonly document: DocumentRecord;
  readonly file: File | undefined;
  readonly note: string;
  readonly onBusy: (busy?: 'upload' | 'save') => void;
  readonly onFailure: (failure?: FailureReason | 'upload') => void;
  readonly onFileChange: (file?: File) => void;
  readonly onNoteChange: (note: string) => void;
  readonly onPersisted: (version: number) => void;
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
}) {
  if (file === undefined) {
    return;
  }
  onFailure();
  onBusy('upload');
  const uploaded = yield* uploadFile(file);
  if (!uploaded.ok) {
    onBusy();
    onFailure('upload');
    return;
  }
  onBusy('save');
  const outcome = yield* run({
    _tag: 'DocumentVersionAdd',
    documentId: document.id,
    file: uploaded.file,
    ...optionalField('note', note.trim() === '' ? undefined : note.trim()),
  });
  onBusy();
  if (outcome.ok) {
    let highest = 0;
    for (const entry of document.versions) {
      highest = Math.max(highest, entry.version);
    }
    const next = highest + 1;
    onPersisted(next);
    onFileChange();
    onNoteChange('');
  } else {
    onFailure(outcome.reason);
  }
});

const recordDocumentSignature = Effect.fn('Documents.recordSignature')(function* recordDocumentSignature({
  documentId,
  onBusy,
  onDone,
  onFailure,
  onPersisted,
  run,
  signedBy,
  signedOnInput,
  version,
}: {
  readonly documentId: DocumentRecord['id'];
  readonly onBusy: (busy: boolean) => void;
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
    return;
  }
  onBusy(true);
  const outcome = yield* run({
    _tag: 'DocumentSignatureRecord',
    documentId,
    signedBy: signedBy.trim(),
    signedOn: signedOnInput,
    version: Number(version),
  });
  onBusy(false);
  if (outcome.ok) {
    onPersisted();
    onDone();
  } else {
    onFailure(outcome.reason);
  }
});

const VersionUpload = ({
  document,
  run,
}: {
  readonly document: DocumentRecord;
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
}) => {
  const { t } = useModernI18n();
  const toast = useToast();
  const [file, setFile] = useState<File | undefined>();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'upload' | 'save' | undefined>();
  const [error, setError] = useState<string | undefined>();
  const newVersionLabel = t(`${k}.detail.newVersion`);

  const submit = uploadDocumentVersion({
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
    onFileChange: setFile,
    onNoteChange: setNote,
    onPersisted: (next) => {
      toast.create({ title: t(`${k}.detail.versionSaved`, { version: next }), type: 'success' });
    },
    run,
  });

  return (
    <div className="flex flex-col gap-100 rounded-lg border border-border-primary border-dashed p-150">
      {error !== undefined && (
        <StatusText showIcon status="error">
          {error}
        </StatusText>
      )}
      <div className="flex flex-wrap items-center gap-150">
        <label className="cursor-pointer">
          <input
            className="sr-only"
            data-testid="version-file-input"
            onChange={(event) => {
              const picked = event.target.files?.[0];
              if (picked !== undefined && picked.size > MAX_UPLOAD_BYTES) {
                setError(t(`${k}.tooLarge`));
                return;
              }
              setError(undefined);
              setFile(picked);
            }}
            type="file"
          />
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
        <div className="flex flex-wrap items-end gap-100">
          <div className="min-w-0 flex-1">
            <FormInput
              id="version-note"
              label={t(`${k}.detail.versionNote`)}
              maxLength={4000}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t(`${k}.detail.versionNotePlaceholder`)}
              value={note}
            />
          </div>
          <Button
            isLoading={busy !== undefined}
            loadingText={busy === 'upload' ? t(`${k}.uploading`) : t('facility-operations.common.saving')}
            onClick={() => {
              browserRuntime.runFork(submit);
            }}
            variant="primary"
          >
            {t(`${k}.detail.newVersion`)}
          </Button>
        </div>
      )}
    </div>
  );
};

const SignatureForm = ({
  document,
  onDone,
  run,
}: {
  readonly document: DocumentRecord;
  readonly onDone: () => void;
  readonly run: (command: OpsCommand) => Effect.Effect<CommandOutcome>;
}) => {
  const { t } = useModernI18n();
  const toast = useToast();
  const latest = document.versions.at(-1)?.version ?? 1;
  const [signedBy, setSignedBy] = useState('');
  const [signedOn, setSignedOn] = useState('');
  const [version, setVersion] = useState(String(latest));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureReason | 'required' | undefined>();

  const submit = recordDocumentSignature({
    documentId: document.id,
    onBusy: setBusy,
    onDone,
    onFailure: setError,
    onPersisted: () => {
      toast.create({ title: t(`${k}.signature.saved`), type: 'success' });
    },
    run,
    signedBy,
    signedOnInput: signedOn,
    version,
  });

  return (
    <div className={`${surfaceTileClassName} flex flex-col gap-150 p-150`}>
      {error !== undefined && (
        <StatusText showIcon status="error">
          {error === 'required'
            ? t('facility-operations.common.required')
            : t(`facility-operations.common.errors.${error}`)}
        </StatusText>
      )}
      <div className="grid grid-cols-1 gap-150 sm:grid-cols-3">
        <FormInput
          id="signature-by"
          label={t(`${k}.signature.signedBy`)}
          maxLength={300}
          onChange={(event) => setSignedBy(event.target.value)}
          required
          value={signedBy}
        />
        <FormInput
          id="signature-on"
          label={t(`${k}.signature.signedOn`)}
          onChange={(event) => setSignedOn(event.target.value)}
          required
          type="date"
          value={signedOn}
        />
        <Select
          items={document.versions.map((entry) => ({
            displayValue: t(`${k}.detail.versionLabel`, { version: entry.version }),
            label: t(`${k}.detail.versionLabel`, { version: entry.version }),
            value: String(entry.version),
          }))}
          label={t(`${k}.signature.version`)}
          name="signature-version"
          onValueChange={({ value }) => setVersion(value[0] ?? String(latest))}
          size="md"
          value={[version]}
        />
      </div>
      <div className="flex items-center justify-between gap-100">
        <span className="text-fg-secondary text-xs">{t(`${k}.signature.manualNote`)}</span>
        <Button
          isLoading={busy}
          onClick={() => {
            browserRuntime.runFork(submit);
          }}
          size="sm"
          variant="primary"
        >
          {t(`${k}.signature.record`)}
        </Button>
      </div>
    </div>
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
                <button key={`${link.kind}:${link.id}`} onClick={() => openSubject(link)} type="button">
                  <SubjectChip subject={link} />
                </button>
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
          <Button onClick={() => onAmend(document)} size="sm" theme="outlined" variant="secondary">
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
              <button
                className="text-left font-medium text-sm hover:underline"
                onClick={() => onOpenDocument(amendment.id)}
                type="button"
              >
                {amendment.title}
              </button>
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
      {canWrite && <VersionUpload document={document} run={run} />}
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
                    <Badge size="sm" variant="info">
                      {t(`${k}.detail.current`)}
                    </Badge>
                  )}
                  {document.signature?.version === version.version && (
                    <Badge size="sm" variant="success">
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
                  <Button onClick={() => onPreview(version.file)} size="sm" theme="borderless" variant="secondary">
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
          <Button onClick={() => setSigning(true)} size="sm" theme="outlined" variant="secondary">
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
      {signing && <SignatureForm document={document} onDone={() => setSigning(false)} run={run} />}
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

  if (document === undefined) {
    return null;
  }
  const current = document.versions.at(-1);
  const { contract } = document;
  const openSubject = documentSubjectOpener(onOpenDocument);

  return (
    <SidePanel
      actions={
        <div className="facility-documents-actions">
          {canWrite && (
            <Button onClick={() => onEdit(document)} theme="outlined" variant="secondary">
              {t(`${k}.detail.edit`)}
            </Button>
          )}
          {canWrite && document.category === 'contract' && (
            <Button onClick={() => onAmend(document)} theme="outlined" variant="secondary">
              {t(`${k}.contract.createAmendment`)}
            </Button>
          )}
          <Button onClick={onClose} variant="primary">
            {t('facility-operations.common.close')}
          </Button>
        </div>
      }
      description={
        <span className="flex flex-wrap items-center gap-100">
          <CategoryBadge category={document.category} />
          {contract !== undefined && <ContractStatusBadge status={contract.status} />}
          {document.signature !== undefined && (
            <Badge size="sm" variant="success">
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
          <button
            className="w-fit rounded-md bg-info-light px-150 py-100 text-left text-sm hover:underline"
            onClick={() => onOpenDocument(original.id)}
            type="button"
          >
            ↳ {t(`${k}.contract.amendmentOf`, { title: original.title })}
          </button>
        )}
        {current !== undefined && canPreview(current.file) && (
          <SectionCard
            actions={<DownloadButton file={current.file} />}
            title={[t(`${k}.preview`), t(`${k}.detail.versionLabel`, { version: current.version })].join(' · ')}
          >
            <FilePreviewBody file={current.file} height="420px" />
          </SectionCard>
        )}

        <DocumentMetadata document={document} onOpenDocument={onOpenDocument} />

        {contract !== undefined && <DocumentContractInfo contract={contract} />}

        {(document.category === 'contract' || amendments.length > 0) && (
          <DocumentAmendments
            amendments={amendments}
            canWrite={canWrite}
            document={document}
            onAmend={onAmend}
            onOpenDocument={onOpenDocument}
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
  );
};
