import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Schema } from 'effect';
import { runEffectTestPromise } from '../../packages/core-runtime/src/testing/effect-runtime.ts';
import { KnipConfigSchema } from '../../quality-audit/knip-model.mts';

const appRoot = path.resolve(import.meta.dirname, '../..');

export const runPinnedKnip = async (
  root: string,
  consumerPath: string,
  model: {
    readonly config: typeof KnipConfigSchema.Type;
    readonly consumerSource: string;
  },
) => {
  const directory = path.dirname(consumerPath);
  mkdirSync(directory, { recursive: true });
  writeFileSync(consumerPath, model.consumerSource);
  const configPath = path.join(directory, 'knip.json');
  const configuration = await runEffectTestPromise(
    Schema.encodeEffect(Schema.fromJsonString(KnipConfigSchema))(model.config),
  );
  writeFileSync(configPath, configuration);
  return spawnSync(
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
    { encoding: 'utf-8', timeout: 60_000 },
  );
};
