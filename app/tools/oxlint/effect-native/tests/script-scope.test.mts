import { describe } from 'effect-rstest';

import { collectCases, effectNativeRule, virtualFile } from './rule-tester.mts';

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
const workspaces = ['apps/shell-super-app', 'verticals/contacts', 'packages/core-runtime'];
const sources = workspaces.map((workspace) => `${workspace}/src/operation.ts`);
const scripts = workspaces.map((workspace) => `${workspace}/scripts/operation.mts`);

// Oxlint reports a relative input under its canonical absolute path, and keeps the spelling of an
// absolute input, including one through a directory symlink. Both spellings are covered.
const spellings = { absolute: 'workspace', symlink: 'workspace-link' } as const;

for (const { rule, source } of cases) {
  describe(`${rule} excludes nested scripts by default and honors includeScripts`, () => {
    for (const includeScripts of [false, true]) {
      const { accept, register, reject } = collectCases(
        effectNativeRule(rule),
        `effect-native/${rule} includeScripts=${includeScripts}`,
        includeScripts ? { options: [{ includeScripts: true }] } : {},
      );
      for (const [pathMode, directory] of Object.entries(spellings)) {
        for (const path of [...sources, ...scripts]) {
          const overrides = { filename: virtualFile(`${directory}/${path}`), name: `${pathMode} ${path}` };
          if (includeScripts || sources.includes(path)) {
            reject(1, source, overrides);
          } else {
            accept(source, overrides);
          }
        }
      }
      register();
    }
  });
}
