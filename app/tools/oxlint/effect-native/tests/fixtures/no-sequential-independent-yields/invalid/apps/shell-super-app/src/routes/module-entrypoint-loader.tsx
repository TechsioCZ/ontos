// expect-count: 1
// B1: fallback + injected telemetry Effect value does not establish remote work.
// Root namespace import (`EFX.Effect.gen`) in a TSX file; nested block statements are analysed too.
import * as EFX from 'effect';

declare const registry: {
  readonly manifest: (id: string) => unknown;
  readonly assets: (id: string) => unknown;
};
declare const telemetry: { readonly sample: unknown };

export const loadEntrypoint = (id: string) =>
  EFX.Effect.gen(function* () {
    if (id.length > 0) {
      const manifest = yield* registry.manifest(id);
      const assets = yield* registry.assets(id);
      return { assets, manifest };
    }
    const fallback = yield* registry.manifest('fallback');
    const sample = yield* telemetry.sample;
    return { fallback, sample };
  });

export const Badge = () => <span>{'entrypoint'}</span>;
