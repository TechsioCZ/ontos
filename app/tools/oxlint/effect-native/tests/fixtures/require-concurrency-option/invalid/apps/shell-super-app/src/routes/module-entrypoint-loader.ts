// expect-count: 2
import { Effect } from 'effect';

interface Load {
  readonly entrypoint: string;
}
declare const gateway: {
  readonly check: (snapshot: string, entrypoint: string) => Effect.Effect<void>;
  readonly prepareSnapshot: (entrypoints: readonly string[]) => Effect.Effect<string>;
  readonly run: (load: Load & { readonly snapshot: string }) => Effect.Effect<string>;
};

/** Audit B1 evidence shape (`module-entrypoint-loader.ts:32`): curried, data-last, unbounded-free. */
export const loadModuleEntrypointComposition = (loads: readonly Load[]) =>
  Effect.gen(function* loadModuleEntrypointCompositionEffect() {
    const snapshot = yield* gateway.prepareSnapshot(loads.map((load) => load.entrypoint));
    yield* Effect.forEach((load: (typeof loads)[number]) =>
      gateway.check(snapshot, load.entrypoint),
    )(loads);
    return yield* Effect.forEach((load: (typeof loads)[number]) =>
      gateway.run({ ...load, snapshot }),
    )(loads);
  });
