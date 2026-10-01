import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Array as EffectArray, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

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

/** The GitHub environment that holds the Cloudflare account token. */
const EDGE_ENVIRONMENT = 'stage-edge';
const GATES_WORKFLOW = 'ultramodern-workspace-gates.yml';
const GATES_WORKFLOW_URL = new URL(`../../../.github/workflows/${GATES_WORKFLOW}`, import.meta.url);
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
const EdgeDeployWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    'deploy-cloudflare': Schema.Struct({
      env: Schema.optional(Schema.Unknown),
      environment: Schema.String,
      if: Schema.String,
      needs: Schema.Array(Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
      'timeout-minutes': Schema.Number,
    }),
    'deploy-zerops': Schema.Struct({ environment: Schema.String }),
    'edge-build': Schema.Struct({
      environment: Schema.optional(Schema.Unknown),
      if: Schema.String,
      needs: Schema.Array(Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
      strategy: Schema.Struct({
        'fail-fast': Schema.Boolean,
        matrix: Schema.Struct({ unit: Schema.String }),
      }),
      'timeout-minutes': Schema.Number,
    }),
    'edge-deploy-readiness': Schema.Struct({
      environment: Schema.Struct({ deployment: Schema.Boolean, name: Schema.String }),
      if: Schema.String,
      outputs: Schema.Record(Schema.String, Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
    }),
    'edge-plan': Schema.Struct({
      environment: Schema.optional(Schema.Unknown),
      if: Schema.String,
      needs: Schema.Array(Schema.String),
      outputs: Schema.Record(Schema.String, Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
    }),
  }),
});

/** Every `pnpm …` command line a workflow step runs. */
const packageCommands = (step: typeof WorkflowStepSchema.Type) => (step.run ?? '').match(/pnpm [^\n]*/gu) ?? [];
const PLAN_STEP = 'Plan the impacted edge units';
const DEPLOY_STEP = 'Deploy planned edge units in dependency order';
const RESTORE_STEP = 'Restore the edge Workers this run deployed';
const RETIRE_STEP = 'Report retired Workers that still exist';
const BUILD_STEP = 'Build and verify the planned edge unit';
const UNPACK_STEP = "Unpack the planned edge units' build outputs";
const EDGE_PLAN_JOB = 'edge-plan';
const EDGE_BUILD_JOB = 'edge-build';
const EDGE_UNITS_OUTPUT = expression('needs.edge-plan.outputs.cloudflare');
const PROOF_STEP = 'Prove the deployed edge units on their public URLs';
const PROVEN_STEP = 'Record the proven edge Worker versions';

interface PlacementBuildInputs {
  readonly buildEnvironment: Readonly<Record<string, string>>;
  readonly units: readonly string[];
}

const EDGE_READINESS_JOB = 'edge-deploy-readiness';
const MIGRATIONS_JOB = 'deploy-migrations';
const DEPLOY_TARGET_JOB = 'deploy-target';
const OUTBOX_WORKER_MODE_OUTPUT = expression('needs.deploy-target.outputs.outbox-worker-mode');
const DEPLOY_TARGET_OUTPUT = expression('needs.deploy-target.outputs.target');
const DEPLOY_ENVIRONMENT_OUTPUT = expression('needs.deploy-target.outputs.environment');

const runStep = (script: string, environment: Readonly<Record<string, string>>) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-workflow-step-'));
  const outputPath = path.join(directory, 'output');
  try {
    execFileSync('/bin/bash', ['-eo', 'pipefail', '-c', script], {
      env: { GITHUB_OUTPUT: outputPath, PATH: STEP_PATH, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return Object.fromEntries(
      readFileSync(outputPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
  } catch {
    return 'failed';
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

const readEdgeDeployJobs = () =>
  Schema.decodeUnknownSync(EdgeDeployWorkflowSchema)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8'))).jobs;

it('deploys to Cloudflare only when both the account and the deploy token are configured', () => {
  const jobs = readEdgeDeployJobs();
  // The job runs only with both the account and the token; an unconfigured repository skips it,
  // so it records no deployment at all and CI stays green.
  const readiness = jobs['edge-deploy-readiness'];
  // Only stage can target Cloudflare, so only a stage deploy checks the edge.
  expect(readiness.if).toBe("needs.deploy-target.outputs.environment == 'stage'");
  // Reading `stage-edge` secrets for the check must not add an entry to its deployment history.
  expect(readiness.environment).toEqual({ deployment: false, name: EDGE_ENVIRONMENT });
  const check = readiness.steps.find((step) => step.id === 'configuration');
  expect(readiness.steps.filter((step) => step.env?.CLOUDFLARE_API_TOKEN !== undefined)).toEqual([check]);
  expect(check?.env).toEqual({
    CLOUDFLARE_ACCOUNT_ID: expression('vars.CLOUDFLARE_ACCOUNT_ID'),
    CLOUDFLARE_API_TOKEN: expression('secrets.CLOUDFLARE_API_TOKEN'),
    DEPLOY_TARGET: DEPLOY_TARGET_OUTPUT,
  });
  // A stage that deploys to Zerops only skips the edge; one that targets Cloudflare fails before any
  // Zerops change, since deploy-zerops would otherwise migrate and swap workers beside the old Workers.
  expect(runStep(check?.run ?? 'exit 1', { DEPLOY_TARGET: 'zerops' })).toEqual({ configured: 'false' });
  expect(runStep(check?.run ?? 'exit 1', { DEPLOY_TARGET: 'cloudflare' })).toBe('failed');
  expect(check?.run).toContain('[[ -n "$CLOUDFLARE_ACCOUNT_ID" ]]');
  expect(check?.run).toContain('[[ -n "$CLOUDFLARE_API_TOKEN" ]]');
  expect(readiness.outputs.configured).toBe(expression('steps.configuration.outputs.configured'));
  // An incomplete reviewed build environment is not configured either: the Shell origin, every
  // placed Worker's public URL and the data-plane binding IDs must be present before any Worker is
  // built.
  const filter = /jq -r '(?<filter>[^']+)' app\/topology\/cloudflare-placement\.json/u.exec(check?.run ?? '')?.groups
    ?.filter;
  const missingBuildVariables = (placement: PlacementBuildInputs) =>
    execFileSync('/usr/bin/jq', ['-r', filter ?? 'error("missing filter")'], {
      encoding: 'utf-8',
      input: JSON.stringify(placement),
    })
      .split('\n')
      .filter(Boolean);
  expect(
    missingBuildVariables({ buildEnvironment: {}, units: ['commerce-customer-context', 'shell-super-app'] }),
  ).toEqual([
    'ULTRAMODERN_MF_DEV_ORIGIN',
    'ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID',
    'ULTRAMODERN_CLOUDFLARE_SPICEDB_VPC_SERVICE_ID',
    'ULTRAMODERN_CLOUDFLARE_COMPOSITION_KV_ID',
    'ULTRAMODERN_PUBLIC_URL_COMMERCE_CUSTOMER_CONTEXT',
    'ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP',
  ]);
  expect(
    missingBuildVariables({
      buildEnvironment: {
        ULTRAMODERN_CLOUDFLARE_COMPOSITION_KV_ID: 'composition-kv-id',
        ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID: 'hyperdrive-id',
        ULTRAMODERN_CLOUDFLARE_SPICEDB_VPC_SERVICE_ID: 'vpc-service-id',
        ULTRAMODERN_MF_DEV_ORIGIN: 'https://stage.example.test',
        ULTRAMODERN_PUBLIC_URL_PRICING: 'https://pricing.example.test',
      },
      units: ['pricing'],
    }),
  ).toEqual([]);
});

// A Worker that was never proven is not rolled back to a possibly broken version; the run fails.
const expectProvenRestore = (restore: typeof WorkflowStepSchema.Type | undefined, marker: string | undefined) => {
  expect(restore?.run).toContain('"$previous_version" == unproven');
  expect(restore?.run).toContain('no proven version to restore; not rolled back');
  // A restore is marked proven, so failed runs cannot push the proven deployment out of history.
  expect(restore?.env?.EDGE_PROVEN_MARKER).toBe(marker);
  expect(restore?.run).toContain('EDGE_PROVEN_MARKER}an earlier run; restored after $GITHUB_SHA failed');
};

// The active version is no rollback target: a secret change or manual deploy is never proven.
// Only a version recorded after its proof is restored; a never-proven Worker is not rolled back.
const expectProvenRollbackTargets = (steps: readonly (typeof WorkflowStepSchema.Type)[]) => {
  const byName = new Map(steps.map((step) => [step.name, step]));
  const deploy = byName.get(DEPLOY_STEP);
  const proven = byName.get(PROVEN_STEP);
  const restore = byName.get(RESTORE_STEP);
  const marker = deploy?.env?.EDGE_PROVEN_MARKER;
  expect(marker).toBeTruthy();
  expect(proven?.env?.EDGE_PROVEN_MARKER).toBe(marker);
  expect(deploy?.run).toContain('wrangler deployments list --name "$worker" --json');
  expect(deploy?.run).toContain('startswith($marker)');
  expect(deploy?.run).not.toContain('wrangler deployments status');
  // The proof marks the exact versions this run's deploys created, never a later active version.
  expect(deploy?.run).toContain('WRANGLER_OUTPUT_FILE_PATH="$deploy_output"');
  expect(proven?.env?.EDGE_DEPLOYED_VERSIONS).toBe(deploy?.env?.EDGE_DEPLOYED_VERSIONS);
  expect(proven?.run).toContain('"$active" != "$proven_version"');
  expect(proven?.run).toContain('wrangler versions deploy "$proven_version@100"');
  expect(proven?.run).toContain('--message "$EDGE_PROVEN_MARKER$GITHUB_SHA"');
  const names = steps.map((step) => step.name);
  expect(names.indexOf(PROVEN_STEP)).toBe(names.indexOf(PROOF_STEP) + 1);
  expectProvenRestore(restore, marker);
};

const WRANGLER_COMMAND = /^pnpm --filter "\$(?:[a-z_]+|\d)" exec wrangler /u;

it('deploys planned edge units to Cloudflare after the stage migration, with their own deployment history', () => {
  const jobs = readEdgeDeployJobs();
  const plan = jobs[EDGE_PLAN_JOB];
  const builds = jobs[EDGE_BUILD_JOB];
  const edge = jobs['deploy-cloudflare'];
  // A separate environment keeps a failed or skipped edge deploy from hiding behind a successful
  // Zerops deployment of the same revision.
  expect(jobs['deploy-zerops'].environment).toBe(DEPLOY_ENVIRONMENT_OUTPUT);
  expect(edge.environment).toBe(EDGE_ENVIRONMENT);
  // Planning and building wait only for the deploy target, so they run beside the migrations. Neither
  // records a deployment or reads the environment's secrets.
  expect(plan.needs).toEqual([DEPLOY_TARGET_JOB, EDGE_READINESS_JOB]);
  expect(plan.if).toBe(expression("!cancelled() && needs.edge-deploy-readiness.outputs.configured == 'true'"));
  expect(plan.environment).toBeUndefined();
  expect(builds.needs).toEqual([EDGE_PLAN_JOB]);
  expect(builds.environment).toBeUndefined();
  // Each planned unit builds on its own runner; a plan without units builds nothing.
  expect(builds.strategy.matrix.unit).toBe(expression('fromJSON(needs.edge-plan.outputs.cloudflare)'));
  expect(builds.strategy['fail-fast']).toBe(true);
  expect(builds.if).toBe(
    expression("!cancelled() && needs.edge-plan.result == 'success' && needs.edge-plan.outputs.cloudflare != '[]'"),
  );
  // Only changing Workers waits for the migrations, and it deploys beside the Zerops units. A plan
  // without units still deploys, so its deployment records the revision.
  expect(edge.needs).toEqual([DEPLOY_TARGET_JOB, MIGRATIONS_JOB, EDGE_PLAN_JOB, EDGE_BUILD_JOB]);
  expect(edge.if).toBe(
    expression(
      "!cancelled() && needs.deploy-migrations.result == 'success' && needs.edge-plan.result == 'success' && (needs.edge-build.result == 'success' || (needs.edge-build.result == 'skipped' && needs.edge-plan.outputs.cloudflare == '[]'))",
    ),
  );
  expect(edge.env).toBeUndefined();
  const planSteps = new Map(plan.steps.map((step) => [step.name, step]));
  expect(planSteps.get('Resolve the last successful edge deployment')?.run).toContain('--environment stage-edge');
  expect(planSteps.get(PLAN_STEP)?.id).toBe('impact');
  expect(plan.outputs.cloudflare).toBe(expression('steps.impact.outputs.cloudflare'));
  expect(plan.outputs.cloudflare_retirements).toBe(expression('steps.impact.outputs.cloudflare_retirements'));
  const byName = new Map(edge.steps.map((step) => [step.name, step]));
  const unpack = byName.get(UNPACK_STEP);
  const deploy = byName.get(DEPLOY_STEP);
  const proof = byName.get(PROOF_STEP);
  const restore = byName.get(RESTORE_STEP);
  for (const step of [unpack, deploy, proof]) {
    expect(step?.env?.CLOUDFLARE_UNITS_JSON).toBe(EDGE_UNITS_OUTPUT);
  }
  // The deploy uses each planned unit's build from this run, and stops before any Worker changes
  // when one is missing.
  const names = edge.steps.map((step) => step.name);
  expect(names.indexOf(UNPACK_STEP)).toBeLessThan(names.indexOf(DEPLOY_STEP));
  expect(unpack?.run).toContain('test -f .output/wrangler.json');
  expect(deploy?.run).toContain('exec wrangler deploy --config .output/wrangler.json');
  expect(proof?.run).toContain('run cloudflare:proof');
  // Build configuration comes from the reviewed placement document, not from environment
  // variables a Git diff cannot see.
  expect(proof?.run).toContain(
    ".buildEnvironment | to_entries[] | [.key, .value] | @tsv' topology/cloudflare-placement.json",
  );
  expect(JSON.stringify(proof?.env)).not.toContain('vars');
  // Every Worker is snapshotted before the first one changes, and restored to that snapshot after
  // a failed deploy or proof: its newest proven version, or no Worker when this run created it.
  expectProvenRollbackTargets(edge.steps);
  expect(restore?.run).toContain('wrangler rollback "$previous_version"');
  expect(restore?.run).toContain('wrangler delete --name "$deployed_worker"');
  expect(restore?.run).not.toMatch(/wrangler (?:rollback|delete)[^\n]*\|\| true/u);
  // A cancelled run may have stopped mid-deploy, so it restores too.
  expect(restore?.if).toBe("(failure() || cancelled()) && steps.deploy.outcome != 'skipped'");
  // The account token reaches only the steps that use it, and those run nothing but Wrangler:
  // building, verifying and proving a unit executes dependency code.
  expect(JSON.stringify([plan, builds])).not.toContain('secrets.');
  const tokenSteps = edge.steps.filter((step) => step.env?.CLOUDFLARE_API_TOKEN !== undefined);
  expect(tokenSteps.map((step) => step.name)).toEqual([DEPLOY_STEP, PROVEN_STEP, RETIRE_STEP, RESTORE_STEP]);
  expect(tokenSteps.flatMap(packageCommands).filter((command) => !WRANGLER_COMMAND.test(command))).toEqual([]);
});

it('builds each planned edge unit on its own runner from the reviewed placement, without the token', () => {
  const builds = readEdgeDeployJobs()[EDGE_BUILD_JOB];
  const build = builds.steps.find((step) => step.name === BUILD_STEP);
  expect(build?.env).toMatchObject({
    UNIT_ID: expression('matrix.unit.id'),
    UNIT_PACKAGE: expression('matrix.unit.packageName'),
    UNIT_WORKER: expression('matrix.unit.workerName'),
  });
  // The build step is the unit's `cloudflare:deploy` without its final `wrangler deploy`.
  expect(build?.run).toContain('run cloudflare:build');
  expect(build?.run).toContain('cloudflare-output-verify --app "$UNIT_ID" --require-public-urls');
  // The built Wrangler config must name the Worker the run snapshots, deploys and restores.
  expect(build?.run).toContain("exec jq -r '.name' .output/wrangler.json");
  expect(build?.run).toContain('"$built_worker" != "$UNIT_WORKER"');
  // Build configuration comes from the reviewed placement document, not from environment
  // variables a Git diff cannot see.
  expect(build?.run).toContain(
    ".buildEnvironment | to_entries[] | [.key, .value] | @tsv' topology/cloudflare-placement.json",
  );
  expect(JSON.stringify(build?.env)).not.toContain('vars');
  expect(JSON.stringify(builds)).not.toContain('secrets.');
});

it('bounds every edge step that changes or proves Workers and reports retirements read-only', () => {
  const jobs = readEdgeDeployJobs();
  const edge = jobs['deploy-cloudflare'];
  const byName = new Map(edge.steps.map((step) => [step.name, step]));
  const planSteps = new Map(jobs[EDGE_PLAN_JOB].steps.map((step) => [step.name, step]));
  const builds = jobs[EDGE_BUILD_JOB];
  // A hung build times out inside its own job.
  const build = builds.steps.find((step) => step.name === BUILD_STEP);
  expect(build?.['timeout-minutes']).toBeLessThan(builds['timeout-minutes']);
  const retire = byName.get(RETIRE_STEP);
  // A hung build, deploy, proof or retirement times out as a step failure, leaving the restore
  // step its own budget inside the job deadline.
  const bounded = [DEPLOY_STEP, PROOF_STEP, PROVEN_STEP, RETIRE_STEP, RESTORE_STEP].map(
    (name) => byName.get(name)?.['timeout-minutes'] ?? Number.POSITIVE_INFINITY,
  );
  expect(bounded.every(Number.isFinite)).toBe(true);
  expect(bounded.reduce((total, minutes) => total + minutes, 0)).toBeLessThanOrEqual(edge['timeout-minutes'] - 10);
  // Retirement is two-phase: the retired Worker survives the deploy that drops it, so a rollback
  // still finds it; after the proofs it is reported, read-only, until an operator deletes it.
  expect(retire?.env?.CLOUDFLARE_RETIREMENTS_JSON).toBe(expression('needs.edge-plan.outputs.cloudflare_retirements'));
  expect(retire?.run).toContain('wrangler deployments status --name "$worker"');
  expect(retire?.run).not.toMatch(/exec wrangler (?:delete|rollback|deploy)\b/u);
  const names = edge.steps.map((step) => step.name);
  expect(names.indexOf(RETIRE_STEP)).toBeGreaterThan(names.indexOf(PROOF_STEP));
  expect(retire?.run).not.toContain('exit 1');
  // Full plans still reconcile retirements against the last edge deployment.
  const resolve = planSteps.get('Resolve the last successful edge deployment');
  expect(resolve?.if).toBeUndefined();
  expect(resolve?.run).toContain('--optional');
  expect(planSteps.get(PLAN_STEP)?.run).toContain('--placement-base "$BASE_SHA"');
  // A recovery run after rewritten history fetches that base by id before planning.
  const fetchBase = planSteps.get('Fetch the last edge deployment commit');
  expect(fetchBase?.run).toContain('fetch --no-tags --depth=1 origin "$BASE_SHA"');
  const planNames = [...planSteps.keys()];
  expect(planNames.indexOf('Fetch the last edge deployment commit')).toBeLessThan(planNames.indexOf(PLAN_STEP));
});

const TargetWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    'deploy-cloudflare': Schema.Struct({ needs: Schema.Array(Schema.String) }),
    'deploy-migrations': Schema.Struct({
      concurrency: Schema.Struct({ group: Schema.String }),
      env: Schema.Record(Schema.String, Schema.String),
      environment: Schema.Struct({ deployment: Schema.Boolean, name: Schema.String }),
      if: Schema.String,
      needs: Schema.Array(Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
    }),
    'deploy-plan': Schema.Struct({
      env: Schema.Record(Schema.String, Schema.String),
      environment: Schema.Struct({ deployment: Schema.Boolean, name: Schema.String }),
      if: Schema.String,
      needs: Schema.Array(Schema.String),
      outputs: Schema.Record(Schema.String, Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
    }),
    'deploy-target': Schema.Struct({
      environment: Schema.Struct({ deployment: Schema.Boolean, name: Schema.String }),
      if: Schema.String,
      outputs: Schema.Record(Schema.String, Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
    }),
    'deploy-zerops': Schema.Struct({
      concurrency: Schema.Struct({ group: Schema.String }),
      env: Schema.Record(Schema.String, Schema.String),
      environment: Schema.String,
      if: Schema.String,
      needs: Schema.Array(Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
    }),
    'edge-deploy-readiness': Schema.Struct({ if: Schema.String }),
    'publish-edge-composition': Schema.Struct({
      env: Schema.Record(Schema.String, Schema.String),
      environment: Schema.Struct({ deployment: Schema.Boolean, name: Schema.String }),
      if: Schema.String,
      needs: Schema.Array(Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
    }),
    'queue-proof': Schema.Struct({
      if: Schema.String,
      outputs: Schema.Record(Schema.String, Schema.String),
      permissions: Schema.Record(Schema.String, Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
    }),
    'sync-edge-composition': Schema.Struct({
      environment: Schema.Struct({ deployment: Schema.Boolean, name: Schema.String }),
      if: Schema.String,
      needs: Schema.Array(Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
    }),
    'workspace-gates': Schema.Struct({
      if: Schema.String,
      name: Schema.String,
      needs: Schema.Array(Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
    }),
  }),
  on: Schema.Struct({
    workflow_dispatch: Schema.Struct({
      inputs: Schema.Struct({
        environment: Schema.Struct({ default: Schema.String, options: Schema.Array(Schema.String) }),
      }),
    }),
  }),
});

const readTargetWorkflow = () =>
  Schema.decodeUnknownSync(TargetWorkflowSchema)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')));

/** Runs a workflow step's script as Actions would and returns its GitHub outputs, or its failure. */
/** The deploying environment: the dispatched one, or stage for a push to main. */
const DEPLOY_ENVIRONMENT_EXPRESSION = expression("inputs.environment || 'stage'");

const CONFIGURED = { ZEROPS_PROJECT_ID: 'project', ZEROPS_TOKEN: 'token' } as const;
const DEDICATED = { OUTBOX_WORKER_MODE: 'dedicated' } as const;
const HOST = { OUTBOX_WORKER_MODE: 'host' } as const;

it('selects each environment deploy target from its DEPLOY_TARGET variable, Zerops when unset', () => {
  const workflow = readTargetWorkflow();
  const { 'deploy-target': target } = workflow.jobs;
  // Pushes deploy stage; production deploys only on an explicit dispatch.
  expect(workflow.on.workflow_dispatch.inputs.environment).toEqual({
    default: 'stage',
    options: ['stage', 'production'],
  });
  expect(target.if).toContain("github.ref == 'refs/heads/main'");
  // Reading the environment's variables must not add an entry to its deployment history.
  expect(target.environment).toEqual({ deployment: false, name: DEPLOY_ENVIRONMENT_EXPRESSION });
  const step = target.steps.find(({ id }) => id === 'target');
  expect(step?.env).toEqual({
    DEPLOY_ENVIRONMENT: DEPLOY_ENVIRONMENT_EXPRESSION,
    DEPLOY_TARGET: expression('vars.DEPLOY_TARGET'),
    OUTBOX_WORKER_MODE: expression('vars.OUTBOX_WORKER_MODE'),
    ZEROPS_PROJECT_ID: expression('vars.ZEROPS_PROJECT_ID'),
    ZEROPS_TOKEN: expression('secrets.ZEROPS_TOKEN'),
  });
  expect(target.outputs['outbox-worker-mode']).toBe(expression('steps.target.outputs.outbox_worker_mode'));
  const resolve = (environment: Readonly<Record<string, string>>) => runStep(step?.run ?? 'exit 1', environment);
  // An unset target keeps today's all-Zerops stage.
  expect(resolve({ ...CONFIGURED, ...DEDICATED, DEPLOY_ENVIRONMENT: 'stage', DEPLOY_TARGET: '' })).toEqual({
    configured: 'true',
    environment: 'stage',
    outbox_worker_mode: 'dedicated',
    target: 'zerops',
  });
  expect(resolve({ ...CONFIGURED, ...HOST, DEPLOY_ENVIRONMENT: 'stage', DEPLOY_TARGET: 'cloudflare' })).toEqual({
    configured: 'true',
    environment: 'stage',
    outbox_worker_mode: 'host',
    target: 'cloudflare',
  });
  expect(resolve({ ...CONFIGURED, ...DEDICATED, DEPLOY_ENVIRONMENT: 'production', DEPLOY_TARGET: 'zerops' })).toEqual({
    configured: 'true',
    environment: 'production',
    outbox_worker_mode: 'dedicated',
    target: 'zerops',
  });
  // An environment without its Zerops project and token deploys nothing, so it needs no mode either.
  expect(resolve({ DEPLOY_ENVIRONMENT: 'production', DEPLOY_TARGET: '', OUTBOX_WORKER_MODE: '' })).toEqual({
    configured: 'false',
    environment: 'production',
    outbox_worker_mode: '',
    target: 'zerops',
  });
  // Only stage has an edge deploy history and build environment; unknown targets fail closed.
  expect(resolve({ ...CONFIGURED, ...DEDICATED, DEPLOY_ENVIRONMENT: 'production', DEPLOY_TARGET: 'cloudflare' })).toBe(
    'failed',
  );
  expect(resolve({ ...CONFIGURED, ...HOST, DEPLOY_ENVIRONMENT: 'stage', DEPLOY_TARGET: 'workers' })).toBe('failed');
});

it('requires each configured environment to choose its Outbox Worker mode, independent of the deploy target', () => {
  const step = readTargetWorkflow().jobs['deploy-target'].steps.find(({ id }) => id === 'target');
  const resolve = (environment: Readonly<Record<string, string>>) => runStep(step?.run ?? 'exit 1', environment);
  // Every mode runs beside every target: a cheap host on a Zerops preview, dedicated workers beside the Workers.
  for (const [DEPLOY_TARGET, OUTBOX_WORKER_MODE] of [
    ['zerops', 'host'],
    ['cloudflare', 'dedicated'],
  ] as const) {
    expect(resolve({ ...CONFIGURED, DEPLOY_ENVIRONMENT: 'stage', DEPLOY_TARGET, OUTBOX_WORKER_MODE })).toEqual({
      configured: 'true',
      environment: 'stage',
      outbox_worker_mode: OUTBOX_WORKER_MODE,
      target: DEPLOY_TARGET,
    });
  }
  // No default: a configured environment that has not chosen fails instead of inheriting a mode.
  expect(
    resolve({ ...CONFIGURED, DEPLOY_ENVIRONMENT: 'production', DEPLOY_TARGET: 'zerops', OUTBOX_WORKER_MODE: '' }),
  ).toBe('failed');
  expect(resolve({ ...CONFIGURED, DEPLOY_ENVIRONMENT: 'stage', DEPLOY_TARGET: '', OUTBOX_WORKER_MODE: 'shared' })).toBe(
    'failed',
  );
});

it('deploys the whole topology to Zerops, or only its infrastructure and outbox workers beside the edge', () => {
  const { jobs } = readTargetWorkflow();
  const plan = jobs['deploy-plan'];
  const migrations = jobs[MIGRATIONS_JOB];
  const zerops = jobs['deploy-zerops'];
  // The plan needs no gate, so it is ready when the gates pass. A skipped edge check (production) must not skip it.
  expect(plan.if).toMatch(/^!cancelled\(\)/u);
  expect(plan.if).toContain("needs.deploy-target.outputs.configured == 'true'");
  // The Cloudflare target mutates Zerops only once the edge deploy is configured.
  expect(plan.if).toContain(
    "(needs.deploy-target.outputs.target == 'zerops' || needs.edge-deploy-readiness.outputs.configured == 'true')",
  );
  expect(plan.needs).toEqual([DEPLOY_TARGET_JOB, EDGE_READINESS_JOB]);
  // Only deploy-zerops records the environment's deployment, so a plan or migration before a failed deploy
  // never moves the diff base.
  expect(plan.environment).toEqual({ deployment: false, name: DEPLOY_ENVIRONMENT_OUTPUT });
  expect(migrations.environment).toEqual(plan.environment);
  expect(zerops.environment).toBe(DEPLOY_ENVIRONMENT_OUTPUT);
  // Nothing changes on Zerops before the gates pass or prove skipped on the merge queue's proof.
  expect(migrations.needs).toEqual(['workspace-gates', DEPLOY_TARGET_JOB, 'deploy-plan']);
  expect(migrations.if).toBe(
    expression("!cancelled() && needs.workspace-gates.result == 'success' && needs.deploy-plan.result == 'success'"),
  );
  expect(zerops.needs).toEqual([DEPLOY_TARGET_JOB, 'deploy-plan', MIGRATIONS_JOB]);
  expect(zerops.if).toBe(expression(`!cancelled() && needs.${MIGRATIONS_JOB}.result == 'success'`));
  // Only deploy-zerops publishes, so only it shares the composition refresh's group; migrations lock on their own.
  expect(zerops.concurrency.group).toBe(`zerops-${DEPLOY_ENVIRONMENT_EXPRESSION}`);
  expect(migrations.concurrency.group).toBe(`zerops-migrations-${DEPLOY_ENVIRONMENT_EXPRESSION}`);
  expect(plan.env.DEPLOY_TARGET).toBe(DEPLOY_TARGET_OUTPUT);
  expect(plan.env.OUTBOX_WORKER_MODE).toBe(OUTBOX_WORKER_MODE_OUTPUT);
  expect(zerops.env.DEPLOY_TARGET).toBe(DEPLOY_TARGET_OUTPUT);
  expect(zerops.env.OUTBOX_WORKER_MODE).toBe(OUTBOX_WORKER_MODE_OUTPUT);
  // Every service ID comes from the deploying environment's own variables.
  for (const [name, value] of Object.entries({ ...migrations.env, ...zerops.env }).filter(([key]) =>
    key.startsWith('ZEROPS_'),
  )) {
    expect(value).toBe(expression(`vars.${name}`));
  }
  // Migrations and SpiceDB run alone, before the edge and the Zerops units; a plan without them only skips steps.
  const migrationSteps = new Map(migrations.steps.map((step) => [step.name, step]));
  expect(migrationSteps.get('Run verified database migrations')?.if).toBe(
    "needs.deploy-plan.outputs.migrator == 'true'",
  );
  expect(migrationSteps.get('Deploy SpiceDB when affected')?.if).toBe("needs.deploy-plan.outputs.spicedb == 'true'");
  expect(migrations.env.INFRASTRUCTURE).toBe(
    expression("needs.deploy-plan.outputs.migrator == 'true' || needs.deploy-plan.outputs.spicedb == 'true'"),
  );
  expect(zerops.steps.map(({ name }) => name)).not.toContain('Run verified database migrations');
  expect(zerops.steps.map(({ name }) => name)).not.toContain('Deploy SpiceDB when affected');
  const byName = new Map(plan.steps.map((step) => [step.name, step]));
  const planRun = byName.get('Generate topology-driven deployment impact plan')?.run;
  expect(byName.get("Resolve the environment's last successful deployment")?.run).toContain(
    '--environment "$DEPLOY_ENVIRONMENT"',
  );
  expect(planRun).toContain('--authorization-environment "$DEPLOY_ENVIRONMENT"');
  // The Outbox Worker mode, not the deploy target, chooses the workers the plan deploys and stops.
  expect(planRun).toContain('--outbox-worker-mode "$OUTBOX_WORKER_MODE"');
  expect(planRun).not.toContain('--deploy-target');
  expect(plan.outputs).toEqual({
    any: expression('steps.units.outputs.any'),
    migrator: expression('steps.impact.outputs.migrator'),
    providers: expression('steps.units.outputs.providers'),
    shell: expression('steps.units.outputs.shell'),
    spicedb: expression('steps.impact.outputs.spicedb'),
    'stopped-workers': expression('steps.impact.outputs.stopped_workers'),
  });
  const select = byName.get('Select the Zerops units of the deploy target');
  const impact = {
    MIGRATOR: 'false',
    PROVIDERS_JSON: '["contacts","contacts-worker"]',
    SHELL: 'true',
    SPICEDB: 'false',
    WORKERS_JSON: '["contacts-worker"]',
  };
  const units = (environment: Readonly<Record<string, string>>) => runStep(select?.run ?? 'exit 1', environment);
  expect(units({ ...impact, DEPLOY_TARGET: 'zerops' })).toEqual({
    any: 'true',
    providers: impact.PROVIDERS_JSON,
    shell: 'true',
  });
  expect(units({ ...impact, DEPLOY_TARGET: 'cloudflare' })).toEqual({
    any: 'true',
    providers: impact.WORKERS_JSON,
    shell: 'false',
  });
  expect(units({ ...impact, DEPLOY_TARGET: 'cloudflare', WORKERS_JSON: '[]' })).toEqual({
    any: 'false',
    providers: '[]',
    shell: 'false',
  });
  // Every Zerops push and publication follows the selected units the plan hands over.
  expect(select?.id).toBe('units');
  for (const step of [...migrations.steps, ...zerops.steps]) {
    expect(`${step.if ?? ''}${JSON.stringify(step.env ?? {})}`).not.toMatch(
      /steps\.impact\.outputs\.(?:any|providers|shell)/u,
    );
    expect(step.run ?? '').not.toContain('--environment stage');
  }
  // Only stage deploys to the edge, after its migrations and beside its Zerops services.
  expect(jobs['edge-deploy-readiness'].if).toBe("needs.deploy-target.outputs.environment == 'stage'");
  expect(jobs['deploy-cloudflare'].needs).toEqual([DEPLOY_TARGET_JOB, MIGRATIONS_JOB, EDGE_PLAN_JOB, EDGE_BUILD_JOB]);
  // On Cloudflare the snapshot is published again from the new Workers, outside the deploy history.
  const publish = jobs['publish-edge-composition'];
  expect(publish.if).toBe(
    expression(
      "!cancelled() && needs.deploy-zerops.result == 'success' && needs.deploy-cloudflare.result == 'success' && needs.deploy-target.outputs.target == 'cloudflare'",
    ),
  );
  // It restarts the Zerops consumers, so it waits for deploy-zerops too.
  expect(publish.needs).toEqual(['deploy-target', 'deploy-zerops', 'deploy-cloudflare']);
  expect(publish.environment).toEqual({ deployment: false, name: 'stage' });
  expect(publish.env.DEPLOY_TARGET).toBe('cloudflare');
  expect(publish.env.OUTBOX_WORKER_MODE).toBe(OUTBOX_WORKER_MODE_OUTPUT);
  const edgePublication = publish.steps.find(
    ({ name }) => name === 'Publish the observed Workers and restart the Zerops consumers',
  );
  expect(edgePublication?.run).toContain('publish --environment stage --restart-consumers');
  expect(edgePublication?.run).toContain('--snapshot-file "$SNAPSHOT_FILE"');
  // A new Worker is unobservable before deploy-cloudflare ships it, so deploy-zerops leaves publication to it.
  const zeropsSteps = new Map(zerops.steps.map((step) => [step.name, step]));
  expect(
    zeropsSteps.get('Publish the complete active Application Composition and restart its consumers')?.if,
  ).toContain("env.DEPLOY_TARGET == 'zerops'");
  expect(zeropsSteps.get('Publish the active Application Composition before its consumers deploy')?.run).toContain(
    'if [[ "$DEPLOY_TARGET" == cloudflare ]]; then',
  );
  // Placed Worker consumers read each publication from the composition KV namespace, written from the one environment with the token.
  const sync = jobs['sync-edge-composition'];
  expect(sync.needs).toEqual(['publish-edge-composition']);
  expect(sync.environment).toEqual({ deployment: false, name: EDGE_ENVIRONMENT });
  expect(sync.steps.at(-1)?.run).toBe('app/scripts/put-edge-composition-snapshot.sh');
});

it('hands the edge deployment planner the Outbox Worker mode it requires', () => {
  const plan = readEdgeDeployJobs()[EDGE_PLAN_JOB].steps.find((step) => step.name === PLAN_STEP);
  expect(plan?.env?.OUTBOX_WORKER_MODE).toBe(OUTBOX_WORKER_MODE_OUTPUT);
  expect(plan?.run).toContain('--outbox-worker-mode "$OUTBOX_WORKER_MODE"');
});

const QUEUE_PROOF_JOB = 'queue-proof';
const NODE_ARTIFACT_BUILD_JOB = 'node-artifact-build';
const CLOUDFLARE_ARTIFACT_BUILD_JOB = 'cloudflare-artifact-build';
const WORKSPACE_GATE_JOB = 'workspace-gate';
const FORMAT_AND_LINT_JOB = 'format-and-lint';
/** The gates that start once the merge queue proof is checked. */
const ROOT_GATE_JOBS = [
  WORKSPACE_GATE_JOB,
  'static-contracts',
  FORMAT_AND_LINT_JOB,
  'service-integration',
  NODE_ARTIFACT_BUILD_JOB,
  CLOUDFLARE_ARTIFACT_BUILD_JOB,
] as const;
/** Every gate job; each target's artifact proofs run inside its own build shards. */
const GATE_JOBS = ROOT_GATE_JOBS;
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

it('skips the gates on main only for a commit the merge queue already proved', () => {
  const workflow = readTargetWorkflow();
  const proof = workflow.jobs[QUEUE_PROOF_JOB];
  // Only a push or dispatch on main can carry a proven commit; pull requests and merge groups run every gate.
  expect(proof.if).toBe(
    "(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main'",
  );
  expect(proof.permissions).toEqual({ actions: 'read' });
  expect(proof.outputs.proven).toBe(expression('steps.proof.outputs.proven'));
  // The proof is this workflow's successful merge group run on this exact commit, read from GitHub.
  const lookup = proof.steps.find(({ id }) => id === 'proof')?.run ?? '';
  expect(lookup).toContain('runs?head_sha=$GITHUB_SHA&event=merge_group&status=success');
  expect(lookup).toContain('actions/runs/$GITHUB_RUN_ID');
  const { jobs } = Schema.decodeUnknownSync(GatedJobsSchema)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')));
  for (const gate of ROOT_GATE_JOBS) {
    expect(jobs[gate]?.needs).toEqual([QUEUE_PROOF_JOB]);
    expect(jobs[gate]?.if).toBe(expression("!cancelled() && needs.queue-proof.outputs.proven != 'true'"));
  }
});

it('requires every gate, or the merge queue proof, in the one Workspace gates check', () => {
  const gates = readTargetWorkflow().jobs['workspace-gates'];
  // The main ruleset requires this check by name.
  expect(gates.name).toBe('Workspace gates');
  expect(gates.if).toBe(expression('always()'));
  expect(gates.needs).toEqual([QUEUE_PROOF_JOB, ...GATE_JOBS]);
  const script = gates.steps.at(-1)?.run ?? 'exit 1';
  const needs = (proof: { proven?: string; result: string }, results: readonly string[]) =>
    JSON.stringify({
      [QUEUE_PROOF_JOB]: { outputs: proof.proven === undefined ? {} : { proven: proof.proven }, result: proof.result },
      ...Object.fromEntries(GATE_JOBS.map((gate, index) => [gate, { outputs: {}, result: results[index] }])),
    });
  const allPassed = GATE_JOBS.map(() => 'success');
  const allSkipped = GATE_JOBS.map(() => 'skipped');
  // A pull request or merge group: no proof job, every gate must pass.
  expect(stepPasses(script, { NEEDS_JSON: needs({ result: 'skipped' }, allPassed) })).toBe(true);
  expect(stepPasses(script, { NEEDS_JSON: needs({ result: 'skipped' }, ['failure', ...allPassed.slice(1)]) })).toBe(
    false,
  );
  expect(stepPasses(script, { NEEDS_JSON: needs({ result: 'skipped' }, ['cancelled', ...allPassed.slice(1)]) })).toBe(
    false,
  );
  expect(stepPasses(script, { NEEDS_JSON: needs({ result: 'skipped' }, allSkipped) })).toBe(false);
  // A proven commit on main: every gate skipped.
  expect(stepPasses(script, { NEEDS_JSON: needs({ proven: 'true', result: 'success' }, allSkipped) })).toBe(true);
  // An unproven commit on main runs the gates, and so does a failed lookup, which also fails the check.
  expect(stepPasses(script, { NEEDS_JSON: needs({ proven: 'false', result: 'success' }, allPassed) })).toBe(true);
  expect(stepPasses(script, { NEEDS_JSON: needs({ proven: 'false', result: 'success' }, allSkipped) })).toBe(false);
  expect(stepPasses(script, { NEEDS_JSON: needs({ result: 'failure' }, allPassed) })).toBe(false);
});

it('runs every job after the gates even when a merge-queue-proven run skipped them', () => {
  const { jobs } = Schema.decodeUnknownSync(GatedJobsSchema)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')));
  const ancestors = (job: string): ReadonlySet<string> =>
    new Set((jobs[job]?.needs ?? []).flatMap((parent) => [parent, ...ancestors(parent)]));
  // A skipped ancestor skips a job whose `if` relies on the implicit success(), so every job that the
  // skipped gates precede must decide with !cancelled() (or always()) and check its own needs' results.
  const afterGates = Object.keys(jobs).filter((job) => GATE_JOBS.some((gate) => ancestors(job).has(gate)));
  expect(afterGates).toContain('deploy-cloudflare');
  expect(afterGates).toContain('sync-edge-composition');
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
    [CLOUDFLARE_ARTIFACT_BUILD_JOB]: ArtifactBuildJobSchema,
    [NODE_ARTIFACT_BUILD_JOB]: ArtifactBuildJobSchema,
  }),
});
const TopologyUnitsSchema = Schema.Struct({
  shell: Schema.Struct({ path: Schema.String }),
  verticals: Schema.Array(Schema.Struct({ path: Schema.String })),
});

const sorted = (values: readonly string[]) => EffectArray.sort(values, Order.String);

it('builds every delivery unit of the topology in exactly one build shard of each target', () => {
  const { jobs } = Schema.decodeUnknownSync(ArtifactBuildWorkflowSchema)(
    parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')),
  );
  const topology = Schema.decodeUnknownSync(TopologyUnitsSchema)(
    JSON.parse(readFileSync(new URL('../../topology/reference-topology.json', import.meta.url), 'utf-8')),
  );
  const units = [topology.shell, ...topology.verticals].map((unit) => unit.path);
  for (const [job, script] of [
    [NODE_ARTIFACT_BUILD_JOB, 'build'],
    [CLOUDFLARE_ARTIFACT_BUILD_JOB, 'cloudflare:build'],
  ] as const) {
    const { steps, strategy } = jobs[job];
    // Every shard builds units, and the target's shards build every unit once, with the target's script.
    expect(strategy.matrix.include.map(({ shard }) => shard)).toEqual(strategy.matrix.shard);
    const built = strategy.matrix.include.flatMap(({ units: shardUnits }) => shardUnits.split(/\s+/u).filter(Boolean));
    expect(sorted(built)).toEqual(sorted(units));
    expect(steps.some(({ run }) => run?.includes(`"\${filters[@]}" run ${script}\n`) === true)).toBe(true);
  }
});

const readArtifactBuildJobs = () =>
  Schema.decodeUnknownSync(ArtifactBuildWorkflowSchema)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8'))).jobs;

it('proves each target on its own shards only after every other shard of the target succeeded', () => {
  const jobs = readArtifactBuildJobs();
  for (const [job, proofs, artifacts] of [
    [NODE_ARTIFACT_BUILD_JOB, ['node'], 'node-units-*'],
    [CLOUDFLARE_ARTIFACT_BUILD_JOB, ['outputs', 'topology'], 'cloudflare-units-*'],
  ] as const) {
    const { name, permissions, steps, strategy } = jobs[job];
    // Each proof runs on exactly one shard; the other shards only build.
    const hosted = strategy.matrix.include.map(({ proof }) => proof).filter((proof) => proof !== 'none');
    expect(sorted(hosted)).toEqual([...proofs]);
    expect(permissions).toEqual({ actions: 'read', contents: 'read' });
    // The proving shard waits for every other shard of this job, by the job's own name, before it
    // downloads them; every step after the shard's own upload runs only on a proving shard.
    const prefix = name.slice(0, name.indexOf('${{'));
    const upload = steps.findIndex((step) => step.name === "Upload the shard's build outputs");
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
  const others = [
    { conclusion: 'success', name: 'Build x (2/3)' },
    { conclusion: 'success', name: 'Build x (3/3)' },
  ];
  const unrelated = [
    { conclusion: null, name: 'Build x (1/3)' },
    { conclusion: 'failure', name: 'Static Contracts' },
  ];
  expect(waitForBuildShards([...others, ...unrelated])).toBe(true);
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped']) {
    expect(waitForBuildShards([others[0], { conclusion, name: 'Build x (3/3)' }, ...unrelated])).toBe(false);
  }
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
    'static-contracts': Schema.Struct({ steps: Schema.Array(Schema.Struct({ run: Schema.optional(Schema.String) })) }),
    [WORKSPACE_GATE_JOB]: Schema.Struct({
      strategy: Schema.Struct({
        matrix: Schema.Struct({
          include: Schema.Array(Schema.Struct({ commands: Schema.String, name: Schema.String })),
        }),
      }),
    }),
  }),
});
const RootScriptsSchema = Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) });

const readGateCommandJobs = () =>
  Schema.decodeUnknownSync(GateCommandsWorkflowSchema)(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8'))).jobs;
const gateCommands = () =>
  readGateCommandJobs()[WORKSPACE_GATE_JOB].strategy.matrix.include.map(({ commands }) =>
    commands.split('\n').filter(Boolean),
  );

it('runs every workspace gate check in some workspace-gate entry', () => {
  const commands = gateCommands().flat();
  for (const check of [
    'pnpm typecheck',
    'pnpm typecheck:lint-rules',
    'pnpm test:lint-rules',
    'pnpm api:check:ontos',
    'pnpm test:scripts',
    'pnpm module-entrypoints:check',
    'pnpm test:deployment-impact',
    'pnpm test:generation',
  ]) {
    expect(commands).toContain(check);
  }
  const staticChecks = readGateCommandJobs()['static-contracts'].steps.map(({ run }) => run ?? '');
  expect(staticChecks).toContain('mise exec -- pnpm database-access:check');
});

it('runs the root unit and component tests of every workspace package in exactly one shard', () => {
  const { scripts } = Schema.decodeUnknownSync(RootScriptsSchema)(
    JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')),
  );
  // The shards run exactly what the root script runs, split by package.
  expect(scripts['test:unit']).toBe('pnpm -r --if-present run test:unit && pnpm -r --if-present run test:component');
  const shards = gateCommands().flatMap((commands) => {
    const [unit, component, ...rest] = commands;
    if (unit === undefined || !unit.endsWith(' run test:unit')) {
      return [];
    }
    const filters = unit.replace(/^pnpm -r --if-present /u, '').replace(/ run test:unit$/u, '');
    // Each shard runs test:component over the same packages, after test:unit, and nothing else.
    expect(component).toBe(`pnpm -r --if-present ${filters} run test:component`);
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
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-lint-shards-'));
  try {
    const selected = Array.from({ length: shards }, (_, index) => {
      execFileSync('/bin/bash', ['-eo', 'pipefail', '-c', select], {
        cwd: repository,
        env: { PATH: STEP_PATH, RUNNER_TEMP: directory, SHARD: String(index + 1), SHARDS: String(shards) },
      });
      return readFileSync(path.join(directory, 'shard-files'), 'utf-8').split('\0').filter(Boolean);
    });
    const tracked = execFileSync('/usr/bin/git', ['ls-files', '-z'], { cwd: repository, encoding: 'utf-8' })
      .split('\0')
      .filter(Boolean);
    expect(sorted(selected.flat())).toEqual(sorted(tracked));
    for (const files of selected) {
      expect(files.length).toBeGreaterThan(0);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
