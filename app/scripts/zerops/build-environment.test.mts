import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { expect, it } from 'effect-rstest';

const APP_ROOT = path.resolve(import.meta.dirname, '../..');
const NORMALIZE = '. scripts/zerops/build-environment.sh >&2';
/** What zerops.yaml's app build and the stage workflow's build job declare. */
const DECLARED = {
  ONTOS_PUBLIC_ORIGIN: 'https://shell.example',
  ONTOS_SHOP_STOREFRONT_ORIGIN: 'https://shop.example',
  ONTOS_STOREFRONT_ORIGIN: 'https://storefront.example',
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
};
/** Project variables the Zerops build container carries and the runner does not. */
const AMBIENT = {
  MODERN_PUBLIC_SITE_URL: 'https://site.example',
  NODE_ENV: 'development',
  ULTRAMODERN_MF_DEV_ORIGIN: 'https://dev-origin.example',
  ULTRAMODERN_PUBLIC_URL_NOT_A_UNIT: 'https://stray.example',
};

/** Runs `script` under sh with only the given variables (and PATH/HOME), as build-app.sh's environment. */
const shell = (script: string, variables: Readonly<Record<string, string>>) =>
  Effect.gen(function* runShell() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // The child finds sh, node and Git exactly as this test process does.
    const [home, executables] = yield* Effect.all([Config.String('HOME'), Config.String('PATH')], { concurrency: 1 });
    const handle = yield* spawner.spawn(
      ChildProcess.make('sh', ['-c', script], {
        cwd: APP_ROOT,
        env: { HOME: home, PATH: executables, ...variables },
        extendEnv: false,
      }),
    );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode,
      ],
      { concurrency: 'unbounded' },
    );
    expect({ code: Number(code), stderr: Number(code) === 0 ? '' : stderr }).toEqual({ code: 0, stderr: '' });
    return { stderr, stdout };
  }).pipe(Effect.scoped);

/** The committed unit identities, as build-app.sh computes them after normalizing its environment. */
const identities = (variables: Readonly<Record<string, string>>) =>
  shell(`${NORMALIZE}; node scripts/zerops/delivery-plan-cli.mts digests`, variables).pipe(
    Effect.map(({ stdout }) =>
      stdout
        .trim()
        .split('\n')
        .map((row) => row.split('\t').slice(0, 2).join('\t')),
    ),
  );

it.effect(
  'drops undeclared build variables by name and keeps declared ones and the release-identity overrides',
  () =>
    Effect.gen(function* normalizedEnvironment() {
      const overrides = { ULTRAMODERN_BUILD_MARKER: 'marker', ULTRAMODERN_SOURCE_REVISION: 'a'.repeat(40) };
      const { stderr, stdout } = yield* shell(`${NORMALIZE}; env`, {
        ...DECLARED,
        ...AMBIENT,
        ...overrides,
        UNRELATED_VARIABLE: 'kept',
      });
      const names = new Set(stdout.split('\n').map((line) => line.split('=')[0] ?? ''));
      for (const name of Object.keys(AMBIENT)) {
        expect({ name, present: names.has(name) }).toEqual({ name, present: false });
        expect(stderr).toContain(`build environment: dropped undeclared ${name}\n`);
      }
      for (const name of [...Object.keys(DECLARED), ...Object.keys(overrides), 'UNRELATED_VARIABLE']) {
        expect({ name, present: names.has(name) }).toEqual({ name, present: true });
      }
      // Names only: no dropped value reaches the log.
      for (const value of Object.values(AMBIENT)) {
        expect(stderr).not.toContain(value);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  30_000,
);

it.effect(
  'computes the same identities with the Zerops ambient variables, and new ones when a declared input changes',
  () =>
    Effect.gen(function* identitiesIgnoreAmbientVariables() {
      const declared = yield* identities(DECLARED);
      expect(declared.length).toBeGreaterThan(1);
      expect(yield* identities({ ...DECLARED, ...AMBIENT })).toEqual(declared);
      const changed = yield* identities({ ...DECLARED, ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' });
      expect(changed.filter((row) => declared.includes(row))).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
