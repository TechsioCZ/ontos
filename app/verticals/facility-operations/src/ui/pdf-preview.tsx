// @effect-diagnostics asyncFunction:off -- Private PDF.js adapter consumes its native Promise-based parsing/render tasks, never a BFF port; remove-when: PDF.js publishes an Effect adapter.
// Render the already-authorized file in-page rather than relying on a browser PDF plug-in (absent
// in headless browsers and on many phones). No public file URL or external document service is used.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Effect, Option, Schema } from 'effect';
import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';

const k = 'facility-operations.documents';

interface PdfPreviewProps {
  readonly height: string;
  readonly name: string;
  readonly url: string;
}

class PdfRendererUnavailable extends Schema.TaggedError<PdfRendererUnavailable>()('PdfRendererUnavailable', {
  cause: Schema.Unknown,
}) {}

const loadPdfRenderer = () => {
  // Modern replaces this exact compiler branch before collecting the SSR module graph.
  if (import.meta.env.MODERN_TARGET === 'browser') {
    return Effect.gen(function* importRenderer() {
      const renderer = yield* Effect.tryPromise({
        catch: (cause) => new PdfRendererUnavailable({ cause }),
        try: async () => await import('pdfjs-dist'),
      }).pipe(Effect.timeout('30 seconds'));
      // Keep the parser in-page. Federation chunks do not provide cross-origin module-worker headers.
      yield* Effect.tryPromise({
        catch: (cause) => new PdfRendererUnavailable({ cause }),
        try: async () => {
          await import('pdfjs-dist/build/pdf.worker.mjs');
        },
      }).pipe(Effect.timeout('30 seconds'));
      return Option.some(renderer);
    });
  }
  return Effect.succeed(Option.none());
};

const PdfDocumentPreview = ({ height, name, url }: PdfPreviewProps) => {
  const { t } = useModernI18n();
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | undefined>();
  const [page, setPage] = useState(1);
  const [width, setWidth] = useState(400);
  const [failed, setFailed] = useState(false);
  const [rendered, setRendered] = useState<{ readonly page: number; readonly width: number }>();
  const rendering = rendered?.page !== page || rendered?.width !== width;
  const pageDescription = t(`${k}.pdfPage`, { count: pdf?.numPages ?? 1, page });
  const pageLabel = `${name} · ${pageDescription}`;

  useEffect(() => {
    const node = host.current;
    const observer =
      node === null ? undefined : new ResizeObserver(() => setWidth(Math.max(160, node.clientWidth - 2)));
    if (node !== null) {
      observer?.observe(node);
    }
    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    let destroy: (() => void) | undefined;
    void (async () => {
      try {
        const renderer = await browserRuntime.runPromise(loadPdfRenderer());
        if (!alive || Option.isNone(renderer)) {
          return;
        }
        const task = renderer.value.getDocument({ isEvalSupported: false, url });
        destroy = () => {
          void task.destroy();
        };
        const loaded = await task.promise;
        if (alive) {
          setPdf(loaded);
        }
      } catch {
        if (alive) {
          setFailed(true);
        }
      }
    })();
    return () => {
      alive = false;
      destroy?.();
    };
  }, [url]);

  useEffect(() => {
    let alive = true;
    let cancel: (() => void) | undefined;
    if (pdf !== undefined) {
      void (async () => {
        try {
          const sheet = await pdf.getPage(page);
          const node = canvas.current;
          if (!alive || node === null) {
            return;
          }
          const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
          const viewport = sheet.getViewport({ scale: width / sheet.getViewport({ scale: 1 }).width });
          node.width = Math.ceil(viewport.width * ratio);
          node.height = Math.ceil(viewport.height * ratio);
          node.style.width = `${viewport.width}px`;
          node.style.height = `${viewport.height}px`;
          const task = sheet.render({ canvas: node, transform: [ratio, 0, 0, ratio, 0, 0], viewport });
          cancel = () => task.cancel();
          await task.promise;
          if (alive) {
            setRendered({ page, width });
          }
        } catch {
          if (alive) {
            setFailed(true);
          }
        }
      })();
    }
    return () => {
      alive = false;
      cancel?.();
    };
  }, [pdf, page, width]);

  return (
    <div data-testid="pdf-preview" ref={host}>
      {failed ? (
        <p className="py-300 text-center text-fg-secondary text-sm">{t(`${k}.previewFailed`)}</p>
      ) : (
        <>
          <div
            aria-busy={pdf === undefined || rendering}
            style={{
              background: '#fff',
              border: '1px solid var(--color-border-primary, #d4d4d8)',
              borderRadius: '0.5rem',
              maxHeight: height,
              overflow: 'auto',
            }}
          >
            {(pdf === undefined || rendering) && (
              <output className="block py-200 text-center text-fg-secondary text-sm">
                {t('facility-operations.common.loading')}
              </output>
            )}
            <canvas
              aria-label={pageLabel}
              ref={canvas}
              style={{ display: rendering ? 'none' : 'block', maxWidth: '100%' }}
            >
              {pageLabel}
            </canvas>
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
              <span aria-live="polite">{t(`${k}.pdfPage`, { count: pdf.numPages, page })}</span>
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

/** A new authorized file URL owns fresh parsing, paging and rendering state. */
export const PdfPreview = (props: PdfPreviewProps) => <PdfDocumentPreview key={props.url} {...props} />;
