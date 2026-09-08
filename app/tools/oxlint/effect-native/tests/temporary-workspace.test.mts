import { expect, it } from '@app/effect-rstest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const callerOwned = 'caller-owned';

it('process termination cleans workspaces and preserves caller-owned roots', () => {
  withTemporaryWorkspace((root) => {
    writeFileSync(nodePath.join(root, callerOwned), 'preserve');
    const helper = new URL('temporary-workspace.mts', import.meta.url).href;
    for (const [termination, status] of [
      ['process.exit(23)', 23],
      ["process.emit('SIGINT')", 130],
      ["process.emit('SIGTERM')", 143],
    ] as const) {
      const script = `import { withTemporaryWorkspace } from ${JSON.stringify(helper)}; withTemporaryWorkspace(() => { ${termination}; });`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf-8',
        env: { ...process.env, EFFECT_NATIVE_TEST_TMPDIR: root },
        timeout: 5000,
      });
      expect(result.error).toBe(undefined);
      expect(result.status, result.stderr).toBe(status);
      expect(result.stderr).toBe('');
      expect(readdirSync(root)).toEqual([callerOwned]);
    }
  });
});

it('temporary workspace is removed after success', () => {
  let created = '';
  expect(
    withTemporaryWorkspace((directory) => {
      created = directory;
      return 42;
    }),
  ).toBe(42);
  expect(existsSync(created)).toBe(false);
});

it('early and partially initialized failures retain their cause and clean owned children', () => {
  withTemporaryWorkspace((root) => {
    writeFileSync(nodePath.join(root, callerOwned), 'preserve');
    const failure = new Error('injected fixture initialization failure');
    for (const partial of [false, true]) {
      expect(() =>
        withTemporaryWorkspace((directory) => {
          if (partial) {
            mkdirSync(nodePath.join(directory, 'partial'));
            writeFileSync(nodePath.join(directory, 'partial', 'file'), 'data');
          }
          throw failure;
        }, root),
      ).toThrow({ asymmetricMatch: (error: Error) => error === failure });
      expect(readdirSync(root)).toEqual([callerOwned]);
    }
  });
});
