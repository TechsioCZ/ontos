import { expect, it, rstest } from 'effect-rstest';
import { Schema } from 'effect';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import nodePath from 'node:path';
import { createRequire } from 'node:module';

import { appRoot, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const decodePackageScripts = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) })),
);

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
        nodePath.join(
          nodePath.dirname(createRequire(import.meta.url).resolve('oxlint/package.json')),
          'bin/oxlint',
        ),
      );
      expect(args[1].includes(input)).toBe(true);
      expect(args[1].includes(config)).toBe(true);
    } finally {
      spawn.mockClear();
    }
  });
});

it('lint and lint:fix cover the same directories without changing reporting-only commands', () => {
  const { scripts } = decodePackageScripts(
    readFileSync(nodePath.join(appRoot, 'package.json'), 'utf-8'),
  );
  expect(scripts.lint).toBeDefined();
  expect(scripts['lint:fix']).toBeDefined();
  const lint = (scripts.lint ?? '').split(/\s+/u);
  const fix = (scripts['lint:fix'] ?? '').split(/\s+/u);
  expect(fix.filter((argument) => argument !== '--fix')).toEqual(lint);
  expect(fix.filter((argument) => argument === '--fix').length).toBe(1);
  expect(lint.includes('scripts')).toBe(true);
  for (const name of ['lint', 'lint:effect', 'test:lint-rules', 'check']) {
    expect(!(scripts[name] ?? '').includes('--fix'), `${name} must remain reporting-only`).toBe(
      true,
    );
  }
});
