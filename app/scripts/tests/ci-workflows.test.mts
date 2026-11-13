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
const SERVICE_INTEGRATION_JOB = 'service-integration';
const WORKSPACE_GATE_JOB = 'workspace-gate';

/** Expand only matrix references for the full-run contract tests; separately test the actual planner. */
const readGateWorkflow = () => {
  const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
  const workflow = record(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')));
  const jobs = { ...record(workflow.jobs) };
  const matrices = record(JSON.parse(readFileSync(new URL('../ci-matrices.json', import.meta.url), 'utf-8')));
  for (const [job, key] of [
    [WORKSPACE_GATE_JOB, 'source'],
    [WORKSPACE_UNIT_JOB, 'unit'],
    [SERVICE_INTEGRATION_JOB, 'integration'],
  ] as const) {
    const entry = record(jobs[job ?? '']);
    const strategy = record(entry.strategy);
    const matrix = record(strategy.matrix);
    expect(matrix.include).toBe(`\${{ fromJSON(needs.ci-plan.outputs.${key ?? ''}) }}`);
    jobs[job ?? ''] = { ...entry, strategy: { ...strategy, matrix: { ...matrix, include: matrices[key ?? ''] } } };
  }
  return { ...workflow, jobs };
};
/** The fixed system PATH a workflow step script runs with in these tests. */
const STEP_PATH = '/usr/bin:/bin';
/** The step after which a build shard's outputs are downloadable by the target's proving shards. */
const UPLOAD_STEP = "Upload the shard's build outputs";

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
const NODE_ARTIFACT_BUILD_JOB = 'node-artifact-build';
const NODE_BUILD_ARTIFACT_PATTERN = 'node-units-*';
const RUNNER_TEMP_EXPRESSION = expression('runner.temp');
const UNPACK_NATIVE_ARTIFACTS_SCRIPT = 'bash scripts/unpack-unit-build-outputs.sh';
const UNPACK_NATIVE_ARTIFACTS_COMMAND = `${UNPACK_NATIVE_ARTIFACTS_SCRIPT} "$RUNNER_TEMP/native-composition-units" .output`;
const BACKEND_INTEGRATION_CONDITION = "matrix.suite == 'integration'";
const DERIVE_BUILT_COMPOSITION_COMMAND = 'node scripts/derive-built-application-composition.mts --snapshot-output';
const FORMAT_AND_LINT_JOB = 'format-and-lint';
/** Gate jobs rooted at the merge queue proof. */
const ROOT_GATE_JOBS = [
  WORKSPACE_GATE_JOB,
  WORKSPACE_UNIT_JOB,
  'static-contracts',
  FORMAT_AND_LINT_JOB,
  SERVICE_INTEGRATION_JOB,
  NODE_ARTIFACT_BUILD_JOB,
] as const;
/** Every gate job; each target's artifact proofs run inside its own build shards. */
const GATE_JOBS = ROOT_GATE_JOBS;
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
  for (const gate of ROOT_GATE_JOBS) {
    const needsNodeArtifacts = gate === SERVICE_INTEGRATION_JOB || gate === WORKSPACE_UNIT_JOB;
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
  expect(install).toBeGreaterThan(classify);
  // WorkflowStepSchema omits uses-only metadata, but preserves the controlling if condition.
  expect(steps[install]?.if).toBe("steps.changes.outputs.mode != 'docs' && steps.changes.outputs.mode != 'proven'");
  expect(selection?.env?.APPLY_AFFECTED).toBe(expression('vars.CI_AFFECTED_ENABLED'));
});

it('requires the exact CI plan and rejects missing, failed or unplanned skipped gates', () => {
  const gates = readTargetWorkflow().jobs['workspace-gates'];
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
  expect(afterGates).toContain('workspace-gates');
  // The deploy chain stays out of the gates: no deployment job may reappear here.
  expect(Object.keys(jobs)).not.toContain('deploy-zerops');
  expect(Object.keys(jobs)).not.toContain('deploy-cloudflare');
  expect(Object.keys(jobs)).not.toContain('edge-plan');
  for (const job of afterGates) {
    // The job name leads the subject, so a failure names the job.
    expect(`${job}: ${jobs[job]?.if ?? ''}`).toMatch(/^[a-z-]+: \$\{\{ (?:!cancelled\(\)|always\(\))/u);
  }
});

const ArtifactBuildJobSchema = Schema.Struct({
  name: Schema.String,
  permissions: Schema.Record(Schema.String, Schema.String),
  steps: Schema.Array(
    Schema.Struct({
      env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      if: Schema.optional(Schema.String),
      name: Schema.String,
      run: Schema.optional(Schema.String),
      uses: Schema.optional(Schema.String),
      with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
  strategy: Schema.Struct({
    matrix: Schema.Struct({
      include: Schema.Array(Schema.Struct({ proof: Schema.String, shard: Schema.Number, units: Schema.String })),
      shard: Schema.Array(Schema.Number),
    }),
  }),
});
const ArtifactBuildWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    [NODE_ARTIFACT_BUILD_JOB]: ArtifactBuildJobSchema,
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
  {
    const { steps, strategy } = jobs[NODE_ARTIFACT_BUILD_JOB];
    // Every shard builds units, and the Node target's shards build every unit once, with the Node script.
    expect(strategy.matrix.include.map(({ shard }) => shard)).toEqual(strategy.matrix.shard);
    const built = strategy.matrix.include.flatMap(({ units: shardUnits }) => shardUnits.split(/\s+/u).filter(Boolean));
    expect(sorted(built)).toEqual(sorted(units));
    expect(steps.some(({ run }) => run?.includes(`"\${filters[@]}" run build\n`) === true)).toBe(true);
  }
});

const readArtifactBuildJobs = () => Schema.decodeUnknownSync(ArtifactBuildWorkflowSchema)(readGateWorkflow()).jobs;

it('writes the app host entry of every served unit it builds, after its build, as the app host build does', () => {
  const { steps } = readArtifactBuildJobs()[NODE_ARTIFACT_BUILD_JOB];
  const build = steps.find(({ run }) => run?.includes(`"\${filters[@]}" run build\n`) === true)?.run ?? '';
  // The native hosted-owner fixtures start an owner only from its dist/zerops-entry.mjs, from these same artifacts.
  const entry = build.indexOf(`mise exec -- node scripts/zerops/owner-entry.mts "\${entries[@]}"`);
  expect(entry).toBeGreaterThan(build.indexOf('run build\n'));
  expect(build).toContain('require("./topology/application-release-intent.json")');
  expect(build).toContain('console.log("apps/shell-super-app")');
});

it('proves each target on its own shards only after every other shard of the target uploaded its outputs', () => {
  const jobs = readArtifactBuildJobs();
  for (const [job, proofs, artifacts] of [[NODE_ARTIFACT_BUILD_JOB, ['node'], NODE_BUILD_ARTIFACT_PATTERN]] as const) {
    const { name, permissions, steps, strategy } = jobs[job];
    // Each proof runs on exactly one shard; the other shards only build.
    const hosted = strategy.matrix.include.map(({ proof }) => proof).filter((proof) => proof !== 'none');
    expect(sorted(hosted)).toEqual([...proofs]);
    expect(permissions).toEqual({ actions: 'read', contents: 'read' });
    // The proving shard waits for every other shard of this job, by the job's own name, before it
    // downloads them; every step after the shard's own upload runs only on a proving shard.
    const prefix = name.slice(0, name.indexOf('${{'));
    const upload = steps.findIndex((step) => step.name === UPLOAD_STEP);
    const wait = steps.findIndex(({ run }) => run?.startsWith('bash scripts/wait-for-build-shards.sh') === true);
    const download = steps.findIndex(({ uses }) => uses?.startsWith('actions/download-artifact@') === true);
    expect(steps[wait]?.run).toBe(
      `bash scripts/wait-for-build-shards.sh '${prefix}' ${strategy.matrix.shard.length} '${name}'`,
    );
    expect(upload).toBeGreaterThan(-1);
    expect(upload < wait && wait < download).toBe(true);
    for (const step of steps.slice(upload + 1)) {
      expect(`${step.name}: ${step.if ?? ''}`).toMatch(/matrix\.proof (?:!= 'none'|== '[a-z]+')$/u);
    }
    // Only the target's proving shards download: a single one compares by name, several by `!= 'none'`.
    expect(steps[download]?.if).toBe(proofs.length === 1 ? `matrix.proof == '${proofs[0]}'` : "matrix.proof != 'none'");
    expect(steps[download]?.with?.pattern).toBe(artifacts);
  }
});

/** Runs the shard wait with a `gh` that answers the jobs API with these jobs, as `gh api --jq` would. */
const waitForBuildShards = (jobs: readonly { conclusion: string | null; name: string }[]) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-wait-shards-'));
  try {
    const gh = path.join(directory, 'gh');
    writeFileSync(gh, '#!/bin/sh\n[ "$1" = api ] && [ "$3" = --jq ] || exit 2\nprintf %s "$FAKE_JOBS" | jq -r "$4"\n');
    chmodSync(gh, 0o755);
    execFileSync(
      '/bin/bash',
      [fileURLToPath(new URL('../wait-for-build-shards.sh', import.meta.url)), 'Build x (', '3', 'Build x (1/3)'],
      {
        env: {
          FAKE_JOBS: JSON.stringify({ jobs }),
          GITHUB_REPOSITORY: 'owner/repository',
          GITHUB_RUN_ID: '1',
          PATH: `${directory}:${STEP_PATH}`,
          WAIT_FOR_BUILD_SHARDS_INTERVAL: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      },
    );
    return true;
  } catch {
    return false;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

it('waits for the other build shards of its own target and fails when one does not succeed', () => {
  const last = 'Build x (3/3)';
  const others = [
    { conclusion: 'success', name: 'Build x (2/3)' },
    { conclusion: 'success', name: last },
  ];
  const unrelated = [
    { conclusion: null, name: 'Build x (1/3)' },
    { conclusion: 'failure', name: 'Static Contracts' },
  ];
  expect(waitForBuildShards([...others, ...unrelated])).toBe(true);
  // Another proving shard of the target is still running its proof, but its outputs are uploaded.
  const proving = {
    conclusion: null,
    name: last,
    steps: [
      { conclusion: 'success', name: UPLOAD_STEP },
      { conclusion: null, name: 'Wait for the other build shards' },
    ],
  };
  expect(waitForBuildShards([others[0], proving, ...unrelated])).toBe(true);
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped']) {
    expect(waitForBuildShards([others[0], { conclusion, name: last }, ...unrelated])).toBe(false);
  }
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
  return ([WORKSPACE_GATE_JOB, WORKSPACE_UNIT_JOB] as const).flatMap((job) =>
    jobs[job].strategy.matrix.include.map(({ commands }) => commands.split('\n').filter(Boolean)),
  );
};

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
    'pnpm test:scripts',
    'pnpm module-entrypoints:check',
    'pnpm test:generation',
  ]) {
    expect(commands).toContain(check);
  }
  const { scripts } = readRootScripts();
  // The module entrypoint boundary check is the repository's own boundary script.
  expect(scripts['module-entrypoints:check']).toContain('check-module-entrypoint-boundaries.mts');
  const staticChecks = readGateCommandJobs()['static-contracts'].steps.flatMap(({ parallel, run }) =>
    parallel ? parallel.map((step) => step.run) : [run ?? ''],
  );
  expect(staticChecks).toContain('mise exec -- pnpm database-access:check');
});

it('restores same-run Node metadata only for unit shards that execute public contract fixtures', () => {
  const job = readGateCommandJobs()[WORKSPACE_UNIT_JOB];
  const restored = job.strategy.matrix.include.filter((entry) => entry['node-artifacts'] === true);
  expect(restored.map(({ name }) => name)).toEqual([
    'Unit and Component Tests (Catalog, Commerce Customer Context, and Inventory)',
    'Unit and Component Tests (every other package)',
  ]);
  const download = job.steps.findIndex(
    ({ name }) => name === 'Download the same-run Node artifacts for unit contract fixtures',
  );
  const unpack = job.steps.findIndex(({ name }) => name === 'Unpack the Node artifacts for unit contract fixtures');
  const run = job.steps.findIndex(({ name }) => name === `Run ${expression('matrix.name')}`);
  expect(download !== -1 && download < unpack && unpack < run).toBe(true);
  expect(job.steps[download]?.if).toBe('matrix.node-artifacts == true');
  expect(job.steps[download]?.uses).toBe('actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333');
  expect(job.steps[download]?.with).toEqual({
    path: `${RUNNER_TEMP_EXPRESSION}/native-composition-units`,
    pattern: NODE_BUILD_ARTIFACT_PATTERN,
  });
  expect(job.steps[unpack]?.if).toBe('matrix.node-artifacts == true');
  expect(job.steps[unpack]?.['working-directory']).toBe('app');
  expect(job.steps[unpack]?.run).toBe(UNPACK_NATIVE_ARTIFACTS_COMMAND);
});

it('runs the root unit and component tests of every workspace package in exactly one shard', () => {
  const { scripts } = readRootScripts();
  // The shards run exactly what the root script runs, split by package.
  expect(scripts['test:unit']).toBe(
    'pnpm -r --no-sort --if-present run test:unit && pnpm -r --no-sort --if-present run test:component',
  );
  const shards = gateCommands().flatMap((commands) => {
    const [unit, component, ...rest] = commands;
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
  const named = shards.filter((filters) => filters.every((filter) => !filter.startsWith('!')));
  const remainder = shards.filter((filters) => filters.some((filter) => filter.startsWith('!')));
  expect(named.length + remainder.length).toBe(shards.length);
  // One shard runs every package the others do not name, excluding the workspace root like `pnpm -r`.
  expect(remainder).toHaveLength(1);
  const namedPackages = named.flat();
  expect(sorted(remainder[0] ?? [])).toEqual(sorted(['!.', ...namedPackages.map((filter) => `!${filter}`)]));
  expect(new Set(namedPackages).size).toBe(namedPackages.length);
  for (const filter of namedPackages) {
    expect(filter).toMatch(/^\.\/(?:apps|packages|verticals)\/[a-z-]+$/u);
    expect(() => readFileSync(new URL(`../../${filter}/package.json`, import.meta.url))).not.toThrow();
  }
});

const IntegrationShardsWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    [SERVICE_INTEGRATION_JOB]: Schema.Struct({
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
              'root-suite': Schema.optional(Schema.Boolean),
              'rstest-shard': Schema.optional(Schema.String.check(Schema.isPattern(/^\d+\/\d+$/u))),
              suite: Schema.Literals(['integration', 'browser']),
            }),
          ),
        }),
      }),
    }),
  }),
});

const shardFilters = (shard: { readonly 'package-filters'?: string | undefined }) =>
  [...(shard['package-filters'] ?? '').matchAll(/--filter (?<filter>\S+)/gu)].map(({ groups }) => groups?.filter ?? '');

it('runs the root integration suite once and every package integration suite in exactly one shard', () => {
  const { scripts } = readRootScripts();
  // The shards run exactly what the root script runs, split by package.
  expect(scripts['test:integration']).toBe(
    'rstest --project integration --pool.maxWorkers 1 && pnpm -r --no-sort --workspace-concurrency 1 --if-present run test:integration --pool.maxWorkers 1',
  );
  const job = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(readGateWorkflow()).jobs[
    SERVICE_INTEGRATION_JOB
  ];
  const run = job.steps.find(({ env }) => env?.PACKAGE_FILTERS !== undefined);
  expect(run?.if).toBe(BACKEND_INTEGRATION_CONDITION);
  expect(run?.env).toMatchObject({ APP_ENV_PATH: '/dev/null', SPICEDB_DATABASE_PASSWORD: 'spicedb' });
  expect(run?.run).toContain('mise exec -- pnpm exec rstest --project integration --pool.maxWorkers 1');
  expect(run?.run).toContain(
    'mise exec -- pnpm -r --no-sort --workspace-concurrency 1 --if-present $PACKAGE_FILTERS run test:integration --pool.maxWorkers 1',
  );
  expect(run?.run).toContain('--shard "$RSTEST_SHARD"');
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
  const shards = job.strategy.matrix.include.filter(({ suite }) => suite === 'integration');
  expect(shards.filter((shard) => shard['root-suite'] === true)).toHaveLength(1);
  const named = shards.filter((shard) => shardFilters(shard).every((filter) => !filter.startsWith('!')));
  const remainder = shards.filter((shard) => shardFilters(shard).some((filter) => filter.startsWith('!')));
  // The root-suite shard runs every package the others do not name, excluding the workspace root like `pnpm -r`.
  expect(remainder.map((shard) => shard['root-suite'])).toEqual([true]);
  expect(named.length + remainder.length).toBe(shards.length);
  // A package too large for one job is split by Rstest shards that are alone in their jobs and cover 1..n once.
  const split = named.filter((shard) => shard['rstest-shard'] !== undefined);
  for (const shard of split) {
    expect(shardFilters(shard)).toHaveLength(1);
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
    'node-artifact-build': Schema.Struct({
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
  for (const environment of [integration.env, jobs['node-artifact-build'].env]) {
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
  const stageMigrator = steps.findIndex(
    ({ name }) => name === 'Run the assembled stage migrator artifact against the fresh database',
  );
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
    const node = jobs['node-artifact-build'];
    const environment = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(node.env);
    const service = node.services['proof-postgres'];
    expect(service?.image).toBe(
      expression(
        "matrix.proof == 'node' && 'postgres:18.6-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5' || ''",
      ),
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
    expect(node.steps[initialize]?.if).toBe("matrix.proof == 'node'");
    expect(node.steps[initialize]?.run).toBe('mise exec -- pnpm db:bootstrap-runtime-role');
    expect(node.steps[initialize]?.env).toEqual({
      DATABASE_LOGIN_ROLE_POLICY: 'initialize-local',
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development',
    });
    expect(environment.DATABASE_LOGIN_ROLE_POLICY).toBeUndefined();
    expect(node.steps[provision]?.env).toBeUndefined();
    expect(provision).toBeGreaterThanOrEqual(0);
    expect(provision).toBeLessThan(proof);
    expect(node.steps[provision]?.if).toBe("matrix.proof == 'node'");
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
  expect(roots).toHaveLength(1);
  expect(roots[0]?.suite).toBe('integration');
  const customerContext = integration.strategy.matrix.include.filter((shard) =>
    shardFilters(shard).includes('./verticals/commerce-customer-context'),
  );
  expect(customerContext).toHaveLength(6);
  expect(customerContext.every(({ suite }) => suite === 'integration')).toBe(true);
  expect(integration.strategy.matrix.include.some(({ suite }) => suite === 'browser')).toBe(true);
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
    sorted([QUEUE_PROOF_JOB, CI_PLAN_JOB, 'warm-caches', ...GATE_JOBS, 'workspace-gates']),
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
