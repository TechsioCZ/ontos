import { Effect } from 'effect';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
// Documents linked to one record (S12.R3) — OWNED BY THE documents LANE. Embed inside AgendaFrame:
//   <LinkedDocuments subject={{ kind: 'property', id: property.id, label: property.label }} />
// Lists every document whose links contain that subject, with preview and authorised download. Writers can upload a
// file straight onto the record (new document linked to it) or attach an existing document.
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
import type { CommandOutcome } from './use-agenda.ts';
import { dividedListClassName } from '@app/admin-ui';

const k = 'facility-operations.documents';

const uploadLinkedDocument = Effect.fn('FacilityOperations.uploadLinkedDocument')(function* uploadLinkedDocument(
  file: File,
  context: { readonly run: ReturnType<typeof useAgendaRecords>['run']; readonly subject: SubjectRef },
) {
  const uploaded = yield* uploadFile(file);
  if (!uploaded.ok) {
    return { ok: false as const };
  }
  const outcome = yield* context.run({
    _tag: 'DocumentCreate',
    category: file.type.startsWith('image/') ? 'photo' : 'other',
    file: uploaded.file,
    links: [context.subject],
    title: file.name.replace(/\.[^.]+$/u, ''),
  });
  return { ok: true as const, outcome };
});

export const LinkedDocuments = ({
  hideWhenForbidden = false,
  records,
  subject,
}: {
  readonly hideWhenForbidden?: boolean;
  readonly records?: ReturnType<typeof useAgendaRecords>;
  readonly subject: SubjectRef;
}) => {
  const { language, t } = useModernI18n();
  // The page's records when it passes them (same store entry, no second read), else this panel's own documents read.
  const own = useAgendaRecords(['documents'], { enabled: records === undefined });
  const ops = records ?? own;
  const [preview, setPreview] = useState<{ readonly file: StoredFileRef; readonly title: string } | undefined>();
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

  const stopBusy = Effect.sync(() => setBusy(false));
  const notifyUploadFailed = Effect.sync(() => {
    toast.create({ title: t(`${k}.uploadFailed`), type: 'error' });
  });
  const notifyCommand = (outcome: CommandOutcome, success: 'created' | 'updated') =>
    Effect.sync(() => {
      toast.create(
        outcome.ok
          ? { title: t(`${k}.${success}`), type: 'success' }
          : { title: t(`facility-operations.common.errors.${outcome.reason}`), type: 'error' },
      );
    });
  const finishUpload = (uploaded: Effect.Success<ReturnType<typeof uploadLinkedDocument>>) =>
    uploaded.ok ? notifyCommand(uploaded.outcome, 'created') : notifyUploadFailed;
  const uploadFailed = (error: Effect.Error<ReturnType<typeof uploadLinkedDocument>>) =>
    Effect.logWarning('Linked document upload failed', error).pipe(Effect.andThen(notifyUploadFailed));

  const uploadHere = (file: File | undefined): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (file === undefined) {
        return Effect.void;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return Effect.sync(() => {
          toast.create({ title: t(`${k}.tooLarge`), type: 'error' });
        });
      }
      setBusy(true);
      return uploadLinkedDocument(file, { run: ops.run, subject }).pipe(
        Effect.matchEffect({ onFailure: uploadFailed, onSuccess: finishUpload }),
        Effect.ensuring(stopBusy),
      );
    });

  const finishAttach = (outcome: CommandOutcome) => notifyCommand(outcome, 'updated');
  const attachExisting = (documentId: string | undefined): Effect.Effect<void> =>
    Effect.suspend(() => {
      const document = others.find((entry) => entry.id === documentId);
      if (document === undefined) {
        return Effect.void;
      }
      setBusy(true);
      return ops
        .run({ _tag: 'DocumentUpdate', documentId: document.id, links: [...documentLinks(document), subject] })
        .pipe(Effect.tap(finishAttach), Effect.ensuring(stopBusy), Effect.asVoid);
    });

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
                browserRuntime.runFork(uploadHere(event.target.files?.[0]));
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
                onValueChange={({ value }) => {
                  browserRuntime.runFork(attachExisting(value[0]));
                }}
                placeholder={t(`${k}.linked.attach`)}
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
