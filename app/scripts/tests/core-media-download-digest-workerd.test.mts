import { fileURLToPath } from 'node:url';

import { sha256 } from '@noble/hashes/sha2.js';
import { build } from 'esbuild';
import { Effect, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import { expect, it } from 'effect-rstest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

/*
 * EVIDENCE LEVEL: INTEGRATION EXECUTED on a local workerd (Miniflare), not a deployed Worker and not a measurement of
 * the Worker CPU class: local workerd enforces no CPU limit.
 *
 * Proves that the Core Media content digest picks the platform's native `crypto.DigestStream` on workerd and that its
 * size and SHA-256 equal the pure implementation's for a multi-chunk, multi-MiB body, empty chunks included.
 */

const digestModule = fileURLToPath(new URL('../../packages/core-runtime/src/media/content-digest.ts', import.meta.url));

const probeWorker = `
import { Effect, Stream } from 'effect';
import { ContentDigest, platformDigestStream } from ${JSON.stringify(digestModule)};

export default {
  async fetch(request) {
    const native = platformDigestStream() !== undefined;
    const digest = new ContentDigest();
    const reader = request.body.getReader();
    const program = Effect.gen(function* () {
      for (;;) {
        const next = yield* Effect.promise(() => reader.read());
        if (next.done) break;
        yield* digest.add(next.value);
      }
      return yield* digest.finish();
    });
    const identity = await Effect.runPromise(program);
    return Response.json({ ...identity, native });
  },
};
`;

const ProbeResultSchema = Schema.Struct({
  byteSize: Schema.Number,
  contentSha256: Schema.String,
  native: Schema.Boolean,
});

const MIB = 1024 * 1024;

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

const workerProbe = Effect.gen(function* workerProbeEffect() {
  const bundle = yield* bundled;
  return yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Miniflare(
          convertV4MiniflareOptions({
            compatibilityDate: '2026-06-02',
            modules: true,
            script: bundle.outputFiles[0]?.text ?? '',
          }),
        ),
    ),
    (miniflare) => Effect.promise(() => miniflare.dispose()),
  );
});

/** Deterministic bytes in uneven chunks, never held whole by the test. */
const patterned = (totalBytes: number) => {
  const chunks: Uint8Array[] = [];
  let state = 12_345;
  for (let offset = 0; offset < totalBytes;) {
    const size = Math.min(offset % 3 === 0 ? 64 * 1024 : 7919, totalBytes - offset);
    const chunk = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) {
      state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      chunk[index] = Math.floor(state / 16_777_216);
    }
    chunks.push(chunk);
    if (chunks.length === 1) {
      // An empty chunk is a legal read result: it must change neither the size nor the digest.
      chunks.push(new Uint8Array(0));
    }
    offset += size;
  }
  return chunks;
};

it.live('digests with the native DigestStream on workerd and agrees with the pure SHA-256', () =>
  Effect.gen(function* nativeDigest() {
    const worker = yield* workerProbe;
    for (const size of [0, 1, 8 * MIB]) {
      const chunks = patterned(size);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks.shift();
          if (next === undefined) {
            controller.close();
          } else {
            controller.enqueue(next);
          }
        },
      });
      const expected = (() => {
        const hasher = sha256.create();
        for (const chunk of patterned(size)) {
          hasher.update(chunk);
        }
        return Hex.encode(hasher.digest());
      })();
      const response = yield* Effect.promise(() =>
        worker.dispatchFetch('https://probe.invalid/', {
          body,
          duplex: 'half',
          headers: { 'content-length': String(size) },
          method: 'POST',
        }),
      );
      const result = Schema.decodeUnknownSync(ProbeResultSchema)(yield* Effect.promise(() => response.json()));
      expect(result).toEqual({ byteSize: size, contentSha256: expected, native: true });
    }
  }).pipe(Effect.scoped),
);
