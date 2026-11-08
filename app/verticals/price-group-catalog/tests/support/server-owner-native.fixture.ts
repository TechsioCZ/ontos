import { parseDatabaseConnectionPair } from '@app/core-runtime';
import { Config, Effect, Option, Redacted, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';

export class PriceGroupCatalogNativeUnavailable extends Schema.TaggedError<PriceGroupCatalogNativeUnavailable>()(
  'PriceGroupCatalogNativeUnavailable',
  { stage: Schema.Literals(['configuration', 'migration']) },
) {}

interface PriceGroupCatalogNativeConnections {
  readonly adminConnectionString: Redacted.Redacted;
  readonly runtimeConnectionString: Redacted.Redacted;
}
const isApprovedFixtureDatabase = (name: string, ci: boolean): boolean =>
  name === 'ontos_1094_ab3_20261030' ||
  /^ontos_test_party_gateway_[a-f0-9]{32}$/u.test(name) ||
  (ci && name === 'ontos_ci');

/** Existing owner baseline only. Actual receiving/identity come from the normal packaged application. */
export const migratePriceGroupCatalogNativeBaseline = Effect.fn('PriceGroupCatalogNative.migrateBaseline')(
  function* migratePriceGroupCatalogNativeBaseline(options: PriceGroupCatalogNativeConnections) {
    const connections = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: Redacted.value(options.adminConnectionString),
      DATABASE_URL: Redacted.value(options.runtimeConnectionString),
    }).pipe(Effect.mapError(() => new PriceGroupCatalogNativeUnavailable({ stage: 'configuration' })));
    const ci = yield* Config.Boolean('CI').pipe(Config.withDefault(false));
    const deployment = yield* Config.option(Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'));
    if (
      (Option.isSome(deployment) && ['stage', 'production'].includes(deployment.value)) ||
      ![connections.admin, connections.runtime].every((configuration) =>
        ['localhost', '127.0.0.1'].includes(configuration.host),
      ) ||
      connections.admin.host !== connections.runtime.host ||
      connections.admin.port !== connections.runtime.port ||
      connections.admin.database !== connections.runtime.database ||
      !isApprovedFixtureDatabase(connections.runtime.database, ci)
    ) {
      return yield* new PriceGroupCatalogNativeUnavailable({ stage: 'configuration' });
    }
    const process = yield* ChildProcess.make(
      'mise',
      [
        'exec',
        '--',
        'pnpm',
        '--filter',
        '@app/price-group-catalog',
        'exec',
        'drizzle-kit',
        'migrate',
        '--config',
        'drizzle.config.ts',
      ],
      {
        cwd: new URL('../../../../', import.meta.url).pathname,
        env: {
          APP_ENV_PATH: '/dev/null',
          DATABASE_ADMIN_URL: connections.admin.connectionString,
          DATABASE_URL: connections.runtime.connectionString,
        },
        extendEnv: true,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    );
    const [exit] = yield* Effect.all(
      [process.exitCode, Stream.runDrain(process.stdout), Stream.runDrain(process.stderr)],
      { concurrency: 3 },
    );
    if (Number(exit) !== 0) {
      return yield* new PriceGroupCatalogNativeUnavailable({ stage: 'migration' });
    }
    return yield* Effect.void;
  },
);
