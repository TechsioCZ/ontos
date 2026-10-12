import { Effect, Exit } from 'effect';
import { NodeServices } from '@effect/platform-node';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import { expect, it } from 'effect-rstest';

import { DemoResetConfigurationError } from '../reset-configuration.mts';
import type { DemoResetChildEnvironment } from '../reset-configuration.mts';
import { executeDemoReset, makeDemoResetCommand } from '../reset-demo-entry.mts';

const local: DemoResetChildEnvironment = {
  BETTER_AUTH_SECRET: 'synthetic-test-secret-with-at-least-32-characters',
  BETTER_AUTH_URL: 'http://localhost:3020',
  DATABASE_ADMIN_URL: 'postgresql://ontos_admin:admin-secret@127.0.0.1:5432/siampark_demo',
  DATABASE_URL: 'postgresql://ontos_runtime:runtime-secret@127.0.0.1:5432/siampark_demo',
  SPICEDB_CA_CERT: '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----',
  SPICEDB_ENDPOINT: 'localhost:50051',
  SPICEDB_PRESHARED_KEY: 'synthetic-authorization-secret',
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development',
};

it.effect('the native migration executable starts with inherited PATH and validated overrides', () =>
  Effect.gen(function* nativeMigrationStartup() {
    const command = makeDemoResetCommand(local, 'migrate');
    expect(command.options.extendEnv).toBe(true);
    expect(command.options.env).toEqual({ ...local, MISE_ARGV0: '' });
    expect(command.args).toEqual(['db:migrate']);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // Reuse the real executable/environment; --version is deliberately read only.
    const exitCode = yield* spawner.exitCode(ChildProcess.make(command.command, ['--version'], command.options));
    expect(exitCode).toBe(ChildProcessSpawner.ExitCode(0));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('rejects unsafe configuration before any migration or fixture subprocess can run', () =>
  Effect.gen(function* refusesUnsafeReset() {
    for (const invalid of [
      { ...local, ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' },
      { ...local, DATABASE_ADMIN_URL: local.DATABASE_ADMIN_URL.replace('127.0.0.1', 'example.com') },
      { ...local, DATABASE_URL: local.DATABASE_URL.replace('127.0.0.1', 'example.com') },
      { ...local, DATABASE_URL: local.DATABASE_ADMIN_URL },
      { ...local, SPICEDB_ENDPOINT: 'example.com:50051' },
      { ...local, SPICEDB_CA_CERT: '' },
      { ...local, SPICEDB_PRESHARED_KEY: '' },
      { ...local, BETTER_AUTH_SECRET: 'too-short' },
      { ...local, BETTER_AUTH_URL: 'http://example.com' },
      { ...local, BETTER_AUTH_URL: 'http://localhost:3020/path' },
    ]) {
      const steps: string[] = [];
      const exit = yield* Effect.exit(
        executeDemoReset(invalid, false, (step) =>
          Effect.sync(() => {
            steps.push(step);
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(steps).toEqual([]);
    }
  }),
);

it.effect('rejects original databases and mismatched local endpoints before any subprocess in both modes', () =>
  Effect.gen(function* rejectsNonDemoDatabaseTargets() {
    for (const invalid of [
      {
        ...local,
        DATABASE_ADMIN_URL: local.DATABASE_ADMIN_URL.replace('siampark_demo', 'ontos'),
        DATABASE_URL: local.DATABASE_URL.replace('siampark_demo', 'ontos'),
      },
      { ...local, DATABASE_ADMIN_URL: local.DATABASE_ADMIN_URL.replace('siampark_demo', 'ontos') },
      { ...local, DATABASE_URL: local.DATABASE_URL.replace('siampark_demo', 'ontos') },
      { ...local, DATABASE_URL: local.DATABASE_URL.replace('127.0.0.1', 'localhost') },
      { ...local, DATABASE_URL: local.DATABASE_URL.replace(':5432', ':5433') },
    ]) {
      for (const validateOnly of [false, true]) {
        const steps: string[] = [];
        const exit = yield* Effect.exit(
          executeDemoReset(invalid, validateOnly, (step) =>
            Effect.sync(() => {
              steps.push(step);
            }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(steps).toEqual([]);
      }
    }
  }),
);

it.effect('readonly validation never migrates or resets the database; writes migrate before seeding', () =>
  Effect.gen(function* ordersValidatedReset() {
    const readonlySteps: string[] = [];
    yield* executeDemoReset(local, true, (step) =>
      Effect.sync(() => {
        readonlySteps.push(step);
      }),
    );
    expect(readonlySteps).toEqual(['validate']);
    const writeSteps: string[] = [];
    yield* executeDemoReset(local, false, (step) =>
      Effect.sync(() => {
        writeSteps.push(step);
      }),
    );
    expect(writeSteps).toEqual(['migrate', 'reset']);
    const failedSteps: string[] = [];
    const exit = yield* Effect.exit(
      executeDemoReset(local, false, (step) => {
        failedSteps.push(step);
        return new DemoResetConfigurationError({ reason: 'Simulated failed migration' });
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failedSteps).toEqual(['migrate']);
  }),
);
