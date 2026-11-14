#!/usr/bin/env node
import { createHash } from 'node:crypto';
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Array as EffectArray, Console, Effect, FileSystem, Layer, Order } from 'effect';
import type { PlatformError } from 'effect/PlatformError';

/** Content, not Git identity or mtimes: a demo dist is trusted only with these shared sources. */
export const sharedBuildSourceDigest = Effect.fn('Demo.sharedBuildSourceDigest')(function* sharedBuildSourceDigest(
  appDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const digest = createHash('sha256').update('ontos-demo-shared-build-source:v1\0');
  const hashFile = Effect.fn('Demo.hashSharedBuildSource')(function* hashFile(relative: string) {
    const bytes = yield* fs.readFile(path.join(appDirectory, relative));
    digest.update(`${relative}\0${bytes.byteLength}\0`).update(bytes);
  });
  const visit = (relative: string): Effect.Effect<void, PlatformError> =>
    Effect.gen(function* visitSharedBuildSource() {
      const entries = yield* fs.readDirectory(path.join(appDirectory, relative));
      for (const entry of EffectArray.sort(entries, Order.String)) {
        const child = path.join(relative, entry);
        const stat = yield* fs.stat(path.join(appDirectory, child));
        if (stat.type === 'Directory') {
          yield* visit(child);
        } else if (stat.type === 'File') {
          yield* hashFile(child);
        }
      }
    });
  for (const owner of ['core-runtime', 'shared-contracts']) {
    yield* hashFile(`packages/${owner}/package.json`);
    yield* visit(`packages/${owner}/src`);
  }
  return digest.digest('hex');
});

const executableLayer = Layer.effectDiscard(
  sharedBuildSourceDigest(path.resolve(import.meta.dirname, '../..')).pipe(Effect.flatMap(Console.log)),
).pipe(Layer.provide(NodeServices.layer));

if (import.meta.main) {
  NodeRuntime.runMain(Layer.build(executableLayer).pipe(Effect.scoped));
}
