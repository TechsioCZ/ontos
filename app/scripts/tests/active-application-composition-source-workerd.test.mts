import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

import { ONTOS_APPLICATION_COMPOSITION_MAX_BYTES } from '../../packages/core-runtime/src/modules/application-composition-limits.ts';

const sourceModule = fileURLToPath(
  new URL('../../packages/core-runtime/src/modules/active-application-composition-source.workerd.ts', import.meta.url),
);
const sourceService = fileURLToPath(
  new URL('../../packages/core-runtime/src/modules/active-application-composition-source-service.ts', import.meta.url),
);

const probeWorker = `
import { Effect } from 'effect';
import { ActiveApplicationCompositionSourceLive } from ${JSON.stringify(sourceModule)};
import { ActiveApplicationCompositionSource } from ${JSON.stringify(sourceService)};

export default {
  async fetch() {
    const result = await Effect.runPromise(
      ActiveApplicationCompositionSource.pipe(
        Effect.flatMap(({ load }) => load),
        Effect.provide(ActiveApplicationCompositionSourceLive),
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
const FIRST_SNAPSHOT = '{"snapshot":1}';

const bundled = (contents: string) =>
  Effect.promise(() =>
    build({
      bundle: true,
      conditions: ['workerd', 'worker', 'import'],
      external: ['cloudflare:*'],
      format: 'esm',
      platform: 'neutral',
      stdin: { contents, loader: 'js', resolveDir: import.meta.dirname },
      write: false,
    }),
  );

/** Owns one native Worker and its seeded composition KV for the surrounding Effect scope. */
const workerProbe = (keys: Option.Option<Readonly<Record<string, string>>>, contents = probeWorker) =>
  Effect.gen(function* readInWorkerEffect() {
    const bundle = yield* bundled(contents);
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
    return worker;
  });

const readSnapshot = (worker: Miniflare) =>
  Effect.gen(function* readSnapshotEffect() {
    const response = yield* Effect.promise(() => worker.dispatchFetch('https://probe.invalid/'));
    return Schema.decodeUnknownSync(ProbeResultSchema)(yield* Effect.promise(() => response.json()));
  });

const readInWorker = (keys: Option.Option<Readonly<Record<string, string>>>) =>
  workerProbe(keys).pipe(Effect.flatMap(readSnapshot), Effect.scoped);

it.live('reads the published snapshot from key active of the composition KV binding', () =>
  Effect.gen(function* readsSnapshot() {
    expect(yield* readInWorker(Option.some({ active: FIRST_SNAPSHOT }))).toEqual({ snapshot: FIRST_SNAPSHOT });
  }),
);

it.live('the same Worker reads a newly published snapshot without redeployment', () =>
  Effect.gen(function* runtimePromotion() {
    const worker = yield* workerProbe(Option.some({ active: FIRST_SNAPSHOT }));
    expect(yield* readSnapshot(worker)).toEqual({ snapshot: FIRST_SNAPSHOT });
    const namespace = yield* Effect.promise(() => worker.getKVNamespace(BINDING));
    yield* Effect.promise(() => namespace.put('active', '{"snapshot":2}'));
    expect(yield* readSnapshot(worker)).toEqual({ snapshot: '{"snapshot":2}' });
  }).pipe(Effect.scoped),
);

it.live('captures many one-byte KV fragments with a separate accumulator on every read', () =>
  Effect.gen(function* fragmentedKvSnapshotBody() {
    const fragmentedProbeWorker = `
import { env } from 'cloudflare:workers';
import { Effect } from 'effect';
import { ActiveApplicationCompositionSourceLive } from ${JSON.stringify(sourceModule)};
import { ActiveApplicationCompositionSource } from ${JSON.stringify(sourceService)};

const binding = env.${BINDING};
const originalGet = binding.get.bind(binding);
binding.get = (key, type) => originalGet(key, type).then(async (stream) => {
  if (stream === null) return null;
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.byteLength) controller.close();
      else {
        controller.enqueue(bytes.subarray(offset, offset + 1));
        offset += 1;
      }
    },
  });
});

export default {
  async fetch() {
    const result = await Effect.runPromise(
      ActiveApplicationCompositionSource.pipe(
        Effect.flatMap(({ load }) => load),
        Effect.provide(ActiveApplicationCompositionSourceLive),
        Effect.match({ onFailure: (error) => ({ failure: error.reason }), onSuccess: (snapshot) => ({ snapshot }) }),
      ),
    );
    return Response.json(result);
  },
};
`;
    const first = `{"snapshot":"ř${'x'.repeat(65_536)}"}`;
    const worker = yield* workerProbe(Option.some({ active: first }), fragmentedProbeWorker);
    expect(yield* readSnapshot(worker)).toEqual({ snapshot: first });
    const namespace = yield* Effect.promise(() => worker.getKVNamespace(BINDING));
    yield* Effect.promise(() => namespace.put('active', FIRST_SNAPSHOT));
    expect(yield* readSnapshot(worker)).toEqual({ snapshot: FIRST_SNAPSHOT });
  }).pipe(Effect.scoped),
);

it.live('rejects an oversized KV value instead of admitting a truncated inventory', () =>
  Effect.gen(function* oversizedSnapshot() {
    expect(
      yield* readInWorker(Option.some({ active: 'x'.repeat(ONTOS_APPLICATION_COMPOSITION_MAX_BYTES + 1) })),
    ).toEqual({
      failure: `The active Application Composition snapshot exceeds ${ONTOS_APPLICATION_COMPOSITION_MAX_BYTES} bytes`,
    });
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

it.live('cancels a native KV stream that arrives after timeout and handles cancellation rejection', () =>
  Effect.gen(function* delayedSnapshotAcquisition() {
    const delayedProbeWorker = `
import { env } from 'cloudflare:workers';
import { Effect } from 'effect';
import { ActiveApplicationCompositionSourceLive } from ${JSON.stringify(sourceModule)};
import { ActiveApplicationCompositionSource } from ${JSON.stringify(sourceService)};

export default {
  async fetch() {
    const binding = env.${BINDING};
    const originalGet = binding.get.bind(binding);
    let cancellationStarted = false;
    let cancellationRejected = false;
    let pendingRead = Promise.resolve(null);
    binding.get = (key, type) => {
      pendingRead = originalGet(key, type).then(async (stream) => {
        if (stream !== null) {
          const originalCancel = stream.cancel.bind(stream);
          stream.cancel = async () => {
            cancellationStarted = true;
            await originalCancel();
            cancellationRejected = true;
            throw new Error('fixture cancellation rejection');
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 5100));
        return stream;
      });
      return pendingRead;
    };
    const result = await Effect.runPromise(
      ActiveApplicationCompositionSource.pipe(
        Effect.flatMap(({ load }) => load),
        Effect.provide(ActiveApplicationCompositionSourceLive),
        Effect.match({ onFailure: (error) => ({ failure: error.reason }), onSuccess: (snapshot) => ({ snapshot }) }),
      ),
    );
    await pendingRead;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return Response.json({ ...result, cancellationStarted, cancellationRejected });
  },
};
`;
    const worker = yield* workerProbe(Option.some({ active: FIRST_SNAPSHOT }), delayedProbeWorker);
    const response = yield* Effect.promise(() => worker.dispatchFetch('https://probe.invalid/'));
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        cancellationRejected: Schema.Boolean,
        cancellationStarted: Schema.Boolean,
        failure: Schema.String,
      }),
    )(yield* Effect.promise(() => response.json()));
    expect(result).toEqual({
      cancellationRejected: true,
      cancellationStarted: true,
      failure: 'The Workers KV snapshot read timed out',
    });
  }).pipe(Effect.scoped),
);
