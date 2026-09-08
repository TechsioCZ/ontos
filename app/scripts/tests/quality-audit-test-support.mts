import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { Effect, FileSystem, Schema } from 'effect';

import { KnipConfigSchema } from '../../quality-audit/knip-model.mts';

const appRoot = path.resolve(import.meta.dirname, '../..');

export const runPinnedKnip = Effect.fn('runPinnedKnip')(
  function* runPinnedKnipEffect(
    root: string,
    consumerPath: string,
    model: {
      readonly config: typeof KnipConfigSchema.Type;
      readonly consumerSource: string;
    }
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = path.dirname(consumerPath);
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.writeFileString(consumerPath, model.consumerSource);
    const configPath = path.join(directory, 'knip.json');
    const configuration = yield* Schema.encodeEffect(
      Schema.fromJsonString(KnipConfigSchema)
    )(model.config);
    yield* fileSystem.writeFileString(configPath, configuration);
    return yield* Effect.sync(() =>
      spawnSync(
        process.execPath,
        [
          path.join(appRoot, 'node_modules/knip/bin/knip.js'),
          '--directory',
          root,
          '--config',
          configPath,
          '--reporter',
          'json',
          '--no-progress',
        ],
        { encoding: 'utf-8', timeout: 60_000 }
      )
    );
  }
);
