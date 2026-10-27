/// <reference types="@modern-js/ultramodern-app-tools/react-types" />
// Render the already-authorized file in-page rather than relying on a browser PDF plug-in (absent
// in headless browsers and on many phones). No public file URL or external document service is used.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Effect, Fiber, Option } from 'effect';
import { constVoid } from 'effect/Function';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { pdfRenderLifecycle, PdfPreviewFailed } from './pdf-render-lifecycle.ts';
import type { NativePdfRenderTask } from './pdf-render-lifecycle.ts';

const k = 'facility-operations.documents';
const pdfOperationTimeout = '30 seconds';

interface PdfPreviewProps {
  readonly height: string;
  readonly name: string;
  readonly url: string;
}

const loadPdfRenderer = () => {
  // Modern replaces this exact compiler branch before collecting the SSR module graph.
  if (import.meta.env.MODERN_TARGET === 'browser') {
    return Effect.gen(function* importRenderer() {
      const rendererImport = import('pdfjs-dist');
      const renderer = yield* Effect.tryPromise({
        catch: (cause) => new PdfPreviewFailed({ cause }),
        try: rendererImport.finally.bind(rendererImport, undefined),
      }).pipe(Effect.timeout(pdfOperationTimeout));
      // Federation serves classic chunks without module-worker CORS headers. Keep PDF.js's bundled,
      // in-page worker and parse only the bytes returned by the authorized file read.
      const workerImport = import('pdfjs-dist/build/pdf.worker.mjs');
      yield* Effect.tryPromise({
        catch: (cause) => new PdfPreviewFailed({ cause }),
        try: workerImport.finally.bind(workerImport, undefined),
      }).pipe(Effect.timeout(pdfOperationTimeout));
      return Option.some(renderer);
    });
  }
  return Effect.succeed(Option.none());
};

const loadPdf = Effect.fn('FacilityOperations.loadPdf')(function* loadPdf(url: string) {
  const renderer = yield* loadPdfRenderer();
  if (Option.isNone(renderer)) {
    return Option.none<PDFDocumentProxy>();
  }
  const task = yield* Effect.acquireRelease(
    Effect.try({
      catch: (cause) => new PdfPreviewFailed({ cause }),
      try: () => renderer.value.getDocument({ isEvalSupported: false, url }),
    }),
    (loadingTask) =>
      Effect.tryPromise({
        catch: (cause) => new PdfPreviewFailed({ cause }),
        try: loadingTask.destroy.bind(loadingTask),
      }).pipe(
        Effect.timeout('5 seconds'),
        Effect.catch((error) => Effect.logWarning('PDF preview cleanup failed', error)),
      ),
  );
  return yield* Effect.tryPromise({
    catch: (cause) => new PdfPreviewFailed({ cause }),
    try: task.promise.finally.bind(task.promise, undefined),
  }).pipe(Effect.map(Option.some));
}, Effect.timeout(pdfOperationTimeout));

const preparePdfPage = Effect.fn('FacilityOperations.preparePdfPage')(function* preparePdfPage(input: {
  readonly canvas: HTMLCanvasElement;
  readonly page: number;
  readonly pdf: PDFDocumentProxy;
  readonly width: number;
}) {
  const sheet = yield* Effect.tryPromise({
    catch: (cause) => new PdfPreviewFailed({ cause }),
    try: input.pdf.getPage.bind(input.pdf, input.page),
  }).pipe(Effect.timeout(pdfOperationTimeout));
  return (): NativePdfRenderTask => {
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const viewport = sheet.getViewport({ scale: input.width / sheet.getViewport({ scale: 1 }).width });
    input.canvas.width = Math.ceil(viewport.width * ratio);
    input.canvas.height = Math.ceil(viewport.height * ratio);
    input.canvas.style.width = `${viewport.width}px`;
    input.canvas.style.height = `${viewport.height}px`;
    return sheet.render({ canvas: input.canvas, transform: [ratio, 0, 0, ratio, 0, 0], viewport });
  };
});

type PdfFailure = Effect.Error<ReturnType<typeof loadPdf>>;

interface PdfState {
  readonly error?: PdfFailure;
  readonly failed: boolean;
  readonly page: number;
  readonly pdf?: PDFDocumentProxy;
  readonly url: string;
}

interface RenderedPage {
  readonly error?: PdfFailure;
  readonly failed: boolean;
  readonly page: number;
  readonly pdf: PDFDocumentProxy;
  readonly width: number;
}

const pdfView = (input: {
  readonly document: PdfState;
  readonly rendered: RenderedPage | undefined;
  readonly url: string;
  readonly width: number;
}) => {
  const { document, rendered, url, width } = input;
  const pdf = document.url === url ? document.pdf : undefined;
  const page = document.url === url ? document.page : 1;
  const currentRender = rendered?.pdf === pdf && rendered?.page === page && rendered?.width === width;
  return {
    failed: (document.url === url && document.failed) || (currentRender && rendered !== undefined && rendered.failed),
    page,
    pageCount: pdf?.numPages ?? 1,
    pdf,
    rendering: pdf === undefined || !currentRender,
  };
};

export const PdfPreview = ({ height, name, url }: PdfPreviewProps) => {
  const { t } = useModernI18n();
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PdfState>({ failed: false, page: 1, url });
  const [width, setWidth] = useState(400);
  const [rendered, setRendered] = useState<RenderedPage>();
  const renderPage = useRef<Effect.Success<typeof pdfRenderLifecycle> | null>(null);
  /* oxlint-disable typescript/prefer-nullish-coalescing -- Approved demo/sales-crm policy: React Compiler does not support logical assignment; this canonical lazy ref initialization preserves one gate per preview. */
  if (renderPage.current === null) {
    renderPage.current = browserRuntime.runSync(pdfRenderLifecycle);
  }
  /* oxlint-enable typescript/prefer-nullish-coalescing */
  if (document.url !== url) {
    setDocument({ failed: false, page: 1, url });
  }
  const { failed, page, pageCount, pdf, rendering } = pdfView({ document, rendered, url, width });

  useEffect(() => {
    const node = host.current;
    if (node === null) {
      return constVoid;
    }
    // ResizeObserver delivers an initial observation, then subsequent container size changes.
    const observer = new ResizeObserver(() => setWidth(Math.max(160, node.clientWidth - 2)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    const onLoaded = (loaded: Option.Option<PDFDocumentProxy>) =>
      Effect.sync(() => {
        if (alive && Option.isSome(loaded)) {
          setDocument({ failed: false, page: 1, pdf: loaded.value, url });
        }
      });
    const fiber = browserRuntime.runFork(
      loadPdf(url).pipe(
        Effect.tap(onLoaded),
        // The document and its loading task belong to this mounted URL until cleanup interrupts it.
        Effect.andThen(Effect.never),
        Effect.scoped,
        Effect.match({
          onFailure: (error) => {
            if (alive) {
              setDocument({ error, failed: true, page: 1, url });
            }
          },
          onSuccess: constVoid,
        }),
      ),
    );
    return () => {
      alive = false;
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [url]);

  useEffect(() => {
    const node = canvas.current;
    const render = renderPage.current;
    if (pdf === undefined || node === null || render === null) {
      return constVoid;
    }
    const controller = new AbortController();
    const finishRender = (error?: PdfFailure) => {
      setRendered(
        error === undefined ? { failed: false, page, pdf, width } : { error, failed: true, page, pdf, width },
      );
    };
    const fiber = browserRuntime.runFork(
      render({
        finish: finishRender,
        prepare: preparePdfPage({ canvas: node, page, pdf, width }),
        signal: controller.signal,
      }),
    );
    return () => {
      controller.abort();
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [canvas, page, pdf, renderPage, width]);
  const pageLabel = t(`${k}.pdfPage`, { count: pageCount, page });
  const canvasLabel = `${name} · ${pageLabel}`;

  return (
    <div data-testid="pdf-preview" ref={host}>
      {failed ? (
        <p className="py-300 text-center text-fg-secondary text-sm">{t(`${k}.previewFailed`)}</p>
      ) : (
        <>
          {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- Approved demo/sales-crm policy: this named viewport needs keyboard scrolling. */}
          <section
            aria-busy={pdf === undefined || rendering}
            aria-label={name}
            style={{
              background: '#fff',
              border: '1px solid var(--color-border-primary, #d4d4d8)',
              borderRadius: '0.5rem',
              maxHeight: height,
              overflow: 'auto',
            }}
            tabIndex={0}
          >
            {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */}
            {(pdf === undefined || rendering) && (
              <output className="block py-200 text-center text-fg-secondary text-sm">
                {t('facility-operations.common.loading')}
              </output>
            )}
            {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Approved demo/sales-crm policy: PDF.js paints this labelled raster canvas; the image role supplies its accessible semantics. */}
            <canvas
              aria-label={canvasLabel}
              ref={canvas}
              role="img"
              style={{ display: rendering ? 'none' : 'block', maxWidth: '100%' }}
            />
            {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
          </section>
          {pdf !== undefined && (
            <div className="mt-100 flex items-center justify-between gap-100 text-fg-secondary text-xs">
              <Button
                disabled={page <= 1 || rendering}
                onClick={() => setDocument((current) => ({ ...current, page: current.page - 1 }))}
                size="sm"
                theme="borderless"
                variant="secondary"
              >
                {t(`${k}.pdfPrevious`)}
              </Button>
              <span aria-live="polite">{t(`${k}.pdfPage`, { count: pdf.numPages, page })}</span>
              <Button
                disabled={page >= pdf.numPages || rendering}
                onClick={() => setDocument((current) => ({ ...current, page: current.page + 1 }))}
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
