import { Effect, Schema } from 'effect';

import type { BootWarmUpImport } from '../../packages/core-runtime/src/runtime/boot-warm-up-imports.ts';

export class BootWarmUpImportsAlreadyStarted extends Schema.TaggedError<BootWarmUpImportsAlreadyStarted>()(
  'BootWarmUpImportsAlreadyStarted',
  { reason: Schema.String },
) {}

/** The host scope owns the one set every unit of the process registers its lazy imports in, before any unit loads. */
export const startProcessBootWarmUpImports = Effect.gen(function* startWarmUpImports() {
  const imports = new Set<BootWarmUpImport>();
  yield* Effect.acquireRelease(
    Effect.gen(function* publishWarmUpImports() {
      if (globalThis.ontosBootWarmUpImports !== undefined) {
        return yield* new BootWarmUpImportsAlreadyStarted({
          reason: 'The process already collects boot warm-up imports',
        });
      }
      return yield* Effect.sync(() => {
        globalThis.ontosBootWarmUpImports = imports;
      });
    }),
    () =>
      Effect.sync(() => {
        if (globalThis.ontosBootWarmUpImports === imports) {
          delete globalThis.ontosBootWarmUpImports;
        }
      }),
  );
});
