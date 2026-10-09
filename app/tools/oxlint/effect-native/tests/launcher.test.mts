import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import nodePath from 'node:path';

import { expect, it, rstest } from 'effect-rstest';

import { runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

rstest.mock('node:child_process', () => {
  const original = process.getBuiltinModule('node:child_process');
  return { ...original, spawnSync: rstest.fn(original.spawnSync) };
});

it('Oxlint launches its JavaScript entry point through Node without a platform shim', () => {
  withTemporaryWorkspace((directory) => {
    const config = nodePath.join(directory, 'lint config.json');
    const input = 'source with spaces.ts';
    writeFileSync(config, JSON.stringify({ categories: { correctness: 'off' } }));
    writeFileSync(nodePath.join(directory, input), 'export const value = 1;');
    const spawn = rstest.mocked(spawnSync);
    spawn.mockClear();
    try {
      const run = runOxlint(config, [input], directory);
      expect(run.exitCode).toBe(0);
      expect(run.numberOfFiles).toBe(1);
      expect(run.diagnostics).toEqual([]);
      expect(spawn.mock.calls.length).toBe(1);
      const args: readonly unknown[] = spawn.mock.calls[0];
      expect(args[0]).toBe(process.execPath);
      expect(Array.isArray(args[1])).toBe(true);
      if (!Array.isArray(args[1])) {
        throw new TypeError('Expected spawn arguments array');
      }
      expect(args[1][0]).toBe(
        nodePath.join(nodePath.dirname(createRequire(import.meta.url).resolve('oxlint/package.json')), 'bin/oxlint'),
      );
      expect(args[1].includes(input)).toBe(true);
      expect(args[1].includes(config)).toBe(true);
    } finally {
      spawn.mockClear();
    }
  });
});
