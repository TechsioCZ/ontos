// In-app reset of the AKROS demo company to the same predictable baseline `demo:seed:akros --reset` writes. The
// baseline ships inside the server bundle (akros-baseline.generated.ts), so the reset needs no filesystem and runs
// the same on Node and Cloudflare Workers; parts are decoded and inserted one at a time to keep memory bounded. The
// parts are loaded only when a reset runs, so they cost nothing on a cold isolate's first request.
import { Effect, Encoding, Result, Schema, Stream } from 'effect';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { MerchandisePersistenceUnavailable } from '../../shared/errors/merchandise-persistence-unavailable.ts';
import { loadAkrosBaselineParts } from './akros-baseline.generated.ts';
import { deleteScope, insertSnapshotPart, writeSnapshotHead } from './merchandise-store.ts';
import type { MerchandiseDb, StoreScope } from './merchandise-store.ts';

const baselineUnavailable = (reason: string, cause?: unknown) =>
  Object.defineProperty(
    new MerchandisePersistenceUnavailable({ code: 'merchandise_persistence_unavailable', reason }),
    'cause',
    { enumerable: false, value: cause },
  );

const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(MerchandiseStateSchema));

/** One baseline part: base64 → gzip → JSON → decoded state (Web streams: Node and Workers alike). */
export const decodeAkrosBaselinePart = Effect.fn('Merchandise.decodeAkrosBaselinePart')(function* decodePart(
  part: string,
) {
  const bytes = yield* Result.match(Encoding.decodeBase64(part), {
    onFailure: (cause) => Effect.fail(baselineUnavailable('AKROS baseline part is not base64', cause)),
    onSuccess: Effect.succeed,
  });
  const json = yield* Stream.fromReadableStream({
    evaluate: () => new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('gzip')),
    onError: (cause) => baselineUnavailable('AKROS baseline part does not decompress', cause),
  }).pipe(Stream.decodeText, Stream.mkString);
  return yield* decodeState(json).pipe(
    Effect.mapError((cause) => baselineUnavailable('AKROS baseline does not match the model', cause)),
  );
}) satisfies (part: string) => Effect.Effect<MerchandiseState, MerchandisePersistenceUnavailable>;

/**
 * Replaces the company's merchandise with the AKROS baseline: full catalog, initial stock receipts and the six
 * sample orders. Runs inside the caller's transaction; returns the new revision.
 */
export const resetToAkrosBaseline = Effect.fn('Merchandise.resetToAkrosBaseline')(function* resetToAkrosBaseline(
  db: MerchandiseDb,
  scope: StoreScope,
) {
  const [first, ...rest] = loadAkrosBaselineParts();
  if (first === undefined) {
    return yield* baselineUnavailable('AKROS baseline is empty');
  }
  const head = yield* decodeAkrosBaselinePart(first);
  yield* deleteScope(db, scope);
  yield* insertSnapshotPart(db, scope, head);
  yield* Effect.forEach(
    rest,
    (part) => decodeAkrosBaselinePart(part).pipe(Effect.flatMap((state) => insertSnapshotPart(db, scope, state))),
    { concurrency: 1, discard: true },
  );
  return yield* writeSnapshotHead(db, scope, head);
});
