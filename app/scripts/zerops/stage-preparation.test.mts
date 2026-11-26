import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';
import { parse } from 'yaml';

import { collectToolingProcess } from '../tests/tooling-process-fixture.mts';

const workflow = path.resolve(import.meta.dirname, '../../../.github/workflows/zerops-stage.yml');
const Workflow = Schema.Struct({
  jobs: Schema.Struct({
    plan: Schema.Struct({
      steps: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          run: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  }),
});

for (const status of [0, 23]) {
  it.effect(`overlaps history with setup and joins its complete result (reader exit ${status})`, () =>
    Effect.gen(function* concurrentHistory() {
      const fs = yield* FileSystem.FileSystem;
      const { steps } = Schema.decodeUnknownSync(Workflow)(parse(yield* fs.readFileString(workflow))).jobs.plan;
      const start = steps.findIndex((step) => step.name === 'Start reading mutations since the shared verified base');
      const install = steps.findIndex((step) => step.name === 'Install the planner and identity tooling');
      const finish = steps.findIndex((step) => step.name === 'Finish reading the delivery mutations');
      const plan = steps.findIndex((step) => step.name === 'Plan from the last verified run, never HEAD parent');
      expect(start).toBeGreaterThan(steps.findIndex((step) => step.name.includes('Refuse a superseded')));
      expect(install).toBeGreaterThan(start);
      expect(finish).toBeGreaterThan(install);
      expect(plan).toBeGreaterThan(finish);
      const begin = steps[start]?.run;
      const end = steps[finish]?.run;
      if (begin === undefined || end === undefined) {
        expect.fail('Missing history preparation scripts');
      }
      const root = yield* fs.makeTempDirectoryScoped();
      const app = path.join(root, 'app');
      const scripts = path.join(app, 'scripts/zerops');
      yield* fs.makeDirectory(scripts, { recursive: true });
      yield* fs.makeDirectory(path.join(root, 'zerops-delivery'));
      yield* fs.writeFileString(path.join(root, 'zerops-delivery/history.json'), '{}');
      // The remote history request needs no installed dependencies. It cannot finish until the fixture's
      // toolchain preparation runs, so starting it synchronously loses the complete result.
      yield* fs.writeFileString(
        path.join(scripts, 'read-delivery-history.sh'),
        `#!/usr/bin/env bash
set -euo pipefail
for ((attempt=0; attempt<200; attempt++)); do
  if [ -f "$RUNNER_TEMP/toolchain.ready" ]; then break; fi
  sleep 0.01
done
test -f "$RUNNER_TEMP/toolchain.ready"
echo history-diagnostic >&2
printf '{"runs":[],"mutations":[],"comparison":null}\\n'
exit ${status}
`,
      );
      const execute = (script: string, cwd: string) =>
        collectToolingProcess(
          ChildProcess.make('bash', ['-e', '-u', '-o', 'pipefail', '-c', script], {
            cwd,
            env: { RUNNER_TEMP: root },
            extendEnv: true,
          }),
        );
      const started = yield* execute(begin, app);
      expect(started.status, started.stderr).toBe(0);
      expect(started.stdout).toBe('');
      yield* fs.writeFileString(path.join(root, 'toolchain.ready'), 'prepared');
      const joined = yield* execute(end, root);
      expect(joined.status).toBe(status === 0 ? 0 : 1);
      expect(joined.stdout).toContain('history-diagnostic');
      expect(yield* fs.readFileString(path.join(root, 'zerops-delivery/history.status'))).toBe(`${status}\n`);
      if (status === 0) {
        expect(yield* fs.readFileString(path.join(root, 'zerops-delivery/history.json'))).toBe(
          '{"runs":[],"mutations":[],"comparison":null}\n',
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
