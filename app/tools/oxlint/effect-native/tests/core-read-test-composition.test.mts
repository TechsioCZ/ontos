import { describe } from 'effect-rstest';

import { collectCases, effectNativeRule, fixtureOptions, virtualFile, withOptions } from './rule-tester.mts';

const provideRule = 'no-effect-provide-in-library';
const rules = ['no-wide-factory-signature', provideRule, 'no-layer-provide-in-library'];
const at = (logicalPath: string) => ({ filename: virtualFile(logicalPath) });
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
  describe(`effect-native/${rule} recognizes only the sanctioned Core Read test composition callback`, () => {
    const { accept, register, reject } = collectCases(effectNativeRule(rule), `effect-native/${rule}`, {
      ...withOptions(fixtureOptions(rule)),
    });
    accept(source, at(harnessPath));
    reject(1, source + businessHelper, at(harnessPath));
    reject(1, source.replace('export const makeReadTestHarness', 'const makeReadTestHarness'), at(harnessPath));
    reject(1, source.replace("'./scripted-pg-client.ts'", "'./lookalike-driver.ts'"), at(harnessPath));
    reject(1, source, at('packages/core-runtime/src/testing/business.ts'));
    reject(
      1,
      source.replace(
        'const runtime = makeRuntime(database);',
        'const makeRuntime = () => ({}); const runtime = makeRuntime(database);',
      ),
      at(harnessPath),
    );
    reject(1, source, at('verticals/inventory/src/testing/reads.ts'));
    register();
  });
}

describe('recognizes only the genuine NodeRuntime outer process supply seam', () => {
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
  const { accept, register, reject } = collectCases(
    effectNativeRule(provideRule),
    `effect-native/${provideRule}`,
    withOptions(fixtureOptions(provideRule)),
  );
  for (const scenario of cases) {
    const overrides = { filename: virtualFile(`scripts/${scenario.name}.mts`), name: scenario.name };
    if (scenario.expected === 0) {
      accept(scenario.source, overrides);
    } else {
      reject(scenario.expected, scenario.source, overrides);
    }
  }
  register();
});
