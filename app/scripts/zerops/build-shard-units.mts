#!/usr/bin/env node
/**
 * The units one stage build shard builds (zerops-stage.yml, job `build`), printed space-separated.
 *
 * The Shell builds alone in shard 0: its build takes several times as long as a module's, and the push waits for
 * the slowest shard. The modules of topology/application-release-intent.json are dealt over the other shards. A module
 * stays in the shard it had while the Shell shared shard 0 with every seventh unit (`index % shards`, with the Shell at
 * index 0), so each shard's restored unit cache still holds its modules; only the modules that used to sit beside
 * the Shell move, round-robin over the module shards.
 *
 *   node scripts/zerops/build-shard-units.mts <shard> <shards>
 */
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Data, Effect, FileSystem, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';

import { ReleaseIntentSchema, SHELL_ID, workspaceRoot } from './hosted-units.mts';

/** The Shell's own shard. */
export const SHELL_SHARD = 0;

export class BuildShardError extends Data.TaggedError('BuildShardError')<{ readonly message: string }> {}

/** The shard a module builds in, by its position in the release intent. */
const moduleShard = (position: number, shards: number): number => {
  // The module's index in the old dealing, where the Shell held index 0.
  const index = position + 1;
  const previous = index % shards;
  return previous === SHELL_SHARD ? 1 + ((index / shards - 1) % (shards - 1)) : previous;
};

/** Every shard's units, in release-intent order; shard 0 holds only the Shell. */
export const buildShardUnits = (modules: readonly string[], shards: number): readonly (readonly string[])[] => {
  const dealt = Array.from({ length: shards }, (_, shard): string[] => (shard === SHELL_SHARD ? [SHELL_ID] : []));
  for (const [position, module] of modules.entries()) {
    dealt[moduleShard(position, shards)]?.push(module);
  }
  return dealt;
};

/** The release intent's modules, in file order. */
export const readReleaseModules = Effect.gen(function* readReleaseModules() {
  const fs = yield* FileSystem.FileSystem;
  const intent = yield* Schema.decodeEffect(ReleaseIntentSchema)(
    yield* fs.readFileString(path.join(workspaceRoot, 'topology/application-release-intent.json')),
  );
  return intent.modules.map(({ appId }): string => appId);
});

const command = Command.make(
  'build-shard-units',
  { shard: Argument.Int('shard'), shards: Argument.Int('shards') },
  ({ shard, shards }) =>
    Effect.gen(function* printShardUnits() {
      if (shards < 2 || shard < 0 || shard >= shards) {
        return yield* new BuildShardError({ message: `No shard ${String(shard)} of ${String(shards)}` });
      }
      const units = buildShardUnits(yield* readReleaseModules, shards)[shard] ?? [];
      return yield* Console.log(units.join(' '));
    }),
);

if (import.meta.main) {
  NodeRuntime.runMain(Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)), {
    disableErrorReporting: false,
  });
}
