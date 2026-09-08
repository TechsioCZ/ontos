import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { appRoot, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

test('Oxlint launches its JavaScript entry point through Node without a platform shim', () => {
  withTemporaryWorkspace((directory) => {
    const config = join(directory, 'lint config.json');
    const input = 'source with spaces.ts';
    writeFileSync(config, JSON.stringify({ categories: { correctness: 'off' } }));
    writeFileSync(join(directory, input), 'export const value = 1;');
    const spawn = mock.method(childProcess, 'spawnSync');
    syncBuiltinESMExports();
    try {
      const run = runOxlint(config, [input], directory);
      assert.equal(run.exitCode, 0);
      assert.equal(run.numberOfFiles, 1);
      assert.deepEqual(run.diagnostics, []);
      assert.equal(spawn.mock.callCount(), 1);
      const args: readonly unknown[] = spawn.mock.calls[0]!.arguments;
      assert.equal(args[0], process.execPath);
      assert.ok(Array.isArray(args[1]));
      assert.equal(
        args[1][0],
        fileURLToPath(new URL('bin/oxlint', import.meta.resolve('oxlint/package.json'))),
      );
      assert.ok(args[1].includes(input));
      assert.ok(args[1].includes(config));
    } finally {
      spawn.mock.restore();
      syncBuiltinESMExports();
    }
  });
});

test('lint and lint:fix cover the same directories without changing reporting-only commands', () => {
  const { scripts } = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const lint = scripts['lint']!.split(/\s+/u);
  const fix = scripts['lint:fix']!.split(/\s+/u);
  assert.deepEqual(
    fix.filter((argument) => argument !== '--fix'),
    lint,
  );
  assert.equal(fix.filter((argument) => argument === '--fix').length, 1);
  assert.ok(lint.includes('scripts'));
  for (const name of ['lint', 'lint:effect', 'test:lint-rules', 'check']) {
    assert.ok(!scripts[name]!.includes('--fix'), `${name} must remain reporting-only`);
  }
});
