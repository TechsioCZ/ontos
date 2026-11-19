import { execFileSync, spawnSync } from 'node:child_process';
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

import { Array as EffectArray, Effect, Order, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

import { DATABASE_IDENTITIES } from '../../database/identity-enrollment.ts';
import { parseCiMatrices, taskDirectory } from '../ci/ci-matrices.mts';
import { loadDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';

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

const GATES_WORKFLOW = 'ultramodern-workspace-gates.yml';
const GATES_WORKFLOW_URL = new URL(`../../../.github/workflows/${GATES_WORKFLOW}`, import.meta.url);
const CI_PLAN_JOB = 'ci-plan';
const WORKSPACE_UNIT_JOB = 'workspace-unit';
const WORKSPACE_UNIT_ARTIFACTS_JOB = 'workspace-unit-artifacts';
const SERVICE_INTEGRATION_JOB = 'service-integration';
const BROWSER_INTEGRATION_JOB = 'browser-integration';
const OWNER_INTEGRATION_JOB = 'owner-integration';
const NODE_TOPOLOGY_PROOF_JOB = 'node-topology-proof';
const WORKSPACE_GATE_JOB = 'workspace-gate';
const WEIGHTED_SHARD_SCRIPT = 'scripts/ci/rstest-weighted-shard.sh';
const START_INTEGRATION_WORKERS = 'bash scripts/ci/start-integration-workers.sh';
const RESTORE_INTEGRATION_WORKERS = 'bash scripts/ci/restore-integration-workers.sh';
const INTEGRATION_WORKERS_STEP_ID = 'integration-workers';
const INTEGRATION_DATABASE_ARTIFACT = 'integration-database';
const CUSTOMER_CONTEXT_SELECTOR = './verticals/commerce-customer-context';
const INSTALL_APP_STEP = 'Install the app workspace';
const SOURCE_MIGRATIONS_STEP = 'Apply and verify Core, Auth, and Contacts migrations, plus Party Registry';
const INTEGRATION_TESTS_STEP =
  'Run database, RLS, Action, authorization, identity, Outbox, module-state, Shell, and Contacts integration tests, including Party Registry';
const WORKSPACE_GATES_JOB = 'workspace-gates';
const DOWNLOAD_ARTIFACT_ACTION = 'actions/download-artifact@';
const INITIALIZE_IDENTITIES_STEP = 'Initialize fresh local database login identities';
const ASSEMBLED_MIGRATOR_STEP = 'Run the assembled stage migrator artifact against the fresh database';
const WORKER_PROVISION_STEP = 'Provision the worker host runtime and Bun that the app artifact ships';
const WORKER_PROOF_STEP = 'Build and run the Outbox Worker host artifact against the fresh database';
const MATRIX_SHARD = 'matrix.shard';
const QUALITY_AUDIT_WORKFLOW = 'quality-audit.yml';
const LEFTHOOK_CONFIG = 'lefthook.yml';
const CACHE_SAVE_ACTION = 'actions/cache/save@';
const INSTALL_APP_ACTION = './.github/actions/install-app';
const WHOLE_TREE_LINT_SHARDS = 'shards=[1,2,3]';
/** The overlay the gates workflow binds (CI_MATRICES_OVERLAY of its env), so the tests plan from what the gates run. */
const MATRICES_OVERLAY = Schema.decodeUnknownSync(
  Schema.Struct({ env: Schema.Struct({ CI_MATRICES_OVERLAY: Schema.NonEmptyString }) }),
)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8'))).env.CI_MATRICES_OVERLAY;
/** The matrices the gates plan from (scripts/ci/ci-matrices.mts). */
const MATRICES = Result.getOrThrow(
  parseCiMatrices(
    readFileSync(new URL('../ci-matrices.json', import.meta.url), 'utf-8'),
    readFileSync(new URL(`../../${MATRICES_OVERLAY}`, import.meta.url), 'utf-8'),
  ),
);

const MatrixRowsSchema = Schema.Array(Schema.Record(Schema.String, Schema.Unknown));
const MatricesFileSchema = Schema.Struct({
  integration: MatrixRowsSchema,
  source: MatrixRowsSchema,
  unit: MatrixRowsSchema,
});

/** Expand only matrix references for the full-run contract tests; separately test the actual planner. */
const readGateWorkflow = () => {
  const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
  const workflow = record(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')));
  const jobs = { ...record(workflow.jobs) };
  const matrices = Schema.decodeUnknownSync(MatricesFileSchema)(MATRICES);
  // The planner hands each matrix job only its own rows (scripts/plan-ci-checks.mts).
  for (const [job, key, rows] of [
    [WORKSPACE_GATE_JOB, 'source', matrices.source],
    [WORKSPACE_UNIT_JOB, 'unit', matrices.unit.filter((row) => row['node-artifacts'] !== true)],
    [WORKSPACE_UNIT_ARTIFACTS_JOB, 'unit-artifacts', matrices.unit.filter((row) => row['node-artifacts'] === true)],
    [SERVICE_INTEGRATION_JOB, 'integration', [{ name: 'Prepare integration database', suite: 'database' }]],
    [OWNER_INTEGRATION_JOB, 'integrationOwners', matrices.integration.filter((row) => row.suite === 'integration')],
    [BROWSER_INTEGRATION_JOB, 'integrationBrowser', matrices.integration.filter((row) => row.suite === 'browser')],
    [NODE_TOPOLOGY_PROOF_JOB, 'integrationTopology', matrices.integration.filter((row) => row.suite === 'bootstrap')],
  ] as const) {
    const entry = record(jobs[job]);
    const strategy = record(entry.strategy);
    const matrix = record(strategy.matrix);
    expect(matrix.include).toBe(`\${{ fromJSON(needs.ci-plan.outputs.${key}) }}`);
    jobs[job] = { ...entry, strategy: { ...strategy, matrix: { ...matrix, include: rows } } };
  }
  // ci-plan picks the lint shards; a complete run keeps the three whole-tree shards.
  const lint = record(jobs['format-and-lint']);
  const lintStrategy = record(lint.strategy);
  expect(record(lintStrategy.matrix).shard).toBe(`\${{ fromJSON(needs.ci-plan.outputs.lint-shards) }}`);
  jobs['format-and-lint'] = { ...lint, strategy: { ...lintStrategy, matrix: { shard: [1, 2, 3] } } };
  return { ...workflow, jobs };
};
/** The fixed system PATH a workflow step script runs with in these tests. */
const STEP_PATH = '/usr/bin:/bin';

const skipsGates = (changedPaths: readonly string[], ignored: readonly string[]) =>
  changedPaths.every((changedPath) => ignored.some((pattern) => path.matchesGlob(changedPath, pattern)));

const ROOT_DOCUMENTATION_TRIGGERS = [
  readWorkflow(GATES_WORKFLOW).on.push,
  readWorkflow(QUALITY_AUDIT_WORKFLOW).on.push,
  readWorkflow(QUALITY_AUDIT_WORKFLOW).on.pull_request,
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
const WorkflowStepSchema = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  id: Schema.optional(Schema.String),
  if: Schema.optional(Schema.String),
  name: Schema.String,
  run: Schema.optional(Schema.String),
  'timeout-minutes': Schema.optional(Schema.Number),
});

/** The gates workflow's merge-queue proof job, as the CI-plan tests read it. */
const TargetWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    'queue-proof': Schema.Struct({
      if: Schema.String,
      outputs: Schema.Record(Schema.String, Schema.String),
      permissions: Schema.Record(Schema.String, Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
    }),
    [WORKSPACE_GATES_JOB]: Schema.Struct({
      if: Schema.String,
      name: Schema.String,
      needs: Schema.Array(Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
    }),
  }),
});
const readTargetWorkflow = () => Schema.decodeUnknownSync(TargetWorkflowSchema)(readGateWorkflow());

const QUEUE_PROOF_JOB = 'queue-proof';
const NODE_ARTIFACT_BUILD_JOB = 'node-artifact-build';
const NODE_BUILD_ARTIFACT_PATTERN = 'node-units-*';
const RUNNER_TEMP_EXPRESSION = expression('runner.temp');
const UNPACK_NATIVE_ARTIFACTS_SCRIPT = 'bash scripts/unpack-unit-build-outputs.sh';
/** Consumers pass the units their row names in `artifact-units`; an empty list requires every unit. */
const UNPACK_NATIVE_ARTIFACTS_COMMAND = `${UNPACK_NATIVE_ARTIFACTS_SCRIPT} "$RUNNER_TEMP/native-composition-units" .output $REQUIRED_UNITS`;
const BACKEND_INTEGRATION_CONDITION = "matrix.suite == 'integration'";
/** The integration matrix row that proves the deployment bootstrap and the built topology of every delivery unit. */
const BOOTSTRAP_SUITE = 'bootstrap';
const BOOTSTRAP_CONDITION = `matrix.suite == '${BOOTSTRAP_SUITE}'`;
/** The rows that start their own fresh cluster and migrate it with the source command. */
const NON_BOOTSTRAP_CONDITION = "matrix.suite == 'browser' || matrix.suite == 'database'";
/** Every row that reads built Node artifacts: the owner suites and the bootstrap row. */
const BACKEND_ARTIFACT_CONDITION = "matrix.suite == 'bootstrap' || matrix.suite == 'integration'";
const BACKEND_ARTIFACT_DOWNLOAD_STEP = 'Download and unpack the same-run Node artifacts for native owner fixtures';
const BACKEND_ARTIFACT_UNPACK_STEP = 'Wait for the same-run Node artifacts for native owner fixtures';
const NATIVE_ARTIFACTS_STEP_ID = 'native-artifacts';
const START_INTEGRATION_SERVICES_STEP = 'Start fresh PostgreSQL and SpiceDB services';
/** A backend row unpacks every unit of the topology: its derived Composition reads every unit. */
const INTEGRATION_UNPACK_COMMAND = `${UNPACK_NATIVE_ARTIFACTS_SCRIPT} "$RUNNER_TEMP/native-composition-units" .output`;
const BACKEND_ARTIFACT_DOWNLOAD_COMMAND = [
  `gh run download "$GITHUB_RUN_ID" --repo "$GITHUB_REPOSITORY" --pattern '${NODE_BUILD_ARTIFACT_PATTERN}' --dir "$RUNNER_TEMP/native-composition-units"`,
  INTEGRATION_UNPACK_COMMAND,
  '',
].join('\n');
const GITHUB_TOKEN_EXPRESSION = expression('github.token');
const BACKEND_ARTIFACT_ENV = { GH_TOKEN: GITHUB_TOKEN_EXPRESSION };
const GATE_REPOSITORY = 'TechsioCZ/ontos';
const FEDERATED_TYPES_STEP = 'Generate federated types and check performance readiness over every unit';
const BACKEND_FEDERATION_PROOF_STEP = 'Prove Node backend-federation artifacts';
const DERIVE_BUILT_COMPOSITION_COMMAND = 'node scripts/derive-built-application-composition.mts --snapshot-output';
const FORMAT_AND_LINT_JOB = 'format-and-lint';
const STATIC_CONTRACTS_JOB = 'static-contracts';
/** The gates the plan decides, each one job: its expected result is `success` or `skipped`. */
const ROOT_GATE_JOBS = [
  WORKSPACE_GATE_JOB,
  WORKSPACE_UNIT_JOB,
  WORKSPACE_UNIT_ARTIFACTS_JOB,
  STATIC_CONTRACTS_JOB,
  FORMAT_AND_LINT_JOB,
  SERVICE_INTEGRATION_JOB,
  NODE_ARTIFACT_BUILD_JOB,
] as const;
/** The jobs that run a planned list of integration rows, with the plan output that lists them. */
const PLANNED_ROW_JOBS = [
  [BROWSER_INTEGRATION_JOB, 'integrationBrowser'],
  [OWNER_INTEGRATION_JOB, 'integrationOwners'],
  [NODE_TOPOLOGY_PROOF_JOB, 'integrationTopology'],
] as const;
/** The ci-plan outputs the gate aggregator reads. */
interface PlanOutputs {
  expected: string;
  integrationBrowser?: string | undefined;
  integrationOwners?: string | undefined;
  integrationTopology?: string | undefined;
  mode: string;
}
/** Every job the required check reads, in the order it needs them. */
const GATE_JOBS = [
  ...ROOT_GATE_JOBS.slice(0, 6),
  BROWSER_INTEGRATION_JOB,
  OWNER_INTEGRATION_JOB,
  NODE_ARTIFACT_BUILD_JOB,
  NODE_TOPOLOGY_PROOF_JOB,
] as const;
/** Gate jobs that read this run's built outputs: they wait for the build shards and nothing else. */
const ARTIFACT_CONSUMER_JOBS: ReadonlySet<string> = new Set([WORKSPACE_UNIT_ARTIFACTS_JOB]);
const GatedJobsSchema = Schema.Struct({
  env: Schema.Record(Schema.String, Schema.String),
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({ if: Schema.optional(Schema.String), needs: Schema.optional(Schema.Array(Schema.String)) }),
  ),
});

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
  // A forced run is never skipped. Main looks for its merge queue proof; a push to the demo trunk, which has no merge
  // queue, for a candidate run of the same commit (scripts/tests/ci-commit-proof.test.mts proves the decision).
  expect(proof.if.replaceAll(/\s+/gu, ' ')).toBe(
    "inputs.force-ci-full != true && ( (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main' || github.event_name == 'push' && github.ref == 'refs/heads/demo/sales-crm')",
  );
  expect(proof.permissions).toEqual({ actions: 'read', contents: 'read' });
  expect(proof.outputs.proven).toBe(expression('steps.proof.outputs.proven || steps.candidate-proof.outputs.proven'));
  expect(proof.outputs.run).toBe(expression('steps.proof.outputs.run || steps.candidate-proof.outputs.run'));
  const lookup = proof.steps.find(({ id }) => id === 'proof');
  expect(lookup?.if).toBe("github.ref == 'refs/heads/main'");
  expect(lookup?.run).toContain('runs?head_sha=$GITHUB_SHA&event=merge_group&status=success');
  const candidateProof = proof.steps.find(({ id }) => id === 'candidate-proof');
  expect(candidateProof?.if).toBe("github.ref == 'refs/heads/demo/sales-crm'");
  expect(candidateProof?.run).toBe('bash app/scripts/ci/commit-proof.sh find');
  expect(candidateProof?.env).toEqual({
    BEFORE_SHA: expression('github.event.before'),
    GH_TOKEN: GITHUB_TOKEN_EXPRESSION,
  });
  const { jobs } = Schema.decodeUnknownSync(GatedJobsSchema)(readGateWorkflow());
  expect(jobs[CI_PLAN_JOB]?.needs).toEqual([QUEUE_PROOF_JOB]);
  // Lint reads no build output.
  expect(jobs[FORMAT_AND_LINT_JOB]?.needs).toEqual([CI_PLAN_JOB]);
  expect(jobs[FORMAT_AND_LINT_JOB]?.if).toBe(
    expression(
      `!cancelled() && needs.ci-plan.result == 'success' && fromJSON(needs.ci-plan.outputs.expected)['${FORMAT_AND_LINT_JOB}'] == 'success'`,
    ),
  );
  for (const gate of ROOT_GATE_JOBS.filter((job) => job !== FORMAT_AND_LINT_JOB)) {
    const needsNodeArtifacts = ARTIFACT_CONSUMER_JOBS.has(gate);
    expect(jobs[gate]?.needs).toEqual(needsNodeArtifacts ? [CI_PLAN_JOB, NODE_ARTIFACT_BUILD_JOB] : [CI_PLAN_JOB]);
    expect(jobs[gate]?.if).toBe(
      expression(
        `!cancelled() && needs.ci-plan.result == 'success' && ${
          needsNodeArtifacts ? "needs.node-artifact-build.result == 'success' && " : ''
        }fromJSON(needs.ci-plan.outputs.expected)['${gate}'] == 'success'`,
      ),
    );
  }
});

it('starts each integration row job once its producers finished and only when the plan lists rows for it', () => {
  const { jobs } = Schema.decodeUnknownSync(GatedJobsSchema)(readGateWorkflow());
  // Artifact dependencies belong to the scheduler, not a polling process holding a runner. The database producer
  // reads no build output and starts with the run; the owner rows need it and the build shards, the bootstrap row
  // the build shards, and the browser checks migrate their own database and need nobody.
  expect(jobs[OWNER_INTEGRATION_JOB]?.needs).toEqual([CI_PLAN_JOB, NODE_ARTIFACT_BUILD_JOB, SERVICE_INTEGRATION_JOB]);
  expect(jobs[OWNER_INTEGRATION_JOB]?.if).toBe(
    expression(
      "!cancelled() && needs.ci-plan.result == 'success' && needs.node-artifact-build.result == 'success' && needs.service-integration.result == 'success' && needs.ci-plan.outputs.integrationOwners != '[]'",
    ),
  );
  expect(jobs[NODE_TOPOLOGY_PROOF_JOB]?.needs).toEqual([CI_PLAN_JOB, NODE_ARTIFACT_BUILD_JOB]);
  expect(jobs[NODE_TOPOLOGY_PROOF_JOB]?.if).toBe(
    expression(
      "!cancelled() && needs.ci-plan.result == 'success' && needs.node-artifact-build.result == 'success' && needs.ci-plan.outputs.integrationTopology != '[]'",
    ),
  );
  expect(jobs[BROWSER_INTEGRATION_JOB]?.needs).toEqual([CI_PLAN_JOB]);
  expect(jobs[BROWSER_INTEGRATION_JOB]?.if).toBe(
    expression("!cancelled() && needs.ci-plan.result == 'success' && needs.ci-plan.outputs.integrationBrowser != '[]'"),
  );
  // Only the required check waits for the owner rows, the bootstrap row and the browser checks.
  for (const [job] of PLANNED_ROW_JOBS) {
    expect(Object.keys(jobs).filter((other) => jobs[other]?.needs?.includes(job) === true)).toEqual([
      WORKSPACE_GATES_JOB,
    ]);
  }
});

it('classifies documentation before installation and schedules full regression without enabling deployment', () => {
  const schema = Schema.Struct({
    jobs: Schema.Struct({
      [CI_PLAN_JOB]: Schema.Struct({ steps: Schema.Array(WorkflowStepSchema) }),
      [WORKSPACE_GATES_JOB]: Schema.Struct({ permissions: Schema.Record(Schema.String, Schema.String) }),
    }),
    on: Schema.Struct({
      schedule: Schema.Array(Schema.Struct({ cron: Schema.String })),
    }),
  });
  const workflow = Schema.decodeUnknownSync(schema)(readGateWorkflow());
  expect(workflow.on.schedule).toEqual([{ cron: '30 2 * * *' }]);
  expect(workflow.jobs[WORKSPACE_GATES_JOB].permissions).toEqual({ contents: 'read' });
  const { steps } = workflow.jobs[CI_PLAN_JOB];
  const classify = steps.findIndex(({ id }) => id === 'changes');
  const install = steps.findIndex(({ name }) => name === 'Install the app workspace for code impact analysis');
  const selection = steps.find(({ id }) => id === 'selection');
  expect(classify).toBeGreaterThan(-1);
  expect(install).toBeGreaterThan(classify);
  // WorkflowStepSchema omits uses-only metadata, but preserves the controlling if condition.
  expect(steps[install]?.if).toBe("steps.changes.outputs.mode != 'docs' && steps.changes.outputs.mode != 'proven'");
  // A candidate dispatch that is not forced full and a push to the demo trunk narrow the gates to the changed owners;
  // pull requests, merge groups and pushes to main still run the complete suite.
  expect(selection?.env?.APPLY_AFFECTED).toBe(
    expression(
      "(steps.candidate.outputs.base != '' || (github.event_name == 'push' && github.ref == 'refs/heads/demo/sales-crm')) && 'true' || 'false'",
    ),
  );
  // Only a candidate dispatch that is not forced full resolves a comparison point, before the classification.
  const candidate = steps.findIndex(({ id }) => id === 'candidate');
  expect(candidate).toBeGreaterThan(-1);
  expect(candidate).toBeLessThan(classify);
  expect(steps[candidate]?.if).toBe(
    "github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/heads/candidate/') && inputs.force-ci-full != true",
  );
  expect(steps[candidate]?.env).toEqual({ BASE_REF: expression('inputs.base-ref') });
  // A demo trunk push compares with the newest commit whose push run succeeded, never with the commit before it:
  // every push branch but main has no merge queue, which turns on the lookup in plan-ci-changes.sh.
  expect(steps.some(({ id }) => id === 'proven-base')).toBe(false);
  expect(steps[classify]?.env?.BASE_SHA).toBe(
    expression('steps.candidate.outputs.base || github.event.merge_group.base_sha || github.event.before'),
  );
  expect(steps[classify]?.env?.NEWEST_GREEN_BASE).toBe(expression("github.ref != 'refs/heads/main'"));
  expect(steps[classify]?.env?.QUEUE_PROVEN).toBe(expression('needs.queue-proof.outputs.proven'));
  expect(steps[classify]?.env?.PROOF_RUN).toBe(expression('needs.queue-proof.outputs.run'));
  expect(steps[classify]?.env?.GH_TOKEN).toBe(GITHUB_TOKEN_EXPRESSION);
  expect(steps[classify]?.env?.CANDIDATE_DISPATCH).toBe(expression("steps.candidate.outputs.base != ''"));
});

it('records what a candidate plan compared with, last in the plan job, for the demo trunk proof finder', () => {
  const { steps } = Schema.decodeUnknownSync(
    Schema.Struct({
      jobs: Schema.Struct({
        [CI_PLAN_JOB]: Schema.Struct({
          steps: Schema.Array(
            Schema.Struct({
              env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
              if: Schema.optional(Schema.String),
              run: Schema.optional(Schema.String),
              with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
            }),
          ),
        }),
      }),
    }),
  )(readGateWorkflow()).jobs[CI_PLAN_JOB];
  // Last, so only a plan that completed is recorded. scripts/tests/ci-commit-proof.test.mts reads the record back.
  const candidateDispatch =
    "github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/heads/candidate/')";
  const [record, publish] = steps.slice(-2);
  expect(record?.if).toBe(candidateDispatch);
  expect(record?.run).toBe('bash app/scripts/ci/commit-proof.sh record "$RUNNER_TEMP/ci-comparison/comparison.json"');
  expect(record?.env).toEqual({
    BASE_REF: expression('inputs.base-ref'),
    BASE_SHA: expression('steps.candidate.outputs.base'),
    HEAD_SHA: expression('github.sha'),
    PLAN_MODE: expression('steps.selection.outputs.mode || steps.changes.outputs.mode'),
  });
  expect(publish?.if).toBe(candidateDispatch);
  expect(publish?.with).toMatchObject({
    name: 'ci-comparison',
    overwrite: true,
    path: `${RUNNER_TEMP_EXPRESSION}/ci-comparison/comparison.json`,
  });
});

it('runs one candidate at a time without changing main, pull request or merge queue concurrency', () => {
  const ConcurrencySchema = Schema.Struct({
    concurrency: Schema.Struct({ 'cancel-in-progress': Schema.String, group: Schema.String }),
    on: Schema.Struct({
      workflow_dispatch: Schema.Struct({
        inputs: Schema.Record(Schema.String, Schema.Struct({ default: Schema.Unknown, type: Schema.String })),
      }),
    }),
  });
  const workflow = Schema.decodeUnknownSync(ConcurrencySchema)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')));
  // Neither trunk cancels a running push run: a newer push waits as the one pending run, so every run gets a verdict.
  expect(workflow.concurrency['cancel-in-progress']).toBe(
    expression("github.ref != 'refs/heads/main' && github.ref != 'refs/heads/demo/sales-crm'"),
  );
  expect(workflow.concurrency.group.replaceAll(/\s+/gu, ' ')).toBe(
    expression(
      "startsWith(github.ref, 'refs/heads/candidate/') && (inputs.keep && format('ultramodern-workspace-kept-{0}', github.run_id) || 'ultramodern-workspace-candidates') || format('ultramodern-workspace-{0}-{1}', github.workflow, github.ref)",
    ),
  );
  expect(workflow.on.workflow_dispatch.inputs.keep).toEqual({ default: false, type: 'boolean' });
  expect(workflow.on.workflow_dispatch.inputs['base-ref']).toMatchObject({ default: 'demo/sales-crm', type: 'string' });
  expect(workflow.on.workflow_dispatch.inputs['force-ci-full']).toMatchObject({ default: false, type: 'boolean' });
});

it('requires the exact CI plan and rejects missing, failed or unplanned skipped gates', () => {
  const gates = readTargetWorkflow().jobs[WORKSPACE_GATES_JOB];
  expect(gates.name).toBe('Workspace gates');
  expect(gates.if).toBe(expression('always()'));
  expect(gates.needs).toEqual([QUEUE_PROOF_JOB, CI_PLAN_JOB, ...GATE_JOBS]);
  expect(gates.steps.at(-1)?.run).toBe('bash app/scripts/check-ci-gates.sh');
  const script = readFileSync(new URL('../check-ci-gates.sh', import.meta.url), 'utf-8');
  /** A plan whose row lists are filled exactly when the plan runs integration, and every job's result. */
  const needs = (mode: string, results: readonly string[], proof = 'skipped', proven?: string) => {
    const rows = JSON.stringify(['docs', 'proven'].includes(mode) ? [] : [{ name: 'row' }]);
    const outputs: PlanOutputs = {
      expected: JSON.stringify(
        Object.fromEntries(
          ROOT_GATE_JOBS.map((gate) => [gate, ['docs', 'proven'].includes(mode) ? 'skipped' : 'success']),
        ),
      ),
      integrationBrowser: rows,
      integrationOwners: rows,
      integrationTopology: rows,
      mode,
    };
    return {
      [CI_PLAN_JOB]: { outputs, result: 'success' },
      [QUEUE_PROOF_JOB]: { outputs: proven === undefined ? {} : { proven }, result: proof },
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
          // Serialized as Actions serializes job results; a job without outputs has none.
          readonly outputs?: object;
          readonly result: string;
        }
      >
    >,
  ) => stepPasses(script, { NEEDS_JSON: JSON.stringify(value) });
  expect(passes(needs('full', passed))).toBe(true);
  expect(passes(needs('docs', skipped))).toBe(true);
  expect(passes(needs('proven', skipped, 'success', 'true'))).toBe(true);
  expect(passes(needs('proven', skipped))).toBe(false);
  expect(passes(needs('full', skipped))).toBe(false);
  expect(passes(needs('full', ['failure', ...passed.slice(1)]))).toBe(false);
  expect(passes(needs('full', ['cancelled', ...passed.slice(1)]))).toBe(false);
  expect(passes(needs('full', passed, 'failure'))).toBe(false);
  const affected = needs('affected', passed);
  expect(passes(affected)).toBe(true);
  // A job that runs a planned row list passes only as planned: run and green with rows, skipped without.
  for (const [job, output] of PLANNED_ROW_JOBS) {
    expect(passes({ ...affected, [job]: { result: 'skipped' } }), job).toBe(false);
    expect(passes({ ...affected, [job]: { result: 'failure' } }), job).toBe(false);
    const empty = needs('affected', passed);
    empty[CI_PLAN_JOB].outputs[output] = '[]';
    expect(passes({ ...empty, [job]: { result: 'skipped' } }), job).toBe(true);
    expect(passes(empty), job).toBe(false);
    const missingRows = needs('affected', passed);
    const plannedOutputs = Object.entries(missingRows[CI_PLAN_JOB].outputs).filter(([key]) => key !== output);
    expect(
      passes({ ...missingRows, [CI_PLAN_JOB]: { outputs: Object.fromEntries(plannedOutputs), result: 'success' } }),
      job,
    ).toBe(false);
  }
  // An affected plan may leave test matrices without rows, but never every unit row or the builds.
  const testMatrices: readonly string[] = [WORKSPACE_UNIT_JOB, WORKSPACE_UNIT_ARTIFACTS_JOB, SERVICE_INTEGRATION_JOB];
  const rowJobs: readonly string[] = PLANNED_ROW_JOBS.map(([job]) => job);
  const planned = (skippedGates: readonly string[]) => {
    const value = needs('affected', passed);
    value[CI_PLAN_JOB].outputs.expected = JSON.stringify(
      Object.fromEntries(ROOT_GATE_JOBS.map((gate) => [gate, skippedGates.includes(gate) ? 'skipped' : 'success'])),
    );
    for (const [job, output] of PLANNED_ROW_JOBS) {
      if (skippedGates.includes(job)) {
        value[CI_PLAN_JOB].outputs[output] = '[]';
      }
    }
    return {
      ...value,
      ...Object.fromEntries(skippedGates.map((gate) => [gate, { result: 'skipped' }])),
    };
  };
  expect(passes(planned([SERVICE_INTEGRATION_JOB, OWNER_INTEGRATION_JOB]))).toBe(true);
  expect(passes(planned([WORKSPACE_UNIT_JOB, BROWSER_INTEGRATION_JOB]))).toBe(true);
  expect(passes(planned([...testMatrices, ...rowJobs]))).toBe(false);
  expect(passes(planned([NODE_ARTIFACT_BUILD_JOB]))).toBe(false);
  expect(passes(needs('affected', skipped))).toBe(false);
  // A scoped plan builds nothing and starts no service, but its source rows, static contracts and lint always run.
  const scoped = (skippedGates: readonly string[]) => {
    const value = planned(skippedGates);
    value[CI_PLAN_JOB].outputs.mode = 'scoped';
    return value;
  };
  const unbuilt = [...testMatrices, ...rowJobs, NODE_ARTIFACT_BUILD_JOB];
  expect(passes(scoped(unbuilt))).toBe(true);
  expect(passes(scoped(unbuilt.filter((gate) => gate !== WORKSPACE_UNIT_JOB)))).toBe(true);
  for (const required of [WORKSPACE_GATE_JOB, STATIC_CONTRACTS_JOB, FORMAT_AND_LINT_JOB]) {
    expect(passes(scoped([...unbuilt, required])), required).toBe(false);
  }
  expect(passes(needs('scoped', passed, 'success', 'true'))).toBe(false);
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
  expect(afterGates).toContain(WORKSPACE_GATES_JOB);
  // The deploy chain stays out of the gates: no deployment job may reappear here.
  expect(Object.keys(jobs)).not.toContain('deploy-zerops');
  expect(Object.keys(jobs)).not.toContain('deploy-cloudflare');
  expect(Object.keys(jobs)).not.toContain('edge-plan');
  for (const job of afterGates) {
    // The job name leads the subject, so a failure names the job.
    expect(`${job}: ${jobs[job]?.if ?? ''}`).toMatch(/^[a-z-]+: \$\{\{ (?:!cancelled\(\)|always\(\))/u);
  }
});

const ArtifactStepSchema = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  if: Schema.optional(Schema.String),
  name: Schema.String,
  run: Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
  with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const ArtifactBuildJobSchema = Schema.Struct({
  env: Schema.Record(Schema.String, Schema.String),
  name: Schema.String,
  needs: Schema.Array(Schema.String),
  permissions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  services: Schema.optional(Schema.Unknown),
  steps: Schema.Array(ArtifactStepSchema),
  strategy: Schema.Struct({
    matrix: Schema.Struct({
      include: Schema.Array(Schema.Struct({ shard: Schema.Number, units: Schema.String })),
      shard: Schema.Array(Schema.Number),
    }),
  }),
  'timeout-minutes': Schema.Number,
});
const ArtifactProofJobSchema = Schema.Struct({
  needs: Schema.Array(Schema.String),
  steps: Schema.Array(Schema.Struct({ ...ArtifactStepSchema.fields, wait: Schema.optional(Schema.String) })),
});
const ArtifactBuildWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    [NODE_ARTIFACT_BUILD_JOB]: ArtifactBuildJobSchema,
    [NODE_TOPOLOGY_PROOF_JOB]: ArtifactProofJobSchema,
  }),
});
const TopologyUnitsSchema = Schema.Struct({
  shell: Schema.Struct({ id: Schema.String, path: Schema.String }),
  verticals: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String })),
});

const sorted = (values: readonly string[]) => EffectArray.sort(values, Order.String);
const readArtifactBuildJobs = () => Schema.decodeUnknownSync(ArtifactBuildWorkflowSchema)(readGateWorkflow()).jobs;
/** The build step runs the build driver: each pending unit runs its own package `build` script, BUILD_JOBS at a time. */
const BUILD_DRIVER_COMMAND = 'mise exec -- bash scripts/ci/build-units.sh';
const UNIT_BUILD_COMMAND = 'pnpm --filter "./$unit" run build';
const buildStep = () =>
  readArtifactBuildJobs()[NODE_ARTIFACT_BUILD_JOB].steps.find(({ run }) => run === BUILD_DRIVER_COMMAND);
const buildDriver = () => readFileSync(new URL('../ci/build-units.sh', import.meta.url), 'utf-8');

it('builds every delivery unit of the topology in exactly one build shard', () => {
  const { strategy } = readArtifactBuildJobs()[NODE_ARTIFACT_BUILD_JOB];
  const topology = Schema.decodeUnknownSync(TopologyUnitsSchema)(
    JSON.parse(readFileSync(new URL('../../topology/reference-topology.json', import.meta.url), 'utf-8')),
  );
  const units = [topology.shell, ...topology.verticals].map((unit) => unit.path);
  expect(strategy.matrix.include.map(({ shard }) => shard)).toEqual(strategy.matrix.shard);
  const built = strategy.matrix.include.flatMap(({ units: shardUnits }) => shardUnits.split(/\s+/u).filter(Boolean));
  expect(sorted(built)).toEqual(sorted(units));
  // A shard with no unit would only pay a runner's setup.
  expect(strategy.matrix.include.filter(({ units: shardUnits }) => shardUnits.trim() === '')).toEqual([]);
  expect(buildStep()).toBeDefined();
});

/** A job of the expanded gates workflow: what it waits for and, for a matrix job, the lists it runs one job per. */
const FirstWaveJobSchema = Schema.Struct({
  needs: Schema.optional(Schema.Array(Schema.String)),
  strategy: Schema.optional(Schema.Struct({ matrix: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)) })),
});

/** One job per combination of a matrix's lists; `include` only extends those, unless it is the whole matrix. */
const matrixJobs = (matrix: Readonly<Record<string, readonly unknown[]>>) => {
  const { include = [], ...lists } = matrix;
  const sizes = Object.values(lists).map((values) => values.length);
  return sizes.length === 0 ? include.length : sizes.reduce((product, size) => product * size, 1);
};

it('starts no more jobs after planning than the 20 shared runners hold', () => {
  const { jobs } = Schema.decodeUnknownSync(Schema.Struct({ jobs: Schema.Record(Schema.String, FirstWaveJobSchema) }))(
    readGateWorkflow(),
  );
  // On a full run they all start together. In run 44467964945 there were 24: three build shards and the browser
  // checks waited 88 to 145 s for a runner, and the owner rows, which need every shard, started that much later.
  const firstWave = Object.values(jobs)
    .filter(({ needs }) => needs?.length === 1 && needs[0] === CI_PLAN_JOB)
    .reduce((total, { strategy }) => total + (strategy === undefined ? 1 : matrixJobs(strategy.matrix)), 0);
  expect(firstWave).toBeLessThanOrEqual(20);
});

it('writes the app host entry of every served unit it builds, after its build, as the app host build does', () => {
  const { env } = readArtifactBuildJobs()[NODE_ARTIFACT_BUILD_JOB];
  // The native hosted-owner fixtures start an owner only from its dist/zerops-entry.mjs, from these same artifacts.
  expect(env.UNIT_POST_BUILD).toBe('scripts/zerops/owner-entry.mts');
  expect(env.UNIT_SERVED_ENTRY).toBe('dist/zerops-entry.mjs');
  const build = buildDriver();
  const entry = build.indexOf('node "$UNIT_POST_BUILD" "$unit"');
  expect(entry).toBeGreaterThan(build.indexOf(UNIT_BUILD_COMMAND));
  expect(build).toContain('require("./topology/application-release-intent.json")');
  expect(build).toContain('console.log("shell-super-app")');
  // A rebuilt unit starts from clean outputs and gets its cache receipt only after its build and entry.
  expect(build.indexOf('rm -rf -- "$unit/dist" "$unit/.output"')).toBeLessThan(build.indexOf(UNIT_BUILD_COMMAND));
  expect(build.indexOf('node scripts/ci/unit-output-cache.mts stamp --unit "$id"')).toBeGreaterThan(entry);
  // The post-build script and the entry it writes take part in every unit's identity and verification.
  expect(build).toContain('--served-entry "$UNIT_SERVED_ENTRY"');
  expect(build).toContain('--post-build "$UNIT_POST_BUILD"');
});

it('keeps only verified unit outputs from the unit output cache and saves them only after verification', () => {
  const { steps } = readArtifactBuildJobs()[NODE_ARTIFACT_BUILD_JOB];
  const index = (predicate: (step: (typeof steps)[number]) => boolean) => steps.findIndex(predicate);
  const paths = index(({ name }) => name === "Name the shard's cached output paths");
  const restore = index(({ uses }) => uses?.startsWith('actions/cache/restore@') === true);
  const plan = index(({ run }) => run?.includes('unit-output-cache.mts plan --units "$SHARD_UNITS"') === true);
  const build = index(({ run }) => run === BUILD_DRIVER_COMMAND);
  const verify = index(
    ({ run }) =>
      run ===
      'mise exec -- node scripts/ci/unit-output-cache.mts verify --units "$SHARD_UNITS" --served-entry "$UNIT_SERVED_ENTRY" --post-build "$UNIT_POST_BUILD"',
  );
  const save = index(({ uses }) => uses?.startsWith(CACHE_SAVE_ACTION) === true);
  const pack = index(({ name }) => name === "Pack the shard's build outputs");
  expect(paths > -1 && paths < restore && restore < plan && plan < build && build < verify).toBe(true);
  expect(verify < save && save < pack).toBe(true);
  // Named by the shard's unit identities, never by commit or run; an exact hit saves nothing (cache-budget.test.mts).
  const keyStep = index(({ name }) => name === "Name the shard's unit output cache entry");
  expect(paths < keyStep && keyStep < restore).toBe(true);
  expect(steps[keyStep]?.run).toContain('unit-output-cache.mts digest --unit "$SHARD_UNITS"');
  expect(steps[keyStep]?.run).toContain(
    'bash scripts/ci/cache-entry-key.sh "gates-units-v2-$RUNNER_OS-$RUNNER_ARCH-$SHARD-"',
  );
  const prefix = `gates-units-v2-${expression('runner.os')}-${expression('runner.arch')}-${expression(MATRIX_SHARD)}-`;
  expect(steps[restore]?.with).toEqual({
    key: expression('steps.unit-cache-key.outputs.key'),
    path: expression('steps.unit-cache-paths.outputs.paths'),
    'restore-keys': prefix,
  });
  expect(steps[save]?.with).toEqual({
    key: expression('steps.unit-cache-key.outputs.key'),
    path: expression('steps.unit-cache-paths.outputs.paths'),
  });
  expect(steps[save]?.if).toBe("steps.unit-cache.outputs.cache-hit != 'true'");
  expect(steps[build]?.env).toEqual({ BUILD_UNITS: expression('steps.cached-plan.outputs.build') });
});

it('only builds on the shards and proves every unit together on the bootstrap row that no test waits for', () => {
  const jobs = readArtifactBuildJobs();
  const build = jobs[NODE_ARTIFACT_BUILD_JOB];
  expect(build.needs).toEqual([CI_PLAN_JOB]);
  expect(build.services).toBeUndefined();
  expect(build.permissions).toBeUndefined();
  expect(build.steps.some(({ uses }) => uses?.startsWith(DOWNLOAD_ARTIFACT_ACTION) === true)).toBe(false);
  expect(build.steps.some(({ run }) => run?.includes('node:proof') === true)).toBe(false);
  expect(build.steps.at(-1)?.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/u);
  expect(build.steps.at(-1)?.with?.name).toBe(`node-units-${expression(MATRIX_SHARD)}`);
  // A re-run replaces the shard's own earlier upload instead of failing on the existing name.
  expect(build.steps.at(-1)?.with?.overwrite).toBe(true);
  const proof = jobs[NODE_TOPOLOGY_PROOF_JOB];
  expect(proof.needs).toEqual([CI_PLAN_JOB, NODE_ARTIFACT_BUILD_JOB]);
  // The row downloads every shard's archive in the background and unpacks every unit its row names (none: all).
  const download = proof.steps.findIndex(
    ({ run }) => run?.includes(`--pattern '${NODE_BUILD_ARTIFACT_PATTERN}'`) === true,
  );
  const joined = proof.steps.findIndex(({ wait }) => wait === 'native-artifacts');
  const nodeProof = proof.steps.findIndex(({ run }) => run === 'mise exec -- pnpm node:proof');
  expect(proof.steps[download]?.run).toBe(BACKEND_ARTIFACT_DOWNLOAD_COMMAND);
  expect(download !== -1 && download < joined && joined < nodeProof).toBe(true);
  expect(proof.steps[nodeProof]?.if).toBe("matrix.suite == 'bootstrap'");
  // No gate job waits for the proof except the required check.
  const { jobs: all } = Schema.decodeUnknownSync(GatedJobsSchema)(readGateWorkflow());
  const waiting = Object.keys(all).filter((job) => all[job]?.needs?.includes(NODE_TOPOLOGY_PROOF_JOB) === true);
  expect(waiting).toEqual([WORKSPACE_GATES_JOB]);
});

/** Runs the weighted shard runner with a `pnpm` whose `rstest list` reports these files, and records the run. */
const weightedShard = (shard: string, files: readonly string[]) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-weighted-shard-'));
  try {
    const pnpm = path.join(directory, 'pnpm');
    writeFileSync(
      pnpm,
      [
        '#!/bin/bash',
        // The listing file is the last argument; an unset status is 0 in shell arithmetic.
        'if [ "$3" = list ]; then for last; do :; done; printf %s "$FAKE_LIST" >"$last"; exit "$((FAKE_LIST_STATUS))"; fi',
        String.raw`printf "%s\n" "$@" >"$RUN_ARGUMENTS"`,
        '',
      ].join('\n'),
    );
    chmodSync(pnpm, 0o755);
    const runArguments = path.join(directory, 'run');
    execFileSync(
      '/bin/bash',
      [fileURLToPath(new URL('../ci/rstest-weighted-shard.sh', import.meta.url)), shard, 'unit'],
      {
        env: {
          CI_MATRICES_OVERLAY: MATRICES_OVERLAY,
          FAKE_LIST: JSON.stringify(files.map((file) => ({ file, type: 'file' }))),
          PATH: `${directory}:${STEP_PATH}`,
          RUN_ARGUMENTS: runArguments,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    try {
      return readFileSync(runArguments, 'utf-8')
        .split('\n')
        .filter((line) => line.startsWith('/'));
    } catch {
      return [];
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

it('deals the files of a split giant test family over the weighted shards and runs every file exactly once', () => {
  const family = ['consumption', 'expiry', 'identity', 'order', 'reconciliation', 'scope'].map(
    (group) => `/w/tests/integration/purchase-approval-fresh-proof-postgres-${group}.test.ts`,
  );
  const files = [...Array.from({ length: 12 }, (_, index) => `/w/tests/integration/file-${index}.test.ts`), ...family];
  const shards = ['1/6', '2/6', '3/6', '4/6', '5/6', '6/6'].map((shard) => weightedShard(shard, files));
  expect(sorted(shards.flat())).toEqual(sorted(files));
  // Rstest's own --shard would keep the alphabetically adjacent parts together; the weighted deal spreads them.
  for (const shard of shards) {
    expect(shard.filter((file) => family.includes(file))).toHaveLength(1);
  }
  expect(() => weightedShard('7/6', files)).toThrow();
  expect(() => weightedShard('1/2', [])).toThrow();
});

const GateCommandStepSchema = Schema.Struct({
  ...WorkflowStepSchema.fields,
  uses: Schema.optional(Schema.String),
  with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  'working-directory': Schema.optional(Schema.String),
});

const GateCommandsWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    [FORMAT_AND_LINT_JOB]: Schema.Struct({
      steps: Schema.Array(
        Schema.Struct({
          env: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number]))),
          name: Schema.optional(Schema.String),
          run: Schema.optional(Schema.String),
        }),
      ),
      strategy: Schema.Struct({ matrix: Schema.Struct({ shard: Schema.Array(Schema.Number) }) }),
    }),
    'static-contracts': Schema.Struct({
      steps: Schema.Array(
        Schema.Struct({
          name: Schema.optional(Schema.String),
          parallel: Schema.optional(Schema.Array(Schema.Struct({ run: Schema.String }))),
          run: Schema.optional(Schema.String),
        }),
      ),
    }),
    [WORKSPACE_GATE_JOB]: Schema.Struct({
      steps: Schema.Array(GateCommandStepSchema),
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
    }),
    [WORKSPACE_UNIT_ARTIFACTS_JOB]: Schema.Struct({
      steps: Schema.Array(GateCommandStepSchema),
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
    }),
    [WORKSPACE_UNIT_JOB]: Schema.Struct({
      steps: Schema.Array(GateCommandStepSchema),
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
    }),
  }),
});
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
const gateCommands = () => {
  const jobs = readGateCommandJobs();
  return ([WORKSPACE_GATE_JOB, WORKSPACE_UNIT_JOB, WORKSPACE_UNIT_ARTIFACTS_JOB] as const).flatMap((job) =>
    jobs[job].strategy.matrix.include.map(({ commands }) => commands.split('\n').filter(Boolean)),
  );
};

it("builds in main's CI mode, not the stage deploy's, because the typecheck gate proves the types", () => {
  const job = readArtifactBuildJobs()[NODE_ARTIFACT_BUILD_JOB];
  expect(job['timeout-minutes']).toBe(30);
  // As on main: no build-time checker, no server typecheck or declarations, and no JavaScript source maps, which made
  // every unit artifact about three times larger.
  expect(job.env).toMatchObject({ BUILD_JOBS: '2', ONTOS_CI_TYPECHECK_SEPARATE: '1' });
  expect(job.env.ULTRAMODERN_DISABLE_BUILD_TS_CHECKER).toBeUndefined();
  expect(job.env.ULTRAMODERN_SKIP_SERVER_TYPECHECK).toBeUndefined();
  // No public origin is baked into the gate artifacts, unlike the stage deploy.
  expect(Object.keys(job.env).some((key) => key.startsWith('ULTRAMODERN_PUBLIC_URL_'))).toBe(false);
  expect(job.env.ONTOS_PUBLIC_ORIGIN).toBeUndefined();
  expect(buildStep()?.run).toBe(BUILD_DRIVER_COMMAND);
  expect(buildDriver()).toContain('xargs -P "$BUILD_JOBS" -n 1');
  // The typecheck gate that makes the build-time checkers redundant is still a source gate.
  expect(gateCommands().flat()).toContain('pnpm typecheck');
});

it('runs every workspace gate check in some workspace-gate entry', () => {
  const commands = gateCommands().flat();
  for (const check of [
    'pnpm typecheck',
    'pnpm api:check:ontos',
    'pnpm handler-services:check',
    'pnpm shell:ui-candidates:check',
    'pnpm module-entrypoints:check',
    'pnpm test:generation',
  ]) {
    expect(commands).toContain(check);
  }
  const sourceShards = readGateCommandJobs()[WORKSPACE_GATE_JOB].strategy.matrix.include;
  const toolingShards = sourceShards
    .map((entry) => entry.commands.trim())
    .filter((command) => command.includes(`${WEIGHTED_SHARD_SCRIPT} `) && command.includes(' scripts '));
  const toolingCount = toolingShards.length;
  // The weighted shards together run what `pnpm test:scripts` runs, over the same project, with two file workers:
  // the scripts suite was reviewed safe in parallel.
  expect(toolingShards).toEqual(
    Array.from(
      { length: toolingCount },
      (_, index) => `bash ${WEIGHTED_SHARD_SCRIPT} ${index + 1}/${toolingCount} scripts --pool.maxWorkers 2`,
    ),
  );
  const { scripts } = readRootScripts();
  // The local script runs the same project; its local worker count is not what the shards use.
  expect(scripts['test:scripts']).toMatch(/^rstest --project scripts --pool\.maxWorkers \d+$/u);
  // The module entrypoint boundary check is the repository's own boundary script.
  expect(scripts['module-entrypoints:check']).toContain('check-module-entrypoint-boundaries.mts');
  const staticChecks = readGateCommandJobs()['static-contracts'].steps.flatMap(({ parallel, run }) =>
    parallel ? parallel.map((step) => step.run) : [run ?? ''],
  );
  expect(staticChecks).toContain('mise exec -- pnpm database-access:check');
});

it('restores same-run Node metadata only for unit rows that execute public contract fixtures', () => {
  const jobs = readGateCommandJobs();
  // Rows that read no built output start after planning, without downloading anything.
  const plain = jobs[WORKSPACE_UNIT_JOB];
  expect(plain.strategy.matrix.include.some((entry) => entry['node-artifacts'] === true)).toBe(false);
  expect(plain.steps.some(({ uses }) => uses?.startsWith(DOWNLOAD_ARTIFACT_ACTION) === true)).toBe(false);
  const job = jobs[WORKSPACE_UNIT_ARTIFACTS_JOB];
  expect(job.strategy.matrix.include.map(({ name }) => name)).toEqual([
    'Unit Tests (Shell 1/2)',
    'Unit Tests (Shell 2/2)',
    'Unit and Component Tests (Catalog, Commerce Customer Context, and Inventory)',
    'Unit and Component Tests (Pricing, Market Catalog, Privacy, and Symmy)',
  ]);
  const download = job.steps.findIndex(
    ({ name }) => name === 'Download the same-run Node artifacts for unit contract fixtures',
  );
  const unpack = job.steps.findIndex(({ name }) => name === 'Unpack the Node artifacts for unit contract fixtures');
  const run = job.steps.findIndex(({ name }) => name === `Run ${expression('matrix.name')}`);
  expect(download !== -1 && download < unpack && unpack < run).toBe(true);
  expect(job.steps[download]?.uses).toBe('actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333');
  expect(job.steps[download]?.with).toEqual({
    path: `${RUNNER_TEMP_EXPRESSION}/native-composition-units`,
    pattern: NODE_BUILD_ARTIFACT_PATTERN,
  });
  expect(job.steps[unpack]?.['working-directory']).toBe('app');
  expect(job.steps[unpack]?.env).toEqual({ REQUIRED_UNITS: expression('matrix.artifact-units') });
  expect(job.steps[unpack]?.run).toBe(UNPACK_NATIVE_ARTIFACTS_COMMAND);
});

/** `pnpm --filter ./<package> exec bash "$PWD/scripts/ci/rstest-weighted-shard.sh" <k>/<n> unit`. */
const WEIGHTED_UNIT_LINE =
  /^pnpm --filter (?<filter>\.\/[a-z/-]+) exec bash "\$PWD\/scripts\/ci\/rstest-weighted-shard\.sh" (?<shard>\d+\/\d+) unit$/u;

it('runs the root unit and component tests of every workspace package in exactly one shard', () => {
  const { scripts } = readRootScripts();
  // The shards run exactly what the root script runs, split by package.
  // The shared-contracts type tests run on the typecheck row, beside the TS-Go build they depend on.
  expect(scripts['test:unit']).toBe(
    'pnpm -r --no-sort --if-present run test:unit && pnpm -r --no-sort --if-present run test:component && pnpm --filter @app/shared-contracts test:types',
  );
  expect(gateCommands().flat()).toContain('pnpm --filter ./packages/shared-contracts test:types');
  const weighted = new Map<string, { components: number; shards: string[] }>();
  const shards = gateCommands().flatMap((commands) => {
    const [unit, component, ...rest] = commands;
    const shard = WEIGHTED_UNIT_LINE.exec(unit ?? '')?.groups;
    if (shard !== undefined) {
      // A weighted shard of one package's unit project, optionally followed by that package's component tests.
      const filter = shard.filter ?? '';
      const entry = weighted.get(filter) ?? { components: 0, shards: [] };
      entry.shards.push(shard.shard ?? '');
      if (component !== undefined) {
        expect(component).toBe(`pnpm -r --no-sort --if-present --filter ${filter} run test:component`);
        entry.components += 1;
      }
      expect(rest).toEqual([]);
      weighted.set(filter, entry);
      return [];
    }
    if (unit === undefined || !unit.endsWith(' run test:unit')) {
      return [];
    }
    const filters = unit.replace(/^pnpm -r --no-sort --if-present /u, '').replace(/ run test:unit$/u, '');
    // Each shard runs test:component over the same packages, after test:unit, and nothing else.
    expect(component).toBe(`pnpm -r --no-sort --if-present ${filters} run test:component`);
    expect(rest).toEqual([]);
    return [
      [...filters.matchAll(/--filter (?<filter>\S+)/gu)].map(({ groups }) => groups?.filter?.replaceAll("'", '') ?? ''),
    ];
  });
  for (const [filter, entry] of weighted) {
    // The runner runs `rstest --project unit` itself, so the package's script must be exactly that.
    const manifest = Schema.decodeUnknownSync(RootScriptsSchema)(
      JSON.parse(readFileSync(new URL(`../../${filter}/package.json`, import.meta.url), 'utf-8')),
    );
    expect(manifest.scripts['test:unit'], filter).toBe('rstest --project unit');
    const count = Number(entry.shards[0]?.split('/')[1]);
    expect(sorted(entry.shards)).toEqual(sorted(Array.from({ length: count }, (_, index) => `${index + 1}/${count}`)));
    expect(entry.components, filter).toBe(manifest.scripts['test:component'] === undefined ? 0 : 1);
  }
  const named = shards.filter((filters) => filters.every((filter) => !filter.startsWith('!')));
  const remainder = shards.filter((filters) => filters.some((filter) => filter.startsWith('!')));
  expect(named.length + remainder.length).toBe(shards.length);
  // One shard runs every package the others do not name, excluding the workspace root like `pnpm -r`.
  expect(remainder).toHaveLength(1);
  const namedPackages = [...named.flat(), ...weighted.keys()];
  expect(sorted(remainder[0] ?? [])).toEqual(sorted(['!.', ...namedPackages.map((filter) => `!${filter}`)]));
  expect(new Set(namedPackages).size).toBe(namedPackages.length);
  for (const filter of namedPackages) {
    expect(filter).toMatch(/^\.\/(?:apps|packages|verticals)\/[a-z-]+$/u);
    expect(() => readFileSync(new URL(`../../${filter}/package.json`, import.meta.url))).not.toThrow();
  }
});

const IntegrationRunnerSchema = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number]))),
  needs: Schema.Array(Schema.String),
  steps: Schema.Array(
    Schema.Struct({
      ...WorkflowStepSchema.fields,
      background: Schema.optional(Schema.Boolean),
      'continue-on-error': Schema.optional(Schema.Boolean),
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
    [NODE_TOPOLOGY_PROOF_JOB]: IntegrationRunnerSchema,
    [OWNER_INTEGRATION_JOB]: IntegrationRunnerSchema,
    [SERVICE_INTEGRATION_JOB]: IntegrationRunnerSchema,
  }),
});
const readIntegrationJobs = () => Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(readGateWorkflow()).jobs;

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
/** Every owner row of the complete plan. */
const integrationRows = () =>
  readIntegrationJobs()[OWNER_INTEGRATION_JOB].strategy.matrix.include.filter(({ suite }) => suite === 'integration');

it('overlaps independent integration preparations and joins their failures before the first consumer', () => {
  const { steps } = readIntegrationJobs()[OWNER_INTEGRATION_JOB];
  const named = (name: string) => steps.findIndex((step) => step.name === name);
  const install = named(INSTALL_APP_STEP);
  expect(steps[install]?.background).toBeUndefined();
  const tls = named('Create the local SpiceDB TLS certificate');
  const workers = steps.findIndex(({ run }) => run === START_INTEGRATION_WORKERS);
  const services = named(START_INTEGRATION_SERVICES_STEP);
  for (const [id, consumer] of [
    ['integration-images', Math.min(workers, services)],
    [NATIVE_ARTIFACTS_STEP_ID, named('Derive the fresh built Composition for native owner fixtures')],
  ] as const) {
    const launch = steps.findIndex((step) => step.id === id);
    const joins = steps.filter((step) => step.wait === id);
    const join = steps.findIndex((step) => step.wait === id);
    expect(launch).toBeGreaterThan(-1);
    expect(steps[launch]?.background).toBe(true);
    expect(steps[launch]?.['continue-on-error']).toBeUndefined();
    // Native wait propagates the background shell's exit code and keeps its output in the step log.
    expect(joins).toHaveLength(1);
    expect(joins[0]?.if).toBeUndefined();
    expect(joins[0]?.['continue-on-error']).toBeUndefined();
    expect(launch < join && join < consumer).toBe(true);
    expect(launch < install && install < join).toBe(true);
  }
  expect(install < tls && tls < workers && tls < services).toBe(true);
  const artifactsReady = steps.findIndex(({ wait }) => wait === NATIVE_ARTIFACTS_STEP_ID);
  for (const consumer of [FEDERATED_TYPES_STEP, BACKEND_FEDERATION_PROOF_STEP, INTEGRATION_TESTS_STEP]) {
    expect(artifactsReady).toBeLessThan(named(consumer));
  }
  for (const step of steps) {
    if (step.wait !== undefined) {
      expect(step.if, step.name).toBeUndefined();
    }
  }
  const unpackOutput = 'bash preparation output';
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-integration-preparation-'));
  try {
    for (const command of ['gh', 'docker', 'bash']) {
      const executable = path.join(directory, command);
      writeFileSync(executable, `#!/bin/sh\necho "${command} preparation output" >&2\nexit "$PREP_${command}"\n`);
      chmodSync(executable, 0o755);
    }
    // Run the real background shell bodies with failing external commands: neither a failed download,
    // image pull nor unpack may become a successful step for the native wait to join.
    for (const [id, gh, docker, unpack, status, output] of [
      [NATIVE_ARTIFACTS_STEP_ID, '37', '0', '0', 37, 'gh preparation output'],
      [NATIVE_ARTIFACTS_STEP_ID, '0', '0', '43', 43, unpackOutput],
      ['integration-images', '0', '29', '0', 29, 'docker preparation output'],
      [NATIVE_ARTIFACTS_STEP_ID, '0', '0', '0', 0, unpackOutput],
    ] as const) {
      const step = steps.find((candidate) => candidate.id === id);
      const result = spawnSync('/bin/bash', ['-eo', 'pipefail', '-c', step?.run ?? 'exit 0'], {
        cwd: directory,
        encoding: 'utf-8',
        env: {
          GITHUB_REPOSITORY: GATE_REPOSITORY,
          GITHUB_RUN_ID: '123',
          PATH: `${directory}:${STEP_PATH}`,
          PREP_bash: unpack,
          PREP_docker: docker,
          PREP_gh: gh,
          RUNNER_TEMP: directory,
        },
      });
      expect(result.status).toBe(status);
      expect(result.stderr).toContain(output);
      if (gh !== '0') {
        expect(result.stderr).not.toContain(unpackOutput);
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it('publishes the verified database from its own producer and restores it only in jobs that need that producer', () => {
  const jobs = readIntegrationJobs();
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
        uses?.startsWith(DOWNLOAD_ARTIFACT_ACTION) === true && inputs?.name === INTEGRATION_DATABASE_ARTIFACT,
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
  // Every restored cluster also gets the schema-only template the native fixtures clone from.
  expect(restore.indexOf('bash scripts/ci/prepare-schema-template.sh')).toBeGreaterThan(restored);
});

it('supplies same-run built Composition to selected native owner integration shards before their tests', () => {
  const jobs = readIntegrationJobs();
  const integration = jobs[OWNER_INTEGRATION_JOB];
  // Every owner row starts only once every build shard and the database producer uploaded.
  expect(integration.needs).toEqual([CI_PLAN_JOB, NODE_ARTIFACT_BUILD_JOB, SERVICE_INTEGRATION_JOB]);
  const rows = integration.strategy.matrix.include;
  const selected = rows.filter((shard) => shard['native-composition'] === true);
  const rootShards = rows.filter((shard) => rootRow(shard));
  // Derived instead of a literal count, so a reshard cannot be "fixed" by editing a number here: every root
  // shard must derive the fresh Composition and only integration rows may carry it.
  expect(selected.length).toBeGreaterThan(0);
  expect(selected.every(({ suite }) => suite === 'integration')).toBe(true);
  expect(selected.filter((shard) => rootRow(shard))).toEqual(rootShards);
  expect(selected.some((shard) => shardFilters(shard).includes('./verticals/pricing'))).toBe(true);
  expect(selected.some((shard) => shardFilters(shard).includes('./verticals/inventory'))).toBe(true);
  const { steps } = integration;
  const download = steps.findIndex(({ name }) => name === BACKEND_ARTIFACT_DOWNLOAD_STEP);
  const unpack = steps.findIndex(({ wait }) => wait === NATIVE_ARTIFACTS_STEP_ID);
  const derive = steps.findIndex(({ run }) => run?.includes(DERIVE_BUILT_COMPOSITION_COMMAND) === true);
  const tests = steps.findIndex(({ env }) => env?.INTEGRATION_TASKS !== undefined);
  const workers = steps.findIndex(({ run }) => run === START_INTEGRATION_WORKERS);
  expect(workers).toBeGreaterThan(-1);
  expect(download < workers).toBe(true);
  // Every integration job runs the same steps, each selecting its own by the row's suite.
  for (const job of [SERVICE_INTEGRATION_JOB, BROWSER_INTEGRATION_JOB, NODE_TOPOLOGY_PROOF_JOB] as const) {
    expect(jobs[job].steps, job).toEqual(integration.steps);
  }
  expect(download).toBeGreaterThan(-1);
  expect(download < unpack && unpack < derive && derive < tests).toBe(true);
  expect(steps[download]?.run).toBe(BACKEND_ARTIFACT_DOWNLOAD_COMMAND);
  // gh explicitly binds the download to this repository and workflow run.
  expect(steps[download]?.env).toEqual(BACKEND_ARTIFACT_ENV);
  expect(steps[derive]?.env).toEqual({ APP_ENV_PATH: '/dev/null' });
  expect(steps[download]?.if).toBe(BACKEND_ARTIFACT_CONDITION);
  expect(steps[unpack]?.if).toBeUndefined();
  expect(steps[derive]?.if).toBe('matrix.native-composition == true');
  expect(steps.filter(({ if: condition }) => condition === 'matrix.native-composition == true')).toHaveLength(1);
});

it('proves the built topology of every delivery unit in one row of the integration matrix', () => {
  const integration = readIntegrationJobs()[NODE_TOPOLOGY_PROOF_JOB];
  // One row proves all built outputs once every build shard uploaded; check-ci-gates.sh requires its success
  // whenever the plan lists it.
  expect(integration.needs).toEqual([CI_PLAN_JOB, NODE_ARTIFACT_BUILD_JOB]);
  const rows = integration.strategy.matrix.include;
  expect(rows.map(({ suite }) => suite)).toEqual([BOOTSTRAP_SUITE]);
  expect(rows[0]?.tasks).toBeUndefined();
  expect(rows[0]?.['native-composition']).toBeUndefined();
  const { steps } = integration;
  const named = (name: string) => steps.findIndex((step) => step.name === name);
  const indexes = [FEDERATED_TYPES_STEP, BACKEND_FEDERATION_PROOF_STEP].map(named);
  expect(indexes.some((index) => index === -1)).toBe(false);
  // mf:types precedes the proofs that read its output.
  expect(indexes).toEqual(EffectArray.sort(indexes, Order.Number));
  for (const index of indexes) {
    expect(`${steps[index]?.name ?? ''}: ${steps[index]?.if ?? ''}`).toBe(
      `${steps[index]?.name ?? ''}: ${BOOTSTRAP_CONDITION}`,
    );
  }
  // Bootstrap migrates through the assembled stage entry point, not the source command.
  expect(named(BACKEND_ARTIFACT_UNPACK_STEP)).toBeLessThan(indexes[0] ?? -1);
  const migrations = named(SOURCE_MIGRATIONS_STEP);
  expect(steps[migrations]?.if).toBe(NON_BOOTSTRAP_CONDITION);
  const bootstrap = named(ASSEMBLED_MIGRATOR_STEP);
  expect(steps[bootstrap]?.if).toBe(BOOTSTRAP_CONDITION);
  expect(bootstrap).toBeLessThan(indexes[0] ?? -1);
  expect(migrations).toBeLessThan(indexes[0] ?? -1);
  expect(steps[named(START_INTEGRATION_SERVICES_STEP)]?.if).toBe(
    "matrix.suite == 'bootstrap' || matrix.suite == 'browser' || matrix.suite == 'database'",
  );
  // The suites never run on this row, and its steps never run on a suite row.
  expect(steps.find(({ env }) => env?.INTEGRATION_TASKS !== undefined)?.if).toBe(BACKEND_INTEGRATION_CONDITION);
});

it('unpacks the bootstrap Node artifacts before it assembles the app artifact that ships them', () => {
  const { needs, steps } = readIntegrationJobs()[NODE_TOPOLOGY_PROOF_JOB];
  const named = (name: string) => steps.findIndex((step) => step.name === name);
  const download = named(BACKEND_ARTIFACT_DOWNLOAD_STEP);
  const unpack = named(BACKEND_ARTIFACT_UNPACK_STEP);
  // The bootstrap needs the build shards, so the artifacts exist when it starts and it never waits for them.
  expect(needs).toContain(NODE_ARTIFACT_BUILD_JOB);
  expect(download).toBeLessThan(named(INSTALL_APP_STEP));
  // The assembled migrator ships the materialized Outbox Worker host, which is made from the built outputs.
  expect(unpack).toBeLessThan(named(WORKER_PROVISION_STEP));
  expect(named(WORKER_PROVISION_STEP)).toBeLessThan(named(ASSEMBLED_MIGRATOR_STEP));
  for (const proof of [
    ASSEMBLED_MIGRATOR_STEP,
    WORKER_PROOF_STEP,
    FEDERATED_TYPES_STEP,
    BACKEND_FEDERATION_PROOF_STEP,
  ]) {
    expect(named(proof), proof).toBeGreaterThan(unpack);
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
  './packages/core-runtime': [
    'packages/core-runtime/tests/integration/action-authority-v2-migration.test.ts',
    'packages/core-runtime/tests/integration/application-composition-authority-migration.test.ts',
    'packages/core-runtime/tests/integration/application-composition-durable-work-migration.test.ts',
    'packages/core-runtime/tests/integration/auth-namespace-migration.test.ts',
    'packages/core-runtime/tests/integration/contacts-identity-migration.test.ts',
    'packages/core-runtime/tests/integration/search-v2-cutover-migration.test.ts',
  ],
  './verticals/commerce-customer-context': [
    'verticals/commerce-customer-context/tests/integration/organization-profile-ico-migration-postgres.test.ts',
    'verticals/commerce-customer-context/tests/integration/stage-recovery-lane15-lifecycle.test.ts',
  ],
  './verticals/party-registry': [
    'verticals/party-registry/tests/integration/party-identity-runtime.test.ts',
    'verticals/party-registry/tests/integration/official-identifier-original-input-migration.test.ts',
    'verticals/party-registry/tests/integration/verification-removal-migration.test.ts',
  ],
  './verticals/pricing': ['verticals/pricing/tests/integration/market-revision-whole-current-pricing-postgres.test.ts'],
  './verticals/privacy': ['verticals/privacy/tests/integration/privacy-composition-drain.test.ts'],
  root: [
    'scripts/integration/organization-source-customer-owner-conformance.test.mts',
    'scripts/integration/organization-source-customer-identity-conformance.test.mts',
    'scripts/integration/symmy-c14-customer-owner-conformance.test.mts',
    'scripts/integration/symmy-c14-customer-roundtrip-conformance.test.mts',
    'scripts/integration/symmy-c14-pricing-routes-conformance.test.mts',
    'scripts/integration/migrator-runtime-owner-access.test.mts',
    'scripts/integration/stage-recovery-lifecycle.test.mts',
    'scripts/integration/vat-deploy-sequence.test.mts',
  ],
} satisfies Readonly<Record<string, readonly string[]>>;
/** Root integration files that run in another rstest project of app/rstest.config.ts: operator and owned-cluster tests. */
const ROOT_FILES_ELSEWHERE = [
  'scripts/integration/siampark-demo-http.test.mts',
  'scripts/integration/migration-equivalence.test.mts',
];
/** Integration files a sharded family runs, minus the files its whole-owner tasks run alone. */
const familyFiles = (family: string) =>
  (family === 'root'
    ? integrationFiles('scripts/integration', '.test.mts').filter((file) => !ROOT_FILES_ELSEWHERE.includes(file))
    : integrationFiles(`${family.slice(2)}/tests/integration`, '.test.ts')
  ).filter((file) => !Object.entries(WHOLE_FILES).some(([owner, files]) => owner === family && files.includes(file)));
const NATIVE_TOPOLOGY_PROOFS = [
  'whole:organization',
  'whole:organization-identity',
  'whole:customer-readback',
  'whole:customer-roundtrip',
  'whole:pricing-routes',
  'whole:privacy',
  'whole:privacy-recovery',
  'whole:pricing',
  'whole:preproposal-basis',
  'whole:preproposal-approval',
] as const;
/** The migration and recovery proofs, each alone on a freshly reset lane database (scripts/plan-ci-checks.mts). */
const MIGRATION_PROOFS = [
  'whole:migrator-owner-access',
  'whole:stage-recovery',
  'whole:vat-deploy-sequence',
  'whole:core-runtime-migrations',
  'whole:customer-context-migrations',
  'whole:party-migrations',
];
const WHOLE_PROOFS = [...NATIVE_TOPOLOGY_PROOFS, ...MIGRATION_PROOFS, 'whole:party-worker'];
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
    'rstest --project integration --pool.maxWorkers 1 && pnpm -r --no-bail --no-sort --workspace-concurrency 1 --if-present run test:integration --pool.maxWorkers 1',
  );
  for (const file of [...Object.values(WHOLE_FILES).flat(), ...ROOT_FILES_ELSEWHERE]) {
    expect(existsSync(new URL(file, APP_ROOT_URL)), file).toBe(true);
  }
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
    if (family === 'root') {
      // One file per root task, so a root file never shares a task with another as files are added.
      expect(count).toBe(familyFiles(family).length);
    }
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
  const run = readIntegrationJobs()[OWNER_INTEGRATION_JOB].steps.find(
    ({ env }) => env?.INTEGRATION_TASKS !== undefined,
  );
  expect(run?.if).toBe(BACKEND_INTEGRATION_CONDITION);
  expect(run?.env).toMatchObject({
    APP_ENV_PATH: '/dev/null',
    INTEGRATION_LANES: expression('matrix.lanes'),
    INTEGRATION_TASKS: expression('toJSON(matrix.tasks)'),
    ONTOS_CI_ISOLATED_WORKERS: '2',
    SPICEDB_DATABASE_PASSWORD: 'spicedb',
  });
  expect(run?.run?.trim()).toBe('bash scripts/ci/run-integration-suites.sh');
  const rows = integrationRows();
  expect(rows.every(({ lanes }) => lanes === 2)).toBe(true);
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

it('runs excluded whole-owner scenarios exactly once in isolated integration lanes', () => {
  const jobs = readIntegrationJobs();
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
    expect(jobs[OWNER_INTEGRATION_JOB].steps.some(({ run }) => run?.includes(file) === true)).toBe(false);
  }
});

it('formats and lints every tracked file in exactly one pre-commit hook shard', () => {
  const lint = readGateCommandJobs()[FORMAT_AND_LINT_JOB];
  const step = lint.steps.find(({ run }) => run?.includes('--files-from-stdin') === true);
  const shards = Number(step?.env?.SHARDS);
  expect(lint.strategy.matrix.shard).toEqual(Array.from({ length: shards }, (_, index) => index + 1));
  const run = step?.run ?? 'exit 1';
  // The hook sees its shard's files, and a file it fixes fails the gate.
  expect(run).toContain('lefthook run pre-commit --files-from-stdin --no-auto-install');
  expect(run.trimEnd().endsWith('git diff --exit-code HEAD')).toBe(true);
  const select = run.slice(0, run.indexOf('mise exec'));
  const sourceRepository = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-lint-shards-'));
  const repository = path.join(directory, 'repository');
  const nativeGit = '/usr/bin/git';
  try {
    mkdirSync(repository);
    execFileSync(nativeGit, ['init', '--quiet', repository], { env: { PATH: STEP_PATH } });
    const sourcePaths = [
      '.github/workflows/ultramodern-workspace-gates.yml',
      'README.md',
      'app/apps/shell-super-app/package.json',
      'app/package.json',
      'app/packages/core-runtime/package.json',
      'app/scripts/check.mts',
      'app/scripts/zerops/build-app.sh',
      'app/verticals/catalog/package.json',
      LEFTHOOK_CONFIG,
    ];
    for (const file of sourcePaths) {
      const destination = path.join(repository, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(path.join(sourceRepository, file)));
    }
    const specialPaths = ['app/source/with spaces.ts', 'app/source/with\nnewline.ts', 'app/source/žluťoučký.ts'];
    const fixturePaths = [
      ...Array.from({ length: shards * 2 + 1 }, (_, index) => `app/source/file-${index}.ts`),
      ...specialPaths,
    ];
    for (const file of fixturePaths) {
      const destination = path.join(repository, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, 'export {};\n');
    }
    execFileSync(nativeGit, ['-C', repository, 'add', '--all'], { env: { PATH: STEP_PATH } });
    const untrackedPath = 'app/source/untracked-negative.ts';
    writeFileSync(path.join(repository, untrackedPath), 'export {};\n');
    const selected = Array.from({ length: shards }, (_, index) => {
      execFileSync('/bin/bash', ['-eo', 'pipefail', '-c', select], {
        cwd: repository,
        env: { PATH: STEP_PATH, RUNNER_TEMP: directory, SHARD: String(index + 1), SHARDS: String(shards) },
      });
      return readFileSync(path.join(directory, 'shard-files'), 'utf-8').split('\0').filter(Boolean);
    });
    const tracked = execFileSync(nativeGit, ['ls-files', '-z'], {
      cwd: repository,
      encoding: 'utf-8',
      maxBuffer: 8 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean);
    expect(tracked).toHaveLength(sourcePaths.length + fixturePaths.length);
    for (const file of specialPaths) {
      expect(tracked).toContain(file);
    }
    expect(tracked).not.toContain(untrackedPath);
    expect(sorted(selected.flat())).toEqual(sorted(tracked));
    // Each shard is one contiguous slice in `git ls-files` order, so it loads only the type programs of its packages.
    expect(selected.flat()).toEqual(tracked);
    expect(shards).toBeGreaterThan(1);
    for (const files of selected) {
      expect(files.length).toBeGreaterThan(0);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

const RUNTIME_IDENTITY_URLS = Object.fromEntries(
  DATABASE_IDENTITIES.filter(({ urlKey }) => urlKey !== 'DATABASE_URL').map(({ role, urlKey }) => [urlKey, role]),
);
const IDENTITY_STEP_ENV_FILTER = /printenv \| grep -E '(?<pattern>[^']+)'/gu;
const AUDIT_STEP = 'Audit runtime database identities against the checked-in grant manifest';

it('gives every CI database tool a separate login per runtime identity and audits their grants', () => {
  const source = readFileSync(GATES_WORKFLOW_URL, 'utf-8');
  const integration = Schema.decodeUnknownSync(
    Schema.Struct({
      jobs: Schema.Struct({
        [SERVICE_INTEGRATION_JOB]: IntegrationRunnerSchema.mapFields(({ env, steps }) => ({ env, steps })),
      }),
    }),
  )(parse(source)).jobs[SERVICE_INTEGRATION_JOB];
  const admin = Schema.decodeUnknownSync(Schema.URLFromString)(integration.env?.DATABASE_ADMIN_URL);
  for (const [key, role] of Object.entries(RUNTIME_IDENTITY_URLS)) {
    expect(integration.env?.[key]).toBe(`postgresql://${role}:${role}@${admin.host}${admin.pathname}`);
  }
  // Identity URLs stay in each job's explicit environment, never a generated dotenv file.
  expect([...source.matchAll(IDENTITY_STEP_ENV_FILTER)]).toHaveLength(0);
  const { steps } = integration;
  const start = steps.findIndex(({ name }) => name === START_INTEGRATION_SERVICES_STEP);
  const initialize = steps.findIndex(({ name }) => name === INITIALIZE_IDENTITIES_STEP);
  const removeRuntime = steps.findIndex(({ name }) => name.startsWith('Remove the pre-seeded runtime role'));
  const stageMigrator = steps.findIndex(({ name }) => name === ASSEMBLED_MIGRATOR_STEP);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(initialize).toBeGreaterThan(start);
  expect(initialize).toBeLessThan(removeRuntime);
  expect(removeRuntime).toBeLessThan(stageMigrator);
  // Every row that starts its own fresh cluster initializes its login identities; the owner rows restore them.
  expect(steps[initialize]?.if).toBe(steps[start]?.if);
  expect(steps[initialize]?.run).toBe('mise exec -- pnpm db:bootstrap-runtime-role');
  expect(steps[initialize]?.env).toEqual({
    DATABASE_LOGIN_ROLE_POLICY: 'initialize-local',
    ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development',
  });
  expect(integration.env?.DATABASE_LOGIN_ROLE_POLICY).toBeUndefined();
  expect(steps[stageMigrator]?.env?.DATABASE_LOGIN_ROLE_POLICY).toBeUndefined();
  expect(steps[stageMigrator]?.env?.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT).toBe('stage');
  // The grant audit runs once per run, on the bootstrap row only, after the migrator that provisions the
  // identities it audits. It reads no matrix input, so no other row repeats it.
  const audit = steps.findIndex(({ name }) => name === AUDIT_STEP);
  expect(audit).toBeGreaterThan(stageMigrator);
  expect(steps[audit]?.if).toBe(BOOTSTRAP_CONDITION);
  expect(steps[audit]?.run).toBe('mise exec -- pnpm database-trust:audit');
  expect(steps.filter(({ run }) => (run ?? '').includes('database-trust:audit'))).toHaveLength(1);
});

it('proves the deployment bootstrap once, on a row beside the suites', () => {
  const { steps } = readIntegrationJobs()[NODE_TOPOLOGY_PROOF_JOB];
  const names = steps.map(({ name }) => name);
  // Bootstrap ordering is proved end to end: the pre-seeded runtime role goes first, then the real
  // migrator artifact against the scratch cluster, then the grant audit and the host.
  const order = [
    START_INTEGRATION_SERVICES_STEP,
    'Remove the pre-seeded runtime role to prove deployment bootstrap ordering',
    WORKER_PROVISION_STEP,
    ASSEMBLED_MIGRATOR_STEP,
    AUDIT_STEP,
    WORKER_PROOF_STEP,
  ];
  expect(names.filter((name) => order.includes(name))).toEqual(order);
  // Each of these proofs runs on the bootstrap row alone; the runtime-role drop in particular would leave
  // an ordinary row with no login for its own suites.
  for (const name of order.slice(1)) {
    expect(steps.find((candidate) => candidate.name === name)?.if, name).toBe(BOOTSTRAP_CONDITION);
  }
  // The assembled migrator already applies and verifies every owner; the browser and database rows
  // migrate their own cluster once with the source command.
  const migrations = steps.find(({ name }) => name === SOURCE_MIGRATIONS_STEP);
  expect(migrations?.if).toBe(NON_BOOTSTRAP_CONDITION);
  expect(steps.filter(({ run }) => (run ?? '').includes('pnpm db:migrate'))).toHaveLength(1);
  expect(steps.find(({ name }) => name === BACKEND_ARTIFACT_DOWNLOAD_STEP)?.if).toBe(BACKEND_ARTIFACT_CONDITION);
  expect(steps.find(({ name }) => name === BACKEND_ARTIFACT_UNPACK_STEP)?.if).toBeUndefined();
});

it.effect('proves Node artifacts against a migrated PostgreSQL database with every declared login identity', () =>
  Effect.gen(function* proveNodeDatabaseIdentities() {
    // The bootstrap row migrates the cluster it starts itself, with the same identity URLs as the suites.
    const integration = readIntegrationJobs()[NODE_TOPOLOGY_PROOF_JOB];
    const environment = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(integration.env);
    const admin = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(environment.DATABASE_ADMIN_URL);
    expect(admin.port).toBe(environment.POSTGRES_PORT);
    expect(admin.username).toBe(environment.POSTGRES_USER);
    expect(admin.password).toBe(environment.POSTGRES_PASSWORD);
    expect(admin.pathname).toBe(`/${environment.POSTGRES_DB ?? ''}`);
    const bootstrap = integration.steps.findIndex(({ name }) => name === ASSEMBLED_MIGRATOR_STEP);
    const proof = integration.steps.findIndex(({ run }) => run === 'mise exec -- pnpm node:proof');
    expect(integration.steps[bootstrap]?.if).toBe(BOOTSTRAP_CONDITION);
    expect(bootstrap).toBeGreaterThanOrEqual(0);
    expect(bootstrap).toBeLessThan(proof);
    expect(integration.steps[proof]?.if).toBe(BOOTSTRAP_CONDITION);
    for (const identity of DATABASE_IDENTITIES) {
      const connection = yield* loadDatabaseConfig({ environment, envPath: '/dev/null', identity });
      expect(connection.expectedRole).toBe(identity.role);
      const runtime = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(connection.connectionString);
      expect(runtime.username).toBe(identity.role);
      expect(runtime.pathname).toBe(admin.pathname);
      expect(runtime.hostname).toBe(admin.hostname);
      expect(Number(runtime.port)).toBe(Number(admin.port));
    }
  }),
);

it('restores same-run Node artifacts for every backend integration fixture and excludes browser rows', () => {
  const jobs = readIntegrationJobs();
  const integration = jobs[OWNER_INTEGRATION_JOB];
  expect(integration.needs).toContain(NODE_ARTIFACT_BUILD_JOB);
  const ownerRows = integrationRows();
  const roots = ownerRows.filter((shard) => rootRow(shard));
  // Shard counts are reshard-dependent and their completeness is proved where the shard ids are checked
  // as a derived 1..n set; here the contract is only that these fixtures exist and are backend rows.
  expect(roots.length).toBeGreaterThan(0);
  const customerContext = ownerRows.filter((shard) => shardFilters(shard).includes(CUSTOMER_CONTEXT_SELECTOR));
  expect(customerContext.length).toBeGreaterThan(0);
  expect(jobs[SERVICE_INTEGRATION_JOB].strategy.matrix.include.map(({ suite }) => suite)).toEqual(['database']);
  expect(jobs[BROWSER_INTEGRATION_JOB].strategy.matrix.include.map(({ suite }) => suite)).toEqual(['browser']);
  expect(ownerRows).toEqual(integration.strategy.matrix.include);
  const { steps } = integration;
  const download = steps.findIndex(({ name }) => name === BACKEND_ARTIFACT_DOWNLOAD_STEP);
  const unpack = steps.findIndex(({ wait }) => wait === NATIVE_ARTIFACTS_STEP_ID);
  // The suites read the source worker hosts; no row materializes a worker artifact for them.
  expect(steps.some(({ run }) => run?.includes('zerops:materialize') === true && !run.includes('if [ ! -f'))).toBe(
    false,
  );
  const tests = steps.findIndex(({ env }) => env?.INTEGRATION_TASKS !== undefined);
  expect(download).toBeGreaterThan(-1);
  expect(download < unpack && unpack < tests).toBe(true);
  expect(steps.some(({ uses }) => uses?.startsWith(DOWNLOAD_ARTIFACT_ACTION) === true)).toBe(false);
  // Every owner row restores the same artifacts, which exist when it starts.
  const preproposal = ownerRows.filter((shard) =>
    (shard.tasks ?? []).some((task) => task.startsWith('whole:preproposal-')),
  );
  expect(preproposal).toHaveLength(2);
});

it('downloads complete same-run artifacts without holding a runner to poll for them', () => {
  const { needs, steps } = readIntegrationJobs()[OWNER_INTEGRATION_JOB];
  expect(needs).toEqual([CI_PLAN_JOB, NODE_ARTIFACT_BUILD_JOB, SERVICE_INTEGRATION_JOB]);
  expect(steps.some(({ run }) => run?.includes('wait-for-build-shards.sh') === true)).toBe(false);
  const download = steps.findIndex(({ name }) => name === BACKEND_ARTIFACT_DOWNLOAD_STEP);
  expect(download).toBeGreaterThan(-1);
  for (const name of [ASSEMBLED_MIGRATOR_STEP, WORKER_PROOF_STEP]) {
    expect(
      steps.findIndex((step) => step.name === name),
      name,
    ).toBeGreaterThan(download);
  }
});

it('exports the built Composition path to native tests only after its derivation succeeds', () => {
  const { steps } = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(readGateWorkflow()).jobs[
    SERVICE_INTEGRATION_JOB
  ];
  const derive = steps.find(({ run }) => run?.includes(DERIVE_BUILT_COMPOSITION_COMMAND) === true);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-native-composition-step-'));
  try {
    for (const exitCode of [0, 37]) {
      const temporary = path.join(directory, String(exitCode));
      mkdirSync(temporary);
      const executable = path.join(temporary, 'mise');
      // This executable checks only the workflow's CLI boundary, not the derivation codec.
      writeFileSync(
        executable,
        `#!/bin/bash
set -euo pipefail
printf "%s\\n" "$@" > "$DERIVATION_ARGUMENTS"
if [[ "$DERIVATION_EXIT_CODE" != 0 ]]; then exit "$DERIVATION_EXIT_CODE"; fi
printf "derived-snapshot" > "$6"
`,
      );
      chmodSync(executable, 0o755);
      const environmentFile = path.join(temporary, 'environment');
      const argumentsFile = path.join(temporary, 'arguments');
      writeFileSync(environmentFile, '');
      const passed = stepPasses(derive?.run ?? 'exit 1', {
        DERIVATION_ARGUMENTS: argumentsFile,
        DERIVATION_EXIT_CODE: String(exitCode),
        GITHUB_ENV: environmentFile,
        PATH: `${temporary}:${STEP_PATH}`,
        RUNNER_TEMP: temporary,
      });
      const snapshot = path.join(temporary, 'native-composition-snapshot.json');
      expect(passed).toBe(exitCode === 0);
      expect(readFileSync(argumentsFile, 'utf-8').trimEnd().split('\n')).toEqual([
        'exec',
        '--',
        'node',
        'scripts/derive-built-application-composition.mts',
        '--snapshot-output',
        snapshot,
      ]);
      expect(readFileSync(environmentFile, 'utf-8')).toBe(
        exitCode === 0 ? `NATIVE_1290_COMPOSITION_SNAPSHOT_PATH=${snapshot}\n` : '',
      );
      if (exitCode === 0) {
        expect(readFileSync(snapshot, 'utf-8')).toBe('derived-snapshot');
      }
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it('ships a runnable fresh-database proof for the actual app artifact without overwriting existing contents', () => {
  const scriptUrl = new URL('../prove-zerops-migrator-artifact.sh', import.meta.url);
  const script = fileURLToPath(scriptUrl);
  const source = readFileSync(scriptUrl, 'utf-8');
  expect(execFileSync('/bin/sh', ['-n', script], { encoding: 'utf-8' })).toBe('');
  // The proof assembles the app container's runtime tree from the paths the Zerops build packs into its release.
  expect(source).toContain('scripts/zerops/app-runtime-paths.txt');
  expect(source).toContain('exec node scripts/run-zerops-migrator.mjs');
  const runtimePaths = readFileSync(new URL('../zerops/app-runtime-paths.txt', import.meta.url), 'utf-8')
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'));
  expect(runtimePaths.length).toBeGreaterThan(0);
  expect(runtimePaths.every((file) => file.startsWith('app/'))).toBe(true);
  // The Zerops build creates these three; every job that assembles the artifact provisions them before the proof.
  expect(runtimePaths).toEqual(
    expect.arrayContaining(['app/.zerops/runtime/outbox-worker-host', 'app/.zerops/bun', 'app/.zerops/state']),
  );
  // The bootstrap row is the one row that assembles the artifact; it provisions those paths before the proof.
  const { steps } = readIntegrationJobs()[NODE_TOPOLOGY_PROOF_JOB];
  const provision = steps.findIndex(({ name }) => name === WORKER_PROVISION_STEP);
  expect(provision).toBeGreaterThan(-1);
  expect(provision).toBeLessThan(steps.findIndex(({ name }) => name === ASSEMBLED_MIGRATOR_STEP));
  expect(steps[provision]?.if).toBe(BOOTSTRAP_CONDITION);
  // The runner is glibc: the musl build Zerops runs cannot load its C++ runtime here.
  expect(steps[provision]?.run).toContain('sh scripts/install-zerops-bun.sh 1.4.4 glibc');
  expect(steps[provision]?.run).not.toContain('musl');
  expect(steps[provision]?.run).toContain('zerops:materialize --app outbox-worker-host');
  expect(steps[provision]?.run).toContain(
    "mkdir -p .zerops/state && printf '[]' >.zerops/state/module-credential-boots.json",
  );
  const artifact = mkdtempSync(path.join(os.tmpdir(), 'ontos-existing-migrator-artifact-'));
  const marker = path.join(artifact, 'preserved-owner-data');
  try {
    writeFileSync(marker, 'preserve this artifact');
    expect(() => execFileSync('/bin/sh', [script, artifact], { encoding: 'utf-8', stdio: 'pipe' })).toThrow(
      'must be empty',
    );
    expect(readFileSync(marker, 'utf-8')).toBe('preserve this artifact');
  } finally {
    rmSync(artifact, { force: true, recursive: true });
  }
});

it('refuses root native integration when the same-run build archives are missing', () => {
  const integration = readIntegrationJobs()[OWNER_INTEGRATION_JOB];
  const download = integration.steps.find(({ name }) => name === BACKEND_ARTIFACT_DOWNLOAD_STEP);
  // The unpack half of the download step, without the download.
  const unpack = { run: download?.run?.split('\n').slice(1).join('\n') };
  expect(unpack.run?.trim()).toBe(INTEGRATION_UNPACK_COMMAND);
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

it('keeps deployment out of the workspace gates and guards Action transaction I/O', () => {
  const { env, jobs } = Schema.decodeUnknownSync(GatedJobsSchema)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')));
  expect(env.ONTOS_ACTION_TRANSACTION_IO_GUARD).toBe('true');
  // Workflow-level env has no runner context: `runner.temp` there names no directory, so the cache path is literal.
  expect(path.isAbsolute(env.NODE_COMPILE_CACHE ?? '')).toBe(true);
  expect(env.NODE_COMPILE_CACHE).not.toContain('${{');
  // The retired deploy chain stays out of the gates: the workflow only plans and runs checks.
  expect(sorted(Object.keys(jobs))).toEqual(sorted([QUEUE_PROOF_JOB, CI_PLAN_JOB, ...GATE_JOBS, WORKSPACE_GATES_JOB]));
});

it('runs migration equivalence proofs only against the owned CI maintenance database', () => {
  // The proof creates and drops databases on its cluster, so it runs on the bootstrap row, against the cluster that
  // row started and migrated, never on a restored worker cluster that other lanes share.
  const { steps } = readIntegrationJobs()[NODE_TOPOLOGY_PROOF_JOB];
  const proofs = steps.filter(({ run }) => run?.includes('--project owned-cluster') === true);
  expect(proofs).toHaveLength(1);
  expect(proofs[0]?.if).toBe(BOOTSTRAP_CONDITION);
  expect(proofs[0]?.run).toBe('mise exec -- pnpm exec rstest --project owned-cluster --pool.maxWorkers 1');
  expect(proofs[0]?.env).toEqual({
    APP_ENV_PATH: '/dev/null',
    MIGRATION_EQUIVALENCE_TEST_DATABASE_URL: 'postgresql://ontos_ci_admin:ontos_ci_admin@localhost:5433/postgres',
    MIGRATION_EQUIVALENCE_TEST_SANDBOX: 'owned-postgres18',
  });
  expect(proofs[0] === undefined ? -1 : steps.indexOf(proofs[0])).toBeGreaterThan(
    steps.findIndex(({ name }) => name === ASSEMBLED_MIGRATOR_STEP),
  );
  // No owner row may run it: the root project leaves the file to the owned-cluster project.
  const config = readFileSync(new URL('../../rstest.config.ts', import.meta.url), 'utf-8');
  expect(config).toContain("const ownedClusterTests = ['scripts/integration/migration-equivalence.test.mts'];");
  expect(config).toContain("include: ['scripts/integration/**/*.test.mts', ...elsewhere]");
  const tests = steps.find(({ env }) => env?.INTEGRATION_TASKS !== undefined);
  expect(tests?.env?.MIGRATION_EQUIVALENCE_TEST_DATABASE_URL).toBeUndefined();
});

const AnyStepSchema = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  id: Schema.optional(Schema.String),
  if: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
  with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const AnyJobsSchema = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      outputs: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      'runs-on': Schema.optional(Schema.String),
      steps: Schema.Array(AnyStepSchema),
    }),
  ),
});
const readJobsOf = (file: string) =>
  Schema.decodeUnknownSync(AnyJobsSchema)(
    parse(readFileSync(new URL(`../../../.github/workflows/${file}`, import.meta.url), 'utf-8')),
  ).jobs;
const InstallActionSchema = Schema.Struct({
  runs: Schema.Struct({ steps: Schema.Array(AnyStepSchema) }),
});
const readInstallAction = () =>
  Schema.decodeUnknownSync(InstallActionSchema)(
    parse(readFileSync(new URL('../../../.github/actions/install-app/action.yml', import.meta.url), 'utf-8')),
  ).runs.steps;
const CHANGED_PATHS_ARTIFACT = 'ci-changed-paths';
const DEMO_REF = "github.ref == 'refs/heads/demo/sales-crm'";

it('saves the pnpm store from the one planner install, on the trunks only', () => {
  const store = readInstallAction().find(({ name }) => name === 'Save the pnpm store');
  expect(store?.if).toContain(DEMO_REF);
  expect(store?.if).toContain("github.ref == 'refs/heads/main'");
  const gates = readJobsOf(GATES_WORKFLOW);
  const planInstall = gates[CI_PLAN_JOB]?.steps.find(({ uses }) => uses === INSTALL_APP_ACTION);
  expect(planInstall?.with).toEqual({ 'save-store': 'true' });
});

it('saves the installed workspace from the typecheck row alone, and restores it only for a complete install', () => {
  const install = readInstallAction();
  // A caller with its own install arguments (the quality audit, the stage deploy) installs from the store as before.
  for (const name of [
    'List the workspace packages',
    'Name the installed workspace',
    'Restore the installed workspace',
  ]) {
    expect(install.find((step) => step.name === name)?.if, name).toBe(
      "inputs.restore-node-modules == 'true' && inputs.install-args == ''",
    );
  }
  // One first-wave job saves, so parallel jobs never race; the jobs after the build shards restore what it saved.
  const savers = Object.entries(readJobsOf(GATES_WORKFLOW)).flatMap(([job, { steps }]) =>
    steps
      .filter((step) => step.uses === INSTALL_APP_ACTION && step.with?.['save-node-modules'] !== undefined)
      .map((step) => [job, step.with?.['save-node-modules']]),
  );
  expect(savers).toEqual([[WORKSPACE_GATE_JOB, expression('matrix.typescript-build == true')]]);
  expect(MATRICES.source.filter((row) => row['typescript-build'] === true).map(({ name }) => name)).toEqual([
    'Typecheck and OntOS API Boundary Rules',
  ]);
});

const workspaceManifest = (name: string, dependencies: Readonly<Record<string, string>>) =>
  JSON.stringify({ dependencies, name, private: true, version: '1.0.0' });

it('uses a restored workspace only when pnpm would run in it without installing', () => {
  const verify = readInstallAction().find(({ id }) => id === 'restored')?.run ?? 'exit 1';
  // The bash and pnpm the tests run with: the step reads its packages with mapfile, which macOS's /bin/bash lacks.
  const [bash = 'bash', pnpm = 'pnpm'] = execFileSync('/bin/sh', ['-c', 'command -v bash pnpm'], { encoding: 'utf-8' })
    .trim()
    .split('\n');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-restored-workspace-'));
  const bin = path.join(directory, 'bin');
  const workspace = path.join(directory, 'app');
  const env = { HOME: directory, PATH: `${bin}:${path.dirname(pnpm)}:${STEP_PATH}` };
  const usable = () => {
    const output = path.join(directory, 'output');
    writeFileSync(output, '');
    execFileSync(bash, ['--noprofile', '--norc', '-eo', 'pipefail', '-c', verify], {
      cwd: workspace,
      env: { ...env, GITHUB_OUTPUT: output, PACKAGES: 'packages/bare\npackages/linked', RESTORED: 'true' },
      stdio: 'pipe',
    });
    return readFileSync(output, 'utf-8').trim();
  };
  try {
    mkdirSync(bin);
    // The action runs pnpm through mise; this mise runs the command it is given.
    writeFileSync(path.join(bin, 'mise'), '#!/bin/bash\n[ "$1 $2" = "exec --" ] || exit 2\nshift 2\nexec "$@"\n');
    chmodSync(path.join(bin, 'mise'), 0o755);
    for (const [member, dependencies] of [
      ['bare', {}],
      ['linked', { bare: 'workspace:*' }],
    ] as const) {
      mkdirSync(path.join(workspace, 'packages', member), { recursive: true });
      writeFileSync(path.join(workspace, 'packages', member, 'package.json'), workspaceManifest(member, dependencies));
    }
    writeFileSync(path.join(workspace, 'package.json'), workspaceManifest('workspace', {}));
    writeFileSync(path.join(workspace, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    execFileSync(pnpm, ['install', '--offline', '--no-frozen-lockfile'], { cwd: workspace, env, stdio: 'pipe' });
    // A package without dependencies gets no node_modules, and a complete tree is still used.
    expect(existsSync(path.join(workspace, 'packages/bare/node_modules'))).toBe(false);
    expect(usable()).toBe('usable=true');
    // A package that declares dependencies but lost its node_modules: pnpm refuses to run, so it is a clean miss.
    rmSync(path.join(workspace, 'packages/linked/node_modules'), { force: true, recursive: true });
    expect(usable()).toBe('usable=false');
    expect(existsSync(path.join(workspace, 'node_modules'))).toBe(false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it('lints only the changed files of a narrowed run unless a tool configuration changed', () => {
  const plan = readJobsOf(GATES_WORKFLOW)[CI_PLAN_JOB];
  const upload = plan?.steps.find(({ uses }) => uses?.startsWith('actions/upload-artifact@') === true);
  // A re-run of ci-plan, whose planning can fail after this upload, replaces it instead of failing on the name.
  expect(upload?.with).toMatchObject({
    name: CHANGED_PATHS_ARTIFACT,
    overwrite: true,
    path: `${RUNNER_TEMP_EXPRESSION}/ci-changed-paths`,
  });
  expect(plan?.outputs?.['lint-shards']).toBe(expression("steps.lint-shards.outputs.shards || '[1,2,3]'"));
  const choose = plan?.steps.find(({ id }) => id === 'lint-shards')?.run ?? 'exit 1';
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-lint-choice-'));
  const shardsFor = (mode: string, paths: readonly string[]) => {
    const changed = path.join(directory, 'changed');
    const output = path.join(directory, 'output');
    writeFileSync(changed, paths.map((file) => `${file}\0`).join(''));
    writeFileSync(output, '');
    execFileSync('/bin/bash', ['-eo', 'pipefail', '-c', choose], {
      env: { CHANGED_PATHS: changed, GITHUB_OUTPUT: output, PATH: STEP_PATH, PLAN_MODE: mode },
      stdio: 'pipe',
    });
    return readFileSync(output, 'utf-8').trim();
  };
  try {
    const ordinary = ['app/verticals/catalog/src/a b.ts', 'app/verticals/catalog/src/index.ts'];
    expect(shardsFor('affected', ordinary)).toBe('shards=[0]');
    expect(shardsFor('scoped', ordinary)).toBe('shards=[0]');
    expect(shardsFor('full', ordinary)).toBe(WHOLE_TREE_LINT_SHARDS);
    expect(shardsFor('scoped', [])).toBe(WHOLE_TREE_LINT_SHARDS);
    expect(shardsFor('affected', [])).toBe(WHOLE_TREE_LINT_SHARDS);
    for (const configuration of [
      'app/oxlint.config.ts',
      'app/.oxfmtrc.json',
      LEFTHOOK_CONFIG,
      'app/verticals/catalog/tsconfig.json',
      'app/tools/oxlint/effect-native/rules/index.mts',
      'app/patches/x.patch',
      'app/package.json',
      'app/pnpm-lock.yaml',
      'app/.mise.toml',
    ]) {
      expect(shardsFor('affected', [...ordinary, configuration])).toBe(WHOLE_TREE_LINT_SHARDS);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
  const lint = readJobsOf(GATES_WORKFLOW)[FORMAT_AND_LINT_JOB]?.steps ?? [];
  const download = lint.find(({ uses }) => uses?.startsWith(DOWNLOAD_ARTIFACT_ACTION) === true);
  expect(download?.if).toBe('matrix.shard == 0');
  expect(download?.with?.name).toBe(CHANGED_PATHS_ARTIFACT);
  const changedRow = lint.find(
    ({ name }) => name === "Format and Lint the run's changed files through the pre-commit hook",
  );
  expect(changedRow?.if).toBe('matrix.shard == 0');
  expect(changedRow?.run).toContain('export GIT_LITERAL_PATHSPECS=1');
  expect(changedRow?.run).toContain('lefthook run pre-commit --files-from-stdin --no-auto-install');
  expect(changedRow?.run?.trimEnd().endsWith('git diff --exit-code HEAD')).toBe(true);
  expect(lint.find(({ name }) => name === "Format and Lint the shard's files through the pre-commit hook")?.if).toBe(
    'matrix.shard != 0',
  );
});

it('runs the lint rules and the whole-tree repository policy once in every plan, beside the lint', () => {
  const lint = readJobsOf(GATES_WORKFLOW)[FORMAT_AND_LINT_JOB]?.steps ?? [];
  // The row every plan runs: shard 0 of a narrowed run, shard 1 of a whole-tree sweep. A scoped plan skips the
  // Typecheck row, and the policy lints the whole app tree, so it runs here whatever the hook found.
  const once = expression("!cancelled() && steps.install.outcome == 'success' && matrix.shard <= 1");
  expect(lint.filter((step) => step.if === once).map(({ run }) => run)).toEqual([
    'mise exec -- pnpm typecheck:lint-rules',
    'mise exec -- pnpm test:lint-rules',
    'mise exec -- pnpm lint:repository-policy',
  ]);
  for (const shards of [[0], [1, 2, 3]]) {
    expect(
      shards.filter((shard) => shard <= 1),
      String(shards),
    ).toHaveLength(1);
  }
  expect(WHOLE_TREE_LINT_SHARDS).toBe('shards=[1,2,3]');
  expect(
    readGateCommandJobs()[WORKSPACE_GATE_JOB].strategy.matrix.include.filter(({ commands }) =>
      /lint-rules|lint:repository-policy/u.test(commands),
    ),
  ).toEqual([]);
});

it('saves the demo trunk its own TS-Go and Chromium caches once, after the step that proves them', () => {
  const jobs = readJobsOf(GATES_WORKFLOW);
  const tsgo = jobs[WORKSPACE_GATE_JOB]?.steps.find(
    ({ uses, with: inputs }) =>
      uses?.startsWith(CACHE_SAVE_ACTION) === true && inputs?.path === 'app/node_modules/.cache/tsgo',
  );
  expect(tsgo?.if).toBe(`success() && matrix.typescript-build == true && ${DEMO_REF}`);
  expect(tsgo?.with?.key).toBe(expression('steps.install.outputs.typescript-build-key'));
  const browser = jobs[BROWSER_INTEGRATION_JOB]?.steps ?? [];
  const wait = browser.findIndex(({ name }) => name === 'Wait for the Chromium install');
  const chromium = browser.findIndex(({ uses }) => uses?.startsWith(CACHE_SAVE_ACTION) === true);
  expect(chromium).toBe(wait + 1);
  expect(browser[chromium]?.if).toContain(DEMO_REF);
  expect(browser[chromium]?.if).toContain("steps.playwright-cache.outputs.cache-hit != 'true'");
});

it('creates schema-only native fixtures from an immutable template of the restored job database', () => {
  // Every worker cluster gets the template from the restored archive before any lane starts (restore script), and
  // each lane's environment names it (scripts/tests/ci-integration-workers.test.mts proves the values).
  const restore = readFileSync(new URL('../ci/restore-integration-workers.sh', import.meta.url), 'utf-8');
  expect(restore).toContain(
    'bash scripts/ci/prepare-schema-template.sh "$database" "$INTEGRATION_DATABASE_ARCHIVE/database.dump"',
  );
  const environment = readFileSync(new URL('../ci/integration-worker-environment.mts', import.meta.url), 'utf-8');
  expect(environment).toContain("ONTOS_TEST_SCHEMA_TEMPLATE: 'ontos_ci_schema_template'");
  const { steps } = readIntegrationJobs()[OWNER_INTEGRATION_JOB];
  const restored = steps.findIndex(({ wait }) => wait === INTEGRATION_WORKERS_STEP_ID);
  const tests = steps.findIndex(({ env }) => env?.INTEGRATION_TASKS !== undefined);
  expect(restored !== -1 && restored < tests).toBe(true);
});

it('runs Quality Audit without its duplicate self-test on the pinned runner image', () => {
  const [audit] = Object.values(readJobsOf(QUALITY_AUDIT_WORKFLOW));
  expect(audit?.['runs-on']).toBe('ubuntu-24.04');
  expect(audit?.steps.some(({ run }) => run?.includes('quality:audit:test') === true)).toBe(false);
  expect(audit?.steps.some(({ run }) => run?.includes('quality:audit:gate --summary') === true)).toBe(true);
});
