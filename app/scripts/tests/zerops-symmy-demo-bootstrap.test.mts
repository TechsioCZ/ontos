import { readFileSync } from 'node:fs';

import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Console, Effect, Match } from 'effect';
import { systemError } from 'effect/PlatformError';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { TestConsole } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { bootstrapStageSymmyDemo, processEnvironment } from '../zerops/app-host.mts';
import { workspaceRoot } from '../zerops/hosted-units.mts';

const SCRIPTS = [
  ['scripts/demo/symmy-demo-source-policies.mts'],
  ['scripts/demo/symmy-demo-customer-authority.mts', '--mode', 'apply'],
  ['scripts/demo/symmy-demo-exchange-authority.mts'],
];
const ADMIN_URL = 'postgres://admin:never-log-this@db/stage';
const CUSTOMER_SETTINGS = {
  DATABASE_URL: 'postgres://ontos_runtime:never-log-runtime@db/stage',
  ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: '[]',
  ONTOS_PRIVACY_SOURCE_PROCESSING_CONTEXTS: '[]',
  ONTOS_SYMMY_JOB_RETENTION_POLICIES: '[]',
};
const STAGE = {
  ...CUSTOMER_SETTINGS,
  DATABASE_ADMIN_URL: ADMIN_URL,
  ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: 'http://not-published-yet/composition',
  ONTOS_OWNER_SECRETS_JSON: '{"shell-super-app":{"unrelated":"never-inherit-this"}}',
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
};

/** Exercise the real child boundary without running the database-writing demo commands. */
const fixture = (failAt = 0) =>
  Effect.gen(function* bootstrapFixture() {
    const native = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = yield* TestConsole.make;
    const calls: ChildProcess.StandardCommand[] = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Match.value(command).pipe(
        Match.tag('StandardCommand', (standard) => {
          calls.push(standard);
          // Both streams contain sensitive output: the hook must discard them, not forward them.
          return native.spawn(
            ChildProcess.make(
              process.execPath,
              [
                '--eval',
                `console.log(process.env.DATABASE_ADMIN_URL); console.error(process.env.DATABASE_ADMIN_URL); process.exit(${calls.length === failAt ? '7' : '0'});`,
              ],
              standard.options,
            ),
          );
        }),
        Match.tag('PipedCommand', () => Effect.die('unexpected piped bootstrap')),
        Match.exhaustive,
      ),
    );
    const run = (environment: Readonly<Record<string, string>>) =>
      bootstrapStageSymmyDemo.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
        Effect.provideService(Console.Console, output),
      );
    return { calls, output, run };
  });

it.live('runs all three idempotent commands on every stage boot with only supervisor bootstrap settings', () =>
  Effect.gen(function* repeatedStageBoots() {
    const { calls, run } = yield* fixture();
    yield* run(STAGE);
    yield* run(STAGE);
    expect(calls.map(({ args }) => args)).toEqual([...SCRIPTS, ...SCRIPTS]);
    for (const command of calls) {
      expect(command.command).toBe(process.execPath);
      expect(command.options).toMatchObject({
        cwd: workspaceRoot,
        extendEnv: false,
        stderr: 'ignore',
        stdout: 'ignore',
      });
      expect(command.options.env).toEqual({
        ...(command.args.length > 1 ? CUSTOMER_SETTINGS : {}),
        DATABASE_ADMIN_URL: ADMIN_URL,
        NODE_COMPILE_CACHE: expect.any(String),
        ONTOS_DATABASE_POOL_SHARED: 'false',
        ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
      });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live('does nothing outside stage, even without bootstrap credentials', () =>
  Effect.gen(function* notStage() {
    const { calls, run } = yield* fixture();
    yield* run({});
    for (const environment of ['production', 'development']) {
      yield* run({ ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: environment });
    }
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

for (const failAt of [1, 2, 3]) {
  it.live(`stops before publication and logs only a sanitized line when command ${failAt} fails`, () =>
    Effect.gen(function* failedBootstrap() {
      const { calls, output, run } = yield* fixture(failAt);
      let published = false;
      const problem = yield* run(STAGE).pipe(
        Effect.andThen(
          Effect.sync(() => {
            published = true;
          }),
        ),
        Effect.flip,
      );
      expect(published).toBe(false);
      expect(calls).toHaveLength(failAt);
      expect(problem.reason).toBe('stage Symmy demo bootstrap failed; composition not published');
      expect(yield* output.errorLines).toEqual([
        '[app-host] stage Symmy demo bootstrap failed; composition not published',
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.live('fails stage configuration before starting any command and does not expose configuration values', () =>
  Effect.gen(function* missingAdmin() {
    const { calls, output, run } = yield* fixture();
    const problem = yield* run({ ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage' }).pipe(Effect.flip);
    expect(problem.reason).toBe('stage Symmy demo bootstrap failed; composition not published');
    expect(calls).toEqual([]);
    expect(yield* output.errorLines).toEqual([
      '[app-host] stage Symmy demo bootstrap failed; composition not published',
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('sanitizes a process-start error instead of reporting its command details', () =>
  Effect.gen(function* failedSpawn() {
    const output = yield* TestConsole.make;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.fail(systemError({
        _tag: 'PermissionDenied',
        description: ADMIN_URL,
        method: 'spawn',
        module: 'ChildProcessSpawner',
      })),
    );
    const problem = yield* bootstrapStageSymmyDemo.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(STAGE)),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Console.Console, output),
      Effect.flip,
    );
    expect(problem.reason).toBe('stage Symmy demo bootstrap failed; composition not published');
    expect(yield* output.errorLines).toEqual([
      '[app-host] stage Symmy demo bootstrap failed; composition not published',
    ]);
  }),
);

it('does not make the supervisor admin URL available to owners, even through their stored secrets', () => {
  const { environment } = processEnvironment(
    ['shell-super-app', 'symmy-integration'],
    {
      'shell-super-app': { DATABASE_ADMIN_URL: ADMIN_URL },
      'symmy-integration': { DATABASE_ADMIN_URL: ADMIN_URL },
    },
    {},
  );
  expect(environment.DATABASE_ADMIN_URL).toBeUndefined();
});

it('runs the boot hook after migrations and the unchanged parallel access/key proofs, before publication', () => {
  const host = readFileSync(new URL('../zerops/app-host.mts', import.meta.url), 'utf8');
  const startup = host.slice(host.indexOf('const startup = Effect.gen('));
  const hook = startup.indexOf('yield* bootstrapStageSymmyDemo.pipe(');
  expect(hook).toBeGreaterThan(startup.indexOf("runChild('migrator'"));
  expect(hook).toBeGreaterThan(startup.indexOf('yield* releaseAccessProof;'));
  expect(startup.indexOf('yield* publishSnapshot(releaseSnapshot)')).toBeGreaterThan(hook);
  expect(startup.indexOf('yield* openPublicPort.pipe(')).toBeGreaterThan(hook);
});
