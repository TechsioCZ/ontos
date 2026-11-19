import { execFileSync } from 'node:child_process';

import { NodeFileSystem } from '@effect/platform-node';
import { Config, Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { loadAuthConfig } from '../../api/auth/config.ts';
import { loadConfigurationProvider } from '../../api/auth/configuration-provider.ts';
import { loadGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';

/** Writes a real environment file in a scoped temporary directory, so the provider reads it from disk. */
const environmentFile = (contents: string) =>
  Effect.gen(function* writeEnvironmentFile() {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const envPath = `${directory}/.env`;
    yield* fileSystem.writeFileString(envPath, contents);
    return envPath;
  });

it.effect('explicit environment overrides file values and absent keys fall back to the file', () =>
  Effect.gen(function* explicitEnvironment() {
    const envPath = yield* environmentFile('SECRET=file-secret\nURL=file-url\n');
    const result = yield* loadConfigurationProvider(
      { environment: { URL: 'explicit-url' }, envPath },
      () => 'unreadable',
    ).pipe(
      Effect.flatMap((provider) =>
        Config.all({
          secret: Config.String('SECRET'),
          url: Config.String('URL'),
        }).parse(provider),
      ),
    );
    expect(result).toEqual({ secret: 'file-secret', url: 'explicit-url' });
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.effect('a missing environment file is an empty file, not a failure', () =>
  Effect.gen(function* missingFile() {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const result = yield* loadConfigurationProvider(
      { environment: { URL: 'explicit-url' }, envPath: `${directory}/absent.env` },
      () => 'unreadable',
    ).pipe(Effect.flatMap((provider) => Config.String('URL').parse(provider)));
    expect(result).toBe('explicit-url');
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.effect('an explicit empty environment does not fall through to process values', () =>
  Effect.gen(function* emptyEnvironment() {
    const envPath = yield* environmentFile('ONTOS_PROVIDER_TEST=file-value\n');
    // Only the child's launch input contains this value; the test worker's process environment stays untouched.
    const stdout = yield* Effect.try(() =>
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Config, Effect } from 'effect';
const { loadConfigurationProvider } = await import(pathToFileURL(resolve('api/auth/configuration-provider.ts')).href);
const envPath = process.argv[1];
const read = (options) => loadConfigurationProvider({ ...options, envPath }, () => 'unreadable').pipe(
  Effect.flatMap((provider) => Config.String('ONTOS_PROVIDER_TEST').parse(provider)),
);
const inherited = await Effect.runPromise(read({}));
const empty = await Effect.runPromise(read({ environment: {} }));
process.stdout.write(JSON.stringify({ inherited, empty }));`,
          envPath,
        ],
        { encoding: 'utf-8', env: { ONTOS_PROVIDER_TEST: 'process-value' } },
      ),
    );
    const result = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ empty: Schema.String, inherited: Schema.String })),
    )(stdout);
    expect(result.inherited).toBe('process-value');
    expect(result.empty).toBe('file-value');
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

it.effect('file loading failures retain the parser-specific typed error and safe reason', () =>
  Effect.gen(function* fileFailure() {
    const fileSystem = yield* FileSystem.FileSystem;
    // A directory is readable as a path but not as a file: the read fails with a non-NotFound
    // platform error, which each configuration owner maps to its own typed failure.
    const envPath = yield* fileSystem.makeTempDirectoryScoped();
    const authFailure = yield* Effect.flip(loadAuthConfig({ environment: {}, envPath }));
    const gatewayFailure = yield* Effect.flip(loadGatewayIssuerConfig({ environment: {}, envPath }));
    expect(authFailure.reason).toBe('Unable to load the root authentication environment');
    expect(gatewayFailure.reason).toBe('Unable to load the Shell gateway signing environment');
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);
