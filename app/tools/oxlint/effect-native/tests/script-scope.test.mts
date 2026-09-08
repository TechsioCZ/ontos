import { expect, it } from '@app/effect-rstest';
import { mkdirSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';

import { runOxlint, testsDirectory } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const cases = [
  {
    rule: 'no-native-timers',
    source: 'export const handle = setTimeout(() => {}, 10);',
  },
  {
    rule: 'no-dependency-parameters',
    source: `import { Effect } from 'effect';
interface ContactsGateway { readonly list: () => Effect.Effect<string>; }
export const boot = (options: { readonly gateway: ContactsGateway }) => options.gateway;`,
  },
  {
    rule: 'no-wide-factory-signature',
    source: `import { gen } from 'effect/Effect';
export const makeOutboxProcessor = (dependencies: OutboxProcessorDependencies) =>
  gen(function* () { return dependencies; });`,
  },
];

for (const { rule, source } of cases) {
  it(`${rule} excludes nested scripts by default and honors includeScripts`, () => {
    withTemporaryWorkspace((directory) => {
      const workspaces = ['apps/shell-super-app', 'verticals/contacts', 'packages/core-runtime'];
      const sources = workspaces.map((workspace) => `${workspace}/src/operation.ts`);
      const scripts = workspaces.map((workspace) => `${workspace}/scripts/operation.mts`);
      const paths = [...sources, ...scripts];
      for (const path of paths) {
        const file = nodePath.join(directory, path);
        mkdirSync(nodePath.dirname(file), { recursive: true });
        writeFileSync(file, source);
      }
      const config = nodePath.join(directory, '.oxlintrc.json');
      for (const includeScripts of [false, true]) {
        writeFileSync(
          config,
          JSON.stringify({
            categories: { correctness: 'off' },
            jsPlugins: [
              {
                name: 'effect-native',
                specifier: nodePath.join(testsDirectory, 'fixture-plugin.ts'),
              },
            ],
            rules: {
              [`effect-native/${rule}`]: includeScripts
                ? ['error', { includeScripts: true }]
                : 'error',
            },
          }),
        );
        for (const absolute of [false, true]) {
          const run = runOxlint(
            config,
            absolute ? paths.map((path) => nodePath.join(directory, path)) : paths,
            directory,
            rule,
          );
          expect(run.numberOfFiles, `${rule}: every staged file must be linted`).toBe(paths.length);
          expect(run.exitCode, `${rule}: ordinary source must still report`).toBe(1);
          for (const diagnostic of run.diagnostics) {
            expect(diagnostic.code).toBe(`effect-native(${rule})`);
          }
          const reported = [
            ...new Set(
              run.diagnostics.map((diagnostic) =>
                (nodePath.isAbsolute(diagnostic.filename)
                  ? nodePath.relative(directory, diagnostic.filename)
                  : diagnostic.filename
                ).replaceAll('\\', '/'),
              ),
            ),
          ];
          expect(
            reported.toSorted(),
            `${rule}: includeScripts=${includeScripts}, absolute=${absolute}`,
          ).toEqual((includeScripts ? paths : sources).toSorted());
        }
      }
    });
  });
}
