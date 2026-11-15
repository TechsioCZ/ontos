import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';
import { parse } from 'yaml';

import { DeliveryPlanSchema } from '../zerops/delivery-plan.mts';
import { collectToolingProcess } from './tooling-process-fixture.mts';

const Step = Schema.Struct({
  if: Schema.optionalKey(Schema.String),
  name: Schema.String,
  run: Schema.optionalKey(Schema.String),
  uses: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const Workflow = Schema.Struct({ jobs: Schema.Struct({ plan: Schema.Struct({ steps: Schema.Array(Step) }) }) });
const app = path.resolve(import.meta.dirname, '../..');
const readSteps = Effect.gen(function* readPlannerSteps() {
  const fs = yield* FileSystem.FileSystem;
  return (yield* Schema.decodeUnknownEffect(Workflow)(
    parse(yield* fs.readFileString(path.join(app, '../.github/workflows/zerops-stage.yml'))),
  )).jobs.plan.steps;
});

for (const hit of [true, false]) {
  it.effect(`executes the exact frozen planner setup under Bash on cache ${hit ? 'hit' : 'miss'}`, () =>
    Effect.gen(function* executePlannerSetup() {
      const fs = yield* FileSystem.FileSystem;
      const steps = yield* readSteps;
      const directory = yield* fs.makeTempDirectoryScoped();
      const calls = path.join(directory, 'calls');
      for (const name of ['mise', 'git']) {
        const executable = path.join(directory, name);
        yield* fs.writeFileString(
          executable,
          '#!/usr/bin/env bash\nset -euo pipefail\nprintf "%s\\n" "$*" >>"$CALLS"\n',
        );
        yield* fs.chmod(executable, 0o700);
      }
      const restore = steps.find(({ name }) => name === 'Restore the frozen planner dependencies');
      expect(restore?.with?.path).toBe('app/node_modules');
      expect(restore?.with?.key).toBe(
        `zerops-planner-modules-v1-\${{ runner.os }}-\${{ runner.arch }}-\${{ hashFiles('app/pnpm-lock.yaml', 'app/.mise.toml', 'app/package.json', 'app/pnpm-workspace.yaml', 'app/patches/**') }}`,
      );
      expect(restore?.with?.['restore-keys']).toBeUndefined();
      const save = steps.find(({ name }) => name === 'Save the frozen planner dependencies');
      expect(save?.with?.key).toBe(`\${{ steps.planner-dependencies.outputs.cache-primary-key }}`);
      expect(save?.if).toBe("steps.planner-dependencies.outputs.cache-hit != 'true'");
      const install = steps.find(({ name }) => name === 'Install the planner dependencies');
      expect(install?.if).toBe(save?.if);
      const scripts = steps.filter(
        ({ name }) =>
          name === 'Install the planner dependencies' ||
          name === "Fetch only the planned revision's complete ancestry" ||
          name === 'Plan from the last verified release, never HEAD parent',
      );
      expect(scripts).toHaveLength(3);
      for (const step of scripts) {
        expect(step.run).toBeDefined();
        const command = step.run ?? '';
        const options = {
          cwd: app,
          env: {
            CALLS: calls,
            GITHUB_SHA: 'planned-head',
            PATH: `${directory}:${yield* Config.String('PATH')}`,
            RUNNER_TEMP: directory,
          },
          extendEnv: true,
        };
        expect((yield* collectToolingProcess(ChildProcess.make('bash', ['-n', '-c', command], options))).status).toBe(
          0,
        );
        if (step.if !== undefined && hit) {
          continue;
        }
        const result = yield* collectToolingProcess(
          ChildProcess.make('bash', ['-e', '-u', '-o', 'pipefail', '-c', command], options),
        );
        expect(result.status, `${step.name}: ${result.stderr}`).toBe(0);
      }
      const recorded = yield* fs.readFileString(calls);
      expect(recorded).toContain('fetch --no-tags --unshallow origin planned-head');
      expect(recorded.includes('install --frozen-lockfile --trust-lockfile --filter app')).toBe(!hit);
      expect(recorded).toContain('exec -- node scripts/zerops/delivery-plan-cli.mts plan ');
      expect(recorded).not.toContain('pnpm exec');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect('executes the real planner with an unreachable verified base and retains the full-release fallback', () =>
  Effect.gen(function* unreachablePlannerBase() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const head = (yield* collectToolingProcess(
      ChildProcess.make('git', ['rev-parse', 'HEAD'], { cwd: app }),
    )).stdout.trim();
    const missing = 'a'.repeat(40);
    const attempt = { runAttempt: 1, runId: 11, sourceRevision: missing };
    yield* fs.makeDirectory(path.join(directory, 'last-success'));
    yield* fs.makeDirectory(path.join(directory, 'last-attempt'));
    yield* fs.writeFileString(path.join(directory, 'last-attempt/attempt.json'), JSON.stringify(attempt));
    yield* fs.writeFileString(
      path.join(directory, 'last-success/receipt.json'),
      JSON.stringify({
        lastAttempt: attempt,
        runAttempt: 1,
        runId: 11,
        schemaVersion: 1,
        services: { app: missing, n1: missing, shop: missing, storefront: missing },
        validatedHead: missing,
      }),
    );
    yield* fs.writeFileString(
      path.join(directory, 'prior-runs.json'),
      JSON.stringify({
        workflow_runs: [
          {
            conclusion: 'success',
            head_branch: 'demo/sales-crm',
            head_sha: missing,
            id: 11,
            path: '.github/workflows/zerops-stage.yml',
            run_attempt: 1,
            run_number: 3,
            status: 'completed',
          },
        ],
      }),
    );
    const result = yield* collectToolingProcess(
      ChildProcess.make('node', ['scripts/zerops/delivery-plan-cli.mts', 'plan', directory], {
        cwd: app,
        env: {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_OUTPUT: path.join(directory, 'outputs'),
          GITHUB_RUN_ATTEMPT: '1',
          GITHUB_RUN_ID: '12',
          GITHUB_RUN_NUMBER: '4',
          GITHUB_SHA: head,
        },
        extendEnv: true,
      }),
    );
    expect(result.status, result.stderr).toBe(0);
    const plan = yield* Schema.decodeEffect(Schema.fromJsonString(DeliveryPlanSchema))(
      yield* fs.readFileString(path.join(directory, 'plan.json')),
    );
    // A valid prior receipt selected this missing base; this is not merely the missing-receipt fallback.
    expect(plan.base).toBe(missing);
    expect(plan.full).toBe(true);
    const output = yield* fs.readFileString(path.join(directory, 'outputs'));
    for (const service of ['app', 'storefront', 'shop', 'n1', 'full']) {
      expect(output).toContain(`${service}=true\n`);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
