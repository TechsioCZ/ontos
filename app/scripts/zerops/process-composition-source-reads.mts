import { Effect, Schema } from 'effect';

import type { CompositionSourceReads } from '../../packages/core-runtime/src/modules/active-application-composition-source.node.ts';

export class CompositionSourceReadsAlreadyStarted extends Schema.TaggedError<CompositionSourceReadsAlreadyStarted>()(
  'CompositionSourceReadsAlreadyStarted',
  { reason: Schema.String },
) {}

/**
 * The host scope owns one store of composition source reads for every owner bundle and Outbox loop of its process, so
 * the process reads (and, when it changed, parses) the snapshot once per 30 seconds instead of once per bundle or loop.
 */
export const startProcessCompositionSourceReads = Effect.gen(function* startSharedReads() {
  const reads: CompositionSourceReads = new Map();
  yield* Effect.acquireRelease(
    Effect.gen(function* publishSharedReads() {
      if (globalThis.ontosCompositionSourceReads !== undefined) {
        return yield* new CompositionSourceReadsAlreadyStarted({
          reason: 'The process already shares its composition source reads',
        });
      }
      return yield* Effect.sync(() => {
        globalThis.ontosCompositionSourceReads = reads;
      });
    }),
    () =>
      Effect.sync(() => {
        if (globalThis.ontosCompositionSourceReads === reads) {
          delete globalThis.ontosCompositionSourceReads;
        }
      }),
  );
});
