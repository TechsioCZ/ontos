import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, fixtureConfigPath, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const rules = ['no-wide-factory-signature', 'no-effect-provide-in-library', 'no-layer-provide-in-library'];
const harnessPath = 'packages/core-runtime/src/testing/reads.ts';
const source = `import { Effect as Fx, Layer } from 'effect';
import { makeReadRuntime as makeRuntime } from '../reads/runtime.ts';
import { scriptedPgClientLayer as makeDriver } from './scripted-pg-client.ts';
interface ReadHarnessOptions { execute: (sql: string) => Fx.Effect<readonly object[]>; }
export const makeReadTestHarness = Fx.fn('ReadTestHarness.make')(function* makeReadTestHarness(options: ReadHarnessOptions) {
  const database = yield* Layer.build(makeDriver(options.execute).pipe(Layer.provide(dependency)));
  yield* Fx.void.pipe(Fx.provideService(service, database));
  const runtime = makeRuntime(database);
  return runtime;
});
`;
const businessHelper = `
export const makeBusiness = (options: ReadHarnessOptions) => Fx.succeed(options).pipe(
  Fx.provideService(service, dependency),
  Fx.as(Layer.succeed(service, options).pipe(Layer.provide(dependency))),
);
`;

for (const rule of rules) {
  it(`effect-native/${rule} recognizes only the sanctioned Core Read test composition callback`, () => {
    withTemporaryWorkspace((directory) => {
      const diagnostics = (logicalPath: string, candidate: string) => {
        const filename = path.join(directory, logicalPath);
        mkdirSync(path.dirname(filename), { recursive: true });
        writeFileSync(filename, candidate);
        return runOxlint(fixtureConfigPath(rule), [filename], appRoot).diagnostics.filter(
          ({ code }) => code === `effect-native(${rule})`,
        );
      };
      expect(diagnostics(harnessPath, source)).toEqual([]);
      expect(diagnostics(harnessPath, source + businessHelper)).toHaveLength(1);
      expect(
        diagnostics(harnessPath, source.replace('export const makeReadTestHarness', 'const makeReadTestHarness')),
      ).not.toHaveLength(0);
      expect(
        diagnostics(harnessPath, source.replace("'./scripted-pg-client.ts'", "'./lookalike-driver.ts'")),
      ).not.toHaveLength(0);
      expect(diagnostics('packages/core-runtime/src/testing/business.ts', source)).not.toHaveLength(0);
      expect(
        diagnostics(
          harnessPath,
          source.replace(
            'const runtime = makeRuntime(database);',
            'const makeRuntime = () => ({}); const runtime = makeRuntime(database);',
          ),
        ),
      ).not.toHaveLength(0);
      expect(diagnostics('verticals/inventory/src/testing/reads.ts', source)).not.toHaveLength(0);
    });
  });
}

it('recognizes only the genuine NodeRuntime outer process supply seam', () => {
  withTemporaryWorkspace((directory) => {
    const original = `import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
const main = Effect.void;
NodeRuntime.runMain(main.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer))));`;
    const runtimeCall = 'NodeRuntime.runMain';
    const cases = [
      { expected: 0, name: 'node-main', source: original },
      {
        expected: 0,
        name: 'node-main-renamed',
        source: original
          .replaceAll('NodeRuntime', 'Runtime')
          .replace('import { Runtime,', 'import { NodeRuntime as Runtime,'),
      },
      {
        expected: 1,
        name: 'node-main-shadow',
        source: original
          .replace('import { NodeRuntime,', 'import { NodeRuntime as ActualRuntime,')
          .replace(runtimeCall, 'const NodeRuntime = fake; NodeRuntime.runMain'),
      },
      {
        expected: 1,
        name: 'node-main-alias',
        source: original.replace(runtimeCall, 'const start = NodeRuntime.runMain; start'),
      },
      {
        expected: 1,
        name: 'node-main-mutation',
        source: original.replace('const main', 'NodeRuntime.runMain = replacement; const main'),
      },
      {
        expected: 1,
        name: 'node-main-fake-module',
        source: original.replace('@effect/platform-node', './fake-runtime.ts'),
      },
      {
        expected: 1,
        name: 'node-main-exported-and-called',
        source: original
          .replace('NodeRuntime.runMain', 'export function start() { NodeRuntime.runMain')
          .replace('));', ')); } start();'),
      },
      {
        expected: 1,
        name: 'node-main-nested',
        source: original.replace(runtimeCall, 'export const start = () => NodeRuntime.runMain'),
      },
      {
        expected: 1,
        name: 'node-main-hidden-supply',
        source: original.replace(
          'main.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer)))',
          'Effect.succeed(main.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer))))',
        ),
      },
      {
        expected: 1,
        name: 'node-main-optional',
        source: original.replace('NodeRuntime.runMain(', 'NodeRuntime.runMain?.('),
      },
      {
        expected: 1,
        name: 'node-main-second-platform-alias',
        source: original.replace(
          'import { Effect',
          "import * as Platform from '@effect/platform-node'; Platform.NodeRuntime.runMain = replacement; import { Effect",
        ),
      },
    ];
    const filenames = cases.map(({ name, source: candidateSource }) => {
      const filename = path.join(directory, 'scripts', `${name}.mts`);
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, candidateSource);
      return filename;
    });
    const diagnostics = runOxlint(
      fixtureConfigPath('no-effect-provide-in-library'),
      filenames,
      appRoot,
    ).diagnostics.filter(({ code }) => code === 'effect-native(no-effect-provide-in-library)');
    for (const scenario of cases) {
      expect(
        diagnostics.filter(({ filename }) => filename.endsWith(`/${scenario.name}.mts`)).length,
        scenario.name,
      ).toBe(scenario.expected);
    }
  });
});
