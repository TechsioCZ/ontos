import { Effect, Schema, Semaphore } from 'effect';
import type { Cause } from 'effect';
import type { RenderTask } from 'pdfjs-dist';

export class PdfPreviewFailed extends Schema.TaggedError<PdfPreviewFailed>()('PdfPreviewFailed', {
  cause: Schema.Defect(),
}) {}

export type NativePdfRenderTask = Pick<RenderTask, 'promise' | 'cancel'>;
export type PdfRenderFailure = PdfPreviewFailed | Cause.TimeoutError;

interface PdfRenderRequest {
  readonly finish: (error?: PdfRenderFailure) => void;
  readonly prepare: Effect.Effect<() => NativePdfRenderTask, PdfRenderFailure>;
  readonly signal: AbortSignal;
}

const renderNativePdfPage = Effect.fn('FacilityOperations.renderNativePdfPage')(
  function* renderNativePdfPage(request: PdfRenderRequest) {
    // Page preparation may await PDF.js; only synchronous native task creation is acquired uninterruptibly.
    const startNative = yield* request.prepare;
    if (request.signal.aborted) {
      return;
    }
    const nativeTask = yield* Effect.acquireRelease(
      Effect.try({ catch: (cause) => new PdfPreviewFailed({ cause }), try: startNative }),
      (acquiredTask) => Effect.sync(() => acquiredTask.cancel()),
    );
    yield* Effect.tryPromise({
      catch: (cause) => new PdfPreviewFailed({ cause }),
      try: nativeTask.promise.finally.bind(nativeTask.promise, undefined),
    });
  },
  Effect.timeout('30 seconds'),
  Effect.scoped,
);

/** One owner per preview canvas. Its permit includes native cancellation and scope finalization. */
export const pdfRenderLifecycle = Effect.map(
  Semaphore.make(1),
  (gate) =>
    (request: PdfRenderRequest): Effect.Effect<void> => {
      const finish = (error?: PdfRenderFailure) =>
        Effect.sync(() => {
          if (!request.signal.aborted) {
            request.finish(error);
          }
        });
      return gate
        .withPermit(
          Effect.suspend(() => {
            if (request.signal.aborted) {
              return Effect.void;
            }
            return renderNativePdfPage(request);
          }),
        )
        .pipe(Effect.matchEffect({ onFailure: finish, onSuccess: () => finish() }));
    },
);
