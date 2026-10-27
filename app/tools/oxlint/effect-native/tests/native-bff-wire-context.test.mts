import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, fixtureConfigPath, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const ruleName = 'no-threaded-correlation-parameter';
const ruleCode = `effect-native(${ruleName})`;
const moduleName = "'@modern-js/bff-effect/effect-client'";
const source = `import { Effect } from '@modern-js/bff-effect/effect-client';
import type { EffectHttpApiClientOptions as NativeOptions } from '@modern-js/bff-effect/effect-client';
export interface WireContext { readonly traceparent?: string }
export interface Config { readonly requestContext?: WireContext }
export const makeOptions = ({ requestContext }: Config): Effect.Effect<NativeOptions> => {
  const { ...callerContext } = requestContext ?? {};
  return Effect.succeed(undefined).pipe(Effect.map(() => {
    const options: NativeOptions = {};
    if (requestContext !== undefined) options.requestContext = callerContext;
    return options;
  }));
};
`;

it('proves published native BFF wire context while retaining internal correlation controls', () => {
  withTemporaryWorkspace((directory) => {
    const production = readFileSync(
      path.join(appRoot, 'packages/shared-contracts/src/client-runtime.ts'),
      'utf-8',
    ).replaceAll(/^.*eslint-disable-next-line effect-native\/no-threaded-correlation-parameter.*\n/gmu, '');
    const cases = [
      { count: 0, name: 'production', source: production },
      { count: 0, name: 'native', source },
      { count: 1, name: 'foreign-options', source: source.replaceAll(moduleName, "'./fake-bff.ts'") },
      {
        count: 1,
        name: 'fabricated-options',
        source: source.replace(
          'import type { EffectHttpApiClientOptions as NativeOptions } from',
          'import type { OtherOptions as NativeOptions } from',
        ),
      },
      { count: 1, name: 'wrong-sink', source: source.replace('options.requestContext =', 'options.internalContext =') },
      { count: 1, name: 'wrong-source', source: source.replace('requestContext ?? {}', 'otherContext ?? {}') },
      {
        count: 1,
        name: 'wrong-input-type',
        source: source.replace('readonly requestContext?: WireContext', 'readonly unrelated?: WireContext'),
      },
      {
        count: 1,
        name: 'non-native-result',
        source: source.replace('Effect.Effect<NativeOptions>', 'Effect.Effect<OtherOptions>'),
      },
      {
        count: 1,
        name: 'mutable-wire',
        source: source.replace('const { ...callerContext }', 'let { ...callerContext }'),
      },
      {
        count: 1,
        name: 'escaped-wire',
        source: source.replace('return options;', 'opaque(callerContext); return options;'),
      },
      { count: 1, name: 'correlation-id', source: source.replace('traceparent?', 'correlationId?') },
      { count: 1, name: 'non-wire-required', source: source.replace('traceparent?', 'traceparent') },
      {
        count: 1,
        name: 'internal-operation',
        source: `${source}\nexport const operation = (traceparent: string) => perform(traceparent);`,
      },
    ];
    const folder = path.join(directory, 'packages/fixture/src');
    mkdirSync(folder, { recursive: true });
    const files = cases.map((entry) => {
      const filename = path.join(folder, `${entry.name}.ts`);
      writeFileSync(filename, entry.source);
      return filename;
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
