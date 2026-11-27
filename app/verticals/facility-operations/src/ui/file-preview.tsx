// File preview dialog + download button for stored files (documents lane). Both go through the governed records
// read, so the server checks `documents` read access on every open (S12-03).
import { dialogCloseLabel } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { useEffect, useState } from 'react';
import { Effect } from 'effect';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import type { StoredFileRef } from '../../shared/domain/documents.ts';
import { fetchFileObjectUrl, fileKindOf, formatBytes } from './documents-kit.tsx';
import { downloadFile } from './use-agenda.ts';
import { PdfPreview } from './pdf-preview.tsx';

const k = 'facility-operations.documents';

export const canPreview = (file: StoredFileRef) => {
  const kind = fileKindOf(file.mime, file.name);
  return kind === 'pdf' || kind === 'image' || kind === 'text';
};

type PreviewState =
  | { readonly status: 'loading' }
  | { readonly error: Effect.Error<ReturnType<typeof fetchFileObjectUrl>>; readonly status: 'failed' }
  | { readonly mime: string; readonly status: 'ready'; readonly url: string };

/** Inline preview body (PDF in an iframe, image, plain text) for one stored file. */
export const FilePreviewBody = ({
  file,
  height = '70vh',
}: {
  readonly file: StoredFileRef;
  readonly height?: string;
}) => {
  const { t } = useModernI18n();
  const [preview, setPreview] = useState<{ readonly fileId: string; readonly state: PreviewState }>({
    fileId: file.id,
    state: { status: 'loading' },
  });
  if (preview.fileId !== file.id) {
    setPreview({ fileId: file.id, state: { status: 'loading' } });
  }
  const state: PreviewState = preview.fileId === file.id ? preview.state : { status: 'loading' };
  useEffect(() => {
    let alive = true;
    let url: string | undefined;
    browserRuntime.runFork(
      fetchFileObjectUrl(file.id).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              if (alive) {
                setPreview({ fileId: file.id, state: { error, status: 'failed' } });
              }
            }),
          onSuccess: (outcome) =>
            Effect.sync(() => {
              if (!alive) {
                URL.revokeObjectURL(outcome.url);
                return;
              }
              ({ url } = outcome);
              setPreview({ fileId: file.id, state: { mime: outcome.mime, status: 'ready', url: outcome.url } });
            }),
        }),
      ),
    );
    return () => {
      alive = false;
      if (url !== undefined) {
        URL.revokeObjectURL(url);
      }
    };
  }, [file.id]);

  if (state.status === 'loading') {
    return <p className="py-300 text-center text-fg-secondary text-sm">{t('facility-operations.common.loading')}</p>;
  }
  if (state.status === 'failed') {
    return <p className="py-300 text-center text-danger text-sm">{t(`${k}.previewFailed`)}</p>;
  }
  const kind = fileKindOf(state.mime, file.name);
  if (kind === 'image') {
    return (
      <div className="flex justify-center rounded-md bg-highlight p-100">
        <img alt={file.name} className="max-h-[70vh] max-w-full rounded-sm object-contain" src={state.url} />
      </div>
    );
  }
  if (kind === 'pdf') {
    return <PdfPreview height={height} name={file.name} url={state.url} />;
  }
  if (kind === 'text') {
    return (
      <iframe
        className="w-full rounded-md border border-border-primary bg-surface"
        sandbox=""
        src={state.url}
        style={{ height }}
        title={file.name}
      />
    );
  }
  return <p className="py-300 text-center text-fg-secondary text-sm">{t(`${k}.previewUnavailable`)}</p>;
};

export const DownloadButton = ({
  file,
  size = 'sm',
}: {
  readonly file: StoredFileRef;
  readonly size?: 'sm' | 'md';
}) => {
  const { t } = useModernI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      isLoading={busy}
      onClick={() => {
        setBusy(true);
        browserRuntime.runFork(
          downloadFile(file.id).pipe(
            Effect.tap((outcome) =>
              Effect.sync(() => {
                if (!outcome.ok) {
                  toast.create({ title: t(`${k}.downloadFailed`), type: 'error' });
                }
              }),
            ),
            Effect.ensuring(Effect.sync(() => setBusy(false))),
          ),
        );
      }}
      size={size}
      theme="outlined"
      variant="secondary"
    >
      {t(`${k}.download`)}
    </Button>
  );
};

/** Modal preview of one stored file with a download action. */
export const FilePreviewDialog = ({
  file,
  onClose,
  title,
}: {
  readonly file: StoredFileRef | undefined;
  readonly onClose: () => void;
  readonly title?: string | undefined;
}) => {
  const { t } = useModernI18n();
  return (
    <Dialog
      actions={
        file === undefined ? undefined : (
          <>
            <DownloadButton file={file} />
            <Button onClick={onClose} size="sm" variant="primary">
              {t('facility-operations.common.close')}
            </Button>
          </>
        )
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description={file === undefined ? undefined : `${file.name} · ${formatBytes(file.size)}`}
      onOpenChange={({ open }) => {
        if (!open) {
          onClose();
        }
      }}
      open={file !== undefined}
      size="xl"
      title={title ?? file?.name ?? t(`${k}.preview`)}
    >
      {file !== undefined && <FilePreviewBody file={file} />}
    </Dialog>
  );
};
