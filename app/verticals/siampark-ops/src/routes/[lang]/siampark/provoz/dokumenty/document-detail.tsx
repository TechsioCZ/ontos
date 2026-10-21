// @effect-diagnostics asyncFunction:off
// Document detail side panel (S12): metadata, contract terms, links, amendments, preview, version history with
// authorised download, new version upload, manual signature record and the comment thread (S14).
import { DetailList, SectionCard, SidePanel } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { OpsCommand } from '../../../../../../shared/agendas.ts';
import type { DocumentRecord, StoredFileRef, SubjectRef } from '../../../../../../shared/domain/documents.ts';
import { documentLinks } from '../../../../../../shared/domain/documents.ts';
import { CommentThread } from '../../../../../ui/comment-thread.tsx';
import { ChangeHistory } from '../../../../../ui/change-history.tsx';
import {
  CategoryBadge,
  FileTypeIcon,
  formatBytes,
  formatIsoDate,
  formatWhen,
  SubjectChip,
  usePrincipalLabel,
} from '../../../../../ui/documents-kit.tsx';
import { canPreview, DownloadButton, FilePreviewBody, FilePreviewDialog } from '../../../../../ui/file-preview.tsx';
import type { CommandOutcome, FailureReason, useAgendaRecords } from '../../../../../ui/use-agenda.ts';
import { MAX_UPLOAD_BYTES, uploadFile } from '../../../../../ui/use-agenda.ts';
import { ContractStatusBadge } from './documents-model.tsx';

const k = 'siampark-ops.documents';

const VersionUpload = ({
  document,
  run,
}: {
  readonly document: DocumentRecord;
  readonly run: (command: OpsCommand) => Promise<CommandOutcome>;
}) => {
  const { t } = useModernI18n();
  const toast = useToast();
  const [file, setFile] = useState<File | undefined>(undefined);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'upload' | 'save' | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = async () => {
    if (file === undefined) {
      return;
    }
    setError(undefined);
    setBusy('upload');
    const uploaded = await uploadFile(file);
    if (!uploaded.ok) {
      setBusy(undefined);
      setError(t(`${k}.uploadFailed`));
      return;
    }
    setBusy('save');
    const outcome = await run({
      _tag: 'DocumentVersionAdd',
      documentId: document.id,
      file: uploaded.file,
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    });
    setBusy(undefined);
    if (outcome.ok) {
      const next = document.versions.reduce((highest, entry) => Math.max(highest, entry.version), 0) + 1;
      toast.create({ title: t(`${k}.detail.versionSaved`, { version: next }), type: 'success' });
      setFile(undefined);
      setNote('');
    } else {
      setError(t(`siampark-ops.common.errors.${outcome.reason}`));
    }
  };

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
            ⇪ {file === undefined ? `${t(`${k}.detail.newVersion`)}…` : t(`${k}.create.replace`)}
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
            loadingText={busy === 'upload' ? t(`${k}.uploading`) : t('siampark-ops.common.saving')}
            onClick={() => void submit()}
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
  readonly run: (command: OpsCommand) => Promise<CommandOutcome>;
}) => {
  const { t } = useModernI18n();
  const toast = useToast();
  const latest = document.versions.at(-1)?.version ?? 1;
  const [signedBy, setSignedBy] = useState('');
  const [signedOn, setSignedOn] = useState('');
  const [version, setVersion] = useState(String(latest));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FailureReason | 'required' | undefined>(undefined);

  const submit = async () => {
    if (signedBy.trim() === '' || signedOn === '') {
      setError('required');
      return;
    }
    setBusy(true);
    const outcome = await run({
      _tag: 'DocumentSignatureRecord',
      documentId: document.id,
      signedBy: signedBy.trim(),
      signedOn,
      version: Number(version),
    });
    setBusy(false);
    if (outcome.ok) {
      toast.create({ title: t(`${k}.signature.saved`), type: 'success' });
      onDone();
    } else {
      setError(outcome.reason);
    }
  };

  return (
    <div className="flex flex-col gap-150 rounded-lg border border-border-primary p-150">
      {error !== undefined && (
        <StatusText showIcon status="error">
          {error === 'required' ? t('siampark-ops.common.required') : t(`siampark-ops.common.errors.${error}`)}
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
        <Button isLoading={busy} onClick={() => void submit()} size="sm" variant="primary">
          {t(`${k}.signature.record`)}
        </Button>
      </div>
    </div>
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
  readonly records: ReturnType<typeof useAgendaRecords>;
  readonly amendments: readonly DocumentRecord[];
  readonly canWrite: boolean;
  readonly document: DocumentRecord | undefined;
  readonly onAmend: (original: DocumentRecord) => void;
  readonly onClose: () => void;
  readonly onEdit: (document: DocumentRecord) => void;
  readonly onOpenDocument: (documentId: string) => void;
  readonly original: DocumentRecord | undefined;
  readonly run: (command: OpsCommand) => Promise<CommandOutcome>;
}) => {
  const { t } = useModernI18n();
  const principalLabel = usePrincipalLabel();
  const [preview, setPreview] = useState<StoredFileRef | undefined>(undefined);
  const [signing, setSigning] = useState(false);
  const notProvided = t('siampark-ops.common.notProvided');

  if (document === undefined) {
    return null;
  }
  const current = document.versions.at(-1);
  const links = documentLinks(document);
  const contract = document.contract;
  const versionsNewestFirst = document.versions.toReversed();
  const openSubject = (subject: SubjectRef) => {
    if (subject.kind === 'document') {
      onOpenDocument(subject.id);
    }
  };

  return (
    <SidePanel
      actions={
        <div className="siampark-documents-actions">
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
            {t('siampark-ops.common.close')}
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
            {t(`${k}.fields.lastChange`)}: {principalLabel(document.updatedBy)} · {formatWhen(document.updatedAt)}
          </span>
        </span>
      }
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open
      resizeLabel={t('siampark-ops.common.close')}
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
            title={`${t(`${k}.preview`)} · ${t(`${k}.detail.versionLabel`, { version: current.version })}`}
          >
            <FilePreviewBody file={current.file} height="420px" />
          </SectionCard>
        )}

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
                label: t('siampark-ops.common.createdBy'),
                value: `${principalLabel(document.createdBy)} · ${formatWhen(document.createdAt)}`,
              },
              {
                label: t(`${k}.fields.lastChange`),
                value: `${principalLabel(document.updatedBy)} · ${formatWhen(document.updatedAt)}`,
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

        {contract !== undefined && (
          <SectionCard title={t(`${k}.contract.section`)}>
            <DetailList
              items={[
                { label: t(`${k}.contract.contractType`), value: contract.contractType },
                { label: t(`${k}.contract.status`), value: <ContractStatusBadge status={contract.status} /> },
                { label: t(`${k}.contract.parties`), value: contract.parties.join(' · ') },
                { label: t(`${k}.contract.subject`), value: contract.subject ?? notProvided },
                {
                  label: t(`${k}.contract.validity`),
                  value: `${formatIsoDate(contract.validFrom, notProvided)} – ${contract.validTo === undefined ? t(`${k}.contract.indefinite`) : formatIsoDate(contract.validTo, notProvided)}`,
                },
                { label: t(`${k}.contract.amountTerms`), value: contract.amountTerms ?? notProvided },
                { label: t(`${k}.contract.noticePeriod`), value: contract.noticePeriod ?? notProvided },
                { label: t(`${k}.contract.noticeDate`), value: formatIsoDate(contract.noticeDate, notProvided) },
                { label: t(`${k}.contract.owner`), value: contract.owner },
              ]}
            />
          </SectionCard>
        )}

        {(document.category === 'contract' || amendments.length > 0) && (
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
        )}

        <SectionCard title={`${t(`${k}.detail.history`)} (${document.versions.length})`}>
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
                        who: principalLabel(version.uploadedBy),
                      })}
                    </span>
                    {version.note !== undefined && <span className="text-xs italic">„{version.note}“</span>}
                  </div>
                  <span className="flex gap-100">
                    {canPreview(version.file) && (
                      <Button onClick={() => setPreview(version.file)} size="sm" theme="borderless" variant="secondary">
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
                  label: t('siampark-ops.common.createdBy'),
                  value: t(`${k}.signature.recordedBy`, {
                    when: formatWhen(document.signature.recordedAt),
                    who: principalLabel(document.signature.recordedBy),
                  }),
                },
              ]}
            />
          )}
          {signing && <SignatureForm document={document} onDone={() => setSigning(false)} run={run} />}
        </SectionCard>

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
