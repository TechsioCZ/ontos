import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';

import { collectToolingProcess } from './tooling-process-fixture.mts';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));

const modernConfigs = ['apps', 'verticals'].flatMap((group) =>
  readdirSync(path.join(workspaceRoot, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${group}/${entry.name}/modern.config.ts`)
    .filter((config) => readdirSync(path.join(workspaceRoot, path.dirname(config))).includes('modern.config.ts')),
);

// Loads every application config the way `modern build` does and reports the resolved checker switch.
const probe = `
const result = {};
for (const config of JSON.parse(process.argv[1])) {
  const resolved = (await import(new URL(config, 'file://' + process.cwd() + '/').href)).default;
  result[config] = resolved.output?.disableTsChecker ?? false;
}
process.stdout.write(JSON.stringify(result));
`;

const TsCheckerSwitchesSchema = Schema.Record(Schema.String, Schema.Boolean);

const resolveTsCheckerSwitches = Effect.fn(function* resolveTsCheckerSwitches(nodeEnvironment: string) {
  const result = yield* collectToolingProcess(
    ChildProcess.make(
      process.execPath,
      ['--no-warnings', '--input-type=module', '--eval', probe, JSON.stringify(modernConfigs)],
      {
        cwd: workspaceRoot,
        env: { NODE_ENV: nodeEnvironment },
        extendEnv: true,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    ),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
  expect(result.status, result.stderr).toBe(0);
  const switches = Schema.decodeUnknownSync(Schema.fromJsonString(TsCheckerSwitchesSchema))(result.stdout);
  expect(new Set(Object.keys(switches))).toEqual(new Set(modernConfigs));
  return switches;
});

it.live(
  'every application build keeps the published workspace preset TypeScript checker',
  Effect.fn(function* testEffect() {
    expect(modernConfigs.length).toBeGreaterThan(0);
    const switches = yield* resolveTsCheckerSwitches('production');
    for (const [config, disabled] of Object.entries(switches)) {
      expect(disabled, `${config} must keep output.disableTsChecker: false`).toBe(false);
    }
  }),
);

// `modern dev` must not block its first compile on a whole-graph TS-Go check; `pnpm typecheck` owns it there.
it.live(
  'every application dev server leaves type diagnostics to pnpm typecheck',
  Effect.fn(function* testEffect() {
    const switches = yield* resolveTsCheckerSwitches('development');
    for (const [config, disabled] of Object.entries(switches)) {
      expect(disabled, `${config} must set output.disableTsChecker in modern dev`).toBe(true);
    }
  }),
);
