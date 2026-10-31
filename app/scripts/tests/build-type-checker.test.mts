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

// Loads every application config the way `modern build` does and reports its resolved output policy.
// Autoprefixer starts from the preset's ['defaults']; an object config merges into it like Modern's
// config merge, so only a replacing function yields the app's own CSS targets.
const probe = `
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const appToolsRequire = createRequire(require.resolve('@modern-js/app-tools'));
const pluginRequire = createRequire(appToolsRequire.resolve('@modern-js/plugin'));
const { createJiti } = pluginRequire('jiti');
const jiti = createJiti(import.meta.url, { fsCache: false, requireCache: false, interopDefault: true });
const result = {};
for (const config of JSON.parse(process.argv[1])) {
  const loaded = await jiti.import(path.resolve(config));
  const resolved = loaded.default ?? loaded;
  let autoprefixer = { overrideBrowserslist: ['defaults'] };
  for (const configure of [resolved.tools?.autoprefixer].flat()) {
    if (typeof configure === 'function') {
      autoprefixer = configure(autoprefixer) ?? autoprefixer;
    } else if (configure) {
      autoprefixer = {
        ...autoprefixer,
        ...configure,
        overrideBrowserslist: [...autoprefixer.overrideBrowserslist, ...(configure.overrideBrowserslist ?? [])],
      };
    }
  }
  result[config] = {
    autoprefixerBrowserslist: autoprefixer.overrideBrowserslist ?? [],
    disableTsChecker: resolved.output?.disableTsChecker ?? false,
    overrideBrowserslist: resolved.output?.overrideBrowserslist ?? [],
  };
}
process.stdout.write(JSON.stringify(result));
`;

const BuildOutputsSchema = Schema.Record(
  Schema.String,
  Schema.Struct({
    autoprefixerBrowserslist: Schema.Array(Schema.String),
    disableTsChecker: Schema.Boolean,
    overrideBrowserslist: Schema.Array(Schema.String),
  }),
);

const resolveBuildOutputs = Effect.fn(function* resolveBuildOutputs(environment: Readonly<Record<string, string>>) {
  const result = yield* collectToolingProcess(
    ChildProcess.make(
      process.execPath,
      ['--no-warnings', '--input-type=module', '--eval', probe, JSON.stringify(modernConfigs)],
      {
        cwd: workspaceRoot,
        env: { ULTRAMODERN_DISABLE_BUILD_TS_CHECKER: '', ...environment },
        extendEnv: true,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    ),
  ).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
  expect(result.status, result.stderr).toBe(0);
  const outputs = Schema.decodeUnknownSync(Schema.fromJsonString(BuildOutputsSchema))(result.stdout);
  expect(new Set(Object.keys(outputs))).toEqual(new Set(modernConfigs));
  return outputs;
});

// Every app gets the one shared browser policy, for JavaScript and CSS alike. The versions live in
// createWorkspaceModernConfig and FRONTEND.md, not here.
const expectSharedBrowserTargets = (outputs: typeof BuildOutputsSchema.Type) => {
  const policies = new Set(Object.values(outputs).map(({ overrideBrowserslist }) => overrideBrowserslist.join(',')));
  expect([...policies]).toHaveLength(1);
  for (const [config, output] of Object.entries(outputs)) {
    expect(output.overrideBrowserslist.length, `${config} must set browser targets`).toBeGreaterThan(0);
    expect(output.autoprefixerBrowserslist, `${config} must give CSS the same browser targets`).toEqual(
      output.overrideBrowserslist,
    );
  }
};

it.live(
  'every application build uses the browser baseline and keeps the published workspace preset TypeScript checker',
  Effect.fn(function* testEffect() {
    expect(modernConfigs.length).toBeGreaterThan(0);
    const outputs = yield* resolveBuildOutputs({ NODE_ENV: 'production' });
    expectSharedBrowserTargets(outputs);
    for (const [config, output] of Object.entries(outputs)) {
      expect(output.disableTsChecker, `${config} must keep output.disableTsChecker: false`).toBe(false);
    }
  }),
);

// `modern dev` must not block its first compile on a whole-graph TS-Go check; `pnpm typecheck` owns it there.
it.live(
  'every application dev server uses the browser baseline and leaves type diagnostics to pnpm typecheck',
  Effect.fn(function* testEffect() {
    const outputs = yield* resolveBuildOutputs({ NODE_ENV: 'development' });
    expectSharedBrowserTargets(outputs);
    for (const [config, output] of Object.entries(outputs)) {
      expect(output.disableTsChecker, `${config} must set output.disableTsChecker in modern dev`).toBe(true);
    }
  }),
);

// The unit build runs its own TS-Go reference build first, which
// fails on a transitive type error (typecheck-project-references.test.mts), so its bundler skips the second check.
it.live(
  'every application build skips the bundler checker after the unit TS-Go reference build',
  Effect.fn(function* testEffect() {
    const outputs = yield* resolveBuildOutputs({
      NODE_ENV: 'production',
      ULTRAMODERN_DISABLE_BUILD_TS_CHECKER: '1',
    });
    for (const [config, output] of Object.entries(outputs)) {
      expect(output.disableTsChecker, `${config} must honor ULTRAMODERN_DISABLE_BUILD_TS_CHECKER=1`).toBe(true);
    }
  }),
);
