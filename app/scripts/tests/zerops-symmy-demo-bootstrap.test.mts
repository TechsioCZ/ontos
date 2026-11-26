import { readFileSync } from 'node:fs';

import { NodeServices } from '@effect/platform-node';
import { Cause, ConfigProvider, Console, Effect, Match, Option } from 'effect';
import { systemError } from 'effect/PlatformError';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { TestConsole } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import {
  AppHostError,
  bootstrapStageSymmyDemo,
  customerDiscoveryHostError,
  demoFixtureCustomerSource,
  formatAppHostStop,
  processEnvironment,
} from '../zerops/app-host.mts';
import { SymmyDemoCustomerAuthorityError } from '../demo/symmy-demo-customer-authority.mts';
import { workspaceRoot } from '../zerops/hosted-units.mts';
import { n1StorefrontOrigin } from '../zerops/deployment-profile.mts';

const SCRIPTS = [
  ['scripts/demo/symmy-demo-inventory-authority.mts'],
  ['scripts/demo/symmy-demo-source-policies.mts'],
  ['scripts/demo/symmy-demo-customer-authority.mts', '--mode', 'apply'],
  ['scripts/demo/symmy-demo-exchange-authority.mts'],
];
const ADMIN_URL = 'postgres://admin:never-log-this@db/stage';
const STAGE_BOOTSTRAP_FAILED = 'stage Symmy demo bootstrap failed; composition not published';
const STAGE_BOOTSTRAP_STOP = '[app-host] stage Symmy demo bootstrap failed; composition not published';
const UNRELATED_SECRET = 'never-inherit-this';
const SQL_TEXT = 'select secret_value from private_table';
const CUSTOMER_SETTINGS = {
  DATABASE_URL: 'postgres://ontos_runtime:never-log-runtime@db/stage',
  ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: '[]',
  ONTOS_PRIVACY_SOURCE_PROCESSING_CONTEXTS: '[]',
  ONTOS_SYMMY_JOB_RETENTION_POLICIES: '[]',
};
const STAGE = {
  ...CUSTOMER_SETTINGS,
  DATABASE_ADMIN_URL: ADMIN_URL,
  ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: 'https://not-published-yet/composition',
  ONTOS_DEMO_FIXTURES_ENABLED: 'true',
  ONTOS_OWNER_SECRETS_JSON: '{"shell-super-app":{"unrelated":"never-inherit-this"}}',
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
};
/** A fresh deployment of the same stage release: every credential, but no demo fixtures. */
const FRESH_STAGE = { ...STAGE, ONTOS_DEMO_FIXTURES_ENABLED: 'false' };
const FIXTURES_ONLY = { ONTOS_DEMO_FIXTURES_ENABLED: 'true', ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage' };

it('prints only allowlisted host-authored stop reasons, never dynamic reasons or raw causes', () => {
  expect(
    formatAppHostStop(
      Cause.fail(
        new AppHostError({
          reason: 'Unable to resolve the existing AKROS customer source writers',
        }),
      ),
    ),
  ).toBe('[app-host] stopped: Unable to resolve the existing AKROS customer source writers');
  for (const cause of [
    Cause.fail(new AppHostError({ reason: `${ADMIN_URL}; ${SQL_TEXT}` })),
    Cause.fail(new Error(`${ADMIN_URL}; ${SQL_TEXT}`)),
    Cause.die(`${ADMIN_URL}; ${SQL_TEXT}`),
    Cause.fail({ _tag: 'AppHostError', reason: ADMIN_URL }),
  ]) {
    expect(formatAppHostStop(cause)).toBe('[app-host] stopped: unclassified host failure');
  }
});

it('preserves only exact typed discovery phases and replaces every other source error', () => {
  for (const phase of ['integration-route', 'party-writer', 'commerce-writer', 'party-reader']) {
    const error = customerDiscoveryHostError(new SymmyDemoCustomerAuthorityError({ reason: phase }));
    expect(formatAppHostStop(Cause.fail(error))).toBe(
      `[app-host] stopped: AKROS customer discovery failed phase=${phase}`,
    );
  }
  for (const problem of [
    new SymmyDemoCustomerAuthorityError({ reason: `${ADMIN_URL}; ${SQL_TEXT}` }),
    new Error(`${ADMIN_URL}; ${SQL_TEXT}`),
    { _tag: 'SymmyDemoCustomerAuthorityError', reason: 'party-writer' },
  ]) {
    expect(formatAppHostStop(Cause.fail(customerDiscoveryHostError(problem)))).toBe(
      '[app-host] stopped: Unable to resolve the existing AKROS customer source writers',
    );
  }
});

it.effect(
  'reads the demo customer source before migrations only with the demo fixtures, never on a fresh database',
  () =>
    Effect.gen(function* customerSourceDiscovery() {
      let discoveries = 0;
      const discovered = {
        ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: '[]',
        ONTOS_PRIVACY_SOURCE_SYNC_PROCESSING_ENABLED: 'true',
      };
      const discover = Effect.sync(() => {
        discoveries += 1;
        return { environment: discovered };
      });
      const resolve = (environment: Readonly<Record<string, string>>) =>
        demoFixtureCustomerSource(discover).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
        );
      const freshDeployments: readonly Readonly<Record<string, string>>[] = [
        {},
        FRESH_STAGE,
        { ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage' },
      ];
      for (const fresh of freshDeployments) {
        expect(yield* resolve(fresh)).toEqual({ demoFixturesEnabled: false, environment: {} });
      }
      expect(discoveries).toBe(0);
      expect(yield* resolve(STAGE)).toEqual({ demoFixturesEnabled: true, environment: discovered });
      expect(discoveries).toBe(1);
      expect(yield* resolve({ ONTOS_DEMO_FIXTURES_ENABLED: 'not-a-flag' }).pipe(Effect.flip)).toBeDefined();
      expect(discoveries).toBe(1);
    }),
);

const readN1Origin = (environment: Readonly<Record<string, string>>) =>
  n1StorefrontOrigin.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
  );

it.effect('accepts only a bare HTTPS N1 storefront origin and admits none when unset', () =>
  Effect.gen(function* n1Origin() {
    expect(yield* readN1Origin({})).toEqual(Option.none());
    expect(yield* readN1Origin({ ONTOS_N1_STOREFRONT_ORIGIN: 'https://n1.stable.example' })).toEqual(
      Option.some('https://n1.stable.example'),
    );
    for (const rejected of ['http://localhost:3071', 'https://n1.example/path', 'https://user@n1.example', '*']) {
      expect(yield* readN1Origin({ ONTOS_N1_STOREFRONT_ORIGIN: rejected }).pipe(Effect.flip)).toBeDefined();
    }
  }),
);

/** Exercise the real child boundary without running the database-writing demo commands. */
const fixture = (failAt = 0, exitCode = 7) =>
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
                `console.log(process.env.DATABASE_ADMIN_URL); console.error(process.env.DATABASE_ADMIN_URL, ${JSON.stringify(SQL_TEXT)}); process.exit(${calls.length === failAt ? String(exitCode) : '0'});`,
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

it.live('enrolls the native receiver before all source bootstraps with only supervisor bootstrap settings', () =>
  Effect.gen(function* repeatedStageBoots() {
    const { calls, output, run } = yield* fixture();
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
      const compileCache = command.options.env?.NODE_COMPILE_CACHE;
      expect(compileCache).toEqual(expect.any(String));
      const expected: NonNullable<ChildProcess.CommandOptions['env']> = {
        DATABASE_ADMIN_URL: ADMIN_URL,
        NODE_COMPILE_CACHE: compileCache,
        ONTOS_DATABASE_POOL_SHARED: 'false',
        ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
      };
      if (command.args.length > 1) {
        Object.assign(expected, CUSTOMER_SETTINGS);
      }
      if (command.args[0] === SCRIPTS[0][0]) {
        expected.DATABASE_URL = CUSTOMER_SETTINGS.DATABASE_URL;
      }
      expect(command.options.env).toEqual(expected);
    }
    const lines = (yield* output.logLines).map(String);
    for (const kind of ['inventory-authority', 'source-policies', 'customer-authority', 'exchange-authority']) {
      const timings = lines.filter((line) => line.startsWith(`[boot-timing] stage=host.symmy-demo.${kind} `));
      expect(timings).toHaveLength(2);
      for (const timing of timings) {
        expect(timing).toMatch(/ ms=\d+ outcome=ok$/u);
      }
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live('does nothing without the demo fixture opt-in, even on a fully configured stage deployment', () =>
  Effect.gen(function* withoutDemoFixtures() {
    const { calls, run } = yield* fixture();
    yield* run({});
    for (const environment of ['production', 'development', 'stage']) {
      yield* run({ ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: environment });
    }
    yield* run(FRESH_STAGE);
    yield* run(Object.fromEntries(Object.entries(STAGE).filter(([key]) => key !== 'ONTOS_DEMO_FIXTURES_ENABLED')));
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

for (const [failAt, kind] of [
  [1, 'inventory-authority'],
  [2, 'source-policies'],
  [3, 'customer-authority'],
  [4, 'exchange-authority'],
] as const) {
  it.live(`stops before publication and logs two sanitized lines when command ${failAt} fails`, () =>
    Effect.gen(function* failedBootstrap() {
      const exitCode = failAt + 6;
      const { calls, output, run } = yield* fixture(failAt, exitCode);
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
      expect(problem.reason).toBe(STAGE_BOOTSTRAP_FAILED);
      const errors = yield* output.errorLines;
      expect(errors).toEqual([
        `[app-host] stage Symmy ${kind} bootstrap failed category=exit exitCode=${exitCode}`,
        STAGE_BOOTSTRAP_STOP,
      ]);
      const logs = JSON.stringify([...(yield* output.logLines), ...errors]);
      for (const secret of [ADMIN_URL, CUSTOMER_SETTINGS.DATABASE_URL, UNRELATED_SECRET, SQL_TEXT]) {
        expect(logs).not.toContain(secret);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.live('fails stage configuration before starting any command and does not expose configuration values', () =>
  Effect.gen(function* missingAdmin() {
    const { calls, output, run } = yield* fixture();
    const problem = yield* run(FIXTURES_ONLY).pipe(Effect.flip);
    expect(problem.reason).toBe(STAGE_BOOTSTRAP_FAILED);
    expect(calls).toEqual([]);
    expect(yield* output.errorLines).toEqual([
      '[app-host] stage Symmy source-policies bootstrap failed category=config',
      STAGE_BOOTSTRAP_STOP,
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('sanitizes a process-start error instead of reporting its command details', () =>
  Effect.gen(function* failedSpawn() {
    const output = yield* TestConsole.make;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.fail(
        systemError({
          _tag: 'PermissionDenied',
          description: `${ADMIN_URL}; ${SQL_TEXT}`,
          method: 'spawn',
          module: 'ChildProcessSpawner',
        }),
      ),
    );
    const problem = yield* bootstrapStageSymmyDemo.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(STAGE)),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Console.Console, output),
      Effect.flip,
    );
    expect(problem.reason).toBe(STAGE_BOOTSTRAP_FAILED);
    const errors = yield* output.errorLines;
    expect(errors).toEqual([
      '[app-host] stage Symmy inventory-authority bootstrap failed category=spawn',
      STAGE_BOOTSTRAP_STOP,
    ]);
    const logs = JSON.stringify([...(yield* output.logLines), ...errors]);
    for (const secret of [ADMIN_URL, CUSTOMER_SETTINGS.DATABASE_URL, UNRELATED_SECRET, SQL_TEXT]) {
      expect(logs).not.toContain(secret);
    }
  }),
);

it.live('identifies native receiver configuration failure before starting a child or publishing secrets', () =>
  Effect.gen(function* missingCustomerRuntime() {
    const { calls, output, run } = yield* fixture();
    const problem = yield* run({ ...FIXTURES_ONLY, DATABASE_ADMIN_URL: ADMIN_URL }).pipe(Effect.flip);
    expect(problem.reason).toBe(STAGE_BOOTSTRAP_FAILED);
    expect(calls).toEqual([]);
    expect(yield* output.errorLines).toEqual([
      '[app-host] stage Symmy inventory-authority bootstrap failed category=config',
      STAGE_BOOTSTRAP_STOP,
    ]);
    const logs = JSON.stringify([...(yield* output.logLines), ...(yield* output.errorLines)]);
    for (const secret of [ADMIN_URL, CUSTOMER_SETTINGS.DATABASE_URL, UNRELATED_SECRET, SQL_TEXT]) {
      expect(logs).not.toContain(secret);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
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
  const host = readFileSync(new URL('../zerops/app-host.mts', import.meta.url), 'utf-8');
  const startup = host.slice(host.indexOf('const startup = Effect.gen('));
  const hook = startup.indexOf('yield* bootstrapStageSymmyDemo.pipe(');
  expect(hook).toBeGreaterThan(startup.indexOf("runChild('migrator'"));
  expect(hook).toBeGreaterThan(startup.indexOf('yield* releaseAccessProof;'));
  expect(startup.indexOf('yield* publishSnapshot(releaseSnapshot)')).toBeGreaterThan(hook);
  expect(startup.indexOf('yield* openPublicPort.pipe(')).toBeGreaterThan(hook);
});
