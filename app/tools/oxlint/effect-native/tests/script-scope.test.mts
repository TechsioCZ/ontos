import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

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
    withTemporaryWorkspace((root) => {
      const directory = nodePath.join(root, 'workspace');
      const alias = nodePath.join(root, 'workspace-link');
      mkdirSync(directory);
      symlinkSync(directory, alias, 'dir');
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
              [`effect-native/${rule}`]: includeScripts ? ['error', { includeScripts: true }] : 'error',
            },
          }),
        );
        for (const pathMode of ['relative', 'absolute', 'symlink'] as const) {
          const run = runOxlint(
            config,
            pathMode === 'relative'
              ? paths
              : paths.map((path) => nodePath.join(pathMode === 'symlink' ? alias : directory, path)),
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
              // Oxlint may retain absolute spellings when input paths cross a symlink.
              run.diagnostics.map((diagnostic) => realpathSync(nodePath.resolve(directory, diagnostic.filename))),
            ),
          ];
          expect(reported.toSorted(), `${rule}: includeScripts=${includeScripts}, pathMode=${pathMode}`).toEqual(
            (includeScripts ? paths : sources).map((path) => realpathSync(nodePath.join(directory, path))).toSorted(),
          );
        }
      }
    });
  });
}
