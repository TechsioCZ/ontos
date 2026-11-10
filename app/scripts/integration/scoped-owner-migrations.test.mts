// Native operator acceptance. Resources are acquired only inside the live test callbacks.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Config, Console, Deferred, Effect, Fiber, FileSystem, Layer, Ref, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { loadSelectedDatabaseIdentityConnections } from '../../packages/core-runtime/src/db/config.ts';
import { DATABASE_IDENTITIES } from '../../packages/core-runtime/src/db/database-identities.ts';
import { makeTestPgClient } from '../../packages/core-runtime/tests/support/database.ts';
import { loadApplicationMigrationInventory } from '../application-migration-inventory.mts';
import type { ApplicationMigrationRequirements } from '../application-migration-plan.mts';
import { planDeploymentImpact } from '../plan-deployment-impact.mts';
import { quoteIdentifier } from '../postgres/database-login-roles.mts';
import { collectToolingProcess } from '../tests/tooling-process-fixture.mts';
import {
  ScopedOwnerNativeStateSchema,
  ScopedOwnerPreparedPlanSchema,
} from './fixtures/scoped-owner-migrations-observer.mts';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const runner = path.join(workspaceRoot, 'scripts/run-zerops-migrator.mjs');
const selected: ApplicationMigrationRequirements = {
  mode: 'selected',
  owners: [
    { migrate: true, ownerId: 'tax', verify: true },
    { migrate: false, ownerId: 'price-group-catalog', verify: true },
  ],
};
const none: ApplicationMigrationRequirements = { mode: 'none', owners: [] };

class ScopedOwnerNativeFailure extends Schema.TaggedError<ScopedOwnerNativeFailure>()('ScopedOwnerNativeFailure', {
  diagnostic: Schema.optionalKey(Schema.String),
  stage: Schema.String,
  status: Schema.optionalKey(Schema.Number),
}) {}

type Environment = Readonly<Record<string, string>>;

const sanitizedDiagnostic = (output: string, env: Environment): string => {
  const secrets = Object.entries(env)
    .flatMap(([key, value]) => {
      if (key.endsWith('_PASSWORD')) {
        return [value];
      }
      if (key.endsWith('_URL')) {
        const { password } = new URL(value);
        return [value, password, decodeURIComponent(password)];
      }
      return [];
    })
    .filter((value) => value.length > 0);
  let sanitized = output;
  for (const secret of secrets) {
    sanitized = sanitized.replaceAll(secret, '[redacted]');
  }
  return sanitized.replaceAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/giu, '[redacted-url]').slice(-8192);
};

const command = (requirementsFile: string, env: Environment, verifyOnly: boolean) =>
  ChildProcess.make(
    process.execPath,
    [runner, '--requirements', requirementsFile, ...(verifyOnly ? ['--verify-only'] : [])],
    { cwd: workspaceRoot, env, extendEnv: false, stderr: 'pipe', stdin: 'ignore', stdout: 'pipe' },
  );

const verifyMarket = (env: Environment) =>
  collectToolingProcess(
    ChildProcess.make(
      process.execPath,
      [path.join(workspaceRoot, 'verticals/commerce-market-catalog/scripts/verify-db-schema.mts')],
      { cwd: workspaceRoot, env, extendEnv: false, stderr: 'pipe', stdin: 'ignore', stdout: 'pipe' },
    ),
  ).pipe(Effect.scoped, Effect.timeout('30 seconds'));

// The runner emits this only after real selected verifiers succeed and the readiness server listens.
// Port zero avoids a shared fixed port; this tests that actual listening event, not an invented receipt.
const runToReadiness = Effect.fn('ScopedOwnerMigrations.actualRunner')(function* actualRunner(
  requirementsFile: string,
  env: Environment,
  verifyOnly: boolean,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command(requirementsFile, env, verifyOnly));
  const ready = yield* Deferred.make<boolean>();
  const observed = yield* Ref.make('');
  const stdoutFiber = yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.tap((chunk) =>
      Ref.updateAndGet(observed, (current) => current + chunk).pipe(
        Effect.flatMap((current) =>
          current.includes('Migration verification complete; readiness listening on port 0')
            ? Deferred.succeed(ready, true)
            : Effect.void,
        ),
      ),
    ),
    Stream.mkString,
    Effect.forkChild,
  );
  const stderrFiber = yield* child.stderr.pipe(Stream.decodeText(), Stream.mkString, Effect.forkChild);
  yield* Deferred.await(ready).pipe(
    Effect.raceFirst(
      child.exitCode.pipe(
        Effect.flatMap((status) =>
          Effect.gen(function* reportExitedRunner() {
            // Join only after exit, never while a live process is timing out or awaiting readiness.
            const [stdout, stderr] = yield* Effect.all([Fiber.join(stdoutFiber), Fiber.join(stderrFiber)], {
              concurrency: 'unbounded',
            });
            return yield* new ScopedOwnerNativeFailure({
              diagnostic: sanitizedDiagnostic(`${stdout}\n${stderr}`, env),
              stage: 'runner_before_readiness',
              status: Number(status),
            });
          }),
        ),
      ),
    ),
    Effect.timeout('8 minutes'),
  );
  yield* child.kill({ forceKillAfter: '5 seconds', killSignal: 'SIGTERM' });
  const [stdout, , status] = yield* Effect.all([Fiber.join(stdoutFiber), Fiber.join(stderrFiber), child.exitCode], {
    concurrency: 'unbounded',
  });
  expect(Number(status)).toBe(0);
  return stdout;
}, Effect.scoped);

const requirementsFile = Effect.fn('ScopedOwnerMigrations.requirementsFile')(function* requirementsFileEffect(
  directory: string,
  name: string,
  requirements: ApplicationMigrationRequirements,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = path.join(directory, `${name}.json`);
  yield* fs.writeFileString(file, JSON.stringify(requirements));
  return file;
});

const childEnvironment = Effect.gen(function* childEnvironmentEffect() {
  return {
    APP_ENV_PATH: '/dev/null',
    MIGRATOR_PORT: '0',
    PATH: yield* Config.String('PATH'),
  };
});

const readNativeMetadata = Effect.fn('ScopedOwnerMigrations.readNativeMetadata')(function* readNativeMetadataEffect(
  operation: 'observe' | 'prepare',
  env: Environment,
  file: string,
) {
  const result = yield* collectToolingProcess(
    ChildProcess.make(
      process.execPath,
      [path.join(workspaceRoot, 'scripts/integration/fixtures/scoped-owner-migrations-observer.mts')],
      {
        cwd: workspaceRoot,
        env: { ...env, SCOPED_OWNER_NATIVE_OPERATION: operation, SCOPED_OWNER_REQUIREMENTS_FILE: file },
        extendEnv: false,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    ),
  ).pipe(Effect.scoped, Effect.timeout('45 seconds'));
  if (result.status !== 0) {
    return yield* new ScopedOwnerNativeFailure({ stage: 'isolated_metadata_observer', status: result.status });
  }
  return result.stdout;
});

const observeNative = (env: Environment) =>
  readNativeMetadata('observe', env, '').pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ScopedOwnerNativeStateSchema))),
  );
const prepareNative = (env: Environment, file: string) =>
  readNativeMetadata('prepare', env, file).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ScopedOwnerPreparedPlanSchema))),
  );

const withDatabase = (url: string, database: string) => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.href;
};

const fixture = Effect.fn('ScopedOwnerMigrations.ownedDatabase')(function* ownedDatabase() {
  const connections = yield* loadSelectedDatabaseIdentityConnections({
    envPath: '/dev/null',
    identityIds: DATABASE_IDENTITIES.map(({ id }) => id),
  });
  const { admin } = connections;
  const ownedCluster = admin.database === 'ontos_1293_bootstrap' && admin.user === 'ontos_admin' && admin.port !== 5433;
  const disposableCiCluster = admin.database === 'ontos_ci' && admin.user === 'ontos_ci_admin' && admin.port === 5433;
  if (!['127.0.0.1', 'localhost', '::1'].includes(admin.host) || !(ownedCluster || disposableCiCluster)) {
    return yield* new ScopedOwnerNativeFailure({ stage: 'reject_non_disposable_cluster' });
  }
  const administrator = yield* makeTestPgClient(admin.connectionString);
  const identities = yield* administrator.unsafe<{ system_identifier: string }>(
    'select system_identifier::text as system_identifier from pg_control_system()',
  );
  const physicalIdentity = identities[0]?.system_identifier;
  if (physicalIdentity === undefined) {
    return yield* new ScopedOwnerNativeFailure({ stage: 'missing_physical_cluster_identity' });
  }
  const expectedIdentity = yield* Config.String('ONTOS_SCOPED_OWNER_NATIVE_SYSTEM_IDENTIFIER').pipe(
    Config.withDefault(physicalIdentity),
  );
  expect(physicalIdentity).toBe(expectedIdentity);
  const database = `ontos_1293_scoped_${randomUUID().replaceAll('-', '')}`;
  yield* Effect.acquireRelease(administrator.unsafe(`create database ${quoteIdentifier(database)}`), () =>
    administrator.unsafe(`drop database ${quoteIdentifier(database)} with (force)`).pipe(Effect.orDie),
  );
  const adminUrl = withDatabase(admin.connectionString, database);
  const urls: Record<string, string> = {};
  for (const identity of DATABASE_IDENTITIES) {
    const runtime = connections.runtime.get(identity.id);
    if (runtime === undefined) {
      return yield* new ScopedOwnerNativeFailure({ stage: 'missing_canonical_runtime_identity' });
    }
    urls[identity.urlKey] = withDatabase(runtime.connectionString, database);
  }
  const sharedUrl = urls.DATABASE_URL;
  if (sharedUrl === undefined) {
    return yield* new ScopedOwnerNativeFailure({ stage: 'missing_shared_runtime_identity' });
  }
  const base = yield* childEnvironment;
  return {
    allEnvironment: {
      ...base,
      ...urls,
      DATABASE_ADMIN_URL: adminUrl,
      SPICEDB_DATABASE_PASSWORD: yield* Config.String('SPICEDB_DATABASE_PASSWORD'),
    },
    client: yield* makeTestPgClient(adminUrl),
    database,
    physicalIdentity,
    selectedEnvironment: { ...base, DATABASE_ADMIN_URL: adminUrl, DATABASE_URL: sharedUrl },
  };
});

const nativeLayer = Layer.mergeAll(NodeServices.layer, Reactivity.layer);

it.live(
  'the actual none runner reaches readiness with no database, realm or runtime credentials',
  () =>
    Effect.gen(function* noneWithoutInfrastructure() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-scoped-owner-none-' });
      const file = yield* requirementsFile(directory, 'none', none);
      yield* runToReadiness(file, yield* childEnvironment, true);
    }).pipe(Effect.scoped, Effect.provide(nativeLayer)),
  60_000,
);

it.live(
  'real owner migration selection preserves excluded schemas/journals and never replays completed SQL',
  () =>
    Effect.gen(function* genuineOwnerMigrations() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-scoped-owner-native-' });
      const allFile = yield* requirementsFile(directory, 'all', { mode: 'all', owners: [] });
      const selectedFile = yield* requirementsFile(directory, 'selected-tax-retained-catalog', selected);
      const native = yield* fixture();
      yield* runToReadiness(allFile, native.allEnvironment, false);
      const streams = (yield* loadApplicationMigrationInventory()).filter(({ optional }) => !optional);
      expect(streams).toHaveLength(20);
      const baseline = yield* observeNative(native.selectedEnvironment);
      expect(baseline.nativeTargets.map(({ database }) => database)).toEqual([native.database]);
      expect(baseline.nativeTargets.map(({ systemIdentifier }) => systemIdentifier)).toEqual([native.physicalIdentity]);
      expect(
        baseline.observations.every(
          ({ journalExists, schemaEvidence }) => journalExists && schemaEvidence === 'observed-journal',
        ),
      ).toBe(true);
      const tax = streams.find(({ ownerId }) => ownerId === 'tax');
      if (tax === undefined || tax.schemas.length !== 1 || tax.schemas[0] !== 'tax') {
        return yield* new ScopedOwnerNativeFailure({ stage: 'unexpected_tax_owner_inventory' });
      }
      // Only this fresh database is changed. Source SQL/journals, other owners and the parent DB stay intact.
      yield* native.client.unsafe(`drop schema ${quoteIdentifier('tax')} cascade`);
      yield* native.client.unsafe(`drop table drizzle.${quoteIdentifier(tax.journalName)}`);
      const pending = yield* prepareNative(native.selectedEnvironment, selectedFile);
      expect(pending.plan.owners.map(({ ownerId }) => ownerId)).toEqual(['core-runtime', 'price-group-catalog', 'tax']);
      expect(
        pending.plan.owners
          .filter(({ pendingMigrations }) => pendingMigrations.length > 0)
          .map(({ ownerId }) => ownerId),
      ).toEqual(['tax']);
      expect(pending.nativeTargets.map(({ systemIdentifier }) => systemIdentifier)).toEqual([native.physicalIdentity]);
      const pendingSnapshot = yield* observeNative(native.selectedEnvironment);
      const refused = yield* collectToolingProcess(command(selectedFile, native.selectedEnvironment, true)).pipe(
        Effect.scoped,
        Effect.timeout('45 seconds'),
      );
      expect(refused.status).not.toBe(0);
      expect(yield* observeNative(native.selectedEnvironment)).toEqual(pendingSnapshot);
      expect(new Set(Object.keys(native.selectedEnvironment))).toEqual(
        new Set(['APP_ENV_PATH', 'DATABASE_ADMIN_URL', 'DATABASE_URL', 'MIGRATOR_PORT', 'PATH']),
      );
      yield* runToReadiness(selectedFile, native.selectedEnvironment, false);
      const after = yield* observeNative(native.selectedEnvironment);
      // This compares actual global schema/ACL fingerprints plus every independent name/hash journal.
      // Tax is restored by native source migrations; all excluded owners must remain byte-for-byte equivalent.
      expect(after).toEqual(baseline);
      const completed = yield* prepareNative(native.selectedEnvironment, selectedFile);
      expect(completed.plan.owners.every(({ pendingMigrations }) => pendingMigrations.length === 0)).toBe(true);
      yield* runToReadiness(selectedFile, native.selectedEnvironment, false);
      expect(yield* observeNative(native.selectedEnvironment)).toEqual(after);
      yield* runToReadiness(selectedFile, native.selectedEnvironment, true);
      expect(yield* observeNative(native.selectedEnvironment)).toEqual(after);
      // Actual DB observations feed the existing build-impact interface; this does not pretend to run a build.
      const retained = yield* planDeploymentImpact({
        changedPaths: [],
        migrationPlan: completed.plan,
        rootDirectory: workspaceRoot,
      });
      expect(retained.units.providers).toEqual([]);
      expect(retained.units.migrator).toBe(true);
      const rebuilt = yield* planDeploymentImpact({
        changedPaths: ['verticals/tax/src/tax.vertical.ts'],
        migrationPlan: completed.plan,
        rootDirectory: workspaceRoot,
      });
      expect(rebuilt.units.providers).toContain('tax');
      expect(rebuilt.migrationPlan?.owners.every(({ pendingMigrations }) => pendingMigrations.length === 0)).toBe(true);
      // Closed metadata-only corruptions inside the owned database must be rejected by the public verifier.
      for (const control of [
        {
          grant: 'grant DELETE on commerce_market_catalog.market_retirement_admissions to ontos_runtime',
          revoke: 'revoke DELETE on commerce_market_catalog.market_retirement_admissions from ontos_runtime',
        },
        {
          grant: 'grant SELECT on commerce_market_catalog.markets to ontos_runtime',
          revoke: 'revoke SELECT on commerce_market_catalog.markets from ontos_runtime',
        },
      ]) {
        yield* Effect.acquireUseRelease(
          native.client.unsafe(control.grant),
          () =>
            verifyMarket(native.selectedEnvironment).pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  expect(result.status).not.toBe(0);
                  expect(`${result.stdout}${result.stderr}`).toContain('CommerceMarketCatalogVerificationError');
                }),
              ),
            ),
          () => native.client.unsafe(control.revoke).pipe(Effect.orDie),
        );
        const restored = yield* verifyMarket(native.selectedEnvironment);
        expect(restored.status).toBe(0);
      }
      return yield* Console.info(
        'SCOPED_OWNER_NATIVE_METADATA',
        JSON.stringify({ after, baseline, pending: pending.plan, selected: completed.plan }),
      );
    }).pipe(Effect.scoped, Effect.provide(nativeLayer)),
  900_000,
);
