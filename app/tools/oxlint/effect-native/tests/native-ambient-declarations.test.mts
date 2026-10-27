import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const applicationRequire = createRequire(path.join(appRoot, 'package.json'));

it('runs native CFG plugins across bare ambient declarations and still reports violations inside module bodies', () => {
  withTemporaryWorkspace((directory) => {
    const config = path.join(directory, 'oxlint.json');
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: 'off' },
        jsPlugins: [
          { name: 'sonarjs', specifier: applicationRequire.resolve('eslint-plugin-sonarjs') },
          { name: 'perfectionist', specifier: applicationRequire.resolve('eslint-plugin-perfectionist') },
        ],
        rules: {
          'perfectionist/sort-interfaces': 'error',
          // This listener-based rule forces the native JS bridge through prepareSteps/traverseNode.
          'sonarjs/no-invariant-returns': 'error',
        },
      }),
    );
    const valid = [
      { file: 'bare-module.d.ts', source: "declare module 'untyped-provider';\n" },
      { file: 'wildcard-module.d.ts', source: "declare module '*.worker.mjs';\n" },
      {
        file: 'typed-module.d.ts',
        source: "declare module 'typed-provider' { export interface Options { alpha: string; zebra: string; } }\n",
      },
      {
        file: 'module-body-valid.ts',
        source: 'namespace ValidControl { export function choose(flag: boolean) { if (flag) return 1; return 2; } }\n',
      },
    ];
    for (const fixture of valid) {
      writeFileSync(path.join(directory, fixture.file), fixture.source);
    }
    const invalid = 'module-body-invalid.d.ts';
    writeFileSync(
      path.join(directory, invalid),
      [
        "declare module 'bare-before-control';",
        "declare module '*.asset-before-control';",
        "declare module 'invalid-order-provider' {",
        '  export interface Options { zebra: string; alpha: string; }',
        '}',
        '',
      ].join('\n'),
    );
    const files = [...valid.map((fixture) => fixture.file), invalid];
    const negative = runOxlint(config, files, directory);
    expect(negative.numberOfFiles).toBe(files.length);
    expect(negative.exitCode).toBe(1);
    expect(negative.diagnostics.map(({ code, filename }) => ({ code, filename }))).toEqual([
      { code: 'perfectionist(sort-interfaces)', filename: invalid },
    ]);
    writeFileSync(
      path.join(directory, invalid),
      [
        "declare module 'bare-before-control';",
        "declare module '*.asset-before-control';",
        "declare module 'invalid-order-provider' {",
        '  export interface Options { alpha: string; zebra: string; }',
        '}',
        '',
      ].join('\n'),
    );
    const positive = runOxlint(config, files, directory);
    expect(positive.numberOfFiles).toBe(files.length);
    expect(positive.exitCode).toBe(0);
    expect(positive.diagnostics).toEqual([]);
  });
});
