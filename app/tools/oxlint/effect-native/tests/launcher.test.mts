import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import nodePath from 'node:path';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { appRoot, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

it('Oxlint launches through the effect-tsgo JavaScript entry point on Node without a platform shim', () => {
  withTemporaryWorkspace((directory) => {
    const config = nodePath.join(directory, 'lint config.json');
    const input = 'source with spaces.ts';
    writeFileSync(config, JSON.stringify({ categories: { correctness: 'off' } }));
    writeFileSync(nodePath.join(directory, input), 'export const value = 1;');
    const trace = nodePath.join(directory, 'node-argv.jsonl');
    const preload = nodePath.join(directory, 'record-argv.mjs');
    writeFileSync(
      preload,
      `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(trace)}, JSON.stringify(process.argv) + '\\n');
`,
    );
    const previousNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = [previousNodeOptions, `--import=${JSON.stringify(preload)}`].filter(Boolean).join(' ');
    try {
      const run = runOxlint(config, [input], directory);
      expect(run.exitCode).toBe(0);
      expect(run.numberOfFiles).toBe(1);
      expect(run.diagnostics).toEqual([]);
      const launches = readFileSync(trace, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(line));
      const args = launches.find((argv) => argv.includes('oxlint'));
      expect(args?.[0]).toBe(process.execPath);
      expect(args?.slice(1, 4)).toEqual([
        nodePath.join(
          nodePath.dirname(createRequire(import.meta.url).resolve('@effect/tsgo/package.json')),
          'dist/effect-tsgo.cjs',
        ),
        '--tsrs-lint=7.1.0-beta.tsrs3',
        'oxlint',
      ]);
      expect(args?.includes(input)).toBe(true);
      expect(args?.includes(config)).toBe(true);
    } finally {
      if (previousNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = previousNodeOptions;
      }
    }
  });
});

it('the production Rust diagnostics command fails on an Effect warning and accepts the corrected source', () => {
  withTemporaryWorkspace((directory) => {
    const project = nodePath.join(directory, 'tsconfig.json');
    const input = nodePath.join(directory, 'probe.ts');
    const base = nodePath.join(appRoot, 'tsconfig.base.json');
    writeFileSync(project, JSON.stringify({ extends: base, files: ['probe.ts'] }));
    const cli = nodePath.join(appRoot, 'scripts/check-effect-diagnostics.mts');
    const check = () =>
      spawnSync(process.execPath, [cli, project], {
        cwd: appRoot,
        encoding: 'utf-8',
      });
    writeFileSync(
      input,
      "// @effect-diagnostics floatingEffect:warning -- Deliberately warn to prove the production exit policy.\nimport { Effect } from 'effect';\nexport const task = () => { Effect.succeed(123); return 123; };\n",
    );
    const invalid = check();
    expect(invalid.error).toBeUndefined();
    expect(invalid.stdout + invalid.stderr).toContain('warning effect(floatingEffect)');
    expect(invalid.status).toBe(1);
    writeFileSync(input, "import { Effect } from 'effect';\nexport const task = () => Effect.succeed(123);\n");
    const valid = check();
    expect(valid.error).toBeUndefined();
    expect(valid.status, valid.stdout + valid.stderr).toBe(0);
  });
});
