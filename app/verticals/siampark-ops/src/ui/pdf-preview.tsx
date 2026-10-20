// @effect-diagnostics asyncFunction:off
// Render the already-authorized file in-page rather than relying on a browser PDF plug-in (absent
// in headless browsers and on many phones). No public file URL or external document service is used.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

const k = 'siampark-ops.documents';

export const PdfPreview = ({
  url,
  name,
  height,
}: {
  readonly url: string;
  readonly name: string;
  readonly height: string;
}) => {
  const { t } = useModernI18n();
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(400);
  const [failed, setFailed] = useState(false);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    const node = host.current;
    if (node === null) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(160, node.clientWidth - 2)));
    observer.observe(node);
    setWidth(Math.max(160, node.clientWidth - 2));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    let destroy: (() => void) | undefined;
    setFailed(false);
    setPdf(undefined);
    setPage(1);
    void (async () => {
      try {
        const renderer = await import('pdfjs-dist');
        if (!alive) return;
        renderer.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url,
        ).toString();
        const task = renderer.getDocument({ url, isEvalSupported: false });
        destroy = () => {
          void task.destroy();
        };
        const loaded = await task.promise;
        if (alive) setPdf(loaded);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
      destroy?.();
    };
  }, [url]);

  useEffect(() => {
    if (pdf === undefined) return;
    let alive = true;
    let cancel: (() => void) | undefined;
    setRendering(true);
    void (async () => {
      try {
        const sheet = await pdf.getPage(page);
        const node = canvas.current;
        if (!alive || node === null) return;
        const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
        const viewport = sheet.getViewport({ scale: width / sheet.getViewport({ scale: 1 }).width });
        node.width = Math.ceil(viewport.width * ratio);
        node.height = Math.ceil(viewport.height * ratio);
        node.style.width = `${viewport.width}px`;
        node.style.height = `${viewport.height}px`;
        const task = sheet.render({ canvas: node, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
        cancel = () => task.cancel();
        await task.promise;
        if (alive) setRendering(false);
      } catch {
        if (alive) {
          setFailed(true);
          setRendering(false);
        }
      }
    })();
    return () => {
      alive = false;
      cancel?.();
    };
  }, [pdf, page, width]);

  return (
    <div ref={host} data-testid="pdf-preview">
      {failed ? (
        <p className="py-300 text-center text-fg-secondary text-sm">{t(`${k}.previewFailed`)}</p>
      ) : (
        <>
          <div
            aria-busy={pdf === undefined || rendering}
            style={{
              maxHeight: height,
              overflow: 'auto',
              border: '1px solid var(--color-border-primary, #d4d4d8)',
              borderRadius: '0.5rem',
              background: '#fff',
            }}
          >
            {(pdf === undefined || rendering) && (
              <p role="status" className="py-200 text-center text-fg-secondary text-sm">
                {t('siampark-ops.common.loading')}
              </p>
            )}
            <canvas
              ref={canvas}
              role="img"
              aria-label={`${name} · ${t(`${k}.pdfPage`, { page, count: pdf?.numPages ?? 1 })}`}
              style={{ display: rendering ? 'none' : 'block', maxWidth: '100%' }}
            />
          </div>
          {pdf !== undefined && (
            <div className="mt-100 flex items-center justify-between gap-100 text-fg-secondary text-xs">
              <Button
                disabled={page <= 1 || rendering}
                onClick={() => setPage((value) => value - 1)}
                size="sm"
                theme="borderless"
                variant="secondary"
              >
                {t(`${k}.pdfPrevious`)}
              </Button>
              <span aria-live="polite">{t(`${k}.pdfPage`, { page, count: pdf.numPages })}</span>
              <Button
                disabled={page >= pdf.numPages || rendering}
                onClick={() => setPage((value) => value + 1)}
                size="sm"
                theme="borderless"
                variant="secondary"
              >
                {t(`${k}.pdfNext`)}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
