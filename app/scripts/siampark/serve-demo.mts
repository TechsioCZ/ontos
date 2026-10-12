#!/usr/bin/env node
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, ConfigProvider, Console, Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import { parseSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { isLoopbackHostname } from '../../packages/core-runtime/src/modules/application-composition-backend.ts';
import { validateDevelopmentDatabase } from './development-composition.mts';

export class DemoServeError extends Schema.TaggedError<DemoServeError>()('DemoServeError', {
  reason: Schema.String,
}) {}
const requiredText = Schema.Trim.check(Schema.isNonEmpty());
const serveConfiguration = Config.all({
  BETTER_AUTH_SECRET: Config.Redacted('BETTER_AUTH_SECRET'),
  BETTER_AUTH_TRUSTED_ORIGINS: Config.String('BETTER_AUTH_TRUSTED_ORIGINS').pipe(Config.withDefault('')),
  BETTER_AUTH_URL: Config.schema(requiredText, 'BETTER_AUTH_URL'),
  DATABASE_ADMIN_URL: Config.Redacted('DATABASE_ADMIN_URL'),
  DATABASE_URL: Config.Redacted('DATABASE_URL'),
  ONTOS_GATEWAY_ISSUER: Config.schema(requiredText, 'ONTOS_GATEWAY_ISSUER'),
  ONTOS_GATEWAY_PUBLIC_JWKS: Config.schema(requiredText, 'ONTOS_GATEWAY_PUBLIC_JWKS'),
  SPICEDB_CA_CERT: Config.schema(requiredText, 'SPICEDB_CA_CERT'),
  SPICEDB_ENDPOINT: Config.schema(requiredText, 'SPICEDB_ENDPOINT'),
  SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT').pipe(
    Config.withDefault('development'),
  ),
});
type ServeConfiguration = Effect.Success<ReturnType<typeof serveConfiguration.parse>>;
const workspaceRoot = path.resolve(import.meta.dirname, '../..');

export const parseDemoServeConfiguration = Effect.fn('SiamparkDemo.parseServeConfiguration')(
  function* parseConfiguration(provider: ConfigProvider.ConfigProvider) {
    const configuration = yield* serveConfiguration
      .parse(provider)
      .pipe(
        Effect.mapError(() => new DemoServeError({ reason: 'Required server configuration is missing or invalid' })),
      );
    yield* validateDevelopmentDatabase(configuration.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT, {
      DATABASE_ADMIN_URL: Redacted.value(configuration.DATABASE_ADMIN_URL),
      DATABASE_URL: Redacted.value(configuration.DATABASE_URL),
    }).pipe(
      Effect.mapError(() => new DemoServeError({ reason: 'Only the isolated development database is permitted' })),
    );
    yield* Schema.decodeEffect(Schema.Trim.check(Schema.isMinLength(32)))(
      Redacted.value(configuration.BETTER_AUTH_SECRET),
    ).pipe(Effect.mapError(() => new DemoServeError({ reason: 'The configured authentication secret is invalid' })));
    const auth = yield* Schema.decodeEffect(Schema.URLFromString)(configuration.BETTER_AUTH_URL).pipe(
      Effect.mapError(() => new DemoServeError({ reason: 'Authentication requires a valid local HTTP origin' })),
    );
    if (
      auth.protocol !== 'http:' ||
      !isLoopbackHostname(auth.hostname) ||
      auth.origin !== configuration.BETTER_AUTH_URL
    ) {
      return yield* new DemoServeError({ reason: 'Authentication requires an exact local HTTP origin' });
    }
    const spice = yield* parseSpiceDbConfig({
      SPICEDB_CA_CERT: configuration.SPICEDB_CA_CERT,
      SPICEDB_ENDPOINT: configuration.SPICEDB_ENDPOINT,
      SPICEDB_PRESHARED_KEY: Redacted.value(configuration.SPICEDB_PRESHARED_KEY),
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: configuration.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT,
    }).pipe(Effect.mapError(() => new DemoServeError({ reason: 'The configured authorization endpoint is invalid' })));
    const endpoint = yield* Schema.decodeEffect(Schema.URLFromString)(`https://${spice.endpoint}`).pipe(
      Effect.mapError(() => new DemoServeError({ reason: 'The configured authorization endpoint is invalid' })),
    );
    if (!isLoopbackHostname(endpoint.hostname)) {
      return yield* new DemoServeError({ reason: 'The authorization endpoint must be local' });
    }
    return configuration;
  },
);

/** Only this native process boundary unwraps secrets for the child servers. */
export const makeDemoServeCommand = (configuration: ServeConfiguration) =>
  ChildProcess.make(
    'pnpm',
    ['-r', '--parallel', '--filter', './verticals/*', '--filter', './apps/shell-super-app', 'exec', 'modern', 'serve'],
    {
      cwd: workspaceRoot,
      env: {
        ...configuration,
        BETTER_AUTH_SECRET: Redacted.value(configuration.BETTER_AUTH_SECRET),
        DATABASE_ADMIN_URL: Redacted.value(configuration.DATABASE_ADMIN_URL),
        DATABASE_URL: Redacted.value(configuration.DATABASE_URL),
        MISE_ARGV0: '',
        ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: 'http://127.0.0.1:3031/active',
        SPICEDB_PRESHARED_KEY: Redacted.value(configuration.SPICEDB_PRESHARED_KEY),
      },
      extendEnv: true,
      stderr: 'inherit',
      stdin: 'ignore',
      stdout: 'inherit',
    },
  );

const main = (validateOnly: boolean) =>
  Effect.gen(function* launchNativeDemoServers() {
    const file = yield* ConfigProvider.fromDotEnv({ path: path.join(workspaceRoot, '.env') });
    const configuration = yield* parseDemoServeConfiguration(ConfigProvider.orElse(ConfigProvider.fromEnv(), file));
    if (validateOnly) {
      return yield* Console.log('Native development server configuration validated; no servers started.');
    }
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const code = yield* spawner.exitCode(makeDemoServeCommand(configuration));
    if (code !== ChildProcessSpawner.ExitCode(0)) {
      return yield* new DemoServeError({ reason: 'A native demo server exited unsuccessfully' });
    }
    return yield* Effect.void;
  });
const command = Command.make(
  'siampark-demo-serve',
  {
    validateOnly: Flag.Boolean('validate-only').pipe(Flag.withDefault(false)),
  },
  ({ validateOnly }) =>
    main(validateOnly).pipe(
      Effect.scoped,
      Effect.tapError((failure) =>
        Console.error(`Demo server launch failed (${failure._tag}); configuration and process values remain private.`),
      ),
    ),
);

if (import.meta.main) {
  const runtimeLive = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
    Layer.provide(NodeServices.layer),
  );
  const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(runtimeLive)));
  process.exitCode = Exit.isFailure(exit) ? 1 : 0;
}
