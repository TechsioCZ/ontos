import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { maskText } from '../shared/scaffold-text.ts';
import { runOxlint, testsDirectory } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const supplementaryCharacter = '\u{1F600}';

test('scaffold masking preserves UTF-16 offsets and line endings', () => {
  const source = `/* ${supplementaryCharacter}\r\n */ const label="${supplementaryCharacter.repeat(20)}"; process.env.X`;
  for (const strings of [false, true]) {
    const masked = maskText(source, strings);
    assert.equal(masked.length, source.length);
    assert.equal(masked.indexOf('\r\n'), source.indexOf('\r\n'));
    assert.equal(
      masked.indexOf('process.env.X'),
      source.indexOf('process.env.X')
    );
    assert.equal(masked.includes(supplementaryCharacter), !strings);
  }
});

test('manual configuration rule detects access after supplementary Unicode but ignores quoted data', () => {
  withTemporaryWorkspace((directory) => {
    const scaffoldDirectory = join(directory, 'scripts/scaffolding');
    mkdirSync(scaffoldDirectory, { recursive: true });
    const positive = 'scripts/scaffolding/unicode-positive.mts';
    const negative = 'scripts/scaffolding/unicode-negative.mts';
    const prefix = `const label="${supplementaryCharacter.repeat(20)}"; `;
    writeFileSync(
      join(directory, positive),
      `export const source = \`${prefix}process.env.X${' '.repeat(30)}\`;`
    );
    writeFileSync(
      join(directory, negative),
      `export const source = \`${prefix}const example = "process.env.X";\`;`
    );
    const config = join(directory, '.oxlintrc.json');
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
    assert.equal(result.numberOfFiles, 2);
    assert.equal(result.exitCode, 1);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(
      result.diagnostics[0]?.code,
      'effect-native(no-manual-config-in-scaffold-templates)'
    );
    assert.equal(
      result.diagnostics[0]?.filename.replaceAll('\\', '/'),
      positive
    );
  });
});
