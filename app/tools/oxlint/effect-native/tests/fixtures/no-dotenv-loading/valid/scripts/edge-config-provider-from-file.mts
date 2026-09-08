#!/usr/bin/env node
// The A3 target shape in a script: one ConfigProvider composed at the root, no dotenv package.
import { readFileSync } from 'node:fs';

import { Config, ConfigProvider, Effect, Layer, Redacted } from 'effect';

const parseEnvFile = (source: string): ReadonlyMap<string, string> =>
  new Map(
    source
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const),
  );

export const RootConfigProvider = Layer.setConfigProvider(
  ConfigProvider.fromEnv().pipe(
    ConfigProvider.orElse(() => ConfigProvider.fromMap(new Map(parseEnvFile(readFileSync('.env', 'utf8'))))),
  ),
);

export const databaseUrl = Effect.map(Config.redacted('DATABASE_URL'), Redacted.value);
