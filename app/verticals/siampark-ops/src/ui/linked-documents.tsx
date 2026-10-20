// Documents linked to one record (S12.R3) — OWNED BY THE documents LANE. Embed inside AgendaFrame:
//   <LinkedDocuments subject={{ kind: 'property', id: property.id, label: property.label }} />
// Lists every document whose links contain that subject, with preview and authorised download.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { useState } from 'react';
import type { StoredFileRef, SubjectRef } from '../../shared/domain/documents.ts';
import { documentLinks, sameSubject } from '../../shared/domain/documents.ts';
import { CategoryBadge, currentVersion, FileTypeIcon, formatBytes, formatWhen, usePrincipalLabel } from './documents-kit.tsx';
import { canPreview, DownloadButton, FilePreviewDialog } from './file-preview.tsx';
import { useAgendaRecords } from './use-agenda.ts';

const k = 'siampark-ops.documents';

export const LinkedDocuments = ({
  hideWhenForbidden = false,
  subject,
}: {
  readonly subject: SubjectRef;
  readonly hideWhenForbidden?: boolean;
}) => {
  const { language, t } = useModernI18n();
  const principalLabel = usePrincipalLabel();
  const ops = useAgendaRecords(['documents']);
  const [preview, setPreview] = useState<{ readonly file: StoredFileRef; readonly title: string } | undefined>(
    undefined,
  );
  const state = ops.data?.agendas.documents?.state;

  if (ops.status === 'loading') {
    return <p className="text-fg-secondary text-sm">{t('siampark-ops.common.loading')}</p>;
  }
  if (state === undefined) {
    return hideWhenForbidden ? null : <p className="text-fg-secondary text-sm">{t(`${k}.linked.forbidden`)}</p>;
  }
  const documents = state.documents.filter((document) =>
    documentLinks(document).some((link) => sameSubject(link, subject)),
  );
  const hrefOf = (documentId: string) =>
    `/${language ?? 'cs'}/siampark/provoz/dokumenty?doc=${encodeURIComponent(documentId)}`;

  return (
    <section className="flex flex-col gap-150" data-testid="linked-documents">
      {documents.length === 0 ? (
        <p className="text-fg-secondary text-sm">{t(`${k}.linked.empty`)}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-primary rounded-lg border border-border-primary bg-surface">
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
                      : `v${version.version} · ${formatBytes(version.file.size)} · ${principalLabel(version.uploadedBy)} · ${formatWhen(version.uploadedAt)}`}
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
      <FilePreviewDialog file={preview?.file} onClose={() => setPreview(undefined)} title={preview?.title} />
    </section>
  );
};
