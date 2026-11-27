import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';
import { parse } from 'yaml';

import { DeliveryPlanSchema, MUTATION_MARKER } from '../zerops/delivery-plan.mts';
import type { Comparison, RunMutation } from '../zerops/delivery-plan.mts';
import { collectToolingProcess } from './tooling-process-fixture.mts';

const app = path.resolve(import.meta.dirname, '../..');
const HISTORY = 'scripts/zerops/read-delivery-history.sh';
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const WORKFLOW = '.github/workflows/zerops-stage.yml';
const run = (id: number, number: number, conclusion: string | null, status = 'completed') => ({
  conclusion,
  event: 'push',
  head_branch: 'demo/sales-crm',
  head_repository: { id: 1 },
  head_sha: id === 10 ? BASE : 'c'.repeat(40),
  id,
  path: WORKFLOW,
  repository: { id: 1 },
  run_attempt: 1,
  run_number: number,
  status,
});
const jobs = (markerConclusion: string | null) => ({
  jobs: [
    {
      id: 1,
      steps: [
        { conclusion: 'success', name: 'Checkout', status: 'completed' },
        ...(markerConclusion === null
          ? []
          : [{ conclusion: markerConclusion, name: MUTATION_MARKER, status: 'completed' }]),
      ],
    },
  ],
  total_count: 1,
});

/**
 * A `gh api <path> [--jq <filter>]` that answers from fixture files named by the path; an unknown path fails like an
 * API error. The zip endpoint answers with the fixture zip's bytes.
 */
const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = api ] || exit 9
route="$2"
shift 2
filter='.'
if [ "\${1:-}" = --jq ]; then filter="$2"; fi
name="$(printf '%s' "$route" | tr -c 'A-Za-z0-9' '_')"
if [ -f "$FIXTURES/$name.zip" ]; then cat "$FIXTURES/$name.zip"; exit 0; fi
[ -f "$FIXTURES/$name.json" ] || { echo "no fixture for $route" >&2; exit 1; }
jq -c "$filter" "$FIXTURES/$name.json"
`;
const fixtureName = (route: string) => route.replaceAll(/[^A-Za-z0-9]/gu, '_');

// Hotfix delivery (0fcf2ae30d, 5b13f3af9b): the planning job holds no delivery group, so a newer push plans and
// builds while an older one still delivers; deliveries take turns in deliver_app, which no newer run cancels.
// No job refuses a superseded branch tip. Lint has no cross-run group that can replace a pending shard.
it.effect('plans and builds every push at once, and lets deliveries alone take turns, none cancelled', () =>
  Effect.gen(function* deliveriesTakeTurns() {
    const fs = yield* FileSystem.FileSystem;
    const Concurrency = Schema.Struct({ 'cancel-in-progress': Schema.Boolean, group: Schema.String });
    const workflow = yield* fs.readFileString(path.resolve(app, '..', WORKFLOW)).pipe(
      Effect.flatMap((source) =>
        Schema.decodeUnknownEffect(
          Schema.Struct({
            concurrency: Schema.optionalKey(Concurrency),
            jobs: Schema.Record(
              Schema.String,
              Schema.Struct({
                concurrency: Schema.optionalKey(Concurrency),
                steps: Schema.Array(
                  Schema.Struct({
                    name: Schema.String,
                    run: Schema.optionalKey(Schema.String),
                    uses: Schema.optionalKey(Schema.String),
                  }),
                ),
              }),
            ),
          }),
        )(parse(source)),
      ),
    );
    expect(workflow.concurrency).toBeUndefined();
    expect(workflow.jobs.deliver?.concurrency).toBeUndefined();
    expect(workflow.jobs.deliver_app?.concurrency).toEqual({ 'cancel-in-progress': false, group: 'zerops-stage' });
    expect(workflow.jobs.build?.concurrency?.['cancel-in-progress']).toBe(false);
    expect(workflow.jobs.lint?.concurrency).toBeUndefined();
    expect(workflow.jobs['lint-plan']?.concurrency).toBeUndefined();
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps) {
        expect(step.run ?? '', `${name}: ${step.name}`).not.toContain('ls-remote');
      }
    }
    // Only deliver_app marks an attempt and delivers.
    for (const [name, delivers] of [
      ['deliver', false],
      ['build', false],
      ['deliver_app', true],
    ] as const) {
      const steps = workflow.jobs[name]?.steps ?? [];
      expect(
        steps.some((step) => step.name === MUTATION_MARKER),
        name,
      ).toBe(delivers);
      expect(
        steps.some((step) => step.uses === './.github/actions/deliver-stage'),
        name,
      ).toBe(delivers);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('requires exact-commit lint success only for mutation, including no-service plans', () =>
  Effect.gen(function* lintDeliveryBarrier() {
    const fs = yield* FileSystem.FileSystem;
    const workflow = Schema.decodeUnknownSync(
      Schema.Struct({
        jobs: Schema.Record(
          Schema.String,
          Schema.Struct({
            if: Schema.optionalKey(Schema.String),
            needs: Schema.optionalKey(Schema.Array(Schema.String)),
            steps: Schema.Array(
              Schema.Struct({
                name: Schema.String,
                run: Schema.optionalKey(Schema.String),
                uses: Schema.optionalKey(Schema.String),
              }),
            ),
          }),
        ),
      }),
    )(parse(yield* fs.readFileString(path.resolve(app, '..', WORKFLOW))));
    const delivery = workflow.jobs.deliver_app;
    expect(delivery?.needs).toEqual(['deliver', 'build', 'lint']);
    expect(delivery?.if).toContain("needs.lint.result == 'success'");
    expect(delivery?.if).toContain("needs.deliver.result == 'success'");
    expect(workflow.jobs.build?.needs).toEqual(['deliver']);
    expect(workflow.jobs.deliver?.needs).toBeUndefined();
    expect(workflow.jobs.deliver?.if).toBe("github.ref == 'refs/heads/demo/sales-crm'");
    expect(workflow.jobs['lint-plan']?.needs).toBeUndefined();
    expect(workflow.jobs.lint?.needs).toEqual(['lint-plan']);
    expect(workflow.jobs.lint?.if).toBe("needs.lint-plan.result == 'success'");
    expect(workflow.jobs['lint-plan']?.if).toContain("startsWith(github.ref, 'refs/heads/candidate/')");
    expect(workflow.jobs.lint?.steps.some(({ uses }) => uses === './.github/actions/lint-app')).toBe(true);
    // No plan output can skip lint: a no-service run still fails if lint fails.
    expect(workflow.jobs.lint?.if).not.toContain('outputs.any');
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('feeds the verified snapshot into stage lint selection and retains its Markdown paths', () =>
  Effect.gen(function* verifiedComparisonInput() {
    const fs = yield* FileSystem.FileSystem;
    const workflow = Schema.decodeUnknownSync(
      Schema.Struct({
        jobs: Schema.Struct({
          'lint-plan': Schema.Struct({
            steps: Schema.Array(
              Schema.Struct({
                env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
                run: Schema.optionalKey(Schema.String),
              }),
            ),
          }),
        }),
      }),
    )(parse(yield* fs.readFileString(path.resolve(app, '..', WORKFLOW))));
    const selector = workflow.jobs['lint-plan'].steps.find(
      ({ run: command }) => command === 'bash app/scripts/ci/choose-stage-lint-shards.sh',
    );
    expect(selector?.env).toEqual({
      CHANGED_PATHS: `\${{ runner.temp }}/zerops-delivery/changed-paths`,
      COMPARISON_SNAPSHOT: `\${{ runner.temp }}/zerops-delivery/history.json`,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

/** The API answers, as JSON text by route, and the services of each plan artifact, by its zip route. */
const readHistory = (
  fixtures: Readonly<Record<string, string>>,
  zips: Readonly<Record<string, readonly string[]>> = {},
) =>
  Effect.gen(function* runHistoryReader() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const bin = path.join(directory, 'bin');
    const data = path.join(directory, 'fixtures');
    yield* fs.makeDirectory(bin);
    yield* fs.makeDirectory(data);
    yield* fs.writeFileString(path.join(bin, 'gh'), fakeGh);
    yield* fs.chmod(path.join(bin, 'gh'), 0o700);
    for (const [route, body] of Object.entries(fixtures)) {
      yield* fs.writeFileString(path.join(data, `${fixtureName(route)}.json`), body);
    }
    for (const [route, services] of Object.entries(zips)) {
      const staging = path.join(directory, `zip-${fixtureName(route)}`);
      yield* fs.makeDirectory(staging);
      yield* fs.writeFileString(path.join(staging, 'plan.json'), JSON.stringify({ schemaVersion: 2, services }));
      const zipped = yield* collectToolingProcess(
        ChildProcess.make('zip', ['-q', path.join(data, `${fixtureName(route)}.zip`), 'plan.json'], { cwd: staging }),
      );
      expect(zipped.status, zipped.stderr).toBe(0);
    }
    const result = yield* collectToolingProcess(
      ChildProcess.make(
        'bash',
        [
          '-e',
          '-c',
          `bash ${HISTORY} comparison >"$RUNNER_TEMP/comparison.json"; bash ${HISTORY} complete "$RUNNER_TEMP/comparison.json"`,
        ],
        {
          cwd: app,
          env: {
            FIXTURES: data,
            GITHUB_REPOSITORY: 'owner/repo',
            GITHUB_RUN_NUMBER: '20',
            GITHUB_SHA: HEAD,
            PATH: `${bin}:${yield* Config.String('PATH')}`,
            RUNNER_TEMP: directory,
          },
        },
      ),
    );
    expect(result.status, result.stderr).toBe(0);
    return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(result.stdout);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const RUNS = 'repos/owner/repo/actions/workflows/zerops-stage.yml/runs?branch=demo%2Fsales-crm&per_page=50';
const COMPARE = `repos/owner/repo/compare/${BASE}...${HEAD}?per_page=1`;
const jobsOf = (id: number) => `repos/owner/repo/actions/runs/${String(id)}/jobs?filter=all&per_page=100`;
const artifactsOf = (id: number) => `repos/owner/repo/actions/runs/${String(id)}/artifacts?name=zerops-delivery-plan`;

it.effect('reads the newest green run as the base, every later run that changed stage, and the comparison', () =>
  Effect.gen(function* historyRead() {
    const history = yield* readHistory(
      {
        [artifactsOf(13)]: JSON.stringify({ artifacts: [{ id: 77 }] }),
        [COMPARE]: JSON.stringify({
          files: [
            { filename: 'app/n1-storefront/src/a.ts', status: 'modified' },
            { filename: 'b.ts', previous_filename: 'a.ts', status: 'renamed' },
          ],
          status: 'ahead',
        }),
        [jobsOf(12)]: JSON.stringify(jobs(null)),
        [jobsOf(13)]: JSON.stringify(jobs('success')),
        [RUNS]: JSON.stringify({
          workflow_runs: [
            run(13, 13, 'failure'),
            run(12, 12, 'cancelled'),
            run(10, 10, 'success'),
            run(9, 9, 'failure'),
            { ...run(14, 14, 'success'), head_branch: 'other' },
            // Pull requests that name their branch like the stage branch and run their own copy of this workflow,
            // one from a fork: never a base, never a run that changed stage.
            { ...run(16, 16, 'success'), event: 'pull_request', head_repository: { id: 2 } },
            { ...run(15, 15, 'failure'), event: 'pull_request' },
          ],
        }),
      },
      { 'repos/owner/repo/actions/artifacts/77/zip': ['storefront', 'shop'] },
    );
    // An array matches only with the same length: neither pull request is listed.
    expect(history).toMatchObject({ runs: [13, 12, 10, 9, 14].map((id) => ({ id })) });
    expect(history).toMatchObject({
      comparison: {
        ancestor: true,
        base: BASE,
        changedPaths: ['a.ts', 'app/n1-storefront/src/a.ts', 'b.ts'],
        truncated: false,
      },
      mutations: [
        { mutated: true, runId: 13, services: ['storefront', 'shop'] },
        { mutated: false, runId: 12, services: null },
      ],
    });
  }),
);

it.effect('reads mutation markers beyond 100 jobs and treats incomplete attempts as unknown', () =>
  Effect.gen(function* paginatedMutations() {
    const first = {
      jobs: Array.from({ length: 100 }, (_, id) => ({ id, steps: [] })),
      total_count: 101,
    };
    const second = { jobs: [{ id: 100, steps: jobs('success').jobs[0]?.steps }], total_count: 101 };
    const common = {
      [artifactsOf(13)]: JSON.stringify({ artifacts: [{ id: 77 }] }),
      [COMPARE]: JSON.stringify({ files: [], status: 'identical' }),
      [jobsOf(13)]: JSON.stringify(first),
      [RUNS]: JSON.stringify({ workflow_runs: [run(13, 13, 'failure'), run(10, 10, 'success')] }),
    };
    const history = yield* readHistory(
      { ...common, [`${jobsOf(13)}&page=2`]: JSON.stringify(second) },
      { 'repos/owner/repo/actions/artifacts/77/zip': ['app'] },
    );
    expect(history).toMatchObject({ mutations: [{ mutated: true, runId: 13, services: ['app'] }] });
    const untouched = yield* readHistory({
      ...common,
      [`${jobsOf(13)}&page=2`]: JSON.stringify({ jobs: [{ id: 100, steps: [] }], total_count: 101 }),
    });
    expect(untouched).toMatchObject({ mutations: [{ mutated: false, runId: 13, services: null }] });
    for (const page of [
      null,
      {},
      { jobs: [], total_count: 101 },
      { ...second, total_count: 102 },
      { jobs: [{ id: 100 }], total_count: 101 },
    ]) {
      const partial = yield* readHistory(
        page === null ? common : { ...common, [`${jobsOf(13)}&page=2`]: JSON.stringify(page) },
      );
      expect(partial).toMatchObject({ mutations: [{ mutated: null, runId: 13, services: null }] });
    }
    // Even a marker on the readable page cannot turn an unreadable remainder into a complete answer.
    const incomplete = yield* readHistory({
      ...common,
      [jobsOf(13)]: JSON.stringify({ jobs: jobs('success').jobs, total_count: 101 }),
    });
    expect(incomplete).toMatchObject({ mutations: [{ mutated: null, runId: 13, services: null }] });
    const duplicate = yield* readHistory({
      ...common,
      [`${jobsOf(13)}&page=2`]: JSON.stringify({ jobs: [{ id: 0, steps: [] }], total_count: 101 }),
    });
    expect(duplicate).toMatchObject({ mutations: [{ mutated: null, runId: 13, services: null }] });
  }),
);

it.effect('leaves every part it cannot read empty, so the plan deploys every service', () =>
  Effect.gen(function* unreadableHistory() {
    expect(yield* readHistory({})).toEqual({ comparison: null, mutations: [], runs: null });
    const partial = yield* readHistory({
      [COMPARE]: JSON.stringify({
        files: Array.from({ length: 300 }, (_, index) => ({ filename: `f${String(index)}`, status: 'added' })),
        status: 'ahead',
      }),
      [jobsOf(13)]: JSON.stringify(jobs('success')),
      [RUNS]: JSON.stringify({ workflow_runs: [run(13, 13, 'failure'), run(10, 10, 'success')] }),
    });
    expect(partial).toMatchObject({
      comparison: { truncated: true },
      mutations: [{ mutated: true, runId: 13, services: null }],
    });
    const diverged = yield* readHistory({
      [COMPARE]: JSON.stringify({ files: [], status: 'diverged' }),
      [RUNS]: JSON.stringify({ workflow_runs: [run(10, 10, 'success')] }),
    });
    expect(diverged).toMatchObject({ comparison: { ancestor: false } });
  }),
);

/** Runs the real planner on this checkout's HEAD with a history whose base is HEAD's parent-free stand-in. */
interface HistoryFixture {
  readonly comparison: Comparison | null;
  readonly mutations: readonly RunMutation[];
  readonly runs: readonly ReturnType<typeof run>[];
}
const planWith = (history: HistoryFixture, runAttempt = '1') =>
  Effect.gen(function* realPlanner() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(directory, 'history.json'), JSON.stringify(history));
    const head = (yield* collectToolingProcess(
      ChildProcess.make('git', ['rev-parse', 'HEAD'], { cwd: app }),
    )).stdout.trim();
    const result = yield* collectToolingProcess(
      ChildProcess.make('node', ['scripts/zerops/delivery-plan-cli.mts', 'plan', directory], {
        cwd: app,
        env: {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_OUTPUT: path.join(directory, 'outputs'),
          GITHUB_RUN_ATTEMPT: runAttempt,
          GITHUB_RUN_NUMBER: '20',
          GITHUB_SHA: head,
        },
        extendEnv: true,
      }),
    );
    expect(result.status, result.stderr).toBe(0);
    const plan = yield* Schema.decodeEffect(Schema.fromJsonString(DeliveryPlanSchema))(
      yield* fs.readFileString(path.join(directory, 'plan.json')),
    );
    return { outputs: yield* fs.readFileString(path.join(directory, 'outputs')), plan };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
const greenBase = { mutations: [], runs: [run(10, 10, 'success')] };
const changing = (changedPaths: readonly string[]) => ({
  ...greenBase,
  comparison: { ancestor: true, base: BASE, changedPaths, truncated: false },
});

for (const jobName of ['deliver_app']) {
  it.effect(`refuses ${jobName} from an earlier plan attempt before artifacts or stage mutations`, () =>
    Effect.gen(function* freshDeliveryPlan() {
      const fs = yield* FileSystem.FileSystem;
      const Step = Schema.Struct({
        env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
        name: Schema.String,
        run: Schema.optionalKey(Schema.String),
        uses: Schema.optionalKey(Schema.String),
      });
      const { jobs: workflowJobs } = Schema.decodeUnknownSync(
        Schema.Struct({
          jobs: Schema.Record(
            Schema.String,
            Schema.Struct({
              outputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
              steps: Schema.Array(Step),
            }),
          ),
        }),
      )(parse(yield* fs.readFileString(path.resolve(app, '..', WORKFLOW))));
      expect(workflowJobs.deliver?.outputs?.run_attempt).toBe(`\${{ github.run_attempt }}`);
      const steps = workflowJobs[jobName]?.steps ?? [];
      const guard = steps.findIndex(({ name }) => name === 'Refuse a delivery planned in another run attempt');
      expect(guard).toBeGreaterThanOrEqual(0);
      expect(guard).toBeLessThan(
        steps.findIndex(({ uses }) => uses?.startsWith('actions/download-artifact@') === true),
      );
      expect(guard).toBeLessThan(steps.findIndex(({ name }) => name === MUTATION_MARKER));
      const step = steps[guard];
      expect(step?.env?.PLAN_RUN_ATTEMPT).toBe(`\${{ needs.deliver.outputs.run_attempt }}`);
      const script = step?.run;
      if (script === undefined) {
        expect.fail('Missing delivery attempt guard');
      }
      for (const [planned, current, allowed] of [
        ['1', '1', true],
        ['1', '2', false],
        ['', '2', false],
        ['2', '2', true],
      ] as const) {
        const result = yield* collectToolingProcess(
          ChildProcess.make('bash', ['-e', '-u', '-o', 'pipefail', '-c', script], {
            env: { GITHUB_RUN_ATTEMPT: current, GITHUB_RUN_ID: '2468', PLAN_RUN_ATTEMPT: planned },
            extendEnv: true,
          }),
        );
        expect(result.status, result.stderr).toBe(allowed ? 0 : 1);
        if (!allowed) {
          expect(result.stdout).toContain('gh run rerun 2468 (without --failed)');
          expect(result.stdout).toContain('dispatch the workflow on the current head');
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect('admits stale no-service plans to the attempt guard but skips current no-service plans', () =>
  Effect.gen(function* noServiceRetryCondition() {
    const fs = yield* FileSystem.FileSystem;
    const workflow = Schema.decodeUnknownSync(
      Schema.Struct({ jobs: Schema.Struct({ deliver_app: Schema.Struct({ if: Schema.String }) }) }),
    )(parse(yield* fs.readFileString(path.resolve(app, '..', WORKFLOW))));
    // Run the actual job condition's boolean/comparison subset in bash, with the GitHub context substituted.
    // This catches a skip before the attempt guard, not just a failure inside that guard's shell body.
    const currentNoService = {
      any: 'false',
      build: 'skipped',
      cancelled: false,
      deliver: 'success',
      lint: 'success',
      planned: '2',
    };
    const staleNoService = { ...currentNoService, planned: '1' };
    const withService = { ...currentNoService, any: 'true', build: 'success' };
    for (const { admitted, name, ...values } of [
      { ...currentNoService, admitted: false, name: 'current no-service plan' },
      { ...staleNoService, admitted: true, name: 'stale no-service plan' },
      { ...staleNoService, admitted: true, name: 'missing plan attempt', planned: '' },
      { ...withService, admitted: true, name: 'current service plan' },
      { ...withService, admitted: true, name: 'stale service plan', planned: '1' },
      { ...withService, admitted: true, build: 'skipped', name: 'reused unit builds' },
      ...[staleNoService, withService].flatMap((plan) => [
        { ...plan, admitted: false, lint: 'failure', name: 'failed lint' },
        { ...plan, admitted: false, lint: 'cancelled', name: 'cancelled lint' },
        { ...plan, admitted: false, lint: 'skipped', name: 'skipped lint' },
        { ...plan, admitted: false, build: 'failure', name: 'failed build' },
        { ...plan, admitted: false, deliver: 'failure', name: 'failed planner' },
        { ...plan, admitted: false, cancelled: true, name: 'cancelled run' },
      ]),
    ]) {
      const context = {
        '!cancelled()': values.cancelled ? "'true' == 'false'" : "'false' == 'false'",
        'github.run_attempt': "'2'",
        'needs.build.result': `'${values.build}'`,
        'needs.deliver.outputs.any': `'${values.any}'`,
        'needs.deliver.outputs.run_attempt': `'${values.planned}'`,
        'needs.deliver.result': `'${values.deliver}'`,
        'needs.lint.result': `'${values.lint}'`,
      };
      let condition = workflow.jobs.deliver_app.if.replaceAll(/^\$\{\{\s*|\s*\}\}$/gu, '');
      for (const [key, value] of Object.entries(context)) {
        condition = condition.replaceAll(key, value);
      }
      const result = yield* collectToolingProcess(ChildProcess.make('bash', ['-c', `[[ ${condition} ]]`]));
      expect(result.status, `${name}: ${JSON.stringify(values)}`).toBe(admitted ? 0 : 1);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live('replans a full rerun as a retry: a storefront-only first attempt becomes every service', () =>
  Effect.gen(function* fullRerun() {
    const history = changing(['app/akros-storefront/src/app/page.tsx']);
    const first = yield* planWith(history);
    expect(first.plan.full).toBe(false);
    expect(first.plan.services).toEqual(['storefront', 'shop']);
    const retry = yield* planWith(history, '2');
    expect(retry.plan.full).toBe(true);
    expect(retry.plan.services).toEqual(['app', 'storefront', 'shop', 'n1']);
    expect(retry.plan.reasons).toContain('a re-run attempt deploys every service');
    for (const service of ['app', 'storefront', 'shop', 'n1', 'full']) {
      expect(retry.outputs).toContain(`${service}=true\n`);
    }
  }),
);

it.live('executes the real planner: an unreadable comparison deploys every service', () =>
  Effect.gen(function* unreadableComparison() {
    const { outputs, plan } = yield* planWith({ ...greenBase, comparison: null });
    expect(plan.base).toBe(BASE);
    expect(plan.full).toBe(true);
    for (const service of ['app', 'storefront', 'shop', 'n1', 'full']) {
      expect(outputs).toContain(`${service}=true\n`);
    }
  }),
);

it.live("executes the real planner over this commit's reference graph: CI-only changes deploy nothing", () =>
  Effect.gen(function* ciOnly() {
    // A test beside the delivery scripts is no delivery script: no service reads it.
    const { outputs, plan } = yield* planWith(
      changing([
        '.github/workflows/ultramodern-workspace-gates.yml',
        'app/scripts/tests/ci-workflows.test.mts',
        'app/scripts/zerops/app-boot-stages.test.mts',
      ]),
    );
    expect(plan.full).toBe(false);
    expect(plan.services).toEqual([]);
    expect(outputs).toContain('any=false\n');
  }),
);

it.live("executes the real planner over this commit's reference graph: what stage runs deploys every service", () =>
  Effect.gen(function* deliveredInputs() {
    for (const changed of [
      WORKFLOW,
      'app/scripts/zerops/app-host.mts',
      'app/scripts/run-zerops-migrator.mjs',
      'app/scripts/ops/stage-warmup.mts',
      'app/scripts/zerops/push-service.sh',
    ]) {
      const { plan } = yield* planWith(changing([changed]));
      expect(plan.full, changed).toBe(true);
    }
  }),
);

it.effect('leaves malformed comparison file records unknown rather than granting partial or empty proof', () =>
  Effect.gen(function* malformedComparison() {
    for (const files of [
      null,
      {},
      [null],
      [{}],
      [{ filename: '' }],
      [{ filename: 'valid.ts', status: 'modified' }, {}],
      [{ filename: 'new.txt' }],
      [{ filename: 'new.txt', status: null }],
      [{ filename: 'new.txt', status: '' }],
      [{ filename: 'new.txt', status: 'unknown' }],
      [{ filename: 'new.txt', status: 1 }],
      [{ filename: 'new.ts', previous_filename: null, status: 'copied' }],
      [{ filename: 'new.ts', previous_filename: '', status: 'copied' }],
      [{ filename: 'new.ts', status: 'renamed' }],
      [{ filename: 'new.ts', previous_filename: '', status: 'renamed' }],
      [{ filename: 'new.ts', previous_filename: null, status: 'renamed' }],
    ]) {
      const history = yield* readHistory({
        [COMPARE]: JSON.stringify({ files, status: 'identical' }),
        [RUNS]: JSON.stringify({ workflow_runs: [run(10, 10, 'success')] }),
      });
      expect(history).toMatchObject({ comparison: null });
    }
  }),
);

it.effect('accepts every documented GitHub file status and preserves supplied copy origins', () =>
  Effect.gen(function* documentedStatuses() {
    for (const status of ['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']) {
      const origin = status === 'renamed' || status === 'copied';
      const history = yield* readHistory({
        [COMPARE]: JSON.stringify({
          files: [
            origin ? { filename: 'new.txt', previous_filename: 'old.txt', status } : { filename: 'new.txt', status },
          ],
          status: 'ahead',
        }),
        [RUNS]: JSON.stringify({ workflow_runs: [run(10, 10, 'success')] }),
      });
      expect(history).toMatchObject({
        comparison: { changedPaths: origin ? ['new.txt', 'old.txt'] : ['new.txt'], truncated: false },
      });
    }
    // GitHub's diff-entry schema does not require previous_filename for copies.
    expect(
      yield* readHistory({
        [COMPARE]: JSON.stringify({ files: [{ filename: 'copy.txt', status: 'copied' }], status: 'ahead' }),
        [RUNS]: JSON.stringify({ workflow_runs: [run(10, 10, 'success')] }),
      }),
    ).toMatchObject({ comparison: { changedPaths: ['copy.txt'] } });
  }),
);

it.effect('retains both names when a renamed configuration makes unchanged files lint differently', () =>
  Effect.gen(function* renamedConfiguration() {
    const history = yield* readHistory({
      [COMPARE]: JSON.stringify({
        files: [{ filename: 'notes/old-config.txt', previous_filename: '.editorconfig', status: 'renamed' }],
        status: 'ahead',
      }),
      [RUNS]: JSON.stringify({ workflow_runs: [run(10, 10, 'success')] }),
    });
    expect(history).toMatchObject({
      comparison: { changedPaths: ['.editorconfig', 'notes/old-config.txt'], truncated: false },
    });
  }),
);

it.effect('keeps an unavailable terminal marker outcome unknown unless another attempt proves mutation', () =>
  Effect.gen(function* unknownMarker() {
    const unknown = { id: 2, steps: [{ conclusion: null, name: MUTATION_MARKER, status: 'completed' }] };
    for (const proved of [false, true]) {
      const allJobs = proved ? [unknown, ...jobs('success').jobs] : [unknown];
      const history = yield* readHistory({
        [COMPARE]: JSON.stringify({ files: [], status: 'identical' }),
        [jobsOf(13)]: JSON.stringify({ jobs: allJobs, total_count: allJobs.length }),
        [RUNS]: JSON.stringify({ workflow_runs: [run(13, 13, 'failure'), run(10, 10, 'success')] }),
      });
      expect(history).toMatchObject({ mutations: [{ mutated: proved ? true : null, runId: 13, services: null }] });
    }
  }),
);

it.effect('starts Stage Deploy even for a documentation-only repair push', () =>
  Effect.gen(function* documentationTrigger() {
    const fs = yield* FileSystem.FileSystem;
    const workflow = Schema.decodeUnknownSync(
      Schema.Struct({
        on: Schema.Struct({
          push: Schema.Struct({
            branches: Schema.Array(Schema.String),
            paths: Schema.optionalKey(Schema.Array(Schema.String)),
            'paths-ignore': Schema.optionalKey(Schema.Array(Schema.String)),
          }),
        }),
      }),
    )(parse(yield* fs.readFileString(path.resolve(app, '..', WORKFLOW))));
    expect(workflow.on.push.branches).toContain('demo/sales-crm');
    expect(workflow.on.push['paths-ignore']).toBeUndefined();
    expect(workflow.on.push.paths).toBeUndefined();
  }).pipe(Effect.provide(NodeServices.layer)),
);
