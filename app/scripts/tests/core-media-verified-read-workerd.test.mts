import { fileURLToPath } from 'node:url';

import { sha256 } from '@noble/hashes/sha2.js';
import { build } from 'esbuild';
import { Effect, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import { expect, it } from 'effect-rstest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

/*
 * EVIDENCE LEVEL: INTEGRATION EXECUTED on a local workerd (Miniflare), not a deployed Worker, not Cloudflare R2 and not
 * a measurement of the Worker CPU class (local workerd enforces no CPU limit). The object store here is a minimal
 * in-Worker port implementation that streams the request body: the S3 adapter is NOT under test.
 *
 * Runs the REAL `verified-read.ts` and `content-digest.ts` of Core Media inside workerd, so the platform's native
 * `crypto.DigestStream` is the digest (the Node suites run the pure implementation or a stand-in):
 *
 * - the native digest of a multi-chunk object verifies against the confirmed identity (and agrees with Node's SHA-256);
 * - a same-length substitution is `integrity_failed`, never `verified`;
 * - an early clean end and a stream that aborts are `unavailable`, never corruption;
 * - a digest step that does not answer within `DigestStepTimeout` is UNAVAILABLE (never `integrity_failed`, never a
 *   defect), a step slower than a tiny guard trips it and the same step under the built-in 5 s does not.
 *   The stall is a delay wrapped around the REAL native stream (the platform itself never stalls on demand), so the
 *   guard is proven against native stream semantics but not against a genuinely hung platform call.
 *
 * Run alone: `mise exec -- pnpm exec rstest --project scripts scripts/tests/core-media-verified-read-workerd.test.mts`
 * (from `app/`; no container is needed).
 */

const coreMedia = (file: string) =>
  fileURLToPath(new URL(`../../packages/core-runtime/src/media/${file}`, import.meta.url));

const probeWorker = `
import { Cause, Duration, Effect, Exit, Option, Stream } from 'effect';
import { DigestStepTimeout, platformDigestStream } from ${JSON.stringify(coreMedia('content-digest.ts'))};
import { ObjectStorage, ObjectStorageNetworkError } from ${JSON.stringify(coreMedia('object-storage.ts'))};
import { deriveMediaStorageKey } from ${JSON.stringify(coreMedia('storage-key.ts'))};
import { openVerifiedMediaStream, verifyReadyMediaAsset } from ${JSON.stringify(coreMedia('verified-read.ts'))};

const PROVIDER = 'workerd-probe';
const TENANT = '00000000-0000-4000-8000-000000000001';
const ASSET = '00000000-0000-4000-8000-0000000000a1';

/** The real native stream with a delay in front of one step: a stand-in for a platform call that answers late. */
const installStall = (stall, stallMs) => {
  const Native = globalThis.crypto.DigestStream;
  const [where, which] = stall.split(':');
  let writes = -1;
  class StalledDigestStream {
    constructor(algorithm) {
      const inner = new Native(algorithm);
      const writer = inner.getWriter();
      const wait = () => new Promise((resolve) => setTimeout(resolve, stallMs));
      const outer = new WritableStream({
        async write(chunk) {
          writes += 1;
          if (where === 'write' && (which === 'all' || writes === Number(which))) {
            await wait();
          }
          await writer.write(chunk);
        },
        async close() {
          if (where === 'close') {
            await wait();
          }
          await writer.close();
        },
      });
      Object.defineProperty(outer, 'digest', { get: () => inner.digest });
      return outer;
    }
  }
  Object.defineProperty(globalThis.crypto, 'DigestStream', { configurable: true, value: StalledDigestStream });
  return { restore: () => Object.defineProperty(globalThis.crypto, 'DigestStream', { configurable: true, value: Native }) };
};

const outcomeOf = (exit) => {
  if (Exit.isSuccess(exit)) {
    return { kind: 'value', value: exit.value };
  }
  if (exit.cause.reasons.some(Cause.isDieReason)) {
    const die = exit.cause.reasons.find(Cause.isDieReason);
    return { defect: String(die.defect), kind: 'defect' };
  }
  return { kind: 'failure', failure: Option.getOrUndefined(Cause.findErrorOption(exit.cause)) };
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const query = (name) => url.searchParams.get(name) ?? undefined;
    const size = Number(query('size'));
    const declared = query('declared') === undefined ? size : Number(query('declared'));
    const abortAfter = query('abortAfter') === undefined ? undefined : Number(query('abortAfter'));
    const stepMs = query('stepMs') === undefined ? undefined : Number(query('stepMs'));
    const stall = query('stall');
    const mode = query('mode') ?? 'verify';
    const native = platformDigestStream() !== undefined;

    const key = deriveMediaStorageKey({ mediaAssetId: ASSET, tenantId: TENANT });
    const asset = {
      byteSize: BigInt(size),
      contentSha256: query('sha'),
      processingStatus: 'ready',
      sealedAt: new Date(0),
      storageKey: key,
      storageObjectVersionRef: null,
      storageProvider: PROVIDER,
    };
    const stat = { byteSize: declared };
    let seen = 0;
    const body = Stream.fromReadableStream({
      evaluate: () => request.body,
      onError: () => new ObjectStorageNetworkError({ code: 'object_storage_network_error', reason: 'probe read failed' }),
    }).pipe(
      Stream.mapEffect((chunk) => {
        seen += chunk.byteLength;
        return abortAfter !== undefined && seen > abortAfter
          ? Effect.fail(new ObjectStorageNetworkError({ code: 'object_storage_network_error', reason: 'probe aborted' }))
          : Effect.succeed(chunk);
      }),
    );
    const storage = {
      get: () => Effect.succeed({ body, stat }),
      providerId: PROVIDER,
      put: () => Effect.die('the probe store is read-only'),
      stat: () => Effect.succeed(stat),
    };

    const stalled = stall === undefined ? undefined : installStall(stall, Number(query('stallMs') ?? 250));
    try {
      const guarded = (effect) => stepMs === undefined ? effect : Effect.provideService(effect, DigestStepTimeout, Duration.millis(stepMs));
      const started = Date.now();
      let streamDelivered = 0;
      const exit = await Effect.runPromise(
        mode === 'stream'
          ? guarded(
              Effect.gen(function* () {
                const opened = yield* openVerifiedMediaStream(asset);
                yield* opened.body.pipe(Stream.runForEach((chunk) => Effect.sync(() => { streamDelivered += chunk.byteLength; })));
              }).pipe(Effect.provideService(ObjectStorage, storage), Effect.exit),
            )
          : guarded(verifyReadyMediaAsset(asset).pipe(Effect.provideService(ObjectStorage, storage), Effect.exit)),
      );
      const defaultGuardMs = await Effect.runPromise(Effect.map(Effect.service(DigestStepTimeout), Duration.toMillis));
      return Response.json({ defaultGuardMs, elapsedMs: Date.now() - started, native, outcome: outcomeOf(exit), streamDelivered });
    } finally {
      stalled?.restore();
    }
  },
};
`;

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

/** Deterministic bytes in uneven chunks, never held whole by the test (`salt` makes a different object of equal size). */
const patterned = (totalBytes: number, salt = 0) => {
  const chunks: Uint8Array[] = [];
  let state = 12_345 + salt;
  for (let offset = 0; offset < totalBytes;) {
    const size = Math.min(offset % 3 === 0 ? 64 * 1024 : 7919, totalBytes - offset);
    const chunk = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) {
      state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      chunk[index] = Math.floor(state / 16_777_216);
    }
    chunks.push(chunk);
    offset += size;
  }
  return chunks;
};

const digestOf = (chunks: readonly Uint8Array[]) => {
  const hasher = sha256.create();
  for (const chunk of chunks) {
    hasher.update(chunk);
  }
  return Hex.encode(hasher.digest());
};

const ProbeAnswerSchema = Schema.Struct({
  defaultGuardMs: Schema.Number,
  elapsedMs: Schema.Number,
  native: Schema.Boolean,
  outcome: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('value'), value: Schema.Any }),
    Schema.Struct({ defect: Schema.String, kind: Schema.Literal('defect') }),
    Schema.Struct({ failure: Schema.optionalKey(Schema.Any), kind: Schema.Literal('failure') }),
  ]),
  streamDelivered: Schema.Number,
});

interface Probe {
  /** The bytes the store delivers (chunks); the recorded identity is `recorded`'s, which may differ (tampering). */
  readonly delivered: readonly Uint8Array[];
  readonly query: Readonly<Record<string, string>>;
  readonly recorded: readonly Uint8Array[];
}

const askWorker = (worker: Miniflare, probe: Probe) =>
  Effect.gen(function* ask() {
    const chunks = [...probe.delivered];
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
    const total = probe.recorded.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const delivered = probe.delivered.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const query = new URLSearchParams({ ...probe.query, sha: digestOf(probe.recorded), size: String(total) });
    const response = yield* Effect.promise(() =>
      worker.dispatchFetch(`https://probe.invalid/?${query.toString()}`, {
        body,
        duplex: 'half',
        headers: { 'content-length': String(delivered) },
        method: 'POST',
      }),
    );
    return Schema.decodeUnknownSync(ProbeAnswerSchema)(yield* Effect.promise(() => response.json()));
  });

const SMALL = 3 * 64 * 1024 + 7919;
/** What a read answers when a platform digest step does not answer within the guard: retryable, never `failed`. */
const UNANSWERED_DIGEST = { outcome: 'unavailable', reason: 'digest_unanswered' };

it.live(
  'verifies a multi-chunk object with the native DigestStream on workerd, and a same-length swap is integrity_failed',
  () =>
    Effect.gen(function* nativeVerification() {
      const worker = yield* workerProbe;
      const original = patterned(8 * MIB);
      const verified = yield* askWorker(worker, { delivered: original, query: {}, recorded: original });
      expect(verified.native).toBe(true);
      expect(verified.defaultGuardMs).toBe(5000);
      expect(verified.outcome).toEqual({
        kind: 'value',
        value: { byteSize: 8 * MIB, contentSha256: digestOf(original), outcome: 'verified' },
      });

      // Same length, other bytes: only a completely read object that differs proves corruption.
      const swapped = patterned(8 * MIB, 1);
      const tampered = yield* askWorker(worker, { delivered: swapped, query: {}, recorded: original });
      expect(tampered.outcome).toMatchObject({
        kind: 'value',
        value: {
          finding: { observed: { byteSize: 8 * MIB, contentSha256: digestOf(swapped) } },
          outcome: 'integrity_failed',
        },
      });
    }).pipe(Effect.scoped),
);

it.live('an early clean end and an aborted stream are unavailable on workerd, never corruption', () =>
  Effect.gen(function* shortAndAborted() {
    const worker = yield* workerProbe;
    const original = patterned(SMALL);
    // The provider declares the whole object but the stream ends cleanly after fewer bytes.
    const early = yield* askWorker(worker, {
      delivered: original.slice(0, 2),
      query: { declared: String(SMALL) },
      recorded: original,
    });
    expect(early.outcome).toEqual({
      kind: 'value',
      value: { outcome: 'unavailable', reason: 'framing_inconsistent' },
    });
    // The stream fails midway: a transport error is a provider failure.
    const aborted = yield* askWorker(worker, {
      delivered: original,
      query: { abortAfter: '70000' },
      recorded: original,
    });
    expect(aborted.outcome).toMatchObject({
      kind: 'value',
      value: { outcome: 'unavailable', providerFailure: 'object_storage_network_error', reason: 'provider_failure' },
    });
    // The streaming form ends in the same typed interruption and withholds the last chunk of a short object.
    const streamed = yield* askWorker(worker, {
      delivered: original.slice(0, 2),
      query: { declared: String(SMALL), mode: 'stream' },
      recorded: original,
    });
    expect(streamed.outcome).toMatchObject({
      failure: { read: { outcome: 'unavailable', reason: 'framing_inconsistent' } },
      kind: 'failure',
    });
    // The store sent 65536 + 7919 bytes and ended cleanly: some of them were delivered, the held last chunk was not.
    expect(streamed.streamDelivered).toBeGreaterThan(0);
    expect(streamed.streamDelivered).toBeLessThan(65_536 + 7919);
  }).pipe(Effect.scoped),
);

it.live(
  'a digest step slower than the guard is unavailable on workerd, and the built-in 5 s lets the same step pass',
  () =>
    Effect.gen(function* stepGuard() {
      const worker = yield* workerProbe;
      const original = patterned(SMALL);
      const slowStep = { stall: 'write:1', stallMs: '300' };
      // A tiny configured guard: the stalled chunk write trips it. Unavailable, never `failed`.
      const tripped = yield* askWorker(worker, {
        delivered: original,
        query: { ...slowStep, stepMs: '50' },
        recorded: original,
      });
      expect(tripped.outcome).toEqual({ kind: 'value', value: UNANSWERED_DIGEST });
      expect(tripped.elapsedMs).toBeLessThan(2000);
      // The same stall under the built-in guard is only a slow step: the object verifies.
      const patient = yield* askWorker(worker, { delivered: original, query: slowStep, recorded: original });
      expect(patient.defaultGuardMs).toBe(5000);
      expect(patient.outcome).toMatchObject({ kind: 'value', value: { outcome: 'verified' } });
      expect(patient.elapsedMs).toBeGreaterThanOrEqual(250);
      // The final close and digest read is a step too.
      const closing = yield* askWorker(worker, {
        delivered: original,
        query: { stall: 'close', stallMs: '300', stepMs: '50' },
        recorded: original,
      });
      expect(closing.outcome).toEqual({ kind: 'value', value: UNANSWERED_DIGEST });
      // Every write is slow but each under the guard, and together they exceed it: the guard bounds a step, not the object.
      const everyStep = yield* askWorker(worker, {
        delivered: original,
        query: { stall: 'write:all', stallMs: '60', stepMs: '150' },
        recorded: original,
      });
      expect(everyStep.outcome).toMatchObject({ kind: 'value', value: { outcome: 'verified' } });
      expect(everyStep.elapsedMs).toBeGreaterThan(150);
    }).pipe(Effect.scoped),
);
