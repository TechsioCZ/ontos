import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { Effect, Schema } from 'effect';
import type { FileSystem } from 'effect';

import { DemoSeedError } from './seed-client.mts';
import type { SeedTarget, SeedWriteCheckpoint } from './seed-client.mts';

const Entry = Schema.Struct({
  idempotencyKey: Schema.toEncoded(Schema.String.pipe(Schema.brand('SeedIdempotencyKey'))),
  requestHash: Schema.String,
});
export const seedCheckpointDirectory = (target: SeedTarget, root = '.scratch/demo-seed') =>
  path.resolve(
    root,
    createHash('sha256').update(`${target.shellUrl}|${target.tenantId}|${target.legalEntityId}`).digest('hex'),
  );

/** Persist the invocation identity before dispatch. An interrupted exact request reuses its native Action key. */
export const seedWriteCheckpoint =
  (fs: FileSystem.FileSystem, directory: string): SeedWriteCheckpoint =>
  (audience, route, payload) =>
    Effect.gen(function* checkpointWrite() {
      const requestHash = createHash('sha256').update(`${audience}|${route}|${payload}`).digest('hex');
      const file = path.join(directory, 'writes', `${requestHash}.json`);
      yield* fs.makeDirectory(path.dirname(file), { mode: 0o700, recursive: true });
      if (yield* fs.exists(file)) {
        const entry = yield* fs
          .readFileString(file)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Entry))));
        if (entry.requestHash !== requestHash) {
          return yield* new DemoSeedError({ reason: 'Seed write checkpoint does not match this exact request.' });
        }
        return entry.idempotencyKey;
      }
      const entry = { idempotencyKey: randomUUID(), requestHash };
      yield* fs.writeFileString(file, yield* Schema.encodeEffect(Schema.fromJsonString(Entry))(entry), {
        flag: 'wx',
        mode: 0o600,
      });
      return entry.idempotencyKey;
    }).pipe(
      Effect.mapError(
        () =>
          new DemoSeedError({
            reason:
              'Seed checkpoint unavailable; no owner write was dispatched. Keep the checkpoint directory and resolve the failure before rerunning.',
          }),
      ),
    );
