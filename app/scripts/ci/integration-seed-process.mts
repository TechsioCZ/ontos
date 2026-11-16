import path from 'node:path';

import { Config, Effect, FileSystem, Redacted } from 'effect';

import { OpsShell } from '../ops/ops-shell.mts';
import type { OpsCommand } from '../ops/ops-shell.mts';
import { seedFailure } from './integration-seed-model.mts';

export const APP_DIRECTORY = path.resolve(import.meta.dirname, '../..');

/** Suppress raw child diagnostics: SQL errors can echo a password-bearing statement. */
export const runSeedCommand = (
  command: string,
  args: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly input?: string;
  } = {},
) =>
  Effect.gen(function* runSeedChild() {
    const shell = yield* OpsShell;
    const request: OpsCommand = {
      args,
      captureProviderFailure: true,
      command,
      cwd: APP_DIRECTORY,
      env: Object.fromEntries(Object.entries(options.env ?? {}).map(([key, value]) => [key, Redacted.make(value)])),
    };
    return yield* shell
      .run(options.input === undefined ? request : { ...request, stdin: Redacted.make(options.input) })
      .pipe(
        Effect.mapError(() =>
          seedFailure(`${command} CI seed operation failed; child diagnostics withheld to protect credentials`),
        ),
      );
  });

export const requiredEnvironment = (key: string) =>
  Config.NonEmptyString(key).pipe(
    Effect.mapError(() => seedFailure(`Required consumer environment key ${key} is missing`)),
  );

/** Only an isolated GitHub Actions Compose cluster with no application environment file may be seeded. */
const DisposableCiEnvironment = Config.all({
  appEnvPath: Config.Literal('/dev/null', 'APP_ENV_PATH'),
  githubActions: Config.Literal('true', 'GITHUB_ACTIONS'),
});

export const emptyOutputDirectory = (directory: string) =>
  Effect.gen(function* requireEmptyOutput() {
    const fs = yield* FileSystem.FileSystem;
    if ((yield* fs.exists(directory)) && (yield* fs.readDirectory(directory)).length !== 0) {
      return yield* seedFailure(`Artifact directory must be empty: ${directory}`);
    }
    return yield* fs.makeDirectory(directory, { recursive: true });
  });

/** The fixed Compose service, not a URL-selected remote host, owns every database operation. */
export const postgresCommand = (command: string, args: readonly string[], input?: string) =>
  runSeedCommand(
    'docker',
    ['compose', 'exec', '--no-TTY', 'ontos-db', command, ...args],
    input === undefined ? {} : { input },
  );

export const seedSql = (database: string, input: string) =>
  Effect.gen(function* querySeedDatabase() {
    const user = yield* requiredEnvironment('POSTGRES_USER');
    return yield* postgresCommand(
      'psql',
      ['-X', '-qAt', '--set', 'ON_ERROR_STOP=1', '--username', user, '--dbname', database],
      input,
    );
  });

export const assertDisposable = (disposable: boolean) =>
  Effect.gen(function* requireDisposableCi() {
    const disposableCi =
      'Requires --disposable, GITHUB_ACTIONS=true and APP_ENV_PATH=/dev/null; only an isolated CI Compose cluster is allowed';
    if (!disposable) {
      return yield* seedFailure(disposableCi);
    }
    yield* DisposableCiEnvironment.pipe(Effect.mapError(() => seedFailure(disposableCi)));
    const raw = yield* requiredEnvironment('DATABASE_ADMIN_URL');
    const url = URL.parse(raw);
    const user = yield* requiredEnvironment('POSTGRES_USER');
    const database = yield* requiredEnvironment('POSTGRES_DB');
    if (
      url === null ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.search !== '' ||
      url.hash !== '' ||
      decodeURIComponent(url.username) !== user ||
      decodeURIComponent(url.pathname.slice(1)) !== database ||
      !['postgres:', 'postgresql:'].includes(url.protocol)
    ) {
      return yield* seedFailure(
        'DATABASE_ADMIN_URL must name the local disposable Compose administrator and database without routing overrides',
      );
    }
    return yield* Effect.void;
  });

export const readSourceRevision = () =>
  runSeedCommand('git', ['rev-parse', 'HEAD']).pipe(Effect.map((revision) => revision.trim()));
