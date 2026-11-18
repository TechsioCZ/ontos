import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Array as EffectArray, Effect, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

import { loadDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { DATABASE_IDENTITIES } from '../../packages/core-runtime/src/db/database-identity-manifest.ts';

import { CiTemplatesSchema, ciPlanOutputs, planCiChecks, taskDirectory } from '../plan-ci-checks.mts';

const START_INTEGRATION_WORKERS = 'bash scripts/ci/start-integration-workers.sh';
const RESTORE_INTEGRATION_WORKERS = 'bash scripts/ci/restore-integration-workers.sh';
const INTEGRATION_WORKERS_STEP_ID = 'integration-workers';
const INTEGRATION_DATABASE_ARTIFACT = 'integration-database';
const BROWSER_TEST_COMMAND = 'mise exec -- pnpm --filter @app/shell-super-app test:e2e';

const CUSTOMER_CONTEXT_SELECTOR = './verticals/commerce-customer-context';
const TriggerSchema = Schema.Struct({ 'paths-ignore': Schema.optional(Schema.Array(Schema.String)) });
const WorkflowSchema = Schema.Struct({
  on: Schema.Struct({
    merge_group: Schema.optional(Schema.Struct({ types: Schema.Array(Schema.String) })),
    pull_request: TriggerSchema,
    push: TriggerSchema,
  }),
});

const readWorkflow = (name: string) =>
  Schema.decodeUnknownSync(WorkflowSchema)(
    parse(readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf-8')),
  );

const TYPECHECK_COMMAND = 'pnpm typecheck';
const GATES_WORKFLOW = 'ultramodern-workspace-gates.yml';
/** The repository-root git hook configuration; the app workspace may not carry one of its own. */
const LEFTHOOK_CONFIG = 'lefthook.yml';
/** Any pinned download-artifact action; a bare prefix match is what keeps the pin out of these tests. */
const DOWNLOAD_ARTIFACT = 'actions/download-artifact@';
/** A representative changed source path for the format-and-lint selection tests. */
const CHANGED_SOURCE_PATH = 'app/scripts/check.mts';
/** The build shard a matrix row carries. */
const MATRIX_SHARD = 'matrix.shard';
const GATES_WORKFLOW_URL = new URL(`../../../.github/workflows/${GATES_WORKFLOW}`, import.meta.url);
const CI_PLAN_JOB = 'ci-plan';
const WORKSPACE_UNIT_JOB = 'workspace-unit';
const SERVICE_INTEGRATION_JOB = 'service-integration';
const OWNER_INTEGRATION_JOB = 'owner-integration';
const BROWSER_INTEGRATION_JOB = 'browser-integration';
const STATIC_CONTRACTS_JOB = 'static-contracts';
const TOPOLOGY_PROOF_JOB = 'node-topology-proof';
const WORKSPACE_GATE_JOB = 'workspace-gate';
const SOURCE_CONTRACTS_JOB = 'workspace-source-contracts';
const UNIT_AFTER_LINT_JOB = 'workspace-unit-after-lint';
const UNIT_AFTER_STATIC_JOB = 'workspace-unit-after-static';
const UNIT_AFTER_TOOLING_JOB = 'workspace-unit-after-tooling';
const NODE_ARTIFACT_BUILD_JOB = 'node-artifact-build';

/** Every job that receives a planner matrix, with the ci-plan output it expands. */
const PLANNED_MATRIX_JOBS = [
  [WORKSPACE_GATE_JOB, 'source'],
  [WORKSPACE_UNIT_JOB, 'unit'],
  [UNIT_AFTER_LINT_JOB, 'unitAfterLint'],
  [UNIT_AFTER_STATIC_JOB, 'unitAfterStatic'],
  [UNIT_AFTER_TOOLING_JOB, 'unitAfterTooling'],
  [SERVICE_INTEGRATION_JOB, 'integration'],
  [BROWSER_INTEGRATION_JOB, 'integrationBrowser'],
  [OWNER_INTEGRATION_JOB, 'integrationOwners'],
  [NODE_ARTIFACT_BUILD_JOB, 'integrationBuild'],
  [TOPOLOGY_PROOF_JOB, 'integrationTopology'],
] as const;

const readTemplates = () =>
  Schema.decodeUnknownSync(Schema.fromJsonString(CiTemplatesSchema))(
    readFileSync(new URL('../ci-matrices.json', import.meta.url), 'utf-8'),
  );

/** The complete plan's matrices exactly as ci-plan publishes them for a changed-file lint. */
const fullPlanMatrices = (lintSweep: 'all' | 'changed' = 'changed') => {
  const templates = readTemplates();
  return ciPlanOutputs(planCiChecks({ changedPaths: [], forceFull: true, packages: [], templates }), lintSweep);
};

/** Expand every planner matrix reference with its own phase of the full run; separately test the actual planner. */
const readGateWorkflow = () => {
  const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
  const workflow = record(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')));
  const jobs = { ...record(workflow.jobs) };
  const matrices = fullPlanMatrices();
  for (const [job, key] of PLANNED_MATRIX_JOBS) {
    const entry = record(jobs[job]);
    const strategy = record(entry.strategy);
    const matrix = record(strategy.matrix);
    expect(matrix.include).toBe(`\${{ fromJSON(needs.ci-plan.outputs.${key}) }}`);
    jobs[job] = { ...entry, strategy: { ...strategy, matrix: { ...matrix, include: matrices[key] } } };
  }
  return { ...workflow, jobs };
};
/** The fixed system PATH a workflow step script runs with in these tests. */
const STEP_PATH = '/usr/bin:/bin';
const INSTALL_APP_STEP = 'Install the app workspace';
/** The composite action every job uses to install the app workspace. */
const INSTALL_APP_ACTION = './.github/actions/install-app';
/** The last step of a build shard: its consumers need the shard, so they start once this upload exists. */
const UPLOAD_STEP = "Upload the shard's build outputs";
const NODE_BUILD_STEP = "Build the shard's Node artifacts";
const UNIT_ARTIFACTS_CONDITION = 'matrix.node-artifacts == true';

const skipsGates = (changedPaths: readonly string[], ignored: readonly string[]) =>
  changedPaths.every((changedPath) => ignored.some((pattern) => path.matchesGlob(changedPath, pattern)));

const ROOT_DOCUMENTATION_TRIGGERS = [
  readWorkflow(GATES_WORKFLOW).on.push,
  readWorkflow('quality-audit.yml').on.push,
  readWorkflow('quality-audit.yml').on.pull_request,
];

it('deploys nothing and audits nothing for changes to repository-root documentation only', () => {
  for (const trigger of ROOT_DOCUMENTATION_TRIGGERS) {
    const ignored = trigger['paths-ignore'] ?? [];
    expect(skipsGates(['docs/contexts/tax/CONTEXT.md', 'CONTEXT-MAP.md', 'README.md', 'AGENTS.md'], ignored)).toBe(
      true,
    );
    for (const gatedPath of [
      'app/tools/oxlint/effect-native/rules/index.mts',
      'app/docs/architecture/DEPLOYMENT.md',
      'app/AGENTS.md',
      '.github/workflows/ultramodern-workspace-gates.yml',
      LEFTHOOK_CONFIG,
    ]) {
      expect(skipsGates(['docs/index.md', gatedPath], ignored)).toBe(false);
    }
  }
});

it('reports the required Workspace gates check on every pull request and merge group', () => {
  const workflow = readWorkflow(GATES_WORKFLOW);
  // A filtered pull request would never report the check the main ruleset requires, and could never merge.
  expect(workflow.on.pull_request['paths-ignore']).toBeUndefined();
  expect(workflow.on.merge_group).toEqual({ types: ['checks_requested'] });
});

/** A GitHub Actions `${{ … }}` expression, written without JavaScript template placeholders. */
const expression = (body: string) => `\${{ ${body} }}`;
const CURRENT_SOURCE_REVISION = expression('github.sha');

const WorkflowStepSchema = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  id: Schema.optional(Schema.String),
  if: Schema.optional(Schema.String),
  name: Schema.String,
  run: Schema.optional(Schema.String),
  'timeout-minutes': Schema.optional(Schema.Number),
});

const RUNNER_TEMP_EXPRESSION = expression('runner.temp');
/** The artifact that carries ci-plan's exact changed-path list to the format and lint gate. */
const CHANGED_PATHS_ARTIFACT = 'ci-changed-paths';
const SCRIPTS_TEST_COMMAND = 'pnpm test:scripts';
const UNPACK_NATIVE_ARTIFACTS_SCRIPT = 'bash scripts/unpack-unit-build-outputs.sh';
const UNPACK_NATIVE_ARTIFACTS_COMMAND = `${UNPACK_NATIVE_ARTIFACTS_SCRIPT} "$RUNNER_TEMP/native-composition-units" .output`;

const PublicationWorkflowStepSchema = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  id: Schema.optional(Schema.String),
  if: Schema.optional(Schema.String),
  name: Schema.String,
  run: Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
  with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  'working-directory': Schema.optional(Schema.String),
});

const TargetWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    'queue-proof': Schema.Struct({
      if: Schema.String,
      outputs: Schema.Record(Schema.String, Schema.String),
      permissions: Schema.Record(Schema.String, Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
    }),
    'workspace-gates': Schema.Struct({
      if: Schema.String,
      name: Schema.String,
      needs: Schema.Array(Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
    }),
  }),
});

const readTargetWorkflow = () => Schema.decodeUnknownSync(TargetWorkflowSchema)(readGateWorkflow());

const QUEUE_PROOF_JOB = 'queue-proof';
/** The integration matrix row that proves the stage-shaped deployment bootstrap from a scratch cluster. */
const BOOTSTRAP_SUITE = 'bootstrap';
const BOOTSTRAP_CONDITION = `matrix.suite == '${BOOTSTRAP_SUITE}'`;
const NON_BOOTSTRAP_CONDITION = "matrix.suite == 'browser' || matrix.suite == 'database'";
const BOOTSTRAP_MIGRATOR_STEP = 'Run the assembled stage migrator artifact against the fresh database';
const NODE_BUILD_ARTIFACT_PATTERN = 'node-units-*';
/**
 * Every row that reads built Node artifacts: the suites and the whole-topology proof. The browser row
 * drives a deployed release instead, and the bootstrap row assembles the migrator and Outbox Worker host
 * from their own zerops.yaml build commands — making it wait for a build shard is what put the whole
 * bootstrap proof in front of the integration wave before it became a row.
 */
const BACKEND_ARTIFACT_CONDITION = "matrix.suite == 'bootstrap' || matrix.suite == 'integration'";
const BACKEND_ARTIFACT_DOWNLOAD_STEP = 'Download the same-run Node artifacts for native owner fixtures';
const BACKEND_ARTIFACT_UNPACK_STEP = 'Unpack the Node artifacts for native owner fixtures';
const BACKEND_INTEGRATION_CONDITION = "matrix.suite == 'integration'";
/** The integration matrix row that proves the built topology of every delivery unit. */
const NODE_PROOF_SUITE = BOOTSTRAP_SUITE;
const NODE_PROOF_CONDITION = `matrix.suite == '${NODE_PROOF_SUITE}'`;
const FORMAT_AND_LINT_JOB = 'format-and-lint';
/** Gate jobs rooted at the merge queue proof. */
const ROOT_GATE_JOBS = [
  WORKSPACE_GATE_JOB,
  WORKSPACE_UNIT_JOB,
  STATIC_CONTRACTS_JOB,
  FORMAT_AND_LINT_JOB,
  SERVICE_INTEGRATION_JOB,
  NODE_ARTIFACT_BUILD_JOB,
] as const;
/** Direct producer dependencies of the six public gate IDs. */
const GATE_JOB_NEEDS = {
  [FORMAT_AND_LINT_JOB]: [CI_PLAN_JOB],
  [NODE_ARTIFACT_BUILD_JOB]: [CI_PLAN_JOB],
  [SERVICE_INTEGRATION_JOB]: [CI_PLAN_JOB],
  [STATIC_CONTRACTS_JOB]: [CI_PLAN_JOB],
  [WORKSPACE_GATE_JOB]: [CI_PLAN_JOB],
  [WORKSPACE_UNIT_JOB]: [CI_PLAN_JOB, NODE_ARTIFACT_BUILD_JOB, SOURCE_CONTRACTS_JOB],
} satisfies Readonly<Record<string, readonly string[]>>;
const GATE_JOBS = ROOT_GATE_JOBS;
/**
 * A unit job's condition on one job it needs. A unit row reads the build shards only when it asks for Node
 * artifacts, so the shards must have reached what the plan expected of them: a planned skip lets the row
 * decide for itself, a failure or cancellation never does. Every other job it follows must have succeeded.
 */
const neededResult = (job: string) =>
  job === NODE_ARTIFACT_BUILD_JOB
    ? `needs.${job}.result == fromJSON(needs.ci-plan.outputs.expected)['${job}']`
    : `needs.${job}.result == 'success'`;
const GatedJobsSchema = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({ if: Schema.optional(Schema.String), needs: Schema.optional(Schema.Array(Schema.String)) }),
  ),
});

/** Whether a workflow step's script succeeds when Actions runs it with these variables. */
const stepPasses = (script: string, environment: Readonly<Record<string, string>>) => {
  try {
    execFileSync('/bin/bash', ['-eo', 'pipefail', '-c', script], {
      env: { PATH: STEP_PATH, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
};

it('selects work before gates and starts source checks without waiting for artifacts', () => {
  const proof = readTargetWorkflow().jobs[QUEUE_PROOF_JOB];
  expect(proof.if).toContain('inputs.force-ci-full != true');
  expect(proof.permissions).toEqual({ actions: 'read' });
  expect(proof.outputs.proven).toBe(expression('steps.proof.outputs.proven'));
  const lookup = proof.steps.find(({ id }) => id === 'proof')?.run ?? '';
  expect(lookup).toContain('runs?head_sha=$GITHUB_SHA&event=merge_group&status=success');
  const { jobs } = Schema.decodeUnknownSync(GatedJobsSchema)(readGateWorkflow());
  expect(jobs[CI_PLAN_JOB]?.needs).toEqual([QUEUE_PROOF_JOB]);
  for (const gate of ROOT_GATE_JOBS) {
    const needed = GATE_JOB_NEEDS[gate] ?? [];
    expect(jobs[gate]?.needs, gate).toEqual(needed);
    // Every producer this gate needs must have reached what the plan expected of it: a failed producer
    // leaves the gate 'skipped' against an expected 'success', which check-ci-gates.sh rejects.
    const producers = needed
      .filter((job) => job !== CI_PLAN_JOB)
      .map((job) => `${neededResult(job)} && `)
      .join('');
    expect(jobs[gate]?.if, gate).toBe(
      expression(
        `!cancelled() && needs.ci-plan.result == 'success' && ${producers}fromJSON(needs.ci-plan.outputs.expected)['${gate}'] == 'success'`,
      ),
    );
  }
  // The bootstrap proof is a row of the suites, never a job: `needs` is job-level, so proving it upstream
  // put its whole duration in front of every row. No job may carry it as a dependency again.
  expect(Object.keys(jobs)).not.toContain('bootstrap-proof');
  for (const [job, { needs }] of Object.entries(jobs)) {
    expect(needs ?? [], job).not.toContain('bootstrap-proof');
  }
});

const CANCEL_REPLACED_QUEUE_RUNS_JOB = 'cancel-replaced-queue-runs';
/** Each job that stops a red merge queue run, with the one check whose failure starts it. */
const STOPPED_CHECKS = {
  'stop-red-queue-run-after-bootstrap': TOPOLOGY_PROOF_JOB,
  'stop-red-queue-run-after-browser': BROWSER_INTEGRATION_JOB,
  'stop-red-queue-run-after-build': NODE_ARTIFACT_BUILD_JOB,
  'stop-red-queue-run-after-database': SERVICE_INTEGRATION_JOB,
  'stop-red-queue-run-after-lint': FORMAT_AND_LINT_JOB,
  'stop-red-queue-run-after-source-contracts': SOURCE_CONTRACTS_JOB,
  'stop-red-queue-run-after-static-contracts': STATIC_CONTRACTS_JOB,
  'stop-red-queue-run-after-tooling': WORKSPACE_GATE_JOB,
} as const satisfies Readonly<Record<string, string>>;
const CancelWorkflowSchema = Schema.Struct({
  concurrency: Schema.Struct({ 'cancel-in-progress': Schema.String, group: Schema.String }),
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      if: Schema.optional(Schema.String),
      needs: Schema.optional(Schema.Array(Schema.String)),
      permissions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      steps: Schema.optional(
        Schema.Array(Schema.Struct({ run: Schema.optional(Schema.String), uses: Schema.optional(Schema.String) })),
      ),
    }),
  ),
});
const readCancelWorkflow = () =>
  Schema.decodeUnknownSync(CancelWorkflowSchema)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')));

it('cancels the runs of replaced merge queue entries from a job that runs no repository code', () => {
  const { concurrency, jobs } = readCancelWorkflow();
  // Pull request, push, dispatch and schedule runs keep their group; a run on main is never cancelled by it.
  expect(concurrency).toEqual({
    'cancel-in-progress': expression("github.ref != 'refs/heads/main'"),
    group: `ultramodern-workspace-${expression('github.workflow')}-${expression('github.ref')}`,
  });
  const cancel = jobs[CANCEL_REPLACED_QUEUE_RUNS_JOB];
  expect(cancel?.if).toBe("github.event_name == 'merge_group'");
  expect(cancel?.needs).toBeUndefined();
  // The write token sits in one step that checks out nothing and runs no action.
  expect(cancel?.permissions).toEqual({ actions: 'write' });
  expect(cancel?.steps?.map(({ uses }) => uses)).toEqual([undefined]);
  for (const [job, { needs, permissions }] of Object.entries(jobs)) {
    if (job !== CANCEL_REPLACED_QUEUE_RUNS_JOB && !(job in STOPPED_CHECKS)) {
      expect(permissions?.actions, job).not.toBe('write');
    }
    // A cancel never decides the verdict, and nothing waits for it.
    expect(needs ?? [], job).not.toContain(CANCEL_REPLACED_QUEUE_RUNS_JOB);
  }
});

/** One exact `gh` invocation of a fake gh and its answer; any other invocation fails. */
interface FakeGhRoute {
  readonly args: string;
  readonly exit?: number;
  readonly stderr?: string;
  readonly stdout?: string;
}
/** Runs a step script with a fake gh that answers only the given invocations and records every call. */
const runWithFakeGh = (
  script: string,
  routes: readonly FakeGhRoute[],
  environment: Readonly<Record<string, string>>,
) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-fake-gh-'));
  try {
    const calls = path.join(directory, 'calls');
    const summary = path.join(directory, 'summary');
    writeFileSync(calls, '');
    writeFileSync(summary, '');
    const branches = routes.map(({ args, exit = 0, stderr = '', stdout = '' }, index) => {
      writeFileSync(path.join(directory, `stdout-${index}`), stdout);
      writeFileSync(path.join(directory, `stderr-${index}`), stderr);
      return `  '${args}') cat '${directory}/stdout-${index}'; cat '${directory}/stderr-${index}' >&2; exit ${exit} ;;`;
    });
    const gh = path.join(directory, 'gh');
    writeFileSync(
      gh,
      [
        '#!/bin/bash',
        `printf '%s\\n' "$*" >> '${calls}'`,
        'case "$*" in',
        ...branches,
        '  *) echo "unexpected gh $*" >&2; exit 97 ;;',
        'esac',
        '',
      ].join('\n'),
    );
    chmodSync(gh, 0o755);
    const passed = stepPasses(script, {
      GH_TOKEN: 'test-token',
      GITHUB_REPOSITORY: 'TechsioCZ/ontos',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_STEP_SUMMARY: summary,
      PATH: `${directory}:${STEP_PATH}`,
      ...environment,
    });
    return {
      calls: readFileSync(calls, 'utf-8').split('\n').filter(Boolean),
      passed,
      summary: readFileSync(summary, 'utf-8'),
    };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

const QUEUE_RUN_ID = 44_300_000_000;
const QUEUE_ENTRY_PREFIX = 'gh-readonly-queue/main/pr-1492-';
const QUEUE_BASES = ['2de699a1608eda1bdd847c1cd7e5f967b7d52218', '9292b97dccbb4c1b09fe8ea99c8d76a8fb282559'] as const;
const QUEUE_WORKFLOW_ID = 342_952_200;
const LIVE_RUN_STATUSES = ['queued', 'in_progress', 'waiting', 'requested', 'pending'] as const;
const workflowRunsRoute = (status: string, runs: readonly { head_branch: string | null; id: number }[]) => ({
  args: `api repos/TechsioCZ/ontos/actions/workflows/${QUEUE_WORKFLOW_ID}/runs?event=merge_group&status=${status}&per_page=100`,
  stdout: JSON.stringify({ total_count: runs.length, workflow_runs: runs }),
});
const cancelArgs = (id: number) => `api -X POST repos/TechsioCZ/ontos/actions/runs/${id}/cancel`;
const runUrl = (id: number) => `https://github.com/TechsioCZ/ontos/actions/runs/${id}`;

// 07:12 UTC on 18 Nov: the queue rebuilt five entries, and the runs of the replaced ones kept 146 runner-minutes.
it('cancels exactly the older live merge group runs of the same pull request', () => {
  const script = readCancelWorkflow().jobs[CANCEL_REPLACED_QUEUE_RUNS_JOB]?.steps?.[0]?.run ?? 'exit 1';
  const [base, otherBase] = QUEUE_BASES;
  const environment = { GITHUB_REF: `refs/heads/${QUEUE_ENTRY_PREFIX}${base}`, GITHUB_RUN_ID: String(QUEUE_RUN_ID) };
  const replaced = { head_branch: `${QUEUE_ENTRY_PREFIX}${otherBase}`, id: 44_200_000_001 };
  const replacedOnThisBase = { head_branch: `${QUEUE_ENTRY_PREFIX}${base}`, id: 44_200_000_004 };
  const endedBeforeCancel = { head_branch: `${QUEUE_ENTRY_PREFIX}${otherBase}`, id: 44_200_000_007 };
  const lists = {
    in_progress: [
      // Listed again after it started: cancelled once.
      replaced,
      replacedOnThisBase,
      { head_branch: 'main', id: 44_200_000_005 },
      { head_branch: `gh-readonly-queue/release/pr-1492-${base}`, id: 44_200_000_006 },
      { head_branch: `${QUEUE_ENTRY_PREFIX}abc`, id: 44_200_000_008 },
      { head_branch: null, id: 44_200_000_009 },
    ],
    pending: [],
    queued: [
      replaced,
      { head_branch: `gh-readonly-queue/main/pr-149-${base}`, id: 44_200_000_002 },
      { head_branch: `gh-readonly-queue/main/pr-14920-${base}`, id: 44_200_000_003 },
      // A newer run is a later entry of this pull request, never a replaced one.
      { head_branch: `${QUEUE_ENTRY_PREFIX}${otherBase}`, id: QUEUE_RUN_ID + 1 },
    ],
    requested: [],
    waiting: [endedBeforeCancel],
  };
  // Completed runs are never listed: the fake answers only the live statuses.
  const routes = (cancelAnswer: FakeGhRoute, failedList?: string): FakeGhRoute[] => [
    {
      args: `api repos/TechsioCZ/ontos/actions/runs/${QUEUE_RUN_ID} --jq .workflow_id`,
      stdout: `${QUEUE_WORKFLOW_ID}\n`,
    },
    ...LIVE_RUN_STATUSES.map((status) =>
      status === failedList
        ? { ...workflowRunsRoute(status, []), exit: 1, stderr: 'gh: Server Error (HTTP 502)\n', stdout: '' }
        : workflowRunsRoute(status, lists[status]),
    ),
    { args: cancelArgs(replaced.id), stdout: '{}' },
    cancelAnswer,
    {
      args: cancelArgs(endedBeforeCancel.id),
      exit: 1,
      stderr: 'gh: Cannot cancel a workflow run that is completed. (HTTP 409)\n',
      stdout: '{"message":"Cannot cancel a workflow run that is completed."}',
    },
  ];
  const lookups = [
    `api repos/TechsioCZ/ontos/actions/runs/${QUEUE_RUN_ID} --jq .workflow_id`,
    ...LIVE_RUN_STATUSES.map((status) => workflowRunsRoute(status, []).args),
  ];
  const cancels = [replaced, replacedOnThisBase, endedBeforeCancel].map(({ id }) => cancelArgs(id));

  const done = runWithFakeGh(script, routes({ args: cancelArgs(replacedOnThisBase.id), stdout: '{}' }), environment);
  expect(done.calls).toEqual([...lookups, ...cancels]);
  expect(done.passed).toBe(true);
  expect(done.summary).toContain(runUrl(replaced.id));
  expect(done.summary).toContain(runUrl(replacedOnThisBase.id));
  expect(done.summary).not.toContain(runUrl(endedBeforeCancel.id));

  // Any refusal other than "already completed" is a failure, not a skipped cancel.
  const refused = runWithFakeGh(
    script,
    routes({
      args: cancelArgs(replacedOnThisBase.id),
      exit: 1,
      stderr: 'gh: Resource not accessible by integration (HTTP 403)\n',
    }),
    environment,
  );
  expect(refused.passed).toBe(false);
  expect(refused.calls).toEqual([...lookups, ...cancels.slice(0, 2)]);

  // A listing that fails cancels nothing and fails.
  const unlisted = runWithFakeGh(script, routes({ args: cancelArgs(replacedOnThisBase.id) }, 'waiting'), environment);
  expect(unlisted.passed).toBe(false);
  expect(unlisted.calls).toEqual(lookups.slice(0, 4));

  // Only a pull request's queue entry ref names a pull request: anything else fails before any call.
  for (const ref of [
    'refs/heads/main',
    `refs/heads/${QUEUE_ENTRY_PREFIX}abc`,
    'refs/pull/1492/merge',
    `refs/heads/gh-readonly-queue/main/pr--${base}`,
  ]) {
    const rejected = runWithFakeGh(script, routes({ args: cancelArgs(replacedOnThisBase.id) }), {
      ...environment,
      GITHUB_REF: ref,
    });
    expect(rejected.passed, ref).toBe(false);
    expect(rejected.calls, ref).toEqual([]);
  }
});

// 18 Nov: 44260932910 failed lint at 07:48:53 and left the queue at 08:00:52, 85 runner-minutes later.
it('stops a red merge queue run as soon as one early check fails, from jobs that run no repository code', () => {
  const { jobs } = readCancelWorkflow();
  const stops = Object.keys(jobs).filter((job) => job.startsWith('stop-red-queue-run-'));
  expect(new Set(stops)).toEqual(new Set(Object.keys(STOPPED_CHECKS)));
  for (const [stop, check] of Object.entries(STOPPED_CHECKS)) {
    const job = jobs[stop];
    // Started through its check alone, so it holds no runner while it waits and fires as that check ends.
    expect(job?.needs, stop).toEqual([check]);
    expect(job?.if, stop).toBe(
      expression(`!cancelled() && needs.${check}.result == 'failure' && github.event_name == 'merge_group'`),
    );
    expect(job?.permissions, stop).toEqual({ actions: 'write' });
    expect(
      job?.steps?.map(({ uses }) => uses),
      stop,
    ).toEqual([undefined]);
    expect(job?.steps?.[0]?.run, stop).toContain('"repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/cancel"');
  }
  // A matrix need waits for every row: the owner rows end with the run, so nothing would be saved.
  expect(Object.values(STOPPED_CHECKS)).not.toContain(OWNER_INTEGRATION_JOB);
  // The required check still reports on a cancelled run, red, so the queue removes the entry at once.
  expect(jobs['workspace-gates']?.if).toBe(expression('always()'));
  for (const [job, { needs }] of Object.entries(jobs)) {
    for (const stop of stops) {
      expect(needs ?? [], job).not.toContain(stop);
    }
  }
});

it('cancels only its own run and accepts a run that another stop already cancelled', () => {
  const script = readCancelWorkflow().jobs['stop-red-queue-run-after-lint']?.steps?.[0]?.run ?? 'exit 1';
  const environment = {
    GITHUB_REF: `refs/heads/${QUEUE_ENTRY_PREFIX}${QUEUE_BASES[0]}`,
    GITHUB_RUN_ID: String(QUEUE_RUN_ID),
  };
  const cancel = cancelArgs(QUEUE_RUN_ID);
  const stopped = runWithFakeGh(script, [{ args: cancel, stdout: '' }], environment);
  expect(stopped).toMatchObject({ calls: [cancel], passed: true });
  const already = runWithFakeGh(
    script,
    [{ args: cancel, exit: 1, stderr: 'gh: Cannot cancel a workflow run that is completed. (HTTP 409)\n' }],
    environment,
  );
  expect(already).toMatchObject({ calls: [cancel], passed: true });
  const refused = runWithFakeGh(
    script,
    [{ args: cancel, exit: 1, stderr: 'gh: Resource not accessible by integration (HTTP 403)\n' }],
    environment,
  );
  expect(refused).toMatchObject({ calls: [cancel], passed: false });
});

it('classifies documentation before installation and schedules full regression without enabling deployment', () => {
  const schema = Schema.Struct({
    jobs: Schema.Struct({
      [CI_PLAN_JOB]: Schema.Struct({ steps: Schema.Array(WorkflowStepSchema) }),
      'workspace-gates': Schema.Struct({ permissions: Schema.Record(Schema.String, Schema.String) }),
    }),
    on: Schema.Struct({
      schedule: Schema.Array(Schema.Struct({ cron: Schema.String })),
    }),
  });
  const workflow = Schema.decodeUnknownSync(schema)(readGateWorkflow());
  expect(workflow.on.schedule).toEqual([{ cron: '30 2 * * *' }]);
  expect(workflow.jobs['workspace-gates'].permissions).toEqual({ contents: 'read' });
  const { steps } = workflow.jobs[CI_PLAN_JOB];
  const classify = steps.findIndex(({ id }) => id === 'changes');
  const install = steps.findIndex(({ name }) => name === 'Install the app workspace for code impact analysis');
  const selection = steps.find(({ id }) => id === 'selection');
  expect(classify).toBeGreaterThan(-1);
  expect(install).toBe(-1);
  // WorkflowStepSchema omits uses-only metadata, but preserves the controlling if condition.
  expect(selection?.if).toBe("steps.changes.outputs.mode != 'docs' && steps.changes.outputs.mode != 'proven'");
  expect(selection?.env?.BOOTSTRAP_MODE).toBe(expression('steps.changes.outputs.mode'));
  // The planner selects from the changed paths on every run. A repository variable that has never
  // existed must not decide whether the selection applies: that silently planned the full matrix.
  const source = readFileSync(GATES_WORKFLOW_URL, 'utf-8');
  expect(source).not.toContain('CI_AFFECTED_ENABLED');
  expect(source).not.toContain('--apply-affected');
});

it('tells the planner whether a push has a merge queue from the queue-proof job, not from a branch name', () => {
  const plan = Schema.decodeUnknownSync(
    Schema.Struct({
      jobs: Schema.Struct({
        [CI_PLAN_JOB]: Schema.Struct({
          permissions: Schema.Record(Schema.String, Schema.String),
          steps: Schema.Array(
            Schema.Struct({
              env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
              id: Schema.optional(Schema.String),
              name: Schema.optional(Schema.String),
              with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
            }),
          ),
        }),
      }),
    }),
  )(readGateWorkflow()).jobs[CI_PLAN_JOB];
  // actions: read lists this workflow's push runs; nothing else is added to the read-only token.
  expect(plan.permissions).toEqual({ actions: 'read', contents: 'read' });
  const classify = plan.steps.find(({ id }) => id === 'changes');
  expect(classify?.env?.QUEUE_PROOF).toBe(expression('needs.queue-proof.result'));
  expect(classify?.env?.GH_TOKEN).toBe(expression('github.token'));
  // Two commits for a pull request and a push behind the queue as before; a merge group and a push the
  // queue-proof job skipped read the whole history, without file contents.
  const checkout = plan.steps.find(({ name }) => name === 'Checkout the exact comparison history');
  expect(checkout?.with?.['fetch-depth']).toBe(
    expression(
      "github.event_name != 'merge_group' && (github.event_name != 'push' || needs.queue-proof.result != 'skipped') && 2 || 0",
    ),
  );
  expect(checkout?.with?.filter).toBe('blob:none');
});

it('plans without app dependencies and publishes only the exact changed paths', () => {
  const { steps } = Schema.decodeUnknownSync(
    Schema.Struct({
      jobs: Schema.Struct({
        [CI_PLAN_JOB]: Schema.Struct({
          steps: Schema.Array(
            Schema.Struct({
              name: Schema.optional(Schema.String),
              uses: Schema.optional(Schema.String),
              with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
            }),
          ),
        }),
      }),
    }),
  )(readGateWorkflow()).jobs[CI_PLAN_JOB];
  const install = steps.find(({ name }) => name === 'Install the app workspace for code impact analysis');
  expect(install).toBeUndefined();
  expect(steps.some(({ uses }) => uses === INSTALL_APP_ACTION)).toBe(false);
  // Only the planner's changed-path list leaves this job; $RUNNER_TEMP is job-local.
  const publish = steps.find(({ name }) => name === 'Publish the exact changed-path list');
  expect(publish?.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/u);
  // A re-run of ci-plan replaces its own upload rather than failing on the existing artifact name.
  expect(publish?.with).toEqual({
    'if-no-files-found': 'warn',
    name: CHANGED_PATHS_ARTIFACT,
    overwrite: true,
    path: `${RUNNER_TEMP_EXPRESSION}/${CHANGED_PATHS_ARTIFACT}`,
    'retention-days': 1,
  });
});

/** Helper jobs that run a planned list, with the ci-plan output that lists their rows. */
const PLANNED_HELPERS = [
  [UNIT_AFTER_LINT_JOB, 'unitAfterLint'],
  [UNIT_AFTER_STATIC_JOB, 'unitAfterStatic'],
  [UNIT_AFTER_TOOLING_JOB, 'unitAfterTooling'],
  [OWNER_INTEGRATION_JOB, 'integrationOwners'],
  [BROWSER_INTEGRATION_JOB, 'integrationBrowser'],
] as const;

it('requires the exact CI plan and rejects missing, failed or unplanned skipped gates', () => {
  const gates = readTargetWorkflow().jobs['workspace-gates'];
  expect(gates.name).toBe('Workspace gates');
  expect(gates.if).toBe(expression('always()'));
  expect(gates.needs).toEqual([
    QUEUE_PROOF_JOB,
    CI_PLAN_JOB,
    WORKSPACE_GATE_JOB,
    SOURCE_CONTRACTS_JOB,
    WORKSPACE_UNIT_JOB,
    UNIT_AFTER_LINT_JOB,
    UNIT_AFTER_STATIC_JOB,
    UNIT_AFTER_TOOLING_JOB,
    STATIC_CONTRACTS_JOB,
    FORMAT_AND_LINT_JOB,
    SERVICE_INTEGRATION_JOB,
    BROWSER_INTEGRATION_JOB,
    OWNER_INTEGRATION_JOB,
    NODE_ARTIFACT_BUILD_JOB,
    TOPOLOGY_PROOF_JOB,
  ]);
  expect(gates.steps.at(-1)?.run).toBe('bash app/scripts/check-ci-gates.sh');
  const script = readFileSync(new URL('../check-ci-gates.sh', import.meta.url), 'utf-8');
  const needs = (mode: string, results: readonly string[], proof = 'skipped', proven?: string) => {
    const nothing = ['docs', 'proven'].includes(mode);
    // Every ci-plan output the verifier reads; a test may replace or drop any of them.
    const outputs: Record<string, string | undefined> = Object.fromEntries<string>([
      [
        'expected',
        JSON.stringify(Object.fromEntries(GATE_JOBS.map((gate) => [gate, nothing ? 'skipped' : 'success']))),
      ],
      ['mode', mode],
      ...PLANNED_HELPERS.map(([, output]): [string, string] => [output, nothing ? '[]' : '[{}]']),
    ]);
    return {
      [CI_PLAN_JOB]: { outputs, result: 'success' },
      [QUEUE_PROOF_JOB]: { outputs: proven === undefined ? {} : { proven }, result: proof },
      [SOURCE_CONTRACTS_JOB]: { result: nothing ? 'skipped' : 'success' },
      [TOPOLOGY_PROOF_JOB]: { result: nothing ? 'skipped' : 'success' },
      ...Object.fromEntries(PLANNED_HELPERS.map(([helper]) => [helper, { result: nothing ? 'skipped' : 'success' }])),
      ...Object.fromEntries(GATE_JOBS.map((gate, index) => [gate, { result: results[index] }])),
    };
  };
  const passed = GATE_JOBS.map(() => 'success');
  const skipped = GATE_JOBS.map(() => 'skipped');
  const passes = (
    value: Readonly<
      Record<
        string,
        {
          readonly outputs?: Readonly<Record<string, string | undefined>>;
          readonly result: string;
        }
      >
    >,
  ) => stepPasses(script, { NEEDS_JSON: JSON.stringify(value) });
  expect(passes(needs('full', passed))).toBe(true);
  for (const [helper, output] of PLANNED_HELPERS) {
    expect(passes({ ...needs('full', passed), [helper]: { result: 'failure' } }), helper).toBe(false);
    expect(passes({ ...needs('full', passed), [helper]: { result: 'skipped' } }), helper).toBe(false);
    expect(
      passes(Object.fromEntries(Object.entries(needs('full', passed)).filter(([job]) => job !== helper))),
      helper,
    ).toBe(false);
    const valid = needs('full', passed);
    for (const value of [undefined, '{}']) {
      expect(
        passes({
          ...valid,
          [CI_PLAN_JOB]: {
            ...valid[CI_PLAN_JOB],
            outputs: { ...valid[CI_PLAN_JOB].outputs, [output]: value },
          },
        }),
        helper,
      ).toBe(false);
    }
    // A helper whose list the plan left empty must be skipped, never run.
    const empty = needs('affected', passed);
    empty[CI_PLAN_JOB].outputs[output] = '[]';
    expect(passes({ ...empty, [helper]: { result: 'skipped' } }), helper).toBe(true);
    expect(passes({ ...empty, [helper]: { result: 'success' } }), helper).toBe(false);
  }
  expect(passes({ ...needs('full', passed), [TOPOLOGY_PROOF_JOB]: { result: 'failure' } })).toBe(false);
  expect(passes({ ...needs('full', passed), [SOURCE_CONTRACTS_JOB]: { result: 'failure' } })).toBe(false);
  expect(passes({ ...needs('full', passed), [SOURCE_CONTRACTS_JOB]: { result: 'skipped' } })).toBe(false);
  expect(
    passes(Object.fromEntries(Object.entries(needs('full', passed)).filter(([job]) => job !== TOPOLOGY_PROOF_JOB))),
  ).toBe(false);
  expect(passes(needs('docs', skipped))).toBe(true);
  expect(passes(needs('proven', skipped, 'success', 'true'))).toBe(true);
  expect(passes(needs('proven', skipped))).toBe(false);
  expect(passes(needs('full', skipped))).toBe(false);
  expect(passes(needs('full', ['failure', ...passed.slice(1)]))).toBe(false);
  expect(passes(needs('full', ['cancelled', ...passed.slice(1)]))).toBe(false);
  expect(passes(needs('full', passed, 'failure'))).toBe(false);
  const affected = needs('affected', passed);
  expect(passes(affected)).toBe(true);
  // An affected plan without integration work skips the database producer and every integration consumer.
  const noIntegration = needs('affected', passed);
  const selected = Object.fromEntries(
    GATE_JOBS.map((gate) => [gate, gate === SERVICE_INTEGRATION_JOB ? 'skipped' : 'success']),
  );
  noIntegration[CI_PLAN_JOB].outputs.expected = JSON.stringify(selected);
  noIntegration[CI_PLAN_JOB].outputs.integrationOwners = '[]';
  noIntegration[CI_PLAN_JOB].outputs.integrationBrowser = '[]';
  const integrationSkipped = {
    ...noIntegration,
    [BROWSER_INTEGRATION_JOB]: { result: 'skipped' },
    [OWNER_INTEGRATION_JOB]: { result: 'skipped' },
    [SERVICE_INTEGRATION_JOB]: { result: 'skipped' },
    [TOPOLOGY_PROOF_JOB]: { result: 'skipped' },
  };
  expect(passes(integrationSkipped)).toBe(true);
  expect(passes({ ...integrationSkipped, [TOPOLOGY_PROOF_JOB]: { result: 'success' } })).toBe(false);
  expect(passes(needs('affected', skipped))).toBe(false);
  expect(passes(needs('invented', passed))).toBe(false);
  const missing = needs('docs', skipped);
  missing[CI_PLAN_JOB].outputs.expected = '{}';
  expect(passes(missing)).toBe(false);
  const broken = needs('docs', skipped);
  broken[CI_PLAN_JOB].result = 'failure';
  expect(passes(broken)).toBe(false);
});

it('runs every job after the gates even when a merge-queue-proven run skipped them', () => {
  const { jobs } = Schema.decodeUnknownSync(GatedJobsSchema)(readGateWorkflow());
  const ancestors = (job: string): ReadonlySet<string> =>
    new Set((jobs[job]?.needs ?? []).flatMap((parent) => [parent, ...ancestors(parent)]));
  // A skipped ancestor skips a job whose `if` relies on the implicit success(), so every job that the
  // skipped gates precede must decide with !cancelled() (or always()) and check its own needs' results.
  const afterGates = Object.keys(jobs).filter((job) => GATE_JOBS.some((gate) => ancestors(job).has(gate)));
  for (const job of afterGates) {
    // The job name leads the subject, so a failure names the job.
    expect(`${job}: ${jobs[job]?.if ?? ''}`).toMatch(/^[a-z-]+: \$\{\{ (?:!cancelled\(\)|always\(\))/u);
  }
});

/** The Node build shards only build: their matrix carries a shard and its units, and nothing else. */
const NodeBuildJobSchema = Schema.Struct({
  env: Schema.Record(Schema.String, Schema.String),
  needs: Schema.Array(Schema.String),
  permissions: Schema.optional(Schema.Unknown),
  steps: Schema.Array(
    Schema.Struct({
      env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      id: Schema.optional(Schema.String),
      if: Schema.optional(Schema.String),
      name: Schema.String,
      run: Schema.optional(Schema.String),
      'timeout-minutes': Schema.optional(Schema.Number),
      uses: Schema.optional(Schema.String),
      wait: Schema.optional(Schema.String),
      with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
  strategy: Schema.Struct({
    matrix: Schema.Struct({
      include: Schema.Array(Schema.Struct({ name: Schema.String, shard: Schema.Number, units: Schema.String })),
    }),
  }),
  'timeout-minutes': Schema.Number,
});
const ArtifactBuildWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    [NODE_ARTIFACT_BUILD_JOB]: NodeBuildJobSchema,
  }),
});
const TopologyUnitsSchema = Schema.Struct({
  shell: Schema.Struct({ id: Schema.String, path: Schema.String }),
  verticals: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String })),
});

const sorted = (values: readonly string[]) => EffectArray.sort(values, Order.String);

it('builds every delivery unit of the topology in exactly one build shard of each target', () => {
  const { jobs } = Schema.decodeUnknownSync(ArtifactBuildWorkflowSchema)(readGateWorkflow());
  const topology = Schema.decodeUnknownSync(TopologyUnitsSchema)(
    JSON.parse(readFileSync(new URL('../../topology/reference-topology.json', import.meta.url), 'utf-8')),
  );
  const units = [topology.shell, ...topology.verticals].map((unit) => unit.path);
  for (const [job, script, shards] of [
    [NODE_ARTIFACT_BUILD_JOB, 'build', jobs[NODE_ARTIFACT_BUILD_JOB].strategy.matrix.include.map(({ shard }) => shard)],
  ] as const) {
    const { steps, strategy } = jobs[job];
    // Every shard builds units, and the target's shards build every unit once, with the target's script.
    expect(strategy.matrix.include.map(({ shard }) => shard)).toEqual(shards);
    expect(shards).toEqual(shards.map((_shard, index) => index + 1));
    const built = strategy.matrix.include.flatMap(({ units: shardUnits }) => shardUnits.split(/\s+/u).filter(Boolean));
    expect(sorted(built)).toEqual(sorted(units));
    expect(steps.some(({ run }) => run?.includes(`"\${filters[@]}" run ${script}\n`) === true)).toBe(true);
  }
});

const readArtifactBuildJobs = () => Schema.decodeUnknownSync(ArtifactBuildWorkflowSchema)(readGateWorkflow()).jobs;

it('builds, packs and uploads each Node build shard and does nothing else', () => {
  const { needs, permissions, steps, 'timeout-minutes': jobTimeout } = readArtifactBuildJobs()[NODE_ARTIFACT_BUILD_JOB];
  // A producer starts with the run and never waits for anything, so its runner frees as soon as it uploaded.
  expect(needs).toEqual([CI_PLAN_JOB]);
  expect(permissions).toBeUndefined();
  expect(steps.map(({ name }) => name)).toEqual([
    'Harden Runner',
    'Checkout',
    'Sample runner pressure until the job ends',
    INSTALL_APP_STEP,
    NODE_BUILD_STEP,
    "Pack the shard's build outputs",
    UPLOAD_STEP,
    'Print the runner pressure samples',
  ]);
  const upload = steps.find(({ name }) => name === UPLOAD_STEP);
  // The upload still fails rather than publishing an empty archive the consumers would silently trust, and a
  // re-run of a failed shard replaces its own archive instead of failing on the existing name.
  expect(upload?.if).toBeUndefined();
  expect(upload?.with).toEqual({
    'compression-level': 0,
    'if-no-files-found': 'error',
    name: `node-units-${expression(MATRIX_SHARD)}`,
    overwrite: true,
    path: `${RUNNER_TEMP_EXPRESSION}/units.tar.zst`,
    'retention-days': 1,
  });
  expect(jobTimeout).toBeLessThanOrEqual(20);
  // A shard row names its units and nothing an owner row runs.
  for (const row of fullPlanMatrices().integrationBuild) {
    expect(sorted(Object.keys(row))).toEqual(['name', 'shard', 'units']);
  }
});

it('builds every Node release from this commit rather than restoring another release identity', () => {
  const { env, steps, 'timeout-minutes': jobTimeout } = readArtifactBuildJobs()[NODE_ARTIFACT_BUILD_JOB];
  const build = steps.findIndex(({ name }) => name === NODE_BUILD_STEP);
  const pack = steps.findIndex(({ name }) => name === "Pack the shard's build outputs");
  const upload = steps.findIndex(({ name }) => name === UPLOAD_STEP);
  expect(build).toBeGreaterThan(-1);
  expect(build < pack && pack < upload).toBe(true);
  // Every consumer starts once every shard uploaded, so a slow build fails on its own bound instead of
  // holding back the run until the job's limit.
  expect(steps[build]?.['timeout-minutes']).toBe(10);
  expect(jobTimeout).toBeGreaterThan(10);
  expect(steps[build]?.run).toContain(`--workspace-concurrency=2 "\${filters[@]}" run build`);
  // The integration lanes' single-thread cap must not reach the compilers.
  expect(env.RAYON_NUM_THREADS).toBeUndefined();
  expect(steps[build]?.env).toMatchObject({
    NODE_OPTIONS: '--max-old-space-size=2048',
    ONTOS_CI_TYPECHECK_SEPARATE: '1',
    ULTRAMODERN_SOURCE_REVISION: CURRENT_SOURCE_REVISION,
  });
  expect(steps[pack]?.run).toContain('--file "$RUNNER_TEMP/units.tar.zst"');
});

// The integration jobs share their steps and number their rows from 0. A failure upload under a name the run
// already holds fails instead of keeping its evidence, so a second failing job or a failing re-run lost it.
it('names every failure-diagnostics upload per job, row and attempt', () => {
  const { jobs } = Schema.decodeUnknownSync(
    Schema.Struct({
      jobs: Schema.Record(
        Schema.String,
        Schema.Struct({
          steps: Schema.optional(
            Schema.Array(
              Schema.Struct({
                if: Schema.optional(Schema.String),
                uses: Schema.optional(Schema.String),
                with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
              }),
            ),
          ),
        }),
      ),
    }),
  )(readGateWorkflow());
  const names = new Map<string, string>();
  for (const [job, { steps = [] }] of Object.entries(jobs)) {
    for (const step of steps) {
      if (step.uses?.startsWith('actions/upload-artifact@') === true && step.if?.includes('failure()') === true) {
        names.set(`${job}: ${String(step.with?.name)}`, String(step.with?.name));
      }
    }
  }
  expect(names.size).toBeGreaterThanOrEqual(4);
  for (const [where, name] of names) {
    expect(name, where).toContain(expression('github.run_attempt'));
  }
  for (const job of [OWNER_INTEGRATION_JOB, SERVICE_INTEGRATION_JOB, BROWSER_INTEGRATION_JOB, TOPOLOGY_PROOF_JOB]) {
    expect(
      names.get(
        `${job}: native-startup-${expression('github.job')}-${expression('strategy.job-index')}-${expression('github.run_attempt')}`,
      ),
      job,
    ).toBeDefined();
  }
});

it('does not repeat the planner’s installed-workspace publication in the build matrix', () => {
  const { steps } = readArtifactBuildJobs()[NODE_ARTIFACT_BUILD_JOB];
  const install = steps.find(({ name }) => name === INSTALL_APP_STEP);
  expect(install?.with).toBeUndefined();
});

it('warms only reusable dependencies and typecheck state on main, never commit-bound releases', () => {
  const schema = Schema.Struct({
    jobs: Schema.Struct({
      'warm-caches': Schema.Struct({
        if: Schema.String,
        steps: Schema.Array(PublicationWorkflowStepSchema),
      }),
    }),
  });
  const warm = Schema.decodeUnknownSync(schema)(readGateWorkflow()).jobs['warm-caches'];
  expect(warm.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
  expect(warm.steps.find(({ name }) => name === INSTALL_APP_STEP)?.with).toMatchObject({
    'save-node-modules': 'true',
  });
  expect(warm.steps.some(({ run }) => (run ?? '').includes('run build'))).toBe(false);
  expect(warm.steps.some(({ run }) => (run ?? '').includes(TYPECHECK_COMMAND))).toBe(true);
});

// 18 Nov: the warmer ran on ubuntu-24.04 while ubuntu-latest had moved the gates to 26.04, so the toolchain
// and apt package entries it saved carried image names no gate job asked for.
it('warms the caches on the image of every gate job that restores them', () => {
  const schema = Schema.Struct({
    jobs: Schema.Record(
      Schema.String,
      Schema.Struct({
        needs: Schema.optional(Schema.Array(Schema.String)),
        'runs-on': Schema.optional(Schema.String),
        steps: Schema.optional(Schema.Array(Schema.Struct({ uses: Schema.optional(Schema.String) }))),
      }),
    ),
  });
  const source = readFileSync(GATES_WORKFLOW_URL, 'utf-8');
  const { jobs } = Schema.decodeUnknownSync(schema)(parse(source));
  const image = jobs['warm-caches']?.['runs-on'];
  const restorers = (jobs['workspace-gates']?.needs ?? []).filter((job) =>
    (jobs[job]?.steps ?? []).some(({ uses }) => uses === INSTALL_APP_ACTION),
  );
  expect(restorers.length).toBeGreaterThan(10);
  for (const job of restorers) {
    expect(jobs[job]?.['runs-on'], job).toBe(image);
  }
  // One label, written once: a job cannot follow a new image without the warmer following it too.
  expect(source.match(/runs-on: &gate-image /gu)).toHaveLength(1);
  expect(source.match(/runs-on: \*gate-image$/gmu)).toHaveLength(restorers.length);
});

it('saves no toolchain under a merge group ref, which no later run can read', () => {
  const schema = Schema.Struct({
    runs: Schema.Struct({
      steps: Schema.Array(
        Schema.Struct({
          name: Schema.optional(Schema.String),
          uses: Schema.optional(Schema.String),
          with: Schema.optional(Schema.Record(Schema.String, Schema.String)),
        }),
      ),
    }),
  });
  const action = Schema.decodeUnknownSync(schema)(
    parse(readFileSync(new URL('../../../.github/actions/install-app/action.yml', import.meta.url), 'utf-8')),
  );
  const mise = action.runs.steps.filter(({ uses }) => (uses ?? '').startsWith('jdx/mise-action@'));
  expect(mise.map((step) => step.with?.cache_save)).toEqual([expression("github.event_name != 'merge_group'")]);
});

const CommandMatrixJobSchema = Schema.Struct({
  steps: Schema.Array(PublicationWorkflowStepSchema),
  strategy: Schema.Struct({
    matrix: Schema.Struct({
      include: Schema.Array(
        Schema.Struct({
          commands: Schema.String,
          name: Schema.String,
          'node-artifacts': Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  }),
});
const GateCommandsWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    [FORMAT_AND_LINT_JOB]: Schema.Struct({
      steps: Schema.Array(
        Schema.Struct({
          env: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number]))),
          name: Schema.optional(Schema.String),
          run: Schema.optional(Schema.String),
          uses: Schema.optional(Schema.String),
          with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        }),
      ),
      strategy: Schema.optional(Schema.Unknown),
    }),
    [SOURCE_CONTRACTS_JOB]: Schema.Struct({
      steps: Schema.Array(
        Schema.Struct({
          env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
          name: Schema.optional(Schema.String),
        }),
      ),
    }),
    [STATIC_CONTRACTS_JOB]: Schema.Struct({
      steps: Schema.Array(
        Schema.Struct({
          if: Schema.optional(Schema.String),
          name: Schema.optional(Schema.String),
          parallel: Schema.optional(
            Schema.Array(
              Schema.Struct({ if: Schema.optional(Schema.String), name: Schema.String, run: Schema.String }),
            ),
          ),
          run: Schema.optional(Schema.String),
        }),
      ),
      strategy: Schema.Struct({ matrix: Schema.Struct({ row: Schema.Array(Schema.String) }) }),
    }),
    [UNIT_AFTER_LINT_JOB]: CommandMatrixJobSchema,
    [UNIT_AFTER_STATIC_JOB]: CommandMatrixJobSchema,
    [UNIT_AFTER_TOOLING_JOB]: CommandMatrixJobSchema,
    [WORKSPACE_GATE_JOB]: CommandMatrixJobSchema,
    [WORKSPACE_UNIT_JOB]: CommandMatrixJobSchema,
  }),
});
/** Every unit job: the row behind the source contracts and the rows that take the lint, static and tooling slots. */
const UNIT_JOBS = [WORKSPACE_UNIT_JOB, UNIT_AFTER_LINT_JOB, UNIT_AFTER_STATIC_JOB, UNIT_AFTER_TOOLING_JOB] as const;
const RootScriptsSchema = Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) });
/** A workspace package manifest, whose scripts a package may omit entirely. */
const PackageScriptsSchema = Schema.Struct({
  scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const readRootScripts = () =>
  Schema.decodeUnknownSync(RootScriptsSchema)(
    JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')),
  );

const readGateCommandJobs = () => Schema.decodeUnknownSync(GateCommandsWorkflowSchema)(readGateWorkflow()).jobs;
/** A step's command list, one command per line. */
const commandLines = (text: string) => text.split('\n').filter(Boolean);
const gateCommands = () => {
  const jobs = readGateCommandJobs();
  return [
    ...([WORKSPACE_GATE_JOB, ...UNIT_JOBS] as const).flatMap((job) =>
      jobs[job].strategy.matrix.include.map(({ commands }) => commandLines(commands)),
    ),
    ...jobs[SOURCE_CONTRACTS_JOB].steps.flatMap(({ env }) =>
      env?.COMMANDS === undefined ? [] : [commandLines(env.COMMANDS)],
    ),
  ];
};

it('verifies the exact Tunnel download and checksum before allowing a deployment', () => {
  const step = readGateCommandJobs()[STATIC_CONTRACTS_JOB].steps.find(
    ({ name }) => name === 'Verify the pinned Cloudflare Tunnel binary',
  );
  expect(step?.run).toContain('readFileSync("zerops.yaml", "utf8")');
  expect(step?.run).toContain(String.raw`service.build.buildCommands.join("\n")`);
  expect(step?.run).toContain('bash -euo pipefail -c "$commands"');
  expect(step?.run).toContain('app/.zerops/runtime/cloudflared/cloudflared --version');
  expect(step?.run).toContain('mktemp -d "$RUNNER_TEMP/ontos-cloudflared.XXXXXX"');
  expect(step?.run).toContain('trap \'rm -rf -- "$scratch"\' EXIT');
});

it('keeps every check in the source, unit or format gates without repeating the tooling pool', () => {
  const ruleChecks =
    readGateCommandJobs()[FORMAT_AND_LINT_JOB].steps.find(
      ({ name }) => name === 'Check lint rules and shared contract types',
    )?.run ?? '';
  // The one workspace compiler pass runs beside the lint, while the tooling tests hold their own runner.
  const typecheck = readGateCommandJobs()[FORMAT_AND_LINT_JOB].steps.find(
    ({ name }) => name === 'Typecheck the workspace',
  );
  expect(typecheck?.env).toEqual({ GOMEMLIMIT: '4GiB', ULTRAMODERN_TSGO_BUILDERS: '1' });
  const apiAndGeneration =
    readGateCommandJobs()[FORMAT_AND_LINT_JOB].steps.find(
      ({ name }) => name === 'Check OntOS APIs and generator behavior',
    )?.run ?? '';
  const commands = [
    ...apiAndGeneration
      .trim()
      .split('\n')
      .map((command) => command.replace(/^mise exec -- /u, '')),
    ...gateCommands().flat(),
    ...ruleChecks
      .trim()
      .split('\n')
      .map((command) => command.replace(/^mise exec -- /u, '')),
    ...(typecheck?.run ?? '')
      .trim()
      .split('\n')
      .map((command) => command.replace(/^mise exec -- /u, '')),
  ];
  for (const check of [
    TYPECHECK_COMMAND,
    'pnpm typecheck:lint-rules',
    'pnpm test:lint-rules',
    'pnpm lint:repository-policy',
    'pnpm api:check:ontos',
    'node scripts/generate-outbox-worker-deployment.mjs',
    'pnpm module-entrypoints:check',
    'node scripts/plan-deployment-impact.mts --outbox-worker-mode host',
    'pnpm test:generation',
    'pnpm --filter ./packages/shared-contracts test:types',
  ]) {
    expect(commands).toContain(check);
  }
  // One work-stealing tooling pool replaces two uneven count-based shards.
  // Its deployment tests also cover the former duplicate filtered invocation.
  const format = readGateCommandJobs()[FORMAT_AND_LINT_JOB];
  expect(format.steps.some(({ run }) => run?.includes(SCRIPTS_TEST_COMMAND) === true)).toBe(false);
  expect(commands.filter((command) => command.startsWith(SCRIPTS_TEST_COMMAND))).toEqual([SCRIPTS_TEST_COMMAND]);
  expect(commands.filter((command) => command === TYPECHECK_COMMAND)).toHaveLength(1);
  expect(commands).not.toContain('pnpm test:deployment-impact');
  const staticChecks = readGateCommandJobs()[STATIC_CONTRACTS_JOB].steps.flatMap(({ parallel, run }) =>
    parallel ? parallel.map((step) => step.run) : [run ?? ''],
  );
  expect(staticChecks).toContain('mise exec -- pnpm database-access:check');
});

it('runs every static contract check on exactly one row of the static contracts job', () => {
  const job = readGateCommandJobs()[STATIC_CONTRACTS_JOB];
  const rows = job.strategy.matrix.row;
  expect(rows).toEqual(['contracts']);
  expect(
    gateCommands()
      .flat()
      .filter((command) => command.endsWith(' pnpm api:check')),
  ).toEqual([]);
  const api = job.steps.flatMap(({ parallel }) => parallel ?? []).filter(({ run }) => run.includes(' pnpm api:check'));
  expect(api).toHaveLength(1);
  expect(api[0]?.run).toBe(
    'mise exec -- pnpm check:module-contracts\nNODE_OPTIONS=--max-old-space-size=6144 mise exec -- pnpm api:check\n',
  );
  // Every check, including each member of the parallel group, names exactly one row. A check with no
  // row condition would run on all of them, and one naming a row that does not exist would never run.
  const shared = new Set(['Harden Runner', 'Checkout', INSTALL_APP_STEP]);
  const checks = job.steps.flatMap(({ if: condition, name, parallel }) =>
    parallel ? parallel.map((step) => ({ condition: step.if, name: step.name })) : [{ condition, name: name ?? '' }],
  );
  const selected = new Map<string, readonly string[]>();
  for (const { condition, name } of checks) {
    if (shared.has(name)) {
      expect(condition, name).toBeUndefined();
      continue;
    }
    const named = rows.filter((row) => (condition ?? '').includes(`matrix.row == '${row}'`));
    expect(named, name).toHaveLength(1);
    selected.set(named[0] ?? '', [...(selected.get(named[0] ?? '') ?? []), name]);
  }
  // No row is empty: an empty row would only pay the install.
  expect(sorted([...selected.keys()])).toEqual(sorted([...rows]));
  // The i18n scanner walks source directories module contract generation mutates, so they share a row,
  // in that order.
  const i18nRow = [...selected.values()].find((names) => names.includes('I18n Boundaries')) ?? [];
  expect(i18nRow.indexOf('Module Contract Generation')).toBeGreaterThanOrEqual(0);
  expect(i18nRow.indexOf('Module Contract Generation')).toBeLessThan(i18nRow.indexOf('I18n Boundaries'));
});

it('restores same-run Node metadata for the unit shards that execute public contract fixtures', () => {
  const job = readGateCommandJobs()[WORKSPACE_UNIT_JOB];
  const rows = UNIT_JOBS.flatMap((unitJob) => readGateCommandJobs()[unitJob].strategy.matrix.include);
  const restored = rows.filter((entry) => entry['node-artifacts'] === true);
  // Which shards carry a package whose fixtures read published owner metadata follows the shard split,
  // so this is not a fixed list; every shard that opts in must still restore before it runs its tests.
  expect(restored).toEqual(rows);
  const download = job.steps.findIndex(
    ({ name }) => name === 'Download the same-run Node artifacts for unit contract fixtures',
  );
  const unpack = job.steps.findIndex(({ name }) => name === 'Unpack the Node artifacts for unit contract fixtures');
  const run = job.steps.findIndex(({ name }) => name === `Run ${expression('matrix.name')}`);
  expect(download !== -1 && download < unpack && unpack < run).toBe(true);
  expect(job.steps[download]?.if).toBe(UNIT_ARTIFACTS_CONDITION);
  expect(job.steps[download]?.uses).toBe('actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333');
  expect(job.steps[download]?.with).toEqual({
    path: `${RUNNER_TEMP_EXPRESSION}/native-composition-units`,
    pattern: NODE_BUILD_ARTIFACT_PATTERN,
  });
  expect(job.steps[unpack]?.if).toBe(UNIT_ARTIFACTS_CONDITION);
  expect(job.steps[unpack]?.['working-directory']).toBe('app');
  expect(job.steps[unpack]?.run).toBe(UNPACK_NATIVE_ARTIFACTS_COMMAND);
});

it('runs the root unit and component tests of every workspace package in exactly one shard', () => {
  const { scripts } = readRootScripts();
  // The shards run exactly what the root script runs, split by package.
  expect(scripts['test:unit']).toBe(
    'pnpm -r --no-sort --if-present run test:unit && pnpm -r --no-sort --if-present run test:component && pnpm --filter @app/shared-contracts test:types',
  );
  const shards = gateCommands().flatMap((commands) => {
    const [unit, component, ...rest] = commands;
    const match =
      /^pnpm -r --no-sort --workspace-concurrency=(?<packages>[1-4]) --if-present (?<filters>.+) run test:unit --pool.maxWorkers (?<workers>[1-4])$/u.exec(
        unit,
      );
    if (match?.groups === undefined) {
      return [];
    }
    const { filters = '', packages = '', workers = '' } = match.groups;
    expect(Number(packages) * Number(workers)).toBeLessThanOrEqual(4);
    // Each shard runs test:component over the same packages, after test:unit, and nothing else.
    expect(component).toBe(
      `pnpm -r --no-sort --workspace-concurrency=${packages} --if-present ${filters} run test:component --pool.maxWorkers ${workers}`,
    );
    expect(rest).toEqual([]);
    return [
      [...filters.matchAll(/--filter (?<filter>\S+)/gu)].map(({ groups }) => groups?.filter?.replaceAll("'", '') ?? ''),
    ];
  });
  // Every shard names exactly the packages it runs; none negates, so no shard silently inherits a
  // package a reshard forgot.
  const namedPackages = shards.flat();
  expect(namedPackages.every((filter) => !filter.startsWith('!'))).toBe(true);
  expect(new Set(namedPackages).size).toBe(namedPackages.length);
  for (const filter of namedPackages) {
    expect(filter).toMatch(/^\.\/(?:apps|packages|verticals)\/[a-z-]+$/u);
    expect(() => readFileSync(new URL(`../../${filter}/package.json`, import.meta.url))).not.toThrow();
  }
  // Resharding these commands is how a package falls out of the gate without anything failing, so every
  // package whose own manifest defines these tests must be named by some shard. `--if-present` makes a
  // named package without them a no-op, so naming one is allowed.
  const tested = (['apps', 'packages', 'verticals'] as const).flatMap((group) =>
    readdirSync(new URL(`../../${group}`, import.meta.url), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const manifest = new URL(`../../${group}/${entry.name}/package.json`, import.meta.url);
        if (!existsSync(manifest)) {
          return [];
        }
        const { scripts: own } = Schema.decodeUnknownSync(PackageScriptsSchema)(
          JSON.parse(readFileSync(manifest, 'utf-8')),
        );
        return own?.['test:unit'] === undefined && own?.['test:component'] === undefined
          ? []
          : [`./${group}/${entry.name}`];
      }),
  );
  expect(tested.filter((unit) => !namedPackages.includes(unit))).toEqual([]);
});

const IntegrationRunnerSchema = Schema.Struct({
  needs: Schema.Array(Schema.String),
  steps: Schema.Array(
    Schema.Struct({
      ...WorkflowStepSchema.fields,
      background: Schema.optional(Schema.Boolean),
      uses: Schema.optional(Schema.String),
      wait: Schema.optional(Schema.String),
      with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
  strategy: Schema.Struct({
    matrix: Schema.Struct({
      include: Schema.Array(
        Schema.Struct({
          lanes: Schema.optional(Schema.Literals([2, 4])),
          name: Schema.String,
          'native-composition': Schema.optional(Schema.Boolean),
          'proof-packages': Schema.optional(Schema.Array(Schema.String)),
          suite: Schema.Literals([BOOTSTRAP_SUITE, 'integration', 'browser', 'database']),
          tasks: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
    }),
  }),
});
const IntegrationShardsWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    [BROWSER_INTEGRATION_JOB]: IntegrationRunnerSchema,
    [OWNER_INTEGRATION_JOB]: IntegrationRunnerSchema,
    [SERVICE_INTEGRATION_JOB]: IntegrationRunnerSchema,
    [TOPOLOGY_PROOF_JOB]: IntegrationRunnerSchema,
  }),
});

/** The workspace packages whose integration files a row's tasks run. */
const shardFilters = (shard: { readonly tasks?: readonly string[] | undefined }) => [
  ...new Set(
    (shard.tasks ?? []).flatMap((task) => {
      const directory = taskDirectory(task);
      return directory === undefined ? [] : [`./${directory}`];
    }),
  ),
];
/** Whether a row runs root integration files. */
const rootRow = (shard: { readonly tasks?: readonly string[] | undefined }) =>
  (shard.tasks ?? []).some((task) => task.startsWith('root:'));

it('runs retained-release browser recovery separately with one worker and its publication flag enabled', () => {
  const source: unknown = readGateWorkflow();
  const { steps } = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(source).jobs[BROWSER_INTEGRATION_JOB];
  const normal = steps.findIndex(({ run }) => run === BROWSER_TEST_COMMAND);
  const recovery = steps.findIndex(({ env }) => env?.ONTOS_E2E_RETAINED_PARTY_R2 !== undefined);
  expect(normal).toBeGreaterThan(-1);
  expect(recovery).toBeGreaterThan(normal);
  expect(steps[recovery]?.if).toBe("matrix.suite == 'browser'");
  expect(steps[recovery]?.env).toEqual({ ONTOS_E2E_RETAINED_PARTY_R2: 'true' });
  expect(steps[recovery]?.run).toContain(
    "tests/e2e/login.spec.ts --grep 'reloads failed Contacts into a genuinely published R2'",
  );
  expect(steps[recovery]?.run).toContain('--workers 1');
});

it('publishes the verified database from its own producer and restores it only in jobs that need that producer', () => {
  const { jobs } = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(readGateWorkflow());
  const producer = jobs[SERVICE_INTEGRATION_JOB];
  const consumer = jobs[OWNER_INTEGRATION_JOB];
  // The producer only migrates, verifies, exports and uploads; the browser checks migrate their own database.
  expect(producer.needs).toEqual([CI_PLAN_JOB]);
  expect(producer.strategy.matrix.include.map(({ suite }) => suite)).toEqual(['database']);
  expect(jobs[BROWSER_INTEGRATION_JOB].needs).toEqual([CI_PLAN_JOB]);
  expect(jobs[BROWSER_INTEGRATION_JOB].strategy.matrix.include.map(({ suite }) => suite)).toEqual(['browser']);
  const { steps } = producer;
  const migrated = steps.findIndex(({ run }) => run?.includes('pnpm db:verify') === true);
  const exported = steps.findIndex(({ run }) => run === 'bash scripts/ci/export-integration-database.sh');
  const uploaded = steps.findIndex(({ with: inputs }) => inputs?.name === INTEGRATION_DATABASE_ARTIFACT);
  expect(migrated).toBeGreaterThan(-1);
  expect(migrated < exported && exported < uploaded).toBe(true);
  for (const step of [steps[exported], steps[uploaded]]) {
    expect(step?.if).toBe("matrix.suite == 'database'");
  }
  expect(steps[uploaded]?.with?.overwrite).toBe(true);
  // The owner rows need the producer, so the archive exists when they start. Empty clusters start first;
  // only the restore reads the archive, and the tests wait for that restore.
  expect(consumer.needs).toContain(SERVICE_INTEGRATION_JOB);
  const workers = consumer.steps.findIndex(({ run }) => run === START_INTEGRATION_WORKERS);
  const restore = consumer.steps.findIndex(({ id }) => id === INTEGRATION_WORKERS_STEP_ID);
  const restored = consumer.steps.findIndex(({ wait }) => wait === INTEGRATION_WORKERS_STEP_ID);
  const tests = consumer.steps.findIndex(({ env }) => env?.INTEGRATION_TASKS !== undefined);
  expect(workers).toBeGreaterThan(-1);
  expect(workers < restore && restore < restored && restored < tests).toBe(true);
  expect(consumer.steps[workers]?.env?.INTEGRATION_DATABASE_ARCHIVE).toBeUndefined();
  expect(consumer.steps[restore]?.background).toBe(true);
  expect(consumer.steps[restore]?.if).toBe(BACKEND_INTEGRATION_CONDITION);
  // Nothing tells the restore to wait: the archive exists when the row starts.
  expect(sorted(Object.keys(consumer.steps[restore]?.env ?? {}))).toEqual([
    'GH_TOKEN',
    'INTEGRATION_DATABASE_ARCHIVE',
    'ONTOS_CI_ISOLATED_WORKERS',
  ]);
  expect(consumer.steps[restore]?.env?.INTEGRATION_DATABASE_ARCHIVE).toBe(
    `${RUNNER_TEMP_EXPRESSION}/integration-database`,
  );
  // The download names this run's id, so it reads only this workflow run's archive.
  expect(consumer.steps[restore]?.run).toBe(
    [
      `gh run download "$GITHUB_RUN_ID" --repo "$GITHUB_REPOSITORY" --name ${INTEGRATION_DATABASE_ARTIFACT} --dir "$INTEGRATION_DATABASE_ARCHIVE"`,
      RESTORE_INTEGRATION_WORKERS,
      '',
    ].join('\n'),
  );
  expect(
    consumer.steps.some(
      ({ uses, with: inputs }) =>
        uses?.startsWith('actions/download-artifact@') === true && inputs?.name === INTEGRATION_DATABASE_ARTIFACT,
    ),
  ).toBe(false);
});

it('restores the archive only into clusters that already accept connections, after checking it', () => {
  const start = readFileSync(new URL('../ci/start-integration-workers.sh', import.meta.url), 'utf-8');
  const restore = readFileSync(new URL('../ci/restore-integration-workers.sh', import.meta.url), 'utf-8');
  // Starting needs no archive; every read of the archive happens in the restore.
  expect(start).not.toContain('INTEGRATION_DATABASE_ARCHIVE');
  expect(start).toContain('pg_isready');
  const checked = restore.indexOf('sha256sum --check checksums.sha256');
  const manifest = restore.indexOf('.revision == $revision');
  const restored = restore.indexOf('pg_restore');
  expect(checked).toBeGreaterThan(-1);
  expect(checked < manifest && manifest < restored).toBe(true);
});

it('supplies same-run built Composition to selected native owner integration shards before their tests', () => {
  const source: unknown = readGateWorkflow();
  const { jobs } = Schema.decodeUnknownSync(GatedJobsSchema)(source);
  const integrationJobs = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(source).jobs;
  const integration = integrationJobs[OWNER_INTEGRATION_JOB];
  // Every owner row starts only once every build shard and the database producer uploaded.
  expect(jobs[OWNER_INTEGRATION_JOB]?.needs).toEqual([CI_PLAN_JOB, NODE_ARTIFACT_BUILD_JOB, SERVICE_INTEGRATION_JOB]);
  const rows = integration.strategy.matrix.include;
  const selected = rows.filter((shard) => shard['native-composition'] === true);
  const rootShards = rows.filter((shard) => rootRow(shard));
  // Derived instead of a literal count, so a reshard cannot be "fixed" by editing a number here: every root
  // shard must derive the fresh Composition, the same row may carry named owners, and only integration
  // rows may carry it (a browser or proof row would have no Composition to derive).
  expect(selected.length).toBeGreaterThan(0);
  expect(selected.every(({ suite }) => suite === 'integration')).toBe(true);
  expect(selected.filter((shard) => rootRow(shard))).toEqual(rootShards);
  expect(selected.some((shard) => shardFilters(shard).includes('./verticals/pricing'))).toBe(true);
  expect(selected.some((shard) => shardFilters(shard).includes('./verticals/inventory'))).toBe(true);
  const { steps } = integration;
  const download = steps.findIndex(({ with: inputs }) => inputs?.pattern === NODE_BUILD_ARTIFACT_PATTERN);
  const unpack = steps.findIndex(({ run }) => run?.startsWith(UNPACK_NATIVE_ARTIFACTS_SCRIPT) === true);
  const derive = steps.findIndex(({ run }) => run?.includes('prove-build --snapshot-output') === true);
  const tests = steps.findIndex(({ env }) => env?.INTEGRATION_TASKS !== undefined);
  const workers = steps.findIndex(({ run }) => run === START_INTEGRATION_WORKERS);
  expect(workers).toBeGreaterThan(-1);
  expect(workers < download).toBe(true);
  expect(rows.flatMap((row) => row.tasks ?? []).filter((task) => task === 'whole:migrations')).toHaveLength(1);
  // Every integration job runs the same steps, each selecting its own by the row's suite.
  for (const job of [SERVICE_INTEGRATION_JOB, BROWSER_INTEGRATION_JOB, TOPOLOGY_PROOF_JOB] as const) {
    expect(integrationJobs[job].steps, job).toEqual(integration.steps);
  }
  expect(steps.some((step) => step.wait === 'scoped-migrations')).toBe(false);
  expect(download).toBeGreaterThan(-1);
  expect(download < unpack && unpack < derive && derive < tests).toBe(true);
  expect(steps[download]?.uses).toMatch(/^actions\/download-artifact@[a-f0-9]{40}$/u);
  // Omitting a repository, token and run-id keeps the download bound to this workflow run.
  expect(steps[download]?.with).toEqual({
    path: `${RUNNER_TEMP_EXPRESSION}/native-composition-units`,
    pattern: NODE_BUILD_ARTIFACT_PATTERN,
  });
  expect(steps[unpack]?.run).toBe(UNPACK_NATIVE_ARTIFACTS_COMMAND);
  expect(steps[derive]?.env).toEqual({ APP_ENV_PATH: '/dev/null' });
  expect(steps[download]?.if).toBe(BACKEND_ARTIFACT_CONDITION);
  expect(steps[unpack]?.if).toBe(BACKEND_ARTIFACT_CONDITION);
  expect(steps[derive]?.if).toBe('matrix.native-composition == true');
  expect(steps.filter(({ if: condition }) => condition === 'matrix.native-composition == true')).toHaveLength(1);
});

it('proves the built topology of every delivery unit in one row of the integration matrix', () => {
  const integration = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(readGateWorkflow()).jobs[
    TOPOLOGY_PROOF_JOB
  ];
  // One row proves all built outputs once every build shard uploaded; check-ci-gates.sh requires its success
  // whenever the service-integration gate is expected.
  expect(integration.needs).toEqual([CI_PLAN_JOB, NODE_ARTIFACT_BUILD_JOB]);
  const rows = integration.strategy.matrix.include.filter(({ suite }) => suite === NODE_PROOF_SUITE);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.tasks).toBeUndefined();
  expect(rows[0]?.['native-composition']).toBeUndefined();
  const { steps } = integration;
  const named = (name: string) => steps.findIndex((step) => step.name === name);
  const proofs = [
    'Generate federated types and check performance readiness over every unit',
    'Prove Node backend-federation artifacts',
    'Prove the active Application Composition publisher output decodes',
  ];
  const indexes = proofs.map(named);
  expect(indexes.some((index) => index === -1)).toBe(false);
  // mf:types precedes the proofs that read its output.
  expect(indexes).toEqual(EffectArray.sort(indexes, Order.Number));
  for (const index of indexes) {
    expect(`${steps[index]?.name ?? ''}: ${steps[index]?.if ?? ''}`).toBe(
      `${steps[index]?.name ?? ''}: ${NODE_PROOF_CONDITION}`,
    );
  }
  // Bootstrap migrates through the assembled stage entry point, not the source command.
  expect(named(BACKEND_ARTIFACT_UNPACK_STEP)).toBeLessThan(indexes[0] ?? -1);
  const migrations = named('Apply and verify Core, Auth, and Contacts migrations, plus Party Registry');
  expect(steps[migrations]?.if).toBe(NON_BOOTSTRAP_CONDITION);
  const bootstrap = named(BOOTSTRAP_MIGRATOR_STEP);
  expect(steps[bootstrap]?.if).toBe(BOOTSTRAP_CONDITION);
  expect(bootstrap).toBeLessThan(indexes[0] ?? -1);
  expect(migrations).toBeLessThan(indexes[0] ?? -1);
  expect(steps[named('Start fresh PostgreSQL and SpiceDB services')]?.if).toBe(
    "matrix.suite == 'bootstrap' || matrix.suite == 'browser' || matrix.suite == 'database'",
  );
  // The suites never run on this row, and its steps never run on a suite row.
  const tests = steps.find(({ env }) => env?.INTEGRATION_TASKS !== undefined);
  expect(tests?.if).toBe(BACKEND_INTEGRATION_CONDITION);
});

it('downloads the bootstrap Node artifacts after its fresh-database proofs, from shards it needs', () => {
  const { needs, steps } = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(readGateWorkflow()).jobs[
    TOPOLOGY_PROOF_JOB
  ];
  const named = (name: string) => steps.findIndex((step) => step.name === name);
  const download = named(BACKEND_ARTIFACT_DOWNLOAD_STEP);
  const unpack = named(BACKEND_ARTIFACT_UNPACK_STEP);
  // The bootstrap needs the build shards, so the artifacts exist when it starts and it never waits for them.
  expect(needs).toContain(NODE_ARTIFACT_BUILD_JOB);
  expect(steps[download]?.if).toBe(BACKEND_ARTIFACT_CONDITION);
  expect(steps[download]?.with).toEqual({
    path: `${RUNNER_TEMP_EXPRESSION}/native-composition-units`,
    pattern: NODE_BUILD_ARTIFACT_PATTERN,
  });
  expect(named(BOOTSTRAP_MIGRATOR_STEP)).toBeLessThan(download);
  expect(download).toBeLessThan(unpack);
  for (const step of steps) {
    if (step.wait !== undefined) {
      expect(step.if, step.name).toBeUndefined();
    }
  }
});

it('exports the publisher output path to native tests only after the readonly build proof succeeds', () => {
  const { steps } = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(readGateWorkflow()).jobs[
    SERVICE_INTEGRATION_JOB
  ];
  const derive = steps.find(({ run }) => run?.includes('prove-build --snapshot-output') === true);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-native-composition-step-'));
  try {
    for (const exitCode of [0, 37]) {
      const temporary = path.join(directory, String(exitCode));
      mkdirSync(temporary);
      const executable = path.join(temporary, 'mise');
      // This executable checks only the workflow's CLI boundary, not the publisher codec or native authority.
      writeFileSync(
        executable,
        `#!/bin/bash
set -euo pipefail
printf "%s\\n" "$@" > "$PUBLISHER_ARGUMENTS"
if [[ "$PUBLISHER_EXIT_CODE" != 0 ]]; then exit "$PUBLISHER_EXIT_CODE"; fi
printf "publisher-output" > "$7"
`,
      );
      chmodSync(executable, 0o755);
      const environmentFile = path.join(temporary, 'environment');
      const argumentsFile = path.join(temporary, 'arguments');
      writeFileSync(environmentFile, '');
      const passed = stepPasses(derive?.run ?? 'exit 1', {
        GITHUB_ENV: environmentFile,
        PATH: `${temporary}:${STEP_PATH}`,
        PUBLISHER_ARGUMENTS: argumentsFile,
        PUBLISHER_EXIT_CODE: String(exitCode),
        RUNNER_TEMP: temporary,
      });
      const snapshot = path.join(temporary, 'native-composition-snapshot.json');
      expect(passed).toBe(exitCode === 0);
      expect(readFileSync(argumentsFile, 'utf-8').trimEnd().split('\n')).toEqual([
        'exec',
        '--',
        'pnpm',
        'active-composition:publish',
        'prove-build',
        '--snapshot-output',
        snapshot,
      ]);
      expect(readFileSync(environmentFile, 'utf-8')).toBe(
        exitCode === 0 ? `NATIVE_1290_COMPOSITION_SNAPSHOT_PATH=${snapshot}\n` : '',
      );
      if (exitCode === 0) {
        expect(readFileSync(snapshot, 'utf-8')).toBe('publisher-output');
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

const APP_ROOT_URL = new URL('../../', import.meta.url);
/** Every file below an app directory with this suffix, relative to the app root. */
const integrationFiles = (directory: string, suffix: string): readonly string[] =>
  readdirSync(new URL(directory, APP_ROOT_URL), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => path.relative(fileURLToPath(APP_ROOT_URL), path.join(entry.parentPath, entry.name)));
/** Whole-owner files excluded from their family's shards, which run alone as whole tasks. */
const WHOLE_FILES = {
  './verticals/party-registry': ['verticals/party-registry/tests/integration/party-identity-runtime.test.ts'],
  './verticals/pricing': ['verticals/pricing/tests/integration/market-revision-whole-current-pricing-postgres.test.ts'],
  './verticals/privacy': ['verticals/privacy/tests/integration/privacy-composition-drain.test.ts'],
  root: [
    'scripts/integration/organization-source-customer-owner-conformance.test.mts',
    'scripts/integration/scoped-owner-migrations.test.mts',
  ],
} satisfies Readonly<Record<string, readonly string[]>>;
/** Integration files a sharded family runs, minus the files its whole-owner tasks run alone. */
const familyFiles = (family: string) =>
  (family === 'root'
    ? integrationFiles('scripts/integration', '.test.mts')
    : integrationFiles(`${family.slice(2)}/tests/integration`, '.test.ts')
  ).filter((file) => !Object.entries(WHOLE_FILES).some(([owner, files]) => owner === family && files.includes(file)));
const NATIVE_TOPOLOGY_PROOFS = [
  'whole:organization',
  'whole:privacy',
  'whole:pricing',
  'whole:preproposal-basis',
  'whole:preproposal-approval',
] as const;
const WHOLE_PROOFS = [...NATIVE_TOPOLOGY_PROOFS, 'whole:migrations', 'whole:party-worker'];
/** Every owner row of the complete plan. */
const integrationRows = () => {
  const { jobs } = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(readGateWorkflow());
  return jobs[OWNER_INTEGRATION_JOB].strategy.matrix.include.filter(({ suite }) => suite === 'integration');
};
/** Each sharded family's `k/n` shards, keyed by `root` or the package selector. */
const shardFamilies = (tasks: readonly string[]) => {
  const families = new Map<string, string[]>();
  for (const task of tasks) {
    const shard = /^(?<family>root|\.\/[a-z0-9/-]+)[:#](?<shard>\d+\/\d+)$/u.exec(task)?.groups;
    if (shard !== undefined) {
      families.set(shard.family ?? '', [...(families.get(shard.family ?? '') ?? []), shard.shard ?? '']);
    }
  }
  return families;
};

// Rstest sorts a family's files by hash and gives shard k of n its k-th slice. A row list that misses a
// k, repeats one or names more shards than files would silently skip or fail files, so every family's
// shards across the owner rows must be exactly 1..n with n no larger than its file count.
it('covers every integration file exactly once across the owner rows', () => {
  const { scripts } = readRootScripts();
  // The rows run exactly what the root script runs, split by file.
  expect(scripts['test:integration']).toBe(
    'rstest --project integration --pool.maxWorkers 1 && pnpm -r --no-sort --workspace-concurrency 1 --if-present run test:integration --pool.maxWorkers 1',
  );
  const tasks = integrationRows().flatMap((row) => row.tasks ?? []);
  expect(new Set(tasks).size).toBe(tasks.length);
  const families = shardFamilies(tasks);
  expect([...families.keys()]).toContain('root');
  for (const [family, shards] of families) {
    const count = Number(shards[0]?.split('/')[1]);
    expect(
      shards.every((shard) => shard.endsWith(`/${count}`)),
      family,
    ).toBe(true);
    expect(sorted(shards), family).toEqual(
      sorted(Array.from({ length: count }, (_, index) => `${index + 1}/${count}`)),
    );
    expect(count, family).toBeLessThanOrEqual(familyFiles(family).length);
  }
  // Every whole-owner proof and unsharded package runs once, and no package runs both whole and sharded.
  for (const whole of WHOLE_PROOFS) {
    expect(
      tasks.filter((task) => task === whole),
      whole,
    ).toHaveLength(1);
  }
  for (const task of tasks.filter((candidate) => taskDirectory(candidate) !== undefined && !candidate.includes('#'))) {
    expect(families.has(task), task).toBe(false);
  }
});

it('names every package integration suite and keeps native proofs one per runner', () => {
  const { jobs } = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(readGateWorkflow());
  const run = jobs[SERVICE_INTEGRATION_JOB].steps.find(({ env }) => env?.INTEGRATION_TASKS !== undefined);
  expect(run?.if).toBe(BACKEND_INTEGRATION_CONDITION);
  expect(run?.env).toMatchObject({
    APP_ENV_PATH: '/dev/null',
    ONTOS_CI_ISOLATED_WORKERS: '2',
    SPICEDB_DATABASE_PASSWORD: 'spicedb',
  });
  expect(run?.run?.trim()).toBe('bash scripts/ci/run-integration-suites.sh');
  const rows = integrationRows();
  // Every package whose own manifest defines an integration suite is named by some row.
  const namedPackages = [...new Set(rows.flatMap(shardFilters))];
  const tested = (['apps', 'packages', 'verticals'] as const).flatMap((group) =>
    readdirSync(new URL(`../../${group}`, import.meta.url), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const manifest = new URL(`../../${group}/${entry.name}/package.json`, import.meta.url);
        if (!existsSync(manifest)) {
          return [];
        }
        const { scripts: own } = Schema.decodeUnknownSync(PackageScriptsSchema)(
          JSON.parse(readFileSync(manifest, 'utf-8')),
        );
        return own?.['test:integration'] === undefined ? [] : [`./${group}/${entry.name}`];
      }),
  );
  expect(sorted(tested)).toEqual(sorted(namedPackages));
  // Native preproposal proofs supplement the ordinary package suites, one case per runner.
  const scheduler = readFileSync(new URL('../ci/run-integration-suites.sh', import.meta.url), 'utf-8');
  expect(scheduler).toContain(
    "exec timeout --kill-after=3s 20m mise exec -- pnpm --filter @app/commerce-customer-context run test:integration:native-preproposal -t 'produces an exact preproposal basis'",
  );
  const preproposalRows = rows.filter((row) => (row.tasks ?? []).some((task) => task.startsWith('whole:preproposal-')));
  expect(preproposalRows).toHaveLength(2);
  for (const row of preproposalRows) {
    expect(row['proof-packages']?.length ?? 0).toBeGreaterThan(0);
  }
  // A row never runs two native topology proofs side by side.
  for (const row of rows) {
    const native = (row.tasks ?? []).filter((task) => NATIVE_TOPOLOGY_PROOFS.some((proof) => proof === task));
    expect(native.length, row.name).toBeLessThanOrEqual(1);
  }
});

it('formats and lints the run’s changed files through the pre-commit hook, and never silently nothing', () => {
  const lint = readGateCommandJobs()[FORMAT_AND_LINT_JOB];
  // One row over the run's changed files: the whole-tree sweep only ever proved that committed files
  // are already formatted, which the same hook proves at commit time.
  expect(lint.strategy).toBeUndefined();
  const download = lint.steps.find(({ name }) => name === 'Download the exact changed-path list');
  expect(download?.with).toEqual({
    name: CHANGED_PATHS_ARTIFACT,
    path: `${RUNNER_TEMP_EXPRESSION}/ci-plan`,
  });
  const step = lint.steps.find(({ run }) => run?.includes('--files-from-stdin') === true);
  // ci-plan decides the sweep from the exact changed paths, so its successors can plan around it.
  expect(step?.env).toEqual({ LINT_SWEEP: expression('needs.ci-plan.outputs.lintSweep') });
  const run = step?.run ?? 'exit 1';
  // The hook sees the selected files, and a file it fixes fails the gate.
  expect(run).toContain('lefthook run pre-commit --files-from-stdin --no-auto-install');
  // A sweep goes through the hook as well: one `pnpm lint` over every file held every type program at once
  // and lost its runner.
  expect(run).not.toMatch(/pnpm lint$/mu);
  // Effect's tsgolint emits no Effect language-service diagnostics, so the step runs them itself.
  expect(run).toContain('mise exec --cd app -- pnpm lint:effect-diagnostics');
  expect(run.trimEnd().endsWith('git diff --exit-code HEAD')).toBe(true);
  const select = run.slice(0, run.indexOf('mise exec'));
  const sourceRepository = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-lint-selection-'));
  const repository = path.join(directory, 'repository');
  const nativeGit = '/usr/bin/git';
  /** Runs the selection with this changed-path list and returns the files the hook would receive. */
  const selectFiles = (changedPaths?: readonly string[], environment: Readonly<Record<string, string>> = {}) => {
    const planDirectory = path.join(directory, 'ci-plan');
    mkdirSync(planDirectory, { recursive: true });
    const list = path.join(planDirectory, CHANGED_PATHS_ARTIFACT);
    rmSync(list, { force: true });
    rmSync(path.join(directory, 'hook-files'), { force: true });
    if (changedPaths !== undefined) {
      writeFileSync(list, changedPaths.map((changed) => `${changed}\0`).join(''));
    }
    execFileSync('/bin/bash', ['-eo', 'pipefail', '-c', select], {
      cwd: repository,
      env: { LINT_SWEEP: 'changed', PATH: STEP_PATH, RUNNER_TEMP: directory, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return readFileSync(path.join(directory, 'hook-files'), 'utf-8').split('\0').filter(Boolean);
  };
  try {
    mkdirSync(repository);
    execFileSync(nativeGit, ['init', '--quiet', repository], { env: { PATH: STEP_PATH } });
    const sourcePaths = [
      '.github/workflows/ultramodern-workspace-gates.yml',
      'README.md',
      'app/package.json',
      CHANGED_SOURCE_PATH,
      LEFTHOOK_CONFIG,
    ];
    for (const file of sourcePaths) {
      const destination = path.join(repository, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(path.join(sourceRepository, file)));
    }
    // A name with a space, a newline or a glob character is a file name, never a pathspec pattern.
    const specialPaths = [
      'app/source/with spaces.ts',
      'app/source/with\nnewline.ts',
      'app/source/žluťoučký.ts',
      'app/source/star*.ts',
    ];
    const fixturePaths = [...Array.from({ length: 3 }, (_, index) => `app/source/file-${index}.ts`), ...specialPaths];
    for (const file of fixturePaths) {
      const destination = path.join(repository, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, 'export {};\n');
    }
    execFileSync(nativeGit, ['-C', repository, 'add', '--all'], { env: { PATH: STEP_PATH } });
    const untrackedPath = 'app/source/untracked-negative.ts';
    writeFileSync(path.join(repository, untrackedPath), 'export {};\n');
    const tracked = execFileSync(nativeGit, ['ls-files', '-z'], { cwd: repository, encoding: 'utf-8' })
      .split('\0')
      .filter(Boolean);
    expect(tracked).toHaveLength(sourcePaths.length + fixturePaths.length);
    expect(tracked).not.toContain(untrackedPath);
    // Exactly the changed files that this commit still tracks: a deleted or untracked path has nothing
    // to check, and nothing else rides along.
    expect(sorted(selectFiles([...specialPaths, 'app/removed.ts', untrackedPath]))).toEqual(sorted(specialPaths));
    // A sweep of every tracked file ignores the list; ci-plan selects it for tool configuration changes.
    expect(sorted(selectFiles([CHANGED_SOURCE_PATH], { LINT_SWEEP: 'all' }))).toEqual(sorted(tracked));
    // An empty list where the planner selected the changed files, a missing list and an unknown sweep fail.
    expect(() => selectFiles([])).toThrow();
    expect(() => selectFiles()).toThrow();
    expect(() => selectFiles([CHANGED_SOURCE_PATH], { LINT_SWEEP: 'none' })).toThrow();
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

const RUNTIME_IDENTITY_URLS = Object.fromEntries(
  DATABASE_IDENTITIES.filter(({ urlKey }) => urlKey !== 'DATABASE_URL').map(({ role, urlKey }) => [urlKey, role]),
);
const AUDIT_STEP = 'Audit runtime database identities against the checked-in grant manifest';
const IdentityGateJobSchema = Schema.Struct({
  // Unquoted placeholder IDs parse as numbers.
  env: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number]))),
  steps: Schema.Array(WorkflowStepSchema),
});
const IdentityGateJobsSchema = Schema.Struct({
  jobs: Schema.Struct({
    [SERVICE_INTEGRATION_JOB]: IdentityGateJobSchema,
  }),
});

it('gives every CI database tool a separate login per runtime identity and audits their grants', () => {
  const source = readFileSync(GATES_WORKFLOW_URL, 'utf-8');
  const { jobs } = Schema.decodeUnknownSync(IdentityGateJobsSchema)(parse(source));
  const integration = jobs[SERVICE_INTEGRATION_JOB];
  for (const [key, role] of Object.entries(RUNTIME_IDENTITY_URLS)) {
    expect(integration.env?.[key]).toBe(`postgresql://${role}:${role}@localhost:5433/ontos_ci`);
  }
  // The grant audit runs once per run, on the bootstrap row only, directly after the migrations that
  // provision the identities it audits. It reads no matrix input, so no other row repeats it.
  const { steps } = integration;
  const migrations = steps.findIndex(({ name }) => name.startsWith('Apply and verify Core, Auth, and Contacts'));
  const audit = steps.findIndex(({ name }) => name === AUDIT_STEP);
  expect(migrations).toBeGreaterThanOrEqual(0);
  expect(audit).toBe(migrations + 1);
  expect(steps[audit]?.if).toBe(BOOTSTRAP_CONDITION);
  expect(steps[audit]?.run).toBe('mise exec -- pnpm database-trust:audit');
  expect(steps.filter(({ run }) => (run ?? '').includes('database-trust:audit'))).toHaveLength(1);
});

it('proves the deployment bootstrap once, on a row beside the suites', () => {
  const { jobs } = Schema.decodeUnknownSync(IdentityGateJobsSchema)(readGateWorkflow());
  const { steps } = jobs[SERVICE_INTEGRATION_JOB];
  const names = steps.map(({ name }) => name);
  // Bootstrap ordering is proved end to end: the pre-seeded runtime role goes first, then the real
  // migrator artifact against the scratch cluster, then the migrations, the grant audit and the host.
  const order = [
    'Start fresh PostgreSQL and SpiceDB services',
    'Remove the pre-seeded runtime role to prove deployment bootstrap ordering',
    BOOTSTRAP_MIGRATOR_STEP,
    'Apply and verify Core, Auth, and Contacts migrations, plus Party Registry',
    AUDIT_STEP,
    'Build and run the Outbox Worker host artifact against the fresh database',
  ];
  expect(names.filter((name) => order.includes(name))).toEqual(order);
  // Each of the four proofs runs on the bootstrap row alone. Without that guard every row would pay them
  // again, which is the 72.8 machine-minutes per run this arrangement exists to remove; and the
  // runtime-role drop in particular would leave an ordinary row with no login for its own suites.
  const bootstrapOnly = [
    'Remove the pre-seeded runtime role to prove deployment bootstrap ordering',
    BOOTSTRAP_MIGRATOR_STEP,
    AUDIT_STEP,
    'Build and run the Outbox Worker host artifact against the fresh database',
  ];
  for (const name of bootstrapOnly) {
    const step = steps.find((candidate) => candidate.name === name);
    expect(step?.if, name).toBe(BOOTSTRAP_CONDITION);
  }
  // Bootstrap's assembled migrator already applies and verifies every owner. Other rows
  // prepare their own database once. Scoped-owner tests separately prove replay convergence.
  const migrations = steps.find(({ name }) => name.startsWith('Apply and verify Core, Auth, and Contacts'));
  expect(migrations?.if).toBe(NON_BOOTSTRAP_CONDITION);
  expect(steps.filter(({ run }) => (run ?? '').includes('pnpm db:migrate'))).toHaveLength(1);
  expect(steps.find(({ name }) => name === BACKEND_ARTIFACT_DOWNLOAD_STEP)?.if).toBe(BACKEND_ARTIFACT_CONDITION);
  expect(steps.find(({ name }) => name === BACKEND_ARTIFACT_UNPACK_STEP)?.if).toBe(BACKEND_ARTIFACT_CONDITION);
});

it.effect('proves Node artifacts against a migrated PostgreSQL database with every declared login identity', () =>
  Effect.gen(function* proveNodeDatabaseIdentities() {
    const { jobs } = Schema.decodeUnknownSync(IdentityGateJobsSchema)(readGateWorkflow());
    // The proof row migrates the compose cluster it starts itself, with the same identity URLs as the
    // suites, instead of the retired service container of the build job.
    const integration = jobs[SERVICE_INTEGRATION_JOB];
    const environment = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(integration.env);
    const admin = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(environment.DATABASE_ADMIN_URL);
    expect(admin.port).toBe(environment.POSTGRES_PORT);
    expect(admin.username).toBe(environment.POSTGRES_USER);
    expect(admin.password).toBe(environment.POSTGRES_PASSWORD);
    expect(admin.pathname).toBe(`/${environment.POSTGRES_DB ?? ''}`);
    const provision = integration.steps.findIndex(({ run }) => (run ?? '').includes('mise exec -- pnpm db:migrate'));
    const proof = integration.steps.findIndex(({ run }) => run === 'mise exec -- pnpm node:proof');
    expect(provision).toBeGreaterThanOrEqual(0);
    expect(provision).toBeLessThan(proof);
    expect(integration.steps[provision]?.if).toBe(NON_BOOTSTRAP_CONDITION);
    const bootstrap = integration.steps.findIndex(({ name }) => name === BOOTSTRAP_MIGRATOR_STEP);
    expect(integration.steps[bootstrap]?.if).toBe(BOOTSTRAP_CONDITION);
    expect(bootstrap).toBeGreaterThanOrEqual(0);
    expect(bootstrap).toBeLessThan(proof);
    expect(integration.steps[proof]?.if).toBe(NODE_PROOF_CONDITION);
    for (const identity of DATABASE_IDENTITIES) {
      const connection = yield* loadDatabaseConfig({ environment, envPath: '/dev/null', identity });
      expect(connection.user).toBe(identity.role);
      expect(connection.database).toBe(environment.POSTGRES_DB);
      expect(connection.host).toBe(admin.hostname);
      expect(connection.port).toBe(Number(admin.port));
    }
  }),
);

it('restores same-run Node artifacts for every backend integration fixture and excludes browser rows', () => {
  const source: unknown = readGateWorkflow();
  const { jobs } = Schema.decodeUnknownSync(GatedJobsSchema)(source);
  const integrationJobs = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(source).jobs;
  const integration = integrationJobs[OWNER_INTEGRATION_JOB];
  expect(jobs[OWNER_INTEGRATION_JOB]?.needs).toContain(NODE_ARTIFACT_BUILD_JOB);
  const ownerRows = integrationRows();
  const roots = ownerRows.filter((shard) => rootRow(shard));
  // Shard counts are reshard-dependent and their completeness is proved where the shard ids are checked
  // as a derived 1..n set; here the contract is only that these fixtures exist and are backend rows.
  expect(roots.length).toBeGreaterThan(0);
  expect(roots.every(({ suite }) => suite === 'integration')).toBe(true);
  const customerContext = ownerRows.filter((shard) => shardFilters(shard).includes(CUSTOMER_CONTEXT_SELECTOR));
  expect(customerContext.length).toBeGreaterThan(0);
  expect(customerContext.every(({ suite }) => suite === 'integration')).toBe(true);
  expect(integrationJobs[SERVICE_INTEGRATION_JOB].strategy.matrix.include.map(({ suite }) => suite)).toEqual([
    'database',
  ]);
  expect(integrationJobs[BROWSER_INTEGRATION_JOB].strategy.matrix.include.map(({ suite }) => suite)).toEqual([
    'browser',
  ]);
  expect(ownerRows).toEqual(integration.strategy.matrix.include);
  const { steps } = integration;
  const download = steps.findIndex(({ with: inputs }) => inputs?.pattern === NODE_BUILD_ARTIFACT_PATTERN);
  const unpack = steps.findIndex(({ run }) => run?.startsWith(UNPACK_NATIVE_ARTIFACTS_SCRIPT) === true);
  expect(steps.some(({ run }) => run?.includes('zerops:materialize --app commerce-customer-context') === true)).toBe(
    false,
  );
  const tests = steps.findIndex(({ env }) => env?.INTEGRATION_TASKS !== undefined);
  expect(download).toBeGreaterThan(-1);
  expect(download < unpack && unpack < tests).toBe(true);
  expect(steps[download]?.uses).toMatch(/^actions\/download-artifact@[a-f0-9]{40}$/u);
  // No run-id, repository or token override: the artifacts must belong to this workflow run.
  expect(steps[download]?.with).toEqual({
    path: `${RUNNER_TEMP_EXPRESSION}/native-composition-units`,
    pattern: NODE_BUILD_ARTIFACT_PATTERN,
  });
  expect(steps[unpack]?.run).toBe(UNPACK_NATIVE_ARTIFACTS_COMMAND);
  expect(steps[download]?.if).toBe(BACKEND_ARTIFACT_CONDITION);
  expect(steps[unpack]?.if).toBe(BACKEND_ARTIFACT_CONDITION);
  // Every owner row restores the same artifacts, which exist when it starts.
  const preproposal = ownerRows.filter((shard) =>
    (shard.tasks ?? []).some((task) => task.startsWith('whole:preproposal-')),
  );
  expect(preproposal).toHaveLength(2);
  expect(preproposal.every(({ suite }) => suite === 'integration')).toBe(true);
});

it('refuses root native integration when the same-run build archives are missing', () => {
  const integration = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(readGateWorkflow()).jobs[
    SERVICE_INTEGRATION_JOB
  ];
  const unpack = integration.steps.find(({ run }) => run?.startsWith(UNPACK_NATIVE_ARTIFACTS_SCRIPT) === true);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-native-artifact-step-'));
  try {
    const scripts = path.join(directory, 'scripts');
    mkdirSync(scripts);
    // Execute the actual workflow command and unpack helper in an isolated workspace with no archives.
    writeFileSync(
      path.join(scripts, 'unpack-unit-build-outputs.sh'),
      readFileSync(new URL('../unpack-unit-build-outputs.sh', import.meta.url), 'utf-8'),
    );
    expect(() =>
      execFileSync('/bin/bash', ['-eo', 'pipefail', '-c', unpack?.run ?? 'exit 0'], {
        cwd: directory,
        env: { PATH: STEP_PATH, RUNNER_TEMP: directory },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ).toThrow(/No shard build outputs/u);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

// The organisation's free plan runs 20 hosted jobs for every repository together, and the gates may hold at
// most 18 of them. The pull request's Quality Audit holds one while the first wave runs, so every job that
// starts with the run counts against 17, and every later job takes the slot of exactly one finished job.
it('starts at most 17 gate jobs and hands every finished slot to at most one later job', () => {
  const staticRows = readGateCommandJobs()[STATIC_CONTRACTS_JOB].strategy.matrix.row.length;
  for (const lintSweep of ['changed', 'all'] as const) {
    const plan = fullPlanMatrices(lintSweep);
    const lint = 1;
    const sourceContracts = 1;
    const producers = plan.integrationBuild.length + plan.integration.length;
    const first = producers + plan.integrationBrowser.length + plan.source.length + sourceContracts + staticRows + lint;
    expect(first, lintSweep).toBeLessThanOrEqual(17);
    // The owner rows and the bootstrap need the producers, so they take the producers' slots.
    expect(plan.integrationOwners.length + plan.integrationTopology.length, lintSweep).toBeLessThanOrEqual(producers);
    expect(plan.unit.length, lintSweep).toBeLessThanOrEqual(sourceContracts);
    expect(plan.unitAfterLint.length, lintSweep).toBeLessThanOrEqual(lint);
    expect(plan.unitAfterTooling.length, lintSweep).toBeLessThanOrEqual(plan.source.length);
    // A whole-tree lint keeps its slot for minutes, so its row follows the static contracts too. By then the
    // Quality Audit has ended, so the gates hold at most 18.
    expect(plan.unitAfterStatic.length, lintSweep).toBeLessThanOrEqual(staticRows + (lintSweep === 'all' ? 1 : 0));
  }
  expect(fullPlanMatrices('all').unitAfterLint).toEqual([]);
});

it('starts the producers with the run and every consumer in the slot its producers or predecessor free', () => {
  const all = Schema.decodeUnknownSync(GatedJobsSchema)(readGateWorkflow()).jobs;
  for (const job of [
    BROWSER_INTEGRATION_JOB,
    FORMAT_AND_LINT_JOB,
    NODE_ARTIFACT_BUILD_JOB,
    SERVICE_INTEGRATION_JOB,
    SOURCE_CONTRACTS_JOB,
    STATIC_CONTRACTS_JOB,
    WORKSPACE_GATE_JOB,
  ]) {
    expect(all[job]?.needs, job).toEqual([CI_PLAN_JOB]);
  }
  // The bootstrap and the owner rows always read what they need, so each of their producers must have succeeded.
  expect(all[TOPOLOGY_PROOF_JOB]?.needs).toEqual([CI_PLAN_JOB, NODE_ARTIFACT_BUILD_JOB]);
  expect(all[OWNER_INTEGRATION_JOB]?.needs).toEqual([CI_PLAN_JOB, NODE_ARTIFACT_BUILD_JOB, SERVICE_INTEGRATION_JOB]);
  for (const job of [TOPOLOGY_PROOF_JOB, OWNER_INTEGRATION_JOB]) {
    for (const producer of all[job]?.needs ?? []) {
      expect(all[job]?.if, `${job} needs ${producer}`).toContain(`needs.${producer}.result == 'success'`);
    }
  }
  for (const [job, predecessor, output] of [
    [WORKSPACE_UNIT_JOB, SOURCE_CONTRACTS_JOB, undefined],
    [UNIT_AFTER_LINT_JOB, FORMAT_AND_LINT_JOB, 'unitAfterLint'],
    [UNIT_AFTER_STATIC_JOB, STATIC_CONTRACTS_JOB, 'unitAfterStatic'],
    [UNIT_AFTER_TOOLING_JOB, WORKSPACE_GATE_JOB, 'unitAfterTooling'],
  ] as const) {
    expect(all[job]?.needs, job).toEqual([CI_PLAN_JOB, NODE_ARTIFACT_BUILD_JOB, predecessor]);
    // A failed or cancelled build shard never lets a unit row start on a partial set of Node artifacts.
    const planned = output === undefined ? '' : ` && needs.ci-plan.outputs.${output} != '[]'`;
    expect(all[job]?.if, job).toBe(
      expression(
        `!cancelled() && needs.ci-plan.result == 'success' && ${neededResult(NODE_ARTIFACT_BUILD_JOB)} && ${neededResult(predecessor)} && fromJSON(needs.ci-plan.outputs.expected)['${WORKSPACE_UNIT_JOB}'] == 'success'${planned}`,
      ),
    );
  }
  for (const [job, output] of [
    [OWNER_INTEGRATION_JOB, 'integrationOwners'],
    [BROWSER_INTEGRATION_JOB, 'integrationBrowser'],
  ] as const) {
    expect(all[job]?.if).toContain(`needs.ci-plan.outputs.${output} != '[]'`);
  }
  // The source contracts belong to the workspace-gate check and run whenever it does.
  expect(all[SOURCE_CONTRACTS_JOB]?.if).toBe(all[WORKSPACE_GATE_JOB]?.if);
});

it('starts every unit row only once the build shards uploaded and gives it no Actions API access', () => {
  const jobs = readGateCommandJobs();
  const gated = Schema.decodeUnknownSync(
    Schema.Struct({
      jobs: Schema.Record(
        Schema.String,
        Schema.Struct({
          needs: Schema.optional(Schema.Array(Schema.String)),
          permissions: Schema.optional(Schema.Unknown),
        }),
      ),
    }),
  )(readGateWorkflow()).jobs;
  for (const job of UNIT_JOBS) {
    const { steps } = jobs[job];
    const download = steps.findIndex(({ uses }) => uses?.startsWith(DOWNLOAD_ARTIFACT) === true);
    expect(download, job).toBeGreaterThan(-1);
    expect(steps[download]?.if, job).toBe(UNIT_ARTIFACTS_CONDITION);
    expect(gated[job]?.needs, job).toContain(NODE_ARTIFACT_BUILD_JOB);
    // A same-run download needs no API access; only a job that lists or polls the run would.
    expect(gated[job]?.permissions, job).toBeUndefined();
  }
});

/** A step as the run-wait rule reads it. */
const RuleStepSchema = Schema.Struct({
  if: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
  with: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      pattern: Schema.optional(Schema.String),
      'run-id': Schema.optional(Schema.String),
    }),
  ),
});
const RuleJobSchema = Schema.Struct({
  needs: Schema.optional(Schema.Array(Schema.String)),
  steps: Schema.optional(Schema.Array(RuleStepSchema)),
  // A planner matrix is an expression until readGateWorkflow expands it; only expanded rows name a suite.
  strategy: Schema.optional(
    Schema.Struct({ matrix: Schema.optional(Schema.Struct({ include: Schema.optional(Schema.Unknown) })) }),
  ),
});
const RuleWorkflowSchema = Schema.Struct({ jobs: Schema.Record(Schema.String, RuleJobSchema) });
type RuleWorkflow = typeof RuleWorkflowSchema.Type;
type RuleStep = typeof RuleStepSchema.Type;
const isSuiteRows = Schema.is(Schema.Array(Schema.Struct({ suite: Schema.optional(Schema.String) })));
const UPLOAD_ARTIFACT = 'actions/upload-artifact@';
/** A step that waits for jobs of a run: no job of the workflow may hold a runner for that. */
const RUN_WAITS = [/wait-for-[\w-]+\.sh/u, /gh run (?:watch|view)\b/u];
/**
 * A step that reads the jobs or artifacts of a run, or the repository's artifacts: what a poll for this run's
 * output reads. A run id held in a variable cannot be told apart from this run's, so any run counts.
 */
const RUN_READS = [/actions\/(?:artifacts\b|runs\/[^/\s"']+\/(?:artifacts|jobs|attempts))/u];
/** This run's id as a step script or an action input names it. */
const SAME_RUN_ID = /^["']?(?:\$\{?GITHUB_RUN_ID\}?|\$\{\{\s*github\.run_id\s*\}\})["']?$/u;
/** A `gh run download`; its run id may come before or after the options. */
const GH_RUN_DOWNLOAD = /gh run download(?<options>[^\n]*)/gu;
const DOWNLOAD_SELECTOR = /(?:--name|--pattern|-n|-p)[\s=]+["']?(?<selector>[^"'\s]+)/gu;
const SUITE_CLAUSE = /^matrix\.suite (?<operator>==|!=) '(?<suite>[a-z]+)'$/u;

/** An artifact name split at its wildcards and expressions; a name without any is exact. */
const artifactName = (name: string) => {
  const parts = name.split(/\$\{\{.*?\}\}|\*/u);
  return { exact: parts.length === 1, prefix: parts[0] ?? '', suffix: parts.at(-1) ?? '' };
};
/** Whether an uploaded artifact name can be a name that a download selector reads. */
const artifactMayMatch = (uploaded: string, selector: string) => {
  const upload = artifactName(uploaded);
  const download = artifactName(selector);
  if (upload.exact && download.exact) {
    return uploaded === selector;
  }
  return (
    (upload.prefix.startsWith(download.prefix) || download.prefix.startsWith(upload.prefix)) &&
    (upload.suffix.endsWith(download.suffix) || download.suffix.endsWith(upload.suffix))
  );
};
/** The artifacts a script downloads with `gh run download` from the run it runs in; `*` for every one. */
const scriptDownloads = (run: string) =>
  [...run.matchAll(GH_RUN_DOWNLOAD)]
    .filter(({ groups }) =>
      (groups?.options ?? '')
        .trim()
        .split(/\s+/u)
        .some((token) => SAME_RUN_ID.test(token)),
    )
    .flatMap(({ groups }) => {
      const selectors = [...(groups?.options ?? '').matchAll(DOWNLOAD_SELECTOR)].map(
        (match) => match.groups?.selector ?? '*',
      );
      return selectors.length === 0 ? ['*'] : selectors;
    });
/** The artifacts a step downloads from the run it runs in: names or patterns, `*` for every artifact. */
const sameRunDownloads = (step: RuleStep): readonly string[] => {
  if (step.uses?.startsWith(DOWNLOAD_ARTIFACT) !== true) {
    return scriptDownloads(step.run ?? '');
  }
  const runId = step.with?.['run-id'];
  return runId === undefined || SAME_RUN_ID.test(runId) ? [step.with?.name ?? step.with?.pattern ?? '*'] : [];
};
/** The scripts a step runs, read from the repository, so a wait cannot hide behind a script name. */
const stepScripts = (run: string) =>
  [...run.matchAll(/(?:^|\s)(?:bash|sh)\s+(?<script>(?:app\/)?scripts\/[\w./-]+\.sh)/gu)].flatMap(({ groups }) => {
    const script = groups?.script ?? '';
    const file = new URL(`../../${script.replace(/^app\//u, '')}`, import.meta.url);
    return existsSync(file) ? [{ script, source: readFileSync(file, 'utf-8') }] : [];
  });
/**
 * Whether a step runs on a job whose matrix rows have these suites. The integration jobs share one step list
 * and pick their steps by `matrix.suite`; any other condition is assumed to hold.
 */
const stepRunsOnSuites = (condition: string | undefined, suites: readonly (string | undefined)[]) => {
  if (condition === undefined) {
    return true;
  }
  const clauses = condition
    .replace(/^(?:failure|always)\(\) && /u, '')
    .split(' || ')
    .map((clause) => SUITE_CLAUSE.exec(clause)?.groups);
  if (clauses.some((clause) => clause === undefined)) {
    return true;
  }
  return suites.some((suite) => clauses.some((clause) => (clause?.operator === '==') === (suite === clause?.suite)));
};
/** The steps a job runs on at least one of its matrix rows. */
const runningSteps = (jobs: RuleWorkflow['jobs'], job: string) => {
  const include = jobs[job]?.strategy?.matrix?.include;
  const suites = isSuiteRows(include) && include.length > 0 ? include.map(({ suite }) => suite) : [undefined];
  return (jobs[job]?.steps ?? []).filter((step) => stepRunsOnSuites(step.if, suites));
};
/** Every job a job needs, directly or through a needed job. */
const neededJobs = (jobs: RuleWorkflow['jobs'], job: string, needed = new Set<string>()): ReadonlySet<string> => {
  for (const parent of jobs[job]?.needs ?? []) {
    if (!needed.has(parent)) {
      needed.add(parent);
      neededJobs(jobs, parent, needed);
    }
  }
  return needed;
};
interface RuleContext {
  readonly jobs: RuleWorkflow['jobs'];
  readonly uploads: readonly { readonly job: string; readonly name: string }[];
}
const pollViolations = (where: string, run: string, patterns: readonly RegExp[]) =>
  [{ script: 'the step', source: run }, ...stepScripts(run)]
    .filter(({ source }) => patterns.some((pattern) => pattern.test(source)))
    .map(({ script }) => `${where} waits for this run in ${script}`);
const downloadViolations = (context: RuleContext, job: string, where: string, selector: string) => {
  const producers = [
    ...new Set(context.uploads.filter(({ name }) => artifactMayMatch(name, selector)).map((upload) => upload.job)),
  ];
  if (producers.length === 0) {
    return [`${where} downloads ${selector}, which no job of this run uploads`];
  }
  const needed = neededJobs(context.jobs, job);
  // A job may read back what it uploaded itself in an earlier attempt.
  return producers
    .filter((producer) => producer !== job && !needed.has(producer))
    .map((producer) => `${where} downloads ${selector} from ${producer} without needing it`);
};
const stepViolations = (context: RuleContext, job: string, step: RuleStep, reads: boolean) => {
  const where = `${job}: ${step.name ?? step.uses ?? step.run ?? ''}`;
  if (!reads) {
    return pollViolations(where, step.run ?? '', RUN_WAITS);
  }
  return [
    ...pollViolations(where, step.run ?? '', [...RUN_WAITS, ...RUN_READS]),
    ...sameRunDownloads(step).flatMap((selector) => downloadViolations(context, job, where, selector)),
  ];
};

/**
 * Every way a job could hold a runner while it waits for output of another job of the same run: a step (or a
 * script it runs) that waits for jobs, one that reads a run's jobs or artifacts, and a same-run download whose
 * producing job is not among the job's needs, directly or through a needed job. Every job is checked for
 * waits; only the jobs `readScope` accepts are checked for reads and downloads. Every job counts as a producer.
 */
const runWaitViolations = ({ jobs }: RuleWorkflow, readScope: (job: string) => boolean): readonly string[] => {
  const uploads = Object.keys(jobs).flatMap((job) =>
    runningSteps(jobs, job).flatMap(({ uses, with: inputs }) =>
      uses?.startsWith(UPLOAD_ARTIFACT) === true && inputs?.name !== undefined ? [{ job, name: inputs.name }] : [],
    ),
  );
  return Object.keys(jobs).flatMap((job) =>
    runningSteps(jobs, job).flatMap((step) => stepViolations({ jobs, uploads }, job, step, readScope(job))),
  );
};
const everyJob = () => true;

// Run 44227243390 and its neighbours: on 20 hosted runners for the whole organisation, seven runs filled every
// runner with jobs that had taken one and then polled for builds that had none, until the 30-minute limit.
it('holds no runner while a job waits for output of another job of the same run', () => {
  const workflow = Schema.decodeUnknownSync(RuleWorkflowSchema)(readGateWorkflow());
  // No job waits for jobs: every job is checked for reads and downloads too.
  for (const job of [NODE_ARTIFACT_BUILD_JOB, OWNER_INTEGRATION_JOB, TOPOLOGY_PROOF_JOB]) {
    expect(Object.keys(workflow.jobs)).toContain(job);
  }
  expect(runWaitViolations(workflow, everyJob)).toEqual([]);
  expect(existsSync(new URL('../wait-for-build-shards.sh', import.meta.url))).toBe(false);
});

const fixtureUpload = (name: string): RuleStep => ({ uses: 'actions/upload-artifact@pin', with: { name } });
const fixtureDownload = (inputs: RuleStep['with']): RuleStep => ({
  uses: 'actions/download-artifact@pin',
  with: inputs,
});
const onSuite = (suite: string, step: RuleStep): RuleStep => ({ ...step, if: `matrix.suite == '${suite}'` });
const suiteRow = (suite: string) => ({ matrix: { include: [{ suite }] } });
const FIXTURE_DOWNLOAD_UNIT = `gh run download "$GITHUB_RUN_ID" --name units-1 --dir out`;
const FIXTURE_DOWNLOAD_UNIT_LAST = `gh run download --name units-1 --dir out "$GITHUB_RUN_ID"`;

it('finds every job that polls its own run or downloads an artifact its needs do not produce', () => {
  // Two jobs share one step list, as the integration jobs do; each runs only the steps of its suites.
  const shared = [
    onSuite('database', fixtureUpload(INTEGRATION_DATABASE_ARTIFACT)),
    onSuite('integration', fixtureDownload({ name: INTEGRATION_DATABASE_ARTIFACT })),
  ];
  const owners = { needs: ['plan'], steps: shared, strategy: suiteRow('integration') };
  const workflow: RuleWorkflow = {
    jobs: {
      // Needs a job that does not need the shards.
      around: { needs: ['early'], steps: [{ run: FIXTURE_DOWNLOAD_UNIT }] },
      build: { needs: ['plan'], steps: [fixtureUpload(`units-${expression('matrix.shard')}`)] },
      database: { needs: ['plan'], steps: shared, strategy: suiteRow('database') },
      // Needs only the plan, so it would start while the shards still build.
      early: { needs: ['plan'], steps: [fixtureDownload({ pattern: 'units-*' })] },
      // Another run's artifact is not this run's output.
      elsewhere: {
        steps: [fixtureDownload({ name: INTEGRATION_DATABASE_ARTIFACT, 'run-id': expression('inputs.run') })],
      },
      // Every artifact of the run, the database archive among them.
      everything: { needs: ['build'], steps: [fixtureDownload({})] },
      later: { needs: ['build'], steps: [fixtureDownload({ name: 'units-2' })] },
      missing: { needs: ['build', 'database'], steps: [fixtureDownload({ name: 'never-uploaded' })] },
      owners,
      plan: { steps: [{ run: 'echo plan' }] },
      // Takes a runner and then reads the run's jobs and artifacts until they are there.
      poller: {
        needs: ['plan'],
        steps: [
          { name: 'Wait', run: "bash scripts/wait-for-build-shards.sh 'Build x (' 3" },
          { name: 'Poll', run: 'gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/artifacts"' },
          { name: 'Watch', run: 'gh run watch "$GITHUB_RUN_ID"' },
          // The repository's artifact list filtered by this run, and this run's id held in a variable.
          { name: 'Repository', run: 'gh api "repos/$GITHUB_REPOSITORY/actions/artifacts?name=units-1"' },
          { name: 'Variable', run: 'run="$GITHUB_RUN_ID"\ngh api "repos/$GITHUB_REPOSITORY/actions/runs/$run/jobs"' },
        ],
      },
      // Names this run's id after the options.
      reordered: { needs: ['plan'], steps: [{ run: FIXTURE_DOWNLOAD_UNIT_LAST }] },
      // A job may read back its own upload of an earlier attempt.
      retry: { steps: [fixtureDownload({ name: 'own-plan' }), fixtureUpload('own-plan')] },
      // Names this run's id as the action's run id.
      sameRun: {
        needs: ['plan'],
        steps: [fixtureDownload({ name: 'units-1', 'run-id': expression('github.run_id') })],
      },
      // Needs a job that needs the shards: the artifacts exist when it starts.
      through: { needs: ['later'], steps: [{ run: FIXTURE_DOWNLOAD_UNIT }] },
    },
  };
  const ownersWithoutDatabase =
    'owners: actions/download-artifact@pin downloads integration-database from database without needing it';
  expect(runWaitViolations(workflow, everyJob)).toEqual([
    `around: ${FIXTURE_DOWNLOAD_UNIT} downloads units-1 from build without needing it`,
    'early: actions/download-artifact@pin downloads units-* from build without needing it',
    'everything: actions/download-artifact@pin downloads * from database without needing it',
    'everything: actions/download-artifact@pin downloads * from retry without needing it',
    'missing: actions/download-artifact@pin downloads never-uploaded, which no job of this run uploads',
    ownersWithoutDatabase,
    'poller: Wait waits for this run in the step',
    'poller: Poll waits for this run in the step',
    'poller: Watch waits for this run in the step',
    'poller: Repository waits for this run in the step',
    'poller: Variable waits for this run in the step',
    `reordered: ${FIXTURE_DOWNLOAD_UNIT_LAST} downloads units-1 from build without needing it`,
    'sameRun: actions/download-artifact@pin downloads units-1 from build without needing it',
  ]);
  // The owners of the shared step list are fine once they need the database producer.
  expect(
    runWaitViolations({ jobs: { ...workflow.jobs, owners: { ...owners, needs: ['database'] } } }, everyJob),
  ).not.toContain(ownersWithoutDatabase);
  // A job outside the read scope may read the run's artifacts, but it may still never wait for jobs.
  expect(runWaitViolations(workflow, (job) => job !== 'poller').filter((line) => line.startsWith('poller'))).toEqual([
    'poller: Wait waits for this run in the step',
    'poller: Watch waits for this run in the step',
  ]);
});

it('runs excluded whole-owner scenarios exactly once in isolated integration lanes', () => {
  const { jobs } = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(readGateWorkflow());
  const scheduler = readFileSync(new URL('../ci/run-integration-suites.sh', import.meta.url), 'utf-8');
  const excluded = ['whole:organization', 'whole:pricing', 'whole:privacy'];
  const proofs = integrationRows()
    .flatMap((row) => row.tasks ?? [])
    .filter((task) => excluded.includes(task));
  expect(sorted(proofs)).toEqual(excluded);
  for (const file of [
    'scripts/integration/organization-source-customer-owner-conformance.test.mts',
    'tests/integration/market-revision-whole-current-pricing-postgres.test.ts',
    'tests/integration/privacy-composition-drain.test.ts',
  ]) {
    expect(scheduler).toContain(`--exclude ${file}`);
    expect(jobs[SERVICE_INTEGRATION_JOB].steps.some(({ run }) => run?.includes(file) === true)).toBe(false);
    expect(scheduler).toContain(file);
  }
  const run = jobs[SERVICE_INTEGRATION_JOB].steps.find(({ env }) => env?.INTEGRATION_TASKS !== undefined);
  expect(run?.env?.INTEGRATION_TASKS).toBe(expression('toJSON(matrix.tasks)'));
});
