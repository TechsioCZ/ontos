import { NodeServices } from '@effect/platform-node';
import { Effect, Path, Predicate, Redacted, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { expect, it } from 'effect-rstest';

import { loadDatabaseConfig, loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { SHARED_RUNTIME_IDENTITY } from '../../src/db/database-identities.ts';
import type { TestTenantAccessTarget } from '../../src/testing/tenant-access.ts';

/** No dotenv file, so each test sees only the environment it passes. */
const missingEnvPath = '/nonexistent/ontos-tenant-access-target-test/.env';

const runtimeUrl = 'postgresql://ontos_runtime:runtime@localhost:5433/ontos';
const adminUrl = 'postgresql://ontos_ci_admin:admin@localhost:5433/ontos';

const fixtureTarget: TestTenantAccessTarget = {
  spiceDb: { endpoint: '127.0.0.1:50051', preSharedKey: 'test-pre-shared-key' },
  writerConnectionString: Redacted.make(runtimeUrl),
};

const PreSharedKeySchema = Schema.String.pipe(Schema.brand('TestSpiceDbPreSharedKey'));

const TargetOutput = Schema.fromJsonString(
  Schema.Struct({
    spiceDb: Schema.Struct({ endpoint: Schema.String, preSharedKey: PreSharedKeySchema }),
    writerConnectionString: Schema.RedactedFromValue(Schema.String),
  }),
);

it.live('the environment target selects the shared runtime credential and never the admin login', () =>
  Effect.gen(function* writerCredentialBoundary() {
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL('../..', import.meta.url));
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // A fresh process supplies the real environment boundary without changing this test worker's globals.
    const output = yield* spawner.string(
      ChildProcess.make(
        process.execPath,
        [
          '--experimental-strip-types',
          '--input-type=module',
          '--eval',
          `import { Effect, Redacted } from 'effect';
import { environmentTestAccessTarget } from './src/testing/tenant-access.ts';
const target = await Effect.runPromise(environmentTestAccessTarget);
console.log(JSON.stringify({
  spiceDb: target.spiceDb,
  writerConnectionString: Redacted.value(target.writerConnectionString),
}));`,
        ],
        {
          cwd: root,
          env: {
            APP_ENV_PATH: missingEnvPath,
            DATABASE_URL: runtimeUrl,
            SPICEDB_ENDPOINT: fixtureTarget.spiceDb.endpoint,
            SPICEDB_PRESHARED_KEY: fixtureTarget.spiceDb.preSharedKey,
          },
          extendEnv: false,
          stderr: 'inherit',
        },
      ),
    );
    const target = yield* Schema.decodeUnknownEffect(TargetOutput)(output);
    expect(Redacted.value(target.writerConnectionString)).toBe(runtimeUrl);
    expect(target.spiceDb).toEqual(fixtureTarget.spiceDb);
    // The shared runtime login the target now selects needs no administrative configuration.
    const writer = yield* loadDatabaseConfig({
      environment: { DATABASE_URL: runtimeUrl },
      envPath: missingEnvPath,
      identity: SHARED_RUNTIME_IDENTITY,
    });
    expect(writer.connectionString).toBe(runtimeUrl);
    expect(writer.expectedRole).toBe('ontos_runtime');

    // The administrative pair the target used to require is no longer consulted.
    const withoutAdmin = yield* Effect.flip(
      loadDatabaseConnectionPair({ environment: { DATABASE_URL: runtimeUrl }, envPath: missingEnvPath }),
    );
    expect(Predicate.isTagged(withoutAdmin, 'DatabaseConfigError')).toBe(true);
    expect(withoutAdmin.reason).toContain('DATABASE_ADMIN_URL');

    // An administrative login cannot stand in for the writer credential.
    const adminAsWriter = yield* Effect.flip(
      loadDatabaseConfig({
        environment: { DATABASE_URL: adminUrl },
        envPath: missingEnvPath,
        identity: SHARED_RUNTIME_IDENTITY,
      }),
    );
    expect(Predicate.isTagged(adminAsWriter, 'DatabaseConfigError')).toBe(true);
    expect(adminAsWriter.reason).toBe('DATABASE_URL must connect as the ontos_runtime role');
  }).pipe(Effect.provide(NodeServices.layer)),
);
