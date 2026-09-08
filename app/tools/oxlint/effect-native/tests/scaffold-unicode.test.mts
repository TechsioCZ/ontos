import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import { maskText } from '../shared/scaffold-text.ts';
import { runOxlint, testsDirectory } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const supplementaryCharacter = '\u{1F600}';

it('scaffold masking preserves UTF-16 offsets and line endings', () => {
  const source = `/* ${supplementaryCharacter}\r\n */ const label="${supplementaryCharacter.repeat(20)}"; process.env.X`;
  for (const strings of [false, true]) {
    const masked = maskText(source, strings);
    expect(masked.length).toBe(source.length);
    expect(masked.indexOf('\r\n')).toBe(source.indexOf('\r\n'));
    expect(masked.indexOf('process.env.X')).toBe(
      source.indexOf('process.env.X')
    );
    expect(masked.includes(supplementaryCharacter)).toBe(!strings);
  }
});

it('manual configuration rule detects access after supplementary Unicode but ignores quoted data', () => {
  withTemporaryWorkspace((directory) => {
    const scaffoldDirectory = path.join(directory, 'scripts/scaffolding');
    mkdirSync(scaffoldDirectory, { recursive: true });
    const positive = 'scripts/scaffolding/unicode-positive.mts';
    const negative = 'scripts/scaffolding/unicode-negative.mts';
    const prefix = `const label="${supplementaryCharacter.repeat(20)}"; `;
    writeFileSync(
      path.join(directory, positive),
      `export const source = \`${prefix}process.env.X${' '.repeat(30)}\`;`
    );
    writeFileSync(
      path.join(directory, negative),
      `export const source = \`${prefix}const example = "process.env.X";\`;`
    );
    const config = path.join(directory, '.oxlintrc.json');
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: 'off' },
        jsPlugins: [
          {
            name: 'effect-native',
            specifier: path.join(testsDirectory, 'fixture-plugin.ts'),
          },
        ],
        rules: {
          'effect-native/no-manual-config-in-scaffold-templates': 'error',
        },
      })
    );
    const result = runOxlint(
      config,
      [positive, negative],
      directory,
      'no-manual-config-in-scaffold-templates'
    );
    expect(result.numberOfFiles).toBe(2);
    expect(result.exitCode).toBe(1);
    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0]?.code).toBe(
      'effect-native(no-manual-config-in-scaffold-templates)'
    );
    expect(result.diagnostics[0]?.filename.replaceAll('\\', '/')).toBe(
      positive
    );
  });
});
