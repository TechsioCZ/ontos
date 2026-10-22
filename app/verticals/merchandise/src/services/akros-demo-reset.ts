// In-app reset of the AKROS demo company to the same predictable baseline `demo:seed:akros --reset` writes. The
// baseline ships inside the server bundle (akros-baseline.generated.ts), so the reset needs no filesystem and runs
// the same on Node and Cloudflare Workers; parts are decoded and inserted one at a time to keep memory bounded.
import { Effect, Encoding, Result, Schema } from 'effect';
import { MerchandiseStateSchema } from '../../shared/apis/records.ts';
import type { MerchandiseState } from '../../shared/apis/records.ts';
import { MerchandisePersistenceUnavailable } from '../../shared/errors/merchandise-persistence-unavailable.ts';
import { AKROS_BASELINE_PARTS } from './akros-baseline.generated.ts';
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
  const json = yield* Effect.tryPromise({
    catch: (cause) => baselineUnavailable('AKROS baseline part does not decompress', cause),
    try: () =>
      new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'))).text(),
  });
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
  const [first, ...rest] = AKROS_BASELINE_PARTS;
  if (first === undefined) {
    return yield* baselineUnavailable('AKROS baseline is empty');
  }
  const head = yield* decodeAkrosBaselinePart(first);
  yield* deleteScope(db, scope);
  yield* insertSnapshotPart(db, scope, head);
  for (const part of rest) {
    yield* insertSnapshotPart(db, scope, yield* decodeAkrosBaselinePart(part));
  }
  return yield* writeSnapshotHead(db, scope, head);
});
