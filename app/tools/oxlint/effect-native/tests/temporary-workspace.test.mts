import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

test('process termination cleans workspaces and preserves caller-owned roots', () => {
  withTemporaryWorkspace((root) => {
    writeFileSync(join(root, 'caller-owned'), 'preserve');
    const helper = new URL('./temporary-workspace.mts', import.meta.url).href;
    for (const [termination, status] of [
      ['process.exit(23)', 23],
      ["process.emit('SIGINT')", 130],
      ["process.emit('SIGTERM')", 143],
    ] as const) {
      const script = `import { withTemporaryWorkspace } from ${JSON.stringify(helper)}; withTemporaryWorkspace(() => { ${termination}; });`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        env: { ...process.env, EFFECT_NATIVE_TEST_TMPDIR: root },
        timeout: 5000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, status, result.stderr);
      assert.equal(result.stderr, '');
      assert.deepEqual(readdirSync(root), ['caller-owned']);
    }
  });
});

test('temporary workspace is removed after success', () => {
  let created = '';
  assert.equal(
    withTemporaryWorkspace((directory) => {
      created = directory;
      return 42;
    }),
    42,
  );
  assert.equal(existsSync(created), false);
});

test('early and partially initialized failures retain their cause and clean owned children', () => {
  withTemporaryWorkspace((root) => {
    writeFileSync(join(root, 'caller-owned'), 'preserve');
    const failure = new Error('injected fixture initialization failure');
    for (const partial of [false, true]) {
      assert.throws(
        () =>
          withTemporaryWorkspace((directory) => {
            if (partial) {
              mkdirSync(join(directory, 'partial'));
              writeFileSync(join(directory, 'partial', 'file'), 'data');
            }
            throw failure;
          }, root),
        (error) => error === failure,
      );
      assert.deepEqual(readdirSync(root), ['caller-owned']);
    }
  });
});
