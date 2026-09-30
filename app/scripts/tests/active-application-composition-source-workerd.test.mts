import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const sourceModule = fileURLToPath(
  new URL('../../packages/core-runtime/src/modules/active-application-composition-source.workerd.ts', import.meta.url),
);

const probeWorker = `
import { Effect } from 'effect';
import { encodedActiveApplicationCompositionSnapshot } from ${JSON.stringify(sourceModule)};

export default {
  async fetch() {
    const result = await Effect.runPromise(
      encodedActiveApplicationCompositionSnapshot.pipe(
        Effect.match({ onFailure: (error) => ({ failure: error.reason }), onSuccess: (snapshot) => ({ snapshot }) }),
      ),
    );
    return Response.json(result);
  },
};
`;

const ProbeResultSchema = Schema.Union([
  Schema.Struct({ failure: Schema.String }),
  Schema.Struct({ snapshot: Schema.String }),
]);

const BINDING = 'ONTOS_ACTIVE_APPLICATION_COMPOSITION';

const bundled = Effect.promise(() =>
  build({
    bundle: true,
    conditions: ['workerd', 'worker', 'import'],
    external: ['cloudflare:*'],
    format: 'esm',
    platform: 'neutral',
    stdin: { contents: probeWorker, loader: 'js', resolveDir: import.meta.dirname },
    write: false,
  }),
);

/** Runs the workerd source once in a Worker that binds the composition KV seeded with `keys`, or binds none. */
const readInWorker = (keys: Option.Option<Readonly<Record<string, string>>>) =>
  Effect.gen(function* readInWorkerEffect() {
    const bundle = yield* bundled;
    const worker = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Miniflare(
            convertV4MiniflareOptions({
              compatibilityDate: '2026-06-02',
              compatibilityFlags: ['nodejs_compat'],
              kvNamespaces: Option.isSome(keys) ? [BINDING] : [],
              modules: true,
              script: bundle.outputFiles[0]?.text ?? '',
            }),
          ),
      ),
      (miniflare) => Effect.promise(() => miniflare.dispose()),
    );
    if (Option.isSome(keys)) {
      const namespace = yield* Effect.promise(() => worker.getKVNamespace(BINDING));
      for (const [key, value] of Object.entries(keys.value)) {
        yield* Effect.promise(() => namespace.put(key, value));
      }
    }
    const response = yield* Effect.promise(() => worker.dispatchFetch('https://probe.invalid/'));
    return Schema.decodeUnknownSync(ProbeResultSchema)(yield* Effect.promise(() => response.json()));
  }).pipe(Effect.scoped);

it.live('reads the published snapshot from key active of the composition KV binding', () =>
  Effect.gen(function* readsSnapshot() {
    expect(yield* readInWorker(Option.some({ active: '{"snapshot":1}' }))).toEqual({ snapshot: '{"snapshot":1}' });
  }),
);

it.live('fails closed when the composition KV binding holds no snapshot or is not bound', () =>
  Effect.gen(function* failsClosed() {
    expect(yield* readInWorker(Option.some({}))).toEqual({
      failure: `The ${BINDING} Workers KV binding holds no snapshot`,
    });
    expect(yield* readInWorker(Option.none())).toEqual({
      failure: `The ${BINDING} Workers KV binding is required`,
    });
  }),
);
