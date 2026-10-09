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
