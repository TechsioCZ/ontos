// B1 excludes mere Effect-value acquisition; D tier preserves pure/injected accessors.
// Submodule namespace import plus computed `Effect["gen"]` access and a bare member accessor.
import * as Effect from 'effect/Effect';

declare const outbox: { readonly pending: (limit: number) => unknown };
declare const metrics: { readonly snapshot: unknown };

export const cycle = Effect['gen'](function* () {
  const pending = yield* outbox.pending(10);
  const snapshot = yield* metrics.snapshot;
  return { pending, snapshot };
});
