import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Deferred, Effect, Exit, Ref } from 'effect';
import { expect, it } from 'effect-rstest';

import { workspaceRoot } from '../zerops/hosted-units.mts';
import { startProcessBootWarmUpImports } from '../zerops/process-boot-warm-up-imports.mts';
import { servedProcessOf, startBootWarmUp } from '../zerops/serve-units.mts';
import { registerBootWarmUpImport } from '../../packages/core-runtime/src/runtime/boot-warm-up-imports.ts';
import type { BootWarmUpImport } from '../../packages/core-runtime/src/runtime/boot-warm-up-imports.ts';

/** A unit's lazy import that loads at once. */
const loadAtOnce: BootWarmUpImport = Effect.void;

const serveUnitsSource = () => readFileSync(path.join(workspaceRoot, 'scripts/zerops/serve-units.mts'), 'utf-8');

/** The Shell process serves the Shell alone; the owners process serves every other unit (app-host.mts). */
const HOSTS = [
  { ids: ['shell-super-app'], served: 'shell' },
  { ids: ['commerce-market-catalog', 'party-registry', 'work-tasks'], served: 'owners' },
] as const;

for (const { ids, served } of HOSTS) {
  it.live(`the ${served} process forks its warm-up and goes on to serve without awaiting it`, () =>
    Effect.gen(function* warmUpInBackground() {
      expect(servedProcessOf(ids)).toBe(served);
      const started = yield* Deferred.make<boolean>();
      const finished = yield* Ref.make(false);
      // A warm-up that never ends: the boot returns at once all the same, and the warm-up runs in the host scope.
      const neverEnding = Deferred.succeed(started, true).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Ref.set(finished, true)),
      );
      const boot = yield* Effect.scoped(
        Effect.gen(function* hostScope() {
          yield* startBootWarmUp(served, neverEnding);
          yield* Deferred.await(started);
          return yield* Ref.get(finished);
        }),
      ).pipe(Effect.timeout('1 second'), Effect.exit);
      expect(Exit.isSuccess(boot) && boot.value).toBe(false);
      // Closing the host scope interrupts the warm-up.
      expect(yield* Ref.get(finished)).toBe(true);
    }),
  );
}

it('serve-units starts the warm-up before it loads any unit, and installs the lazy-import set before that', () => {
  const source = serveUnitsSource();
  const command = source.slice(source.indexOf("Command.make('serve-units'"));
  const warmUp = command.indexOf('yield* startBootWarmUp(served, nodeHostBootWarmUp());');
  expect(warmUp).toBeGreaterThan(0);
  // Not awaited: no Fiber.join or await of the fork anywhere in the program.
  expect(source).not.toMatch(/Fiber\.(?:join|await)/u);
  expect(warmUp).toBeLessThan(command.indexOf('serveUnit(holders)'));
  const main = source.slice(source.indexOf('if (import.meta.main)'));
  expect(main.indexOf('startProcessBootWarmUpImports')).toBeGreaterThan(0);
  expect(main.indexOf('startProcessBootWarmUpImports')).toBeLessThan(main.indexOf('Layer.build('));
});

it.live('the process host collects the lazy imports its units register, and only while it runs', () =>
  Effect.gen(function* collectImports() {
    registerBootWarmUpImport(loadAtOnce);
    expect(globalThis.ontosBootWarmUpImports).toBeUndefined();
    yield* Effect.scoped(
      Effect.gen(function* hostScope() {
        yield* startProcessBootWarmUpImports;
        registerBootWarmUpImport(loadAtOnce);
        expect([...(globalThis.ontosBootWarmUpImports ?? [])]).toEqual([loadAtOnce]);
        const duplicate = yield* Effect.exit(Effect.scoped(startProcessBootWarmUpImports));
        expect(String(duplicate)).toContain('BootWarmUpImportsAlreadyStarted');
      }),
    );
    expect(globalThis.ontosBootWarmUpImports).toBeUndefined();
  }),
);
