import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, fixtureConfigPath, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const ruleName = 'no-bare-effect-run';
const ruleCode = `effect-native(${ruleName})`;
const pureEffectType = 'Effect.Effect<void>';
const native = `import { Effect } from 'effect';
export interface PageProps { readonly route: string }
export type Preload = (props: PageProps) => Promise<void>;
const CONCURRENCY = 8;
export const preload = (
  ...steps: readonly ((props: PageProps) => Effect.Effect<void>)[]
): Preload => {
  const preloadAll = (props: PageProps): Effect.Effect<void> =>
    Effect.forEach(steps, (step) => Effect.suspend(() => step(props)).pipe(Effect.ignoreCause), {
      concurrency: CONCURRENCY,
      discard: true,
    });
  return async (props) => {
    await Effect.runPromise(preloadAll(props));
  };
};
`;

it('proves the production Module Federation Promise seam without allowing other bare roots', () => {
  withTemporaryWorkspace((directory) => {
    const source = readFileSync(path.join(appRoot, 'packages/shared-contracts/src/page-data.ts'), 'utf-8').replaceAll(
      /^.*eslint-disable-next-line effect-native\/no-bare-effect-run.*\n/gmu,
      '',
    );
    const cases = [
      { count: 0, name: 'production', source },
      { count: 0, name: 'native', source: native },
      {
        count: 1,
        name: 'foreign-effect',
        source: `${native.replace("'effect'", "'./fake-effect.ts'")}\nimport { runPromise } from "effect/Effect"; runPromise(program);`,
      },
      {
        count: 1,
        name: 'contextful-step',
        source: native.replace(pureEffectType, 'Effect.Effect<void, never, Database>'),
      },
      {
        count: 1,
        name: 'contextful-helper',
        source: native.replace(`): ${pureEffectType} =>`, '): Effect.Effect<void, never, Database> =>'),
      },
      { count: 1, name: 'unbounded', source: native.replace('concurrency: CONCURRENCY', "concurrency: 'unbounded'") },
      { count: 1, name: 'duplicate-discard', source: native.replace('concurrency: CONCURRENCY', 'discard: true') },
      { count: 1, name: 'throwing-steps', source: native.replace('.pipe(Effect.ignoreCause)', '') },
      { count: 1, name: 'eager-step', source: native.replace('Effect.suspend(() => step(props))', 'step(props)') },
      { count: 1, name: 'foreign-batch', source: native.replace('Effect.forEach(', 'foreign.forEach(') },
      {
        count: 1,
        name: 'manual-helper-call',
        source: native.replace('return async (props)', 'preloadAll(extra);\n  return async (props)'),
      },
      {
        count: 1,
        name: 'escaped-helper',
        source: native.replace('return async (props)', 'opaque(preloadAll);\n  return async (props)'),
      },
      {
        count: 1,
        name: 'altered-adapter-input',
        source: native.replace('runPromise(preloadAll(props))', 'runPromise(preloadAll(other))'),
      },
      {
        count: 1,
        name: 'fake-promise-type',
        source: native.replace('export type Preload', 'type Promise<A> = A;\nexport type Preload'),
      },
      { count: 1, name: 'different-runner', source: native.replace('Effect.runPromise(', 'Effect.runPromiseExit(') },
      { count: 1, name: 'extra-root', source: `${native}\nEffect.runPromise(otherProgram);` },
    ];
    const folder = path.join(directory, 'packages/fixture/src');
    mkdirSync(folder, { recursive: true });
    const files = cases.map((entry) => {
      const file = path.join(folder, `${entry.name}.ts`);
      writeFileSync(file, entry.source);
      return file;
    });
    const result = runOxlint(fixtureConfigPath(ruleName), files, appRoot);
    expect(result.numberOfFiles).toBe(cases.length);
    expect(result.diagnostics.filter(({ code }) => code !== ruleCode)).toEqual([]);
    for (const [index, entry] of cases.entries()) {
      const diagnostics = result.diagnostics.filter(({ filename }) => path.resolve(appRoot, filename) === files[index]);
      expect(diagnostics, `${entry.name}: ${JSON.stringify(diagnostics)}`).toHaveLength(entry.count);
    }
  });
});
