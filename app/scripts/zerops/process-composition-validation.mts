import { Context, Effect, Layer, Schema } from 'effect';

import { ProcessCompositionValidationLive } from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { ProcessCompositionValidation } from '../../packages/core-runtime/src/modules/process-composition-validation.ts';

export class ProcessCompositionValidationAlreadyStarted extends Schema.TaggedError<ProcessCompositionValidationAlreadyStarted>()(
  'ProcessCompositionValidationAlreadyStarted',
  { reason: Schema.String },
) {}

/** The host scope, not the lifetime of an individual owner request, owns immutable deployment validation. */
export const startProcessCompositionValidation = Effect.gen(function* startValidation() {
  const registry = Context.get(yield* Layer.build(ProcessCompositionValidationLive), ProcessCompositionValidation);
  yield* Effect.acquireRelease(
    Effect.gen(function* publishRegistry() {
      if (globalThis.ontosProcessCompositionValidation !== undefined) {
        return yield* new ProcessCompositionValidationAlreadyStarted({
          reason: 'The process already owns composition validation',
        });
      }
      return yield* Effect.sync(() => {
        globalThis.ontosProcessCompositionValidation = registry;
      });
    }),
    () =>
      Effect.sync(() => {
        if (globalThis.ontosProcessCompositionValidation === registry) {
          delete globalThis.ontosProcessCompositionValidation;
        }
      }),
  );
});
