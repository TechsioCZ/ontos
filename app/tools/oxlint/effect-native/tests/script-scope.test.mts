import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

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
  test(`${rule} excludes nested scripts by default and honors includeScripts`, () => {
    withTemporaryWorkspace((root) => {
      const directory = join(root, 'workspace');
      const alias = join(root, 'workspace-link');
      mkdirSync(directory);
      symlinkSync(directory, alias, 'dir');
      const workspaces = [
        'apps/shell-super-app',
        'verticals/contacts',
        'packages/core-runtime',
      ];
      const sources = workspaces.map(
        (workspace) => `${workspace}/src/operation.ts`
      );
      const scripts = workspaces.map(
        (workspace) => `${workspace}/scripts/operation.mts`
      );
      const paths = [...sources, ...scripts];
      for (const path of paths) {
        const file = join(directory, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, source);
      }
      const config = join(directory, '.oxlintrc.json');
      for (const includeScripts of [false, true]) {
        writeFileSync(
          config,
          JSON.stringify({
            jsPlugins: [
              {
                name: 'effect-native',
                specifier: join(testsDirectory, 'fixture-plugin.ts'),
              },
            ],
            categories: { correctness: 'off' },
            rules: {
              [`effect-native/${rule}`]: includeScripts
                ? ['error', { includeScripts: true }]
                : 'error',
            },
          })
        );
        for (const pathMode of ['relative', 'absolute', 'symlink'] as const) {
          const run = runOxlint(
            config,
            pathMode === 'relative'
              ? paths
              : paths.map((path) =>
                  join(pathMode === 'symlink' ? alias : directory, path)
                ),
            directory,
            rule
          );
          assert.equal(
            run.numberOfFiles,
            paths.length,
            `${rule}: every staged file must be linted`
          );
          assert.equal(
            run.exitCode,
            1,
            `${rule}: ordinary source must still report`
          );
          for (const diagnostic of run.diagnostics)
            assert.equal(diagnostic.code, `effect-native(${rule})`);
          const reported = [
            ...new Set(
              // Oxlint may retain absolute spellings when input paths cross a symlink.
              run.diagnostics.map((diagnostic) =>
                realpathSync(resolve(directory, diagnostic.filename))
              )
            ),
          ];
          assert.deepEqual(
            reported.sort(),
            (includeScripts ? paths : sources)
              .map((path) => realpathSync(join(directory, path)))
              .toSorted(),
            `${rule}: includeScripts=${includeScripts}, pathMode=${pathMode}`
          );
        }
      }
    });
  });
}
