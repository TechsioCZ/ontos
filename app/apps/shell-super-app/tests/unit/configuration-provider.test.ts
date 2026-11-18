import { NodeFileSystem } from '@effect/platform-node';
import { Config, Effect, FileSystem } from 'effect';
import { expect, it, rs } from 'effect-rstest';

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
    yield* Effect.acquireRelease(
      Effect.sync(() => rs.stubEnv('ONTOS_PROVIDER_TEST', 'process-value')),
      () => Effect.sync(() => rs.unstubAllEnvs()),
    );
    const envPath = yield* environmentFile('ONTOS_PROVIDER_TEST=file-value\n');
    const read = (environment?: Readonly<Partial<Record<'ONTOS_PROVIDER_TEST', string>>>) =>
      loadConfigurationProvider(
        environment === undefined ? { envPath } : { environment, envPath },
        () => 'unreadable',
      ).pipe(Effect.flatMap((provider) => Config.String('ONTOS_PROVIDER_TEST').parse(provider)));
    expect(yield* read()).toBe('process-value');
    expect(yield* read({})).toBe('file-value');
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
