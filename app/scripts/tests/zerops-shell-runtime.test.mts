import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Effect, Layer, Match } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { systemError } from 'effect/PlatformError';
import { expect, it } from 'effect-rstest';

import { shellRuntime, startUnitProcess } from '../zerops/app-host.mts';
import { SHELL_ID, workspaceRoot } from '../zerops/hosted-units.mts';

it.effect('defaults to Node and accepts only explicit node or bun runtime settings', () =>
  Effect.gen(function* runtimeConfiguration() {
    for (const [environment, expected] of [
      [{}, 'node'],
      [{ ONTOS_SHELL_RUNTIME: '' }, 'node'],
      [{ ONTOS_SHELL_RUNTIME: 'node' }, 'node'],
      [{ ONTOS_SHELL_RUNTIME: 'bun' }, 'bun'],
    ] as const) {
      expect(
        yield* shellRuntime.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment)))),
      ).toBe(expected);
    }
    for (const value of ['Bun', 'aot', 'other']) {
      const exit = yield* shellRuntime.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ONTOS_SHELL_RUNTIME: value }))),
        Effect.exit,
      );
      expect(exit._tag).toBe('Failure');
    }
  }),
);

it.live('spawns only the isolated Shell with Bun, preserving arguments, environment and scoped exit handling', () =>
  Effect.gen(function* unitSpawning() {
    for (const [ids, runtime, expectedCommand] of [
      [[SHELL_ID], 'bun', path.join(workspaceRoot, '.zerops/bun/bin/bun')],
      [[SHELL_ID], 'node', process.execPath],
      [['crm', 'party-registry'], 'bun', process.execPath],
      [['crm'], 'bun', process.execPath],
      [[SHELL_ID, 'crm'], 'bun', process.execPath],
    ] as const) {
      let spawned = false;
      const spawnerLayer = Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function* nativeFixtureSpawner() {
          const native = yield* ChildProcessSpawner.ChildProcessSpawner;
          return ChildProcessSpawner.make((command) =>
            Match.value(command).pipe(
              Match.tag('StandardCommand', (standard) => {
                spawned = true;
                expect(standard.command).toBe(expectedCommand);
                expect(standard.args).toEqual([path.join(workspaceRoot, 'scripts/zerops/serve-units.mts'), ...ids]);
                expect(standard.options).toMatchObject({
                  cwd: workspaceRoot,
                  env: { NODE_ENV: 'production' },
                  extendEnv: true,
                  stderr: 'inherit',
                  stdout: 'inherit',
                });
                // A stopped child must fail the supervisor, even for an otherwise successful exit.
                return native.spawn(ChildProcess.make(process.execPath, ['--eval', '']));
              }),
              Match.tag('PipedCommand', () => Effect.die('unexpected piped unit command')),
              Match.exhaustive,
            ),
          );
        }),
      ).pipe(Layer.provide(NodeServices.layer));
      const exit = yield* startUnitProcess(ids, runtime, {
        NODE_ENV: 'production',
      }).pipe(Effect.flatten, Effect.scoped, Effect.provide(spawnerLayer), Effect.exit);
      expect(spawned).toBe(true);
      expect(exit._tag).toBe('Failure');
    }
  }),
);

it.effect('fails a missing Bun binary without retrying the Shell on Node', () =>
  Effect.gen(function* missingBunBinary() {
    let attempts = 0;
    const spawner = ChildProcessSpawner.make(() => {
      attempts += 1;
      return Effect.fail(
        systemError({
          _tag: 'NotFound',
          method: 'spawn',
          module: 'ChildProcessSpawner',
          pathOrDescriptor: 'bun',
        }),
      );
    });
    const failure = yield* startUnitProcess([SHELL_ID], 'bun', {}).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.flip,
    );
    expect(failure.reason).toBe(`${SHELL_ID} failed to start`);
    expect(attempts).toBe(1);
  }),
);
