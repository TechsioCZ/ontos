import { sha256 } from '@noble/hashes/sha2.js';
import { Duration, Effect, Exit, Schema, Stream } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeShellAuthenticationApiRuntime } from '../../api/index.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { MediaAssetRefSchema } from '../../../../packages/core-runtime/src/resources/media-asset.ts';
import { deriveMediaStorageKey } from '../../../../packages/core-runtime/src/media/storage-key.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { templateDatabaseLayer } from '../support/access-admin-real-gate-fixture.ts';
import { MEDIA_CAPABILITIES, withMediaE2eWorld } from '../support/core-media-e2e-fixture.ts';
import type { E2eActor, MediaE2eWorld } from '../support/core-media-e2e-fixture.ts';
import {
  confirmOverHttp,
  digestOf,
  downloadOf,
  patternBytes,
  putBytes,
  reserveOverHttp,
  rowOf,
} from '../support/core-media-e2e-steps.ts';

/*
 * EVIDENCE: INTEGRATION EXECUTED on the production Shell composition (decision 9 of #1428): the configured
 * `CORE_MEDIA_DIGEST_STEP_TIMEOUT_MS` reaches the digest of every Shell route that runs one: the download, the byte PUT
 * and the generated confirm. The run is started with a SMALL value (the gate uses 50); the Shell reads it when its
 * runtime starts, so a run without it is BLOCKED (a failure under `D20_E2E_REQUIRED=1`), never green on the 5 s default.
 *
 * A Node run has no native digest, so the platform's `crypto.DigestStream` is stood in by a stream that never answers (a
 * stuck platform call). Under the configured guard that step ends as unavailable, never as proven corruption:
 * a retryable 503 problem on the PUT and the confirm, a closed connection before any complete body on the download, and the
 * asset is never `failed`; the same request completes once the platform answers (a stand-in that answers at once is the
 * control, so a stand-in that is broken in itself cannot read as a pass). How a malformed or absent value degrades is
 * the Shell unit test `core-media-digest-step-timeout-layer`.
 * Object store: an S3-compatible EMULATOR (MinIO), NOT R2. Authentication is the header-named actor substitute.
 */

const platform = {
  makeActionRepository,
  makeActionRuntime,
  makeCompositionSnapshot,
  makeReadRuntime,
  makeShellAuthenticationApiRuntime,
};

const GUARD_VARIABLE = 'CORE_MEDIA_DIGEST_STEP_TIMEOUT_MS';
const options = { requires: [GUARD_VARIABLE] };
const uploaderCapabilities = [MEDIA_CAPABILITIES.upload, MEDIA_CAPABILITIES.confirm];
const readerCapabilities = [MEDIA_CAPABILITIES.metadata, MEDIA_CAPABILITIES.download];

const person = (world: MediaE2eWorld, name: string): E2eActor => {
  const actor = world.people.get(name);
  if (actor === undefined) {
    throw new Error(`The world has no ${name}`);
  }
  return actor;
};

const ReservationAnswerSchema = Schema.Struct({ mediaAssetRef: MediaAssetRefSchema });
const idOf = (answer: { readonly json: typeof Schema.Json.Type }): string =>
  Schema.decodeUnknownSync(ReservationAnswerSchema)(answer.json).mediaAssetRef.resourceId;

/** What the platform's digest stream does right now: answer at once, or never answer (a stuck platform call). */
const platformBehaviour = { stuck: false };

/** The platform's native digest stream; it answers the true SHA-256 after close unless the platform is stuck. */
class StandInDigestStream extends WritableStream<Uint8Array> {
  readonly digest;

  constructor(_algorithm: 'SHA-256') {
    const gate = Promise.withResolvers<ArrayBuffer>();
    const never = Promise.withResolvers<undefined>().promise;
    const hash = sha256.create();
    const settle = () => {
      const bytes = hash.digest();
      gate.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    };
    /** One platform step: it answers at once, or never. */
    const step = (work: () => void): Promise<void> => {
      if (platformBehaviour.stuck) {
        return never;
      }
      work();
      return Promise.resolve();
    };
    super({
      close: () => step(settle),
      write: (chunk) =>
        step(() => {
          hash.update(chunk);
        }),
    });
    this.digest = gate.promise;
  }
}

/** The platform offers its digest stream for the scope of the effect (a Worker does; Node has none). */
const withPlatformDigest =
  (stuck: boolean) =>
  <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        platformBehaviour.stuck = stuck;
        Object.defineProperty(globalThis.crypto, 'DigestStream', { configurable: true, value: StandInDigestStream });
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          Reflect.deleteProperty(globalThis.crypto, 'DigestStream');
        }),
    );
const stuckPlatform = withPlatformDigest(true);
const prompt = withPlatformDigest(false);

/** The request that is stuck on the platform, with how long it took to be answered. */
const stuck = <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
  stuckPlatform(effect).pipe(
    Effect.timed,
    Effect.map(([elapsed, value]) => {
      // A stuck step must end at the CONFIGURED guard (the gate uses 50 ms), not at the built-in 5 s: a request that
      // was still unanswered after this ceiling means the Shell never read the configured value.
      expect(Duration.toMillis(elapsed)).toBeLessThan(2500);
      return value;
    }),
  );

/** Whether the body of an answer is read to its end: a stream that dies mid-way rejects. */
const bodyCompletes = (response: Response) =>
  Effect.promise(async () => {
    try {
      await response.arrayBuffer();
      return true;
    } catch {
      return false;
    }
  });

const storeOutOfBand = (world: MediaE2eWorld, mediaAssetId: string, bytes: Uint8Array) =>
  world.storage
    .put({
      body: Stream.make(bytes),
      contentType: 'application/pdf',
      key: deriveMediaStorageKey({ mediaAssetId, tenantId: world.tenantId }),
    })
    .pipe(Effect.orDie);

it.layer(templateDatabaseLayer, { excludeTestServices: true, timeout: '600 seconds' })(
  'the digest step guard of the Shell (CORE_MEDIA_DIGEST_STEP_TIMEOUT_MS) reaches every route that digests bytes',
  (suite) => {
    suite.effect(
      'the download: a stuck step ends the transfer, never as corruption, and the asset downloads once the platform answers',
      (ctx) =>
        withMediaE2eWorld(
          ctx,
          platform,
          (world) =>
            Effect.scoped(
              Effect.gen(function* download() {
                const uploader = person(world, 'uploader');
                const reader = person(world, 'downloader');
                yield* world.grant(uploader, uploaderCapabilities);
                yield* world.grant(reader, readerCapabilities);
                const edge = yield* world.shell;
                const bytes = patternBytes(70_001);
                const id = idOf(yield* reserveOverHttp(edge, uploader, bytes, { idempotencyKey: 'guard-download' }));
                expect((yield* putBytes(edge, uploader, id, bytes)).status).toBe(200);

                // The first chunk is withheld until its digest step answers, so the connection may close before
                // any header: either the request or the body then fails, and a complete body never arrives.
                const completed = yield* stuck(
                  Effect.gen(function* open() {
                    const answered = yield* Effect.exit(
                      edge.open({
                        actor: reader,
                        headers: { 'x-correlation-id': 'guard-stuck' },
                        method: 'GET',
                        path: `/core/media/assets/${id}/content`,
                      }),
                    );
                    return Exit.isSuccess(answered) ? yield* bodyCompletes(answered.value) : false;
                  }),
                );
                expect(completed).toBe(false);
                // A stuck platform proves nothing about the object: it is still sealed, never failed.
                expect((yield* rowOf(world, id))?.processing_status).toBe('ready');

                // The control: a platform that answers at once downloads the very same asset, bytes and digest intact.
                const served = yield* prompt(downloadOf(edge, reader, id));
                expect(served.status).toBe(200);
                expect(served.bytes).toEqual(bytes);
                expect(digestOf(served.bytes)).toBe(digestOf(bytes));
              }),
            ),
          options,
        ),
    );

    suite.effect('the byte PUT: a stuck step ends as a retryable 503 and the same asset completes afterwards', (ctx) =>
      withMediaE2eWorld(
        ctx,
        platform,
        (world) =>
          Effect.scoped(
            Effect.gen(function* put() {
              const uploader = person(world, 'uploader');
              yield* world.grant(uploader, uploaderCapabilities);
              const edge = yield* world.shell;
              const bytes = patternBytes(70_001);
              const id = idOf(yield* reserveOverHttp(edge, uploader, bytes, { idempotencyKey: 'guard-put' }));

              expect((yield* stuck(putBytes(edge, uploader, id, bytes))).status).toBe(503);
              expect((yield* rowOf(world, id))?.processing_status).toBe('uploaded');

              expect((yield* prompt(putBytes(edge, uploader, id, bytes))).status).toBe(200);
              expect((yield* rowOf(world, id))?.processing_status).toBe('ready');
            }),
          ),
        options,
      ),
    );

    suite.effect('the generated confirm: a stuck read-back ends as a retryable 503, never as failed', (ctx) =>
      withMediaE2eWorld(
        ctx,
        platform,
        (world) =>
          Effect.scoped(
            Effect.gen(function* confirm() {
              const uploader = person(world, 'uploader');
              yield* world.grant(uploader, uploaderCapabilities);
              const edge = yield* world.shell;
              const bytes = patternBytes(70_001);
              const id = idOf(yield* reserveOverHttp(edge, uploader, bytes, { idempotencyKey: 'guard-confirm' }));
              yield* storeOutOfBand(world, id, bytes);

              expect((yield* stuck(confirmOverHttp(edge, uploader, id, 'guard-confirm-1'))).status).toBe(503);
              expect((yield* rowOf(world, id))?.processing_status).toBe('uploaded');

              const confirmed = yield* prompt(confirmOverHttp(edge, uploader, id, 'guard-confirm-2'));
              expect(confirmed.status).toBe(200);
              expect(confirmed.json).toMatchObject({ contentSha256: digestOf(bytes), processingStatus: 'ready' });
            }),
          ),
        options,
      ),
    );
  },
);
