import { fileURLToPath } from 'node:url';

import { Effect, Schema } from 'effect';
import { expect } from 'effect-rstest';
import { ChildProcess } from 'effect/unstable/process';

import { collectToolingProcess } from './tooling-process-fixture.mts';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const ModernConfigCommandSchema = Schema.Literals(['build', 'dev']);
type ModernConfigCommand = typeof ModernConfigCommandSchema.Type;

const ModernConfigEvidenceSchema = Schema.Record(
  Schema.String,
  Schema.Struct({
    disableTsChecker: Schema.Boolean,
    port: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1 }))),
  }),
);

// Use Modern's public loader, including TS/JSON resolution and function-valued configs.
const probe = `
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const modernRequire = createRequire(import.meta.resolve('@modern-js/app-tools'));
const { createLoadedConfig } = await import(pathToFileURL(modernRequire.resolve('@modern-js/plugin/run')).href);
const workspaceRoot = process.cwd();
const result = {};
for (const config of JSON.parse(process.argv[1])) {
  const configFile = path.resolve(workspaceRoot, config);
  process.chdir(path.dirname(configFile));
  const loaded = await createLoadedConfig(path.dirname(configFile), configFile);
  result[config] = {
    disableTsChecker: loaded.config.output?.disableTsChecker ?? false,
    port: loaded.config.server?.port,
  };
}
process.stdout.write(JSON.stringify(result));
`;

export const loadModernConfigEvidence = Effect.fn('Test.loadModernConfigEvidence')(function* loadModernConfigs(
  configs: readonly string[],
  command: ModernConfigCommand,
) {
  const result = yield* collectToolingProcess(
    ChildProcess.make(
      process.execPath,
      ['--no-warnings', '--input-type=module', '--eval', probe, JSON.stringify(configs)],
      {
        cwd: workspaceRoot,
        env: { MODERN_ARGV: `node modern ${command}`, NODE_ENV: command === 'build' ? 'production' : 'development' },
        extendEnv: false,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    ),
  );
  expect(result.status, result.stderr).toBe(0);
  return yield* Schema.decodeEffect(Schema.fromJsonString(ModernConfigEvidenceSchema))(result.stdout);
});
