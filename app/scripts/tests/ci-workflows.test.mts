import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Array as EffectArray, Effect, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

import { DATABASE_IDENTITIES } from '../../database/identity-enrollment.ts';
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
const SEEDED_INTEGRATION_JOB = 'seeded-integration';
const INTEGRATION_SEED_PROOF_JOB = 'integration-seed-proof';
const BROWSER_INTEGRATION_JOB = 'browser-integration';
const WORKSPACE_GATE_JOB = 'workspace-gate';
const WEIGHTED_SHARD_SCRIPT = 'scripts/ci/rstest-weighted-shard.sh';
const WORKSPACE_GATES_JOB = 'workspace-gates';
const DOWNLOAD_ARTIFACT_ACTION = 'actions/download-artifact@';
const ASSEMBLED_MIGRATOR_STEP = 'Run the assembled stage migrator artifact against the fresh database';

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
  const matrices = Schema.decodeUnknownSync(MatricesFileSchema)(
    JSON.parse(readFileSync(new URL('../ci-matrices.json', import.meta.url), 'utf-8')),
  );
  // The planner hands each matrix job only its own rows (scripts/plan-ci-checks.mts).
  for (const [job, key, rows] of [
    [WORKSPACE_GATE_JOB, 'source', matrices.source],
    [WORKSPACE_UNIT_JOB, 'unit', matrices.unit.filter((row) => row['node-artifacts'] !== true)],
    [WORKSPACE_UNIT_ARTIFACTS_JOB, 'unit-artifacts', matrices.unit.filter((row) => row['node-artifacts'] === true)],
    [
      SERVICE_INTEGRATION_JOB,
      'integration',
      matrices.integration.filter((row) => row.suite === 'integration' && row.seed !== true),
    ],
    [
      SEEDED_INTEGRATION_JOB,
      'seeded-integration',
      matrices.integration.filter((row) => row.suite === 'integration' && row.seed === true),
    ],
    [BROWSER_INTEGRATION_JOB, 'browser', matrices.integration.filter((row) => row.suite === 'browser')],
  ] as const) {
    const entry = record(jobs[job]);
    const strategy = record(entry.strategy);
    const matrix = record(strategy.matrix);
    expect(matrix.include).toBe(`\${{ fromJSON(needs.ci-plan.outputs.${key}) }}`);
    jobs[job] = { ...entry, strategy: { ...strategy, matrix: { ...matrix, include: rows } } };
  }
  return { ...workflow, jobs };
};
/** The fixed system PATH a workflow step script runs with in these tests. */
const STEP_PATH = '/usr/bin:/bin';

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
      'lefthook.yml',
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
const NODE_ARTIFACT_PROOF_JOB = 'node-artifact-proof';
const NODE_BUILD_ARTIFACT_PATTERN = 'node-units-*';
const RUNNER_TEMP_EXPRESSION = expression('runner.temp');
const UNPACK_NATIVE_ARTIFACTS_SCRIPT = 'bash scripts/unpack-unit-build-outputs.sh';
/** Consumers pass the units their row names in `artifact-units`; an empty list requires every unit. */
const UNPACK_NATIVE_ARTIFACTS_COMMAND = `${UNPACK_NATIVE_ARTIFACTS_SCRIPT} "$RUNNER_TEMP/native-composition-units" .output $REQUIRED_UNITS`;
const BACKEND_INTEGRATION_CONDITION = "matrix.suite == 'integration'";
const DERIVE_BUILT_COMPOSITION_COMMAND = 'node scripts/derive-built-application-composition.mts --snapshot-output';
const FORMAT_AND_LINT_JOB = 'format-and-lint';
/** Gate jobs rooted at the merge queue proof. */
const ROOT_GATE_JOBS = [
  WORKSPACE_GATE_JOB,
  WORKSPACE_UNIT_JOB,
  WORKSPACE_UNIT_ARTIFACTS_JOB,
  'static-contracts',
  FORMAT_AND_LINT_JOB,
  SERVICE_INTEGRATION_JOB,
  SEEDED_INTEGRATION_JOB,
  INTEGRATION_SEED_PROOF_JOB,
  BROWSER_INTEGRATION_JOB,
  NODE_ARTIFACT_BUILD_JOB,
  NODE_ARTIFACT_PROOF_JOB,
] as const;
/** Every gate job; the Node proof is a gate job of its own that no test job waits for. */
const GATE_JOBS = ROOT_GATE_JOBS;
/** Gate jobs that read this run's built outputs: they wait for the build shards and nothing else. */
const ARTIFACT_CONSUMER_JOBS: ReadonlySet<string> = new Set([
  WORKSPACE_UNIT_ARTIFACTS_JOB,
  SERVICE_INTEGRATION_JOB,
  INTEGRATION_SEED_PROOF_JOB,
  NODE_ARTIFACT_PROOF_JOB,
]);
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
  expect(proof.if).toContain('inputs.force-ci-full != true');
  expect(proof.permissions).toEqual({ actions: 'read' });
  expect(proof.outputs.proven).toBe(expression('steps.proof.outputs.proven'));
  const lookup = proof.steps.find(({ id }) => id === 'proof')?.run ?? '';
  expect(lookup).toContain('runs?head_sha=$GITHUB_SHA&event=merge_group&status=success');
  const { jobs } = Schema.decodeUnknownSync(GatedJobsSchema)(readGateWorkflow());
  expect(jobs[CI_PLAN_JOB]?.needs).toEqual([QUEUE_PROOF_JOB]);
  // Seeded rows also wait for the seed producer, and only for it.
  expect(jobs[SEEDED_INTEGRATION_JOB]?.needs).toEqual([
    CI_PLAN_JOB,
    NODE_ARTIFACT_BUILD_JOB,
    INTEGRATION_SEED_PROOF_JOB,
  ]);
  expect(jobs[SEEDED_INTEGRATION_JOB]?.if).toBe(
    expression(
      `!cancelled() && needs.ci-plan.result == 'success' && needs.node-artifact-build.result == 'success' && needs.integration-seed-proof.result == 'success' && fromJSON(needs.ci-plan.outputs.expected)['${SEEDED_INTEGRATION_JOB}'] == 'success'`,
    ),
  );
  for (const gate of ROOT_GATE_JOBS.filter((job) => job !== SEEDED_INTEGRATION_JOB)) {
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
  expect(selection?.env?.APPLY_AFFECTED).toBe(
    expression("(vars.CI_AFFECTED_ENABLED == 'true' || steps.candidate.outputs.base != '') && 'true' || 'false'"),
  );
  // Only a candidate dispatch that is not forced full resolves a comparison point, before the classification.
  const candidate = steps.findIndex(({ id }) => id === 'candidate');
  expect(candidate).toBeGreaterThan(-1);
  expect(candidate).toBeLessThan(classify);
  expect(steps[candidate]?.if).toBe(
    "github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/heads/candidate/') && inputs.force-ci-full != true",
  );
  expect(steps[candidate]?.env).toEqual({ BASE_REF: expression('inputs.base-ref') });
  expect(steps[classify]?.env?.BASE_SHA).toBe(
    expression(
      'steps.candidate.outputs.base || github.event.pull_request.base.sha || github.event.merge_group.base_sha || github.event.before',
    ),
  );
  expect(steps[classify]?.env?.CANDIDATE_DISPATCH).toBe(expression("steps.candidate.outputs.base != ''"));
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
  expect(workflow.concurrency['cancel-in-progress']).toBe(expression("github.ref != 'refs/heads/main'"));
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
  const needs = (mode: string, results: readonly string[], proof = 'skipped', proven?: string) => ({
    [CI_PLAN_JOB]: {
      outputs: {
        expected: JSON.stringify(
          Object.fromEntries(
            GATE_JOBS.map((gate) => [gate, ['docs', 'proven'].includes(mode) ? 'skipped' : 'success']),
          ),
        ),
        mode,
      },
      result: 'success',
    },
    [QUEUE_PROOF_JOB]: { outputs: proven === undefined ? {} : { proven }, result: proof },
    ...Object.fromEntries(GATE_JOBS.map((gate, index) => [gate, { result: results[index] }])),
  });
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
  expect(passes(needs('docs', skipped))).toBe(true);
  expect(passes(needs('proven', skipped, 'success', 'true'))).toBe(true);
  expect(passes(needs('proven', skipped))).toBe(false);
  expect(passes(needs('full', skipped))).toBe(false);
  expect(passes(needs('full', ['failure', ...passed.slice(1)]))).toBe(false);
  expect(passes(needs('full', ['cancelled', ...passed.slice(1)]))).toBe(false);
  expect(passes(needs('full', passed, 'failure'))).toBe(false);
  const affected = needs('affected', passed);
  expect(passes(affected)).toBe(true);
  const noIntegration = needs('affected', passed);
  const selected = Object.fromEntries(
    GATE_JOBS.map((gate) => [gate, gate === SERVICE_INTEGRATION_JOB ? 'skipped' : 'success']),
  );
  noIntegration[CI_PLAN_JOB].outputs.expected = JSON.stringify(selected);
  expect(passes({ ...noIntegration, [SERVICE_INTEGRATION_JOB]: { result: 'skipped' } })).toBe(true);
  // An affected plan may leave test matrices without rows, but never every unit row, the builds or the Node proof.
  const testMatrices: readonly string[] = [
    WORKSPACE_UNIT_JOB,
    WORKSPACE_UNIT_ARTIFACTS_JOB,
    SERVICE_INTEGRATION_JOB,
    SEEDED_INTEGRATION_JOB,
    INTEGRATION_SEED_PROOF_JOB,
    BROWSER_INTEGRATION_JOB,
  ];
  const planned = (skippedGates: readonly string[]) => {
    const value = needs('affected', passed);
    value[CI_PLAN_JOB].outputs.expected = JSON.stringify(
      Object.fromEntries(GATE_JOBS.map((gate) => [gate, skippedGates.includes(gate) ? 'skipped' : 'success'])),
    );
    return {
      ...value,
      ...Object.fromEntries(skippedGates.map((gate) => [gate, { result: 'skipped' }])),
    };
  };
  expect(passes(planned([WORKSPACE_UNIT_JOB, BROWSER_INTEGRATION_JOB]))).toBe(true);
  expect(passes(planned([SEEDED_INTEGRATION_JOB, INTEGRATION_SEED_PROOF_JOB]))).toBe(true);
  expect(passes(planned(testMatrices))).toBe(false);
  expect(passes(planned([NODE_ARTIFACT_PROOF_JOB]))).toBe(false);
  expect(passes(planned([NODE_ARTIFACT_BUILD_JOB]))).toBe(false);
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
  steps: Schema.Array(ArtifactStepSchema),
});
const ArtifactBuildWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    [NODE_ARTIFACT_BUILD_JOB]: ArtifactBuildJobSchema,
    [NODE_ARTIFACT_PROOF_JOB]: ArtifactProofJobSchema,
  }),
});
const TopologyUnitsSchema = Schema.Struct({
  shell: Schema.Struct({ id: Schema.String, path: Schema.String }),
  verticals: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String })),
});

const sorted = (values: readonly string[]) => EffectArray.sort(values, Order.String);
const readArtifactBuildJobs = () => Schema.decodeUnknownSync(ArtifactBuildWorkflowSchema)(readGateWorkflow()).jobs;
/** The build step: each pending unit runs its own package `build` script, BUILD_JOBS at a time. */
const UNIT_BUILD_COMMAND = 'pnpm --filter "./$unit" run build';
const buildStep = () =>
  readArtifactBuildJobs()[NODE_ARTIFACT_BUILD_JOB].steps.find(({ run }) => run?.includes(UNIT_BUILD_COMMAND) === true);

it('builds every delivery unit of the topology in exactly one build shard, with the Shell alone', () => {
  const { strategy } = readArtifactBuildJobs()[NODE_ARTIFACT_BUILD_JOB];
  const topology = Schema.decodeUnknownSync(TopologyUnitsSchema)(
    JSON.parse(readFileSync(new URL('../../topology/reference-topology.json', import.meta.url), 'utf-8')),
  );
  const units = [topology.shell, ...topology.verticals].map((unit) => unit.path);
  expect(strategy.matrix.include.map(({ shard }) => shard)).toEqual(strategy.matrix.shard);
  const built = strategy.matrix.include.flatMap(({ units: shardUnits }) => shardUnits.split(/\s+/u).filter(Boolean));
  expect(sorted(built)).toEqual(sorted(units));
  expect(
    strategy.matrix.include.find(({ units: shardUnits }) => shardUnits.includes('apps/shell-super-app'))?.units,
  ).toBe('apps/shell-super-app');
  expect(buildStep()).toBeDefined();
});

it('writes the app host entry of every served unit it builds, after its build, as the app host build does', () => {
  const build = buildStep()?.run ?? '';
  // The native hosted-owner fixtures start an owner only from its dist/zerops-entry.mjs, from these same artifacts.
  const entry = build.indexOf('node scripts/zerops/owner-entry.mts "$unit"');
  expect(entry).toBeGreaterThan(build.indexOf(UNIT_BUILD_COMMAND));
  expect(build).toContain('require("./topology/application-release-intent.json")');
  expect(build).toContain('console.log("shell-super-app")');
  // A rebuilt unit starts from clean outputs and gets its cache receipt only after its build and entry.
  expect(build.indexOf('rm -rf -- "$unit/dist" "$unit/.output"')).toBeLessThan(build.indexOf(UNIT_BUILD_COMMAND));
  expect(build.indexOf('node scripts/ci/unit-output-cache.mts stamp --unit "$id"')).toBeGreaterThan(entry);
});

it('keeps only verified unit outputs from the unit output cache and saves them only after verification', () => {
  const { steps } = readArtifactBuildJobs()[NODE_ARTIFACT_BUILD_JOB];
  const index = (predicate: (step: (typeof steps)[number]) => boolean) => steps.findIndex(predicate);
  const paths = index(({ name }) => name === "Name the shard's cached output paths");
  const restore = index(({ uses }) => uses?.startsWith('actions/cache/restore@') === true);
  const plan = index(({ run }) => run?.includes('unit-output-cache.mts plan --units "$SHARD_UNITS"') === true);
  const build = index(({ run }) => run?.includes(UNIT_BUILD_COMMAND) === true);
  const verify = index(
    ({ run }) => run === 'mise exec -- node scripts/ci/unit-output-cache.mts verify --units "$SHARD_UNITS"',
  );
  const save = index(({ uses }) => uses?.startsWith('actions/cache/save@') === true);
  const pack = index(({ name }) => name === "Pack the shard's build outputs");
  expect(paths > -1 && paths < restore && restore < plan && plan < build && build < verify).toBe(true);
  expect(verify < save && save < pack).toBe(true);
  const prefix = `gates-units-v1-${expression('runner.os')}-${expression('runner.arch')}-${expression('matrix.shard')}-`;
  expect(steps[restore]?.with).toEqual({
    key: `${prefix}${expression('github.sha')}-${expression('github.run_id')}-${expression('github.run_attempt')}`,
    path: expression('steps.unit-cache-paths.outputs.paths'),
    'restore-keys': prefix,
  });
  expect(steps[save]?.with).toEqual({
    key: expression('steps.unit-cache.outputs.cache-primary-key'),
    path: expression('steps.unit-cache-paths.outputs.paths'),
  });
  expect(steps[save]?.if).toBeUndefined();
  expect(steps[build]?.env).toEqual({ BUILD_UNITS: expression('steps.cached-plan.outputs.build') });
});

it('only builds on the shards and proves every unit together in its own job that no test waits for', () => {
  const jobs = readArtifactBuildJobs();
  const build = jobs[NODE_ARTIFACT_BUILD_JOB];
  expect(build.needs).toEqual([CI_PLAN_JOB]);
  expect(build.services).toBeUndefined();
  expect(build.permissions).toBeUndefined();
  expect(build.steps.some(({ uses }) => uses?.startsWith(DOWNLOAD_ARTIFACT_ACTION) === true)).toBe(false);
  expect(build.steps.some(({ run }) => run?.includes('node:proof') === true)).toBe(false);
  expect(build.steps.at(-1)?.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/u);
  expect(build.steps.at(-1)?.with?.name).toBe(`node-units-${expression('matrix.shard')}`);
  const proof = jobs[NODE_ARTIFACT_PROOF_JOB];
  expect(proof.needs).toEqual([CI_PLAN_JOB, NODE_ARTIFACT_BUILD_JOB]);
  const download = proof.steps.findIndex(({ uses }) => uses?.startsWith(DOWNLOAD_ARTIFACT_ACTION) === true);
  const unpack = proof.steps.findIndex(({ run }) => run?.startsWith(UNPACK_NATIVE_ARTIFACTS_SCRIPT) === true);
  const nodeProof = proof.steps.findIndex(({ run }) => run === 'mise exec -- pnpm node:proof');
  expect(proof.steps[download]?.with?.pattern).toBe(NODE_BUILD_ARTIFACT_PATTERN);
  // The proof names no unit, so the unpack helper requires every delivery unit of the topology.
  expect(proof.steps[unpack]?.run).toBe(`${UNPACK_NATIVE_ARTIFACTS_SCRIPT} "$RUNNER_TEMP/units" .output`);
  expect(download < unpack && unpack < nodeProof).toBe(true);
  // No gate job waits for the proof except the required check.
  const { jobs: all } = Schema.decodeUnknownSync(GatedJobsSchema)(readGateWorkflow());
  const waiting = Object.keys(all).filter((job) => all[job]?.needs?.includes(NODE_ARTIFACT_PROOF_JOB) === true);
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

it('builds in the stage deploy mode because the typecheck gate proves the types', () => {
  const job = readArtifactBuildJobs()[NODE_ARTIFACT_BUILD_JOB];
  expect(job['timeout-minutes']).toBe(30);
  expect(job.env).toMatchObject({
    BUILD_JOBS: '2',
    ULTRAMODERN_DISABLE_BUILD_TS_CHECKER: '1',
    ULTRAMODERN_SKIP_SERVER_TYPECHECK: '1',
  });
  // No public origin is baked into the gate artifacts, unlike the stage deploy.
  expect(Object.keys(job.env).some((key) => key.startsWith('ULTRAMODERN_PUBLIC_URL_'))).toBe(false);
  expect(job.env.ONTOS_PUBLIC_ORIGIN).toBeUndefined();
  expect(buildStep()?.run).toContain('xargs -P "$BUILD_JOBS" -n 1');
  // The typecheck gate that makes the build-time checkers redundant is still a source gate.
  expect(gateCommands().flat()).toContain('pnpm typecheck');
});

it('runs every workspace gate check in some workspace-gate entry', () => {
  const commands = gateCommands().flat();
  for (const check of [
    'pnpm typecheck',
    'pnpm typecheck:lint-rules',
    'pnpm test:lint-rules',
    'pnpm lint:repository-policy',
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
  expect(scripts['test:scripts']).toBe('rstest --project scripts --pool.maxWorkers 1');
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
  expect(scripts['test:unit']).toBe(
    'pnpm -r --no-sort --if-present run test:unit && pnpm -r --no-sort --if-present run test:component',
  );
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

const IntegrationJobSchema = Schema.Struct({
  needs: Schema.Array(Schema.String),
  steps: Schema.Array(
    Schema.Struct({
      ...WorkflowStepSchema.fields,
      uses: Schema.optional(Schema.String),
      with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
  strategy: Schema.Struct({
    matrix: Schema.Struct({
      include: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          'native-composition': Schema.optional(Schema.Boolean),
          'native-preproposal': Schema.optional(Schema.Boolean),
          'package-filters': Schema.optional(Schema.String),
          'root-rstest-shard': Schema.optional(Schema.String.check(Schema.isPattern(/^\d+\/\d+$/u))),
          'root-suite': Schema.optional(Schema.Boolean),
          'rstest-shard': Schema.optional(Schema.String.check(Schema.isPattern(/^\d+\/\d+$/u))),
          seed: Schema.optional(Schema.Boolean),
          suite: Schema.Literals(['integration', 'browser']),
        }),
      ),
    }),
  }),
});
const IntegrationShardsWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    [SEEDED_INTEGRATION_JOB]: IntegrationJobSchema,
    [SERVICE_INTEGRATION_JOB]: IntegrationJobSchema,
  }),
});

const shardFilters = (shard: { readonly 'package-filters'?: string | undefined }) =>
  [...(shard['package-filters'] ?? '').matchAll(/--filter (?<filter>\S+)/gu)].map(({ groups }) => groups?.filter ?? '');

it('runs the root integration suite once and every package integration suite in exactly one shard', () => {
  const { scripts } = readRootScripts();
  // The shards run exactly what the root script runs, split by package.
  expect(scripts['test:integration']).toBe(
    'rstest --project integration --pool.maxWorkers 1 && pnpm -r --no-bail --no-sort --workspace-concurrency 1 --if-present run test:integration --pool.maxWorkers 1',
  );
  const job = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(readGateWorkflow()).jobs[
    SERVICE_INTEGRATION_JOB
  ];
  const run = job.steps.find(({ env }) => env?.PACKAGE_FILTERS !== undefined);
  expect(run?.if).toBe(BACKEND_INTEGRATION_CONDITION);
  expect(run?.env).toMatchObject({ APP_ENV_PATH: '/dev/null', SPICEDB_DATABASE_PASSWORD: 'spicedb' });
  // The root suite and the large packages run as weighted shards of the very project their scripts run.
  expect(run?.run).toContain('mise exec -- pnpm exec rstest --project integration --pool.maxWorkers 1 || status=$?');
  expect(run?.run).toContain(
    `mise exec -- bash ${WEIGHTED_SHARD_SCRIPT} "$ROOT_RSTEST_SHARD" integration --pool.maxWorkers 1 || status=$?`,
  );
  expect(run?.run).toContain(
    `mise exec -- pnpm $PACKAGE_FILTERS exec bash "$PWD/${WEIGHTED_SHARD_SCRIPT}" "$RSTEST_SHARD" integration --pool.maxWorkers "$RSTEST_WORKERS" || status=$?`,
  );
  expect(run?.run).toContain(
    'mise exec -- pnpm -r --no-bail --no-sort --workspace-concurrency 1 --if-present $PACKAGE_FILTERS run test:integration --pool.maxWorkers 1 || status=$?',
  );
  expect(run?.env?.RSTEST_WORKERS).toBe(expression('matrix.rstest-workers || 1'));
  // Only the Shell and Customer Context suites, reviewed safe for parallel file workers, run two of them.
  const parallelRows = Schema.decodeUnknownSync(MatricesFileSchema)(
    JSON.parse(readFileSync(new URL('../ci-matrices.json', import.meta.url), 'utf-8')),
  ).integration.filter((row) => row['rstest-workers'] !== undefined);
  expect(
    new Set(parallelRows.map((row) => `${String(row['package-filters'])}:${String(row['rstest-workers'])}`)),
  ).toEqual(new Set(['--filter ./apps/shell-super-app:2', '--filter ./verticals/commerce-customer-context:2']));
  expect(parallelRows.every((row) => row['rstest-shard'] !== undefined)).toBe(true);
  // One suite's failure never hides another's: every status is kept and the step fails only at the end.
  expect(run?.run).toContain('exit "$status"');
  // Opted-in native proofs supplement (not replace or shard) the ordinary package suites.
  const nativeShards = job.strategy.matrix.include.filter((shard) => shard['native-preproposal'] === true);
  expect(nativeShards).toHaveLength(1);
  expect(nativeShards[0]?.suite).toBe('integration');
  expect(nativeShards[0]?.['rstest-shard']).toBeUndefined();
  const nativeSteps = job.steps.filter(({ if: condition }) => condition === 'matrix.native-preproposal == true');
  expect(nativeSteps).toHaveLength(1);
  expect(nativeSteps[0]?.env).toEqual({ APP_ENV_PATH: '/dev/null' });
  expect(nativeSteps[0]?.run).toBe(
    'mise exec -- pnpm --filter @app/commerce-customer-context run test:integration:native-preproposal',
  );
  expect(nativeSteps[0]?.['timeout-minutes']).toBe(20);
  const commerceScripts = Schema.decodeUnknownSync(RootScriptsSchema)(
    JSON.parse(
      readFileSync(new URL('../../verticals/commerce-customer-context/package.json', import.meta.url), 'utf-8'),
    ),
  ).scripts;
  expect(commerceScripts['test:integration:native-preproposal']).toBe(
    'ONTOS_PREPROPOSAL_STANDALONE=true ONTOS_PREPROPOSAL_NATIVE=true ONTOS_APPROVAL_NATIVE=true rstest --project integration --pool.maxWorkers 1 tests/integration/preproposal-basis-postgres.test.ts --testTimeout 1200000',
  );
  const seededJob = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(readGateWorkflow()).jobs[
    SEEDED_INTEGRATION_JOB
  ];
  // Seeded rows run the very same test step; together both jobs cover every package once.
  expect(seededJob.steps.find(({ name }) => name === run?.name)).toEqual(run);
  const shards = [...job.strategy.matrix.include, ...seededJob.strategy.matrix.include].filter(
    ({ suite }) => suite === 'integration',
  );
  const roots = shards.filter((shard) => shard['root-suite'] === true);
  expect(roots.map((shard) => shard['root-rstest-shard'])).toEqual(['1/4', '2/4', '3/4', '4/4']);
  expect(roots.every((shard) => shardFilters(shard).length === 0)).toBe(true);
  const packages = shards.filter((shard) => shard['root-suite'] !== true);
  const named = packages.filter((shard) => shardFilters(shard).every((filter) => !filter.startsWith('!')));
  const remainder = packages.filter((shard) => shardFilters(shard).some((filter) => filter.startsWith('!')));
  expect(remainder).toHaveLength(1);
  expect(named.length + remainder.length).toBe(packages.length);
  // A package too large for one job is split by Rstest shards that are alone in their jobs and cover 1..n once.
  const split = named.filter((shard) => shard['rstest-shard'] !== undefined);
  for (const shard of split) {
    expect(shardFilters(shard)).toHaveLength(1);
    // The weighted runner runs `rstest --project integration` itself, so the package's script must be exactly that.
    const manifest = Schema.decodeUnknownSync(RootScriptsSchema)(
      JSON.parse(readFileSync(new URL(`../../${shardFilters(shard)[0] ?? ''}/package.json`, import.meta.url), 'utf-8')),
    );
    expect(manifest.scripts['test:integration'], shard.name).toBe('rstest --project integration');
  }
  for (const filter of new Set(split.flatMap(shardFilters))) {
    const parts = split
      .filter((shard) => shardFilters(shard)[0] === filter)
      .map((shard) => shard['rstest-shard'] ?? '');
    const count = Number(parts[0]?.split('/')[1]);
    expect(sorted(parts)).toEqual(sorted(Array.from({ length: count }, (_, index) => `${index + 1}/${count}`)));
  }
  const namedPackages = [
    ...new Set(split.flatMap(shardFilters)),
    ...named.filter((shard) => shard['rstest-shard'] === undefined).flatMap(shardFilters),
  ];
  expect(sorted(remainder.flatMap(shardFilters))).toEqual(
    sorted(['!.', ...namedPackages.map((filter) => `!${filter}`)]),
  );
  expect(new Set(namedPackages).size).toBe(namedPackages.length);
  for (const filter of namedPackages) {
    expect(filter).toMatch(/^\.\/(?:apps|packages|verticals)\/[a-z-]+$/u);
    const manifest = Schema.decodeUnknownSync(RootScriptsSchema)(
      JSON.parse(readFileSync(new URL(`../../${filter}/package.json`, import.meta.url), 'utf-8')),
    );
    expect(manifest.scripts['test:integration']).toBeDefined();
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
      'lefthook.yml',
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
const IdentityGateJobSchema = Schema.Struct({
  // Unquoted placeholder IDs parse as numbers.
  env: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number]))),
  steps: Schema.Array(WorkflowStepSchema),
});
const IdentityGateJobsSchema = Schema.Struct({
  jobs: Schema.Struct({
    [NODE_ARTIFACT_PROOF_JOB]: Schema.Struct({
      ...IdentityGateJobSchema.fields,
      services: Schema.Record(
        Schema.String,
        Schema.Struct({
          env: Schema.Record(Schema.String, Schema.String),
          image: Schema.String,
          options: Schema.String,
          ports: Schema.Array(Schema.String),
        }),
      ),
    }),
    [SERVICE_INTEGRATION_JOB]: IdentityGateJobSchema,
  }),
});

it('gives every CI database tool a separate login per runtime identity and audits their grants', () => {
  const source = readFileSync(GATES_WORKFLOW_URL, 'utf-8');
  const { jobs } = Schema.decodeUnknownSync(IdentityGateJobsSchema)(parse(source));
  const integration = jobs[SERVICE_INTEGRATION_JOB];
  for (const environment of [integration.env, jobs[NODE_ARTIFACT_PROOF_JOB].env]) {
    const admin = Schema.decodeUnknownSync(Schema.URLFromString)(environment?.DATABASE_ADMIN_URL);
    for (const [key, role] of Object.entries(RUNTIME_IDENTITY_URLS)) {
      expect(environment?.[key]).toBe(`postgresql://${role}:${role}@${admin.host}${admin.pathname}`);
    }
  }
  // Identity URLs stay in each job's explicit environment, never a generated dotenv file.
  expect([...source.matchAll(IDENTITY_STEP_ENV_FILTER)]).toHaveLength(0);
  const { steps } = integration;
  const start = steps.findIndex(({ name }) => name === 'Start fresh PostgreSQL and SpiceDB services');
  const initialize = steps.findIndex(({ name }) => name === 'Initialize fresh local database login identities');
  const removeRuntime = steps.findIndex(({ name }) => name.startsWith('Remove the pre-seeded runtime role'));
  const stageMigrator = steps.findIndex(({ name }) => name === ASSEMBLED_MIGRATOR_STEP);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(initialize).toBeGreaterThan(start);
  expect(initialize).toBeLessThan(removeRuntime);
  expect(removeRuntime).toBeLessThan(stageMigrator);
  expect(steps[initialize]?.run).toBe('mise exec -- pnpm db:bootstrap-runtime-role');
  expect(steps[initialize]?.env).toEqual({
    DATABASE_LOGIN_ROLE_POLICY: 'initialize-local',
    ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development',
  });
  expect(integration.env?.DATABASE_LOGIN_ROLE_POLICY).toBeUndefined();
  expect(steps[stageMigrator]?.env?.DATABASE_LOGIN_ROLE_POLICY).toBeUndefined();
  expect(steps[stageMigrator]?.env?.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT).toBe('stage');
  const migrations = steps.findIndex(({ name }) => name.startsWith('Apply and verify Core, Auth, and Contacts'));
  const audit = steps.findIndex(({ name }) => name === AUDIT_STEP);
  expect(migrations).toBeGreaterThanOrEqual(0);
  expect(audit).toBe(migrations + 1);
  expect(steps[audit]?.if).toBe(BACKEND_INTEGRATION_CONDITION);
  expect(steps[audit]?.run).toBe('mise exec -- pnpm database-trust:audit');
});

it.effect('proves Node artifacts against a migrated PostgreSQL database with every declared login identity', () =>
  Effect.gen(function* proveNodeDatabaseIdentities() {
    const { jobs } = Schema.decodeUnknownSync(IdentityGateJobsSchema)(readGateWorkflow());
    const node = jobs[NODE_ARTIFACT_PROOF_JOB];
    const environment = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(node.env);
    const service = node.services['proof-postgres'];
    expect(service?.image).toBe(
      'postgres:18.6-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5',
    );
    expect(service?.ports).toContain('5433:5432');
    const admin = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(environment.DATABASE_ADMIN_URL);
    expect(admin.username).toBe(service?.env.POSTGRES_USER);
    expect(admin.password).toBe(service?.env.POSTGRES_PASSWORD);
    expect(admin.pathname).toBe(`/${service?.env.POSTGRES_DB ?? ''}`);
    expect(service?.options).toContain(`pg_isready -U ${admin.username} -d ${service?.env.POSTGRES_DB ?? ''}`);
    const provision = node.steps.findIndex(
      ({ name }) => name === 'Migrate the Node proof database and provision its runtime identities',
    );
    const initialize = node.steps.findIndex(
      ({ name }) => name === 'Initialize the fresh Node proof database login identities',
    );
    const proof = node.steps.findIndex(({ run }) => run === 'mise exec -- pnpm node:proof');
    expect(initialize).toBeGreaterThanOrEqual(0);
    expect(initialize).toBeLessThan(provision);
    expect(node.steps[initialize]?.if).toBeUndefined();
    expect(node.steps[initialize]?.run).toBe('mise exec -- pnpm db:bootstrap-runtime-role');
    expect(node.steps[initialize]?.env).toEqual({
      DATABASE_LOGIN_ROLE_POLICY: 'initialize-local',
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development',
    });
    expect(environment.DATABASE_LOGIN_ROLE_POLICY).toBeUndefined();
    expect(node.steps[provision]?.env).toBeUndefined();
    expect(provision).toBeGreaterThanOrEqual(0);
    expect(provision).toBeLessThan(proof);
    expect(node.steps[provision]?.if).toBeUndefined();
    expect(node.steps[provision]?.run).toBe('mise exec -- pnpm db:migrate');
    expect(node.steps[proof]?.env).toBeUndefined();
    for (const identity of DATABASE_IDENTITIES) {
      const connection = yield* loadDatabaseConfig({ environment, envPath: '/dev/null', identity });
      expect(connection.expectedRole).toBe(identity.role);
      const runtime = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(connection.connectionString);
      expect(runtime.username).toBe(identity.role);
      expect(runtime.pathname).toBe(`/${service?.env.POSTGRES_DB ?? ''}`);
      expect(runtime.hostname).toBe(admin.hostname);
      expect(Number(runtime.port)).toBe(Number(admin.port));
    }
  }),
);

it('restores same-run Node artifacts for every backend integration fixture and excludes browser rows', () => {
  const source: unknown = readGateWorkflow();
  const { jobs } = Schema.decodeUnknownSync(GatedJobsSchema)(source);
  const integration = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(source).jobs[SERVICE_INTEGRATION_JOB];
  expect(integration.needs).toEqual([CI_PLAN_JOB, NODE_ARTIFACT_BUILD_JOB]);
  // The producer depends only on queue proof, so waiting for its complete matrix cannot create a cycle.
  expect(jobs[NODE_ARTIFACT_BUILD_JOB]?.needs).toEqual([CI_PLAN_JOB]);
  const roots = integration.strategy.matrix.include.filter((shard) => shard['root-suite'] === true);
  expect(roots).toHaveLength(4);
  expect(roots.every(({ suite }) => suite === 'integration')).toBe(true);
  const customerContext = integration.strategy.matrix.include.filter((shard) =>
    shardFilters(shard).includes('./verticals/commerce-customer-context'),
  );
  expect(customerContext).toHaveLength(4);
  expect(customerContext.every(({ suite }) => suite === 'integration')).toBe(true);
  // The browser suite reads no built output: its own job needs only the plan.
  expect(integration.strategy.matrix.include.some(({ suite }) => suite === 'browser')).toBe(false);
  const browser = Schema.decodeUnknownSync(
    Schema.Struct({
      jobs: Schema.Struct({
        [BROWSER_INTEGRATION_JOB]: Schema.Struct({
          needs: Schema.Array(Schema.String),
          steps: Schema.Array(GateCommandStepSchema),
          strategy: Schema.Struct({
            matrix: Schema.Struct({ include: Schema.Array(Schema.Struct({ suite: Schema.String })) }),
          }),
        }),
      }),
    }),
  )(source).jobs[BROWSER_INTEGRATION_JOB];
  expect(browser.needs).toEqual([CI_PLAN_JOB]);
  expect(browser.strategy.matrix.include.map(({ suite }) => suite)).toEqual(['browser']);
  expect(browser.steps.some(({ uses }) => uses?.startsWith(DOWNLOAD_ARTIFACT_ACTION) === true)).toBe(false);
  expect(browser.steps.some(({ run }) => run === 'mise exec -- pnpm --filter @app/shell-super-app test:e2e')).toBe(
    true,
  );
  const { steps } = integration;
  const download = steps.findIndex(({ with: inputs }) => inputs?.pattern === NODE_BUILD_ARTIFACT_PATTERN);
  const unpack = steps.findIndex(({ run }) => run?.startsWith(UNPACK_NATIVE_ARTIFACTS_SCRIPT) === true);
  const derive = steps.findIndex(({ run }) => run?.includes(DERIVE_BUILT_COMPOSITION_COMMAND) === true);
  const worker = steps.findIndex(({ run }) => run?.includes('zerops:materialize') === true);
  const tests = steps.findIndex(({ env }) => env?.PACKAGE_FILTERS !== undefined);
  expect(download).toBeGreaterThan(-1);
  expect(download < unpack && unpack < derive && derive < worker && worker < tests).toBe(true);
  expect(steps[download]?.uses).toMatch(/^actions\/download-artifact@[a-f0-9]{40}$/u);
  // No run-id, repository or token override: the artifacts must belong to this workflow run.
  expect(steps[download]?.with).toEqual({
    path: `${RUNNER_TEMP_EXPRESSION}/native-composition-units`,
    pattern: NODE_BUILD_ARTIFACT_PATTERN,
  });
  expect(steps[unpack]?.run).toBe(UNPACK_NATIVE_ARTIFACTS_COMMAND);
  expect(steps[worker]?.run).toBe(
    'mise exec -- pnpm zerops:materialize --app outbox-worker-host --package app --package-dir . --worker',
  );
  expect(steps[worker]?.env).toEqual({ APP_ENV_PATH: '/dev/null' });
  for (const index of [download, unpack]) {
    expect(steps[index]?.if).toBe(BACKEND_INTEGRATION_CONDITION);
  }
  expect(steps[worker]?.if).toBe('matrix.root-suite == true');
  expect(steps[derive]?.env).toEqual({ APP_ENV_PATH: '/dev/null' });
  expect(steps[derive]?.if).toBe('matrix.native-composition == true');
  expect(steps.filter(({ if: condition }) => condition === 'matrix.native-composition == true')).toHaveLength(1);
  const preproposal = integration.strategy.matrix.include.filter((shard) => shard['native-preproposal'] === true);
  expect(preproposal).toHaveLength(1);
  expect(preproposal[0]?.suite).toBe('integration');
});

it('proves the fresh-database preparation once and restores it only in rows that cover no migration behaviour', () => {
  const source = readGateWorkflow();
  const { jobs } = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(source);
  const seeded = jobs[SEEDED_INTEGRATION_JOB];
  // The seed model refuses these rows; they keep today's complete fresh preparation in service-integration.
  for (const row of seeded.strategy.matrix.include) {
    expect(row.name).not.toMatch(
      /Database, Migration|Root Integration|Core Runtime Integration|Party Registry Integration|Commerce Customer Context/u,
    );
    expect(row['root-suite']).toBeUndefined();
    expect(row['native-preproposal']).toBeUndefined();
  }
  expect(seeded.strategy.matrix.include.map(({ name }) => name)).toEqual([
    'Shell Integration (1/4)',
    'Shell Integration (2/4)',
    'Shell Integration (3/4)',
    'Shell Integration (4/4)',
    'Privacy Integration (1/3)',
    'Privacy Integration (2/3)',
    'Privacy Integration (3/3)',
    'Pricing and Inventory Integration',
    'Catalog Integration',
    'Market, Order, Payment Term, Price Group, and Storefront Integration',
  ]);
  const names = seeded.steps.map(({ name }) => name);
  for (const replaced of [
    'Initialize fresh local database login identities',
    ASSEMBLED_MIGRATOR_STEP,
    'Apply and verify Core, Auth, and Contacts migrations, plus Party Registry',
    AUDIT_STEP,
    'Build and run the Outbox Worker host artifact against the fresh database',
  ]) {
    expect(names).not.toContain(replaced);
  }
  const restore = seeded.steps.findIndex(({ run }) => run?.includes('integration-seed.mts restore') === true);
  const worker = seeded.steps.findIndex(({ run }) => run?.includes('worker-host-artifact.mts use') === true);
  const tests = seeded.steps.findIndex(
    ({ env }) => env?.PACKAGE_FILTERS !== undefined && env.ROOT_RSTEST_SHARD !== undefined,
  );
  expect(restore !== -1 && restore < worker && worker < tests).toBe(true);
  expect(seeded.steps[restore]?.run).toContain('--purpose ordinary-tests --job-name "$CI_MATRIX_NAME"');
  expect(seeded.steps[restore]?.run).toContain('--test-files "$CI_TEST_FILES"');
  const producer = Schema.decodeUnknownSync(
    Schema.Struct({ jobs: Schema.Struct({ [INTEGRATION_SEED_PROOF_JOB]: IdentityGateJobSchema }) }),
  )(source).jobs[INTEGRATION_SEED_PROOF_JOB];
  const produce = producer.steps.findIndex(
    ({ run }) =>
      run ===
      'mise exec -- node scripts/ci/integration-seed.mts produce --directory "$RUNNER_TEMP/integration-seed" --disposable',
  );
  const build = producer.steps.findIndex(({ run }) => run?.includes('worker-host-artifact.mts build') === true);
  expect(produce !== -1 && produce < build).toBe(true);
  expect(producer.env?.INTEGRATION_SEED_COMMERCE_AUTH_DATABASE_URL).toBe(
    'postgresql://commerce_auth_runtime:commerce_auth_runtime@localhost:5433/ontos_ci',
  );
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
  expect(source).toContain("setup === 'app'");
  expect(source).toContain(String.raw`app.build.deployFiles.join('\n')`);
  expect(source).toContain('exec node scripts/run-zerops-migrator.mjs');
  const packaging = Schema.decodeUnknownSync(
    Schema.Struct({
      zerops: Schema.Array(
        Schema.Struct({
          build: Schema.Struct({ deployFiles: Schema.Array(Schema.String) }),
          setup: Schema.String,
        }),
      ),
    }),
  )(parse(readFileSync(new URL('../../zerops.yaml', import.meta.url), 'utf-8')));
  expect(packaging.zerops.find(({ setup }) => setup === 'app')?.build.deployFiles).toEqual(['app/']);
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

it('keeps deployment out of the workspace gates and guards Action transaction I/O', () => {
  const { env, jobs } = Schema.decodeUnknownSync(GatedJobsSchema)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')));
  expect(env.ONTOS_ACTION_TRANSACTION_IO_GUARD).toBe('true');
  // The retired deploy chain stays out of the gates: the workflow only plans and runs checks.
  expect(sorted(Object.keys(jobs))).toEqual(
    sorted([QUEUE_PROOF_JOB, CI_PLAN_JOB, 'warm-caches', ...GATE_JOBS, WORKSPACE_GATES_JOB]),
  );
});

it('runs migration equivalence proofs only against the owned CI maintenance database', () => {
  const { jobs } = Schema.decodeUnknownSync(IdentityGateJobsSchema)(readGateWorkflow());
  const integration = jobs[SERVICE_INTEGRATION_JOB].steps.find(({ env }) => env?.PACKAGE_FILTERS !== undefined);
  expect(integration?.if).toBe(BACKEND_INTEGRATION_CONDITION);
  expect(integration?.env).toMatchObject({
    MIGRATION_EQUIVALENCE_TEST_DATABASE_URL: 'postgresql://ontos_ci_admin:ontos_ci_admin@localhost:5433/postgres',
    MIGRATION_EQUIVALENCE_TEST_SANDBOX: 'owned-postgres18',
  });
});
