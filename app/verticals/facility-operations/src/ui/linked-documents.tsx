// Documents linked to one record (S12.R3) — OWNED BY THE documents LANE. Embed inside AgendaFrame:
//   <LinkedDocuments subject={{ kind: 'property', id: property.id, label: property.label }} />
// Lists every document whose links contain that subject, with preview and authorised download. Writers can upload a
// file straight onto the record (new document linked to it) or attach an existing document.
// @effect-diagnostics asyncFunction:off
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import type { StoredFileRef, SubjectRef } from '../../shared/domain/documents.ts';
import { documentLinks, sameSubject } from '../../shared/domain/documents.ts';
import { CategoryBadge, currentVersion, FileTypeIcon, formatBytes, formatWhen } from './documents-kit.tsx';
import { canPreview, DownloadButton, FilePreviewDialog } from './file-preview.tsx';
import { LoadingSkeleton } from './loading-skeleton.tsx';
import { MAX_UPLOAD_BYTES, uploadFile, useAgendaRecords } from './use-agenda.ts';
import { dividedListClassName } from '@app/admin-ui';

const k = 'facility-operations.documents';

export const LinkedDocuments = ({
  hideWhenForbidden = false,
  subject,
  records,
}: {
  readonly subject: SubjectRef;
  readonly records?: ReturnType<typeof useAgendaRecords>;
  readonly hideWhenForbidden?: boolean;
}) => {
  const { language, t } = useModernI18n();
  // The page's records when it passes them (same store entry, no second read), else this panel's own documents read.
  const own = useAgendaRecords(['documents'], { enabled: records === undefined });
  const ops = records ?? own;
  const [preview, setPreview] = useState<{ readonly file: StoredFileRef; readonly title: string } | undefined>(
    undefined,
  );
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const envelope = ops.data?.agendas.documents;
  const state = envelope?.state;
  const canWrite = envelope?.canWrite === true;

  if (ops.status === 'loading') {
    return <LoadingSkeleton rows={2} />;
  }
  if (state === undefined) {
    return hideWhenForbidden ? null : <p className="text-fg-secondary text-sm">{t(`${k}.linked.forbidden`)}</p>;
  }
  const documents = state.documents.filter((document) =>
    documentLinks(document).some((link) => sameSubject(link, subject)),
  );
  const others = state.documents.filter((document) => !documents.includes(document));

  const uploadHere = async (file: File | undefined) => {
    if (file === undefined) {
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.create({ title: t(`${k}.tooLarge`), type: 'error' });
      return;
    }
    setBusy(true);
    const uploaded = await uploadFile(file);
    if (!uploaded.ok) {
      setBusy(false);
      toast.create({ title: t(`${k}.uploadFailed`), type: 'error' });
      return;
    }
    const outcome = await ops.run({
      _tag: 'DocumentCreate',
      category: file.type.startsWith('image/') ? 'photo' : 'other',
      file: uploaded.file,
      links: [subject],
      title: file.name.replace(/\.[^.]+$/, ''),
    });
    setBusy(false);
    toast.create(
      outcome.ok
        ? { title: t(`${k}.created`), type: 'success' }
        : { title: t(`facility-operations.common.errors.${outcome.reason}`), type: 'error' },
    );
  };

  const attachExisting = async (documentId: string | undefined) => {
    const document = others.find((entry) => entry.id === documentId);
    if (document === undefined) {
      return;
    }
    setBusy(true);
    const outcome = await ops.run({
      _tag: 'DocumentUpdate',
      documentId: document.id,
      links: [...documentLinks(document), subject],
    });
    setBusy(false);
    toast.create(
      outcome.ok
        ? { title: t(`${k}.updated`), type: 'success' }
        : { title: t(`facility-operations.common.errors.${outcome.reason}`), type: 'error' },
    );
  };

  const hrefOf = (documentId: string) => `/${language ?? 'cs'}/provoz/dokumenty?doc=${encodeURIComponent(documentId)}`;

  return (
    <section className="facility-linked-documents flex flex-col gap-150" data-testid="linked-documents">
      {documents.length === 0 ? (
        <p className="text-fg-secondary text-sm">{t(`${k}.linked.empty`)}</p>
      ) : (
        <ul className={`flex flex-col ${dividedListClassName}`}>
          {documents.map((document) => {
            const version = currentVersion(document);
            return (
              <li className="flex flex-wrap items-center gap-150 px-150 py-100" key={document.id}>
                {version === undefined ? (
                  <FileTypeIcon mime="" name="" />
                ) : (
                  <FileTypeIcon mime={version.file.mime} name={version.file.name} />
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                  <Link className="truncate font-medium text-sm" href={hrefOf(document.id)}>
                    {document.title}
                  </Link>
                  <span className="text-fg-secondary text-xs">
                    {version === undefined
                      ? t(`${k}.noFileYet`)
                      : `v${version.version} · ${formatBytes(version.file.size)} · ${formatWhen(version.uploadedAt)}`}
                  </span>
                </div>
                <CategoryBadge category={document.category} />
                {version !== undefined && canPreview(version.file) && (
                  <Button
                    onClick={() => setPreview({ file: version.file, title: document.title })}
                    size="sm"
                    theme="borderless"
                    variant="secondary"
                  >
                    {t(`${k}.preview`)}
                  </Button>
                )}
                {version !== undefined && <DownloadButton file={version.file} />}
              </li>
            );
          })}
        </ul>
      )}
      {canWrite && (
        <div className="facility-linked-document-actions flex flex-wrap items-end gap-150">
          <label className={busy ? 'pointer-events-none opacity-60' : 'cursor-pointer'}>
            <input
              className="sr-only"
              data-testid="linked-documents-upload"
              onChange={(event) => {
                void uploadHere(event.target.files?.[0]);
                event.target.value = '';
              }}
              type="file"
            />
            <span className="inline-flex items-center gap-100 rounded-md border border-border-primary bg-surface px-150 py-100 font-medium text-sm hover:bg-highlight">
              ⇪ {busy ? t(`${k}.uploading`) : t(`${k}.linked.upload`)}
            </span>
          </label>
          {others.length > 0 && (
            <div className="min-w-0 flex-1 sm:max-w-xs">
              <Select
                items={others.map((document) => ({
                  displayValue: document.title,
                  label: document.title,
                  value: document.id,
                }))}
                label={t(`${k}.linked.attach`)}
                name={`attach-${subject.kind}-${subject.id}`}
                placeholder={t(`${k}.linked.attach`)}
                onValueChange={({ value }) => void attachExisting(value[0])}
                size="sm"
                value={[]}
              />
            </div>
          )}
        </div>
      )}
      <FilePreviewDialog file={preview?.file} onClose={() => setPreview(undefined)} title={preview?.title} />
    </section>
  );
};
