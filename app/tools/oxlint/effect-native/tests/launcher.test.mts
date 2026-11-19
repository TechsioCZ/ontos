import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import nodePath from 'node:path';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

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
    const runner = nodePath.join(directory, 'invoke-launcher.mjs');
    const launcherUrl = new URL('oxlint.mts', import.meta.url).href;
    writeFileSync(
      runner,
      `import { runOxlint } from ${JSON.stringify(launcherUrl)};
const run = runOxlint(${JSON.stringify(config)}, [${JSON.stringify(input)}], ${JSON.stringify(directory)});
process.stdout.write(JSON.stringify(run));
`,
    );
    const child = spawnSync(process.execPath, [runner], {
      cwd: directory,
      encoding: 'utf-8',
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${JSON.stringify(preload)}`].filter(Boolean).join(' '),
      },
      timeout: 120_000,
    });
    if (child.error !== undefined) {
      throw child.error;
    }
    if (child.status !== 0) {
      throw new Error(`Launcher process failed (${child.status}): ${child.stderr}`);
    }
    const run = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({ diagnostics: Schema.Array(Schema.Unknown), exitCode: Schema.Int, numberOfFiles: Schema.Int }),
      ),
    )(child.stdout);
    expect(run.exitCode).toBe(0);
    expect(run.numberOfFiles).toBe(1);
    expect(run.diagnostics).toEqual([]);
    const launches = readFileSync(trace, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(line));
    const lintLaunches = launches.filter((argv) => argv.includes('oxlint'));
    expect(lintLaunches).toHaveLength(1);
    const [args] = lintLaunches;
    expect(args?.[0]).toBe(process.execPath);
    expect(args?.slice(1, 4)).toEqual([
      nodePath.join(
        nodePath.dirname(createRequire(import.meta.url).resolve('@effect/tsgo/package.json')),
        'dist/effect-tsgo.cjs',
      ),
      '--tsrs-lint',
      'oxlint',
    ]);
    expect(args?.includes(input)).toBe(true);
    expect(args?.includes(config)).toBe(true);
  });
});
