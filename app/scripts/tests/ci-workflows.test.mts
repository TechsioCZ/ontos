import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

const TriggerSchema = Schema.Struct({ 'paths-ignore': Schema.Array(Schema.String) });
const WorkflowSchema = Schema.Struct({ on: Schema.Struct({ pull_request: TriggerSchema, push: TriggerSchema }) });

const readWorkflow = (name: string) =>
  Schema.decodeUnknownSync(WorkflowSchema)(
    parse(readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf-8')),
  );

/** The GitHub environment that holds the Cloudflare account token. */
const EDGE_ENVIRONMENT = 'stage-edge';
const gateWorkflows = ['ultramodern-workspace-gates.yml', 'quality-audit.yml'];

const skipsGates = (changedPaths: readonly string[], ignored: readonly string[]) =>
  changedPaths.every((changedPath) => ignored.some((pattern) => path.matchesGlob(changedPath, pattern)));

it('skips the gate workflows for pushes and pull requests that change only repository-root documentation', () => {
  for (const name of gateWorkflows) {
    const workflow = readWorkflow(name);
    for (const trigger of [workflow.on.push, workflow.on.pull_request]) {
      const ignored = trigger['paths-ignore'];
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
  }
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
    'edge-deploy-readiness': Schema.Struct({
      environment: Schema.Struct({ deployment: Schema.Boolean, name: Schema.String }),
      if: Schema.String,
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
const BUILD_STEP = 'Build and verify planned edge units';
const PROOF_STEP = 'Prove the deployed edge units on their public URLs';

interface PlacementBuildInputs {
  readonly buildEnvironment: Readonly<Record<string, string>>;
  readonly units: readonly string[];
}

const EDGE_READINESS_JOB = 'edge-deploy-readiness';
const DEPLOY_TARGET_JOB = 'deploy-target';
const OUTBOX_WORKER_MODE_OUTPUT = expression('needs.deploy-target.outputs.outbox-worker-mode');

const runStep = (script: string, environment: Readonly<Record<string, string>>) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-workflow-step-'));
  const outputPath = path.join(directory, 'output');
  try {
    execFileSync('/bin/bash', ['-eo', 'pipefail', '-c', script], {
      env: { GITHUB_OUTPUT: outputPath, PATH: '/usr/bin:/bin', ...environment },
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
  Schema.decodeUnknownSync(EdgeDeployWorkflowSchema)(
    parse(
      readFileSync(new URL('../../../.github/workflows/ultramodern-workspace-gates.yml', import.meta.url), 'utf-8'),
    ),
  ).jobs;

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
    DEPLOY_TARGET: expression('needs.deploy-target.outputs.target'),
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
    'ULTRAMODERN_PUBLIC_URL_COMMERCE_CUSTOMER_CONTEXT',
    'ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP',
  ]);
  expect(
    missingBuildVariables({
      buildEnvironment: {
        ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID: 'hyperdrive-id',
        ULTRAMODERN_CLOUDFLARE_SPICEDB_VPC_SERVICE_ID: 'vpc-service-id',
        ULTRAMODERN_MF_DEV_ORIGIN: 'https://stage.example.test',
        ULTRAMODERN_PUBLIC_URL_PRICING: 'https://pricing.example.test',
      },
      units: ['pricing'],
    }),
  ).toEqual([]);
});

const WRANGLER_COMMAND = /^pnpm --filter "\$(?:[a-z_]+|\d)" exec wrangler /u;

it('deploys planned edge units to Cloudflare after the stage migration, with their own deployment history', () => {
  const jobs = readEdgeDeployJobs();
  const edge = jobs['deploy-cloudflare'];
  // A separate environment keeps a failed or skipped edge deploy from hiding behind a successful
  // Zerops deployment of the same revision.
  expect(jobs['deploy-zerops'].environment).toBe(expression('needs.deploy-target.outputs.environment'));
  expect(edge.environment).toBe(EDGE_ENVIRONMENT);
  expect(edge.needs).toEqual([DEPLOY_TARGET_JOB, 'deploy-zerops', EDGE_READINESS_JOB]);
  expect(edge.if).toBe("needs.edge-deploy-readiness.outputs.configured == 'true'");
  expect(edge.env).toBeUndefined();
  const byName = new Map(edge.steps.map((step) => [step.name, step]));
  expect(byName.get('Resolve the last successful edge deployment')?.run).toContain('--environment stage-edge');
  expect(byName.get(PLAN_STEP)?.id).toBe('impact');
  const build = byName.get(BUILD_STEP);
  const deploy = byName.get(DEPLOY_STEP);
  const proof = byName.get(PROOF_STEP);
  const restore = byName.get(RESTORE_STEP);
  for (const step of [build, deploy, proof]) {
    expect(step?.env?.CLOUDFLARE_UNITS_JSON).toBe(expression('steps.impact.outputs.cloudflare'));
  }
  // The build step is each unit's `cloudflare:deploy` without its final `wrangler deploy`.
  expect(build?.run).toContain('run cloudflare:build');
  expect(build?.run).toContain('cloudflare-output-verify --app "$id" --require-public-urls');
  // The built Wrangler config must name the Worker the run snapshots, deploys and restores.
  expect(build?.run).toContain("exec jq -r '.name' .output/wrangler.json");
  expect(build?.run).toContain('"$built_worker" != "$worker"');
  expect(deploy?.run).toContain('exec wrangler deploy --config .output/wrangler.json');
  expect(proof?.run).toContain('run cloudflare:proof');
  // Build configuration comes from the reviewed placement document, not from environment
  // variables a Git diff cannot see.
  for (const step of [build, proof]) {
    expect(step?.run).toContain(
      ".buildEnvironment | to_entries[] | [.key, .value] | @tsv' topology/cloudflare-placement.json",
    );
    expect(JSON.stringify(step?.env)).not.toContain('vars');
  }
  // Every Worker is snapshotted before the first one changes, and restored to that snapshot after
  // a failed deploy or proof: the recorded version, or no Worker when this run created it.
  expect(deploy?.run).toContain('wrangler deployments status');
  expect(restore?.run).toContain('wrangler rollback "$previous_version"');
  expect(restore?.run).toContain('wrangler delete --name "$deployed_worker"');
  expect(restore?.run).not.toMatch(/wrangler (?:rollback|delete)[^\n]*\|\| true/u);
  // A cancelled run may have stopped mid-deploy, so it restores too.
  expect(restore?.if).toBe("(failure() || cancelled()) && steps.deploy.outcome != 'skipped'");
  // The account token reaches only the steps that use it, and those run nothing but Wrangler:
  // building, verifying and proving a unit executes dependency code.
  const tokenSteps = edge.steps.filter((step) => step.env?.CLOUDFLARE_API_TOKEN !== undefined);
  expect(tokenSteps.map((step) => step.name)).toEqual([DEPLOY_STEP, RETIRE_STEP, RESTORE_STEP]);
  expect(tokenSteps.flatMap(packageCommands).filter((command) => !WRANGLER_COMMAND.test(command))).toEqual([]);
});

it('bounds every edge step that changes or proves Workers and reports retirements read-only', () => {
  const edge = readEdgeDeployJobs()['deploy-cloudflare'];
  const byName = new Map(edge.steps.map((step) => [step.name, step]));
  const retire = byName.get(RETIRE_STEP);
  // A hung build, deploy, proof or retirement times out as a step failure, leaving the restore
  // step its own budget inside the job deadline.
  const bounded = [BUILD_STEP, DEPLOY_STEP, PROOF_STEP, RETIRE_STEP, RESTORE_STEP].map(
    (name) => byName.get(name)?.['timeout-minutes'] ?? Number.POSITIVE_INFINITY,
  );
  expect(bounded.every(Number.isFinite)).toBe(true);
  expect(bounded.reduce((total, minutes) => total + minutes, 0)).toBeLessThanOrEqual(edge['timeout-minutes'] - 10);
  // Retirement is two-phase: the retired Worker survives the deploy that drops it, so a rollback
  // still finds it; after the proofs it is reported, read-only, until an operator deletes it.
  expect(retire?.env?.CLOUDFLARE_RETIREMENTS_JSON).toBe(expression('steps.impact.outputs.cloudflare_retirements'));
  expect(retire?.run).toContain('wrangler deployments status --name "$worker"');
  expect(retire?.run).not.toMatch(/exec wrangler (?:delete|rollback|deploy)\b/u);
  const names = edge.steps.map((step) => step.name);
  expect(names.indexOf(RETIRE_STEP)).toBeGreaterThan(names.indexOf(PROOF_STEP));
  expect(retire?.run).not.toContain('exit 1');
  // Full plans still reconcile retirements against the last edge deployment.
  const resolve = byName.get('Resolve the last successful edge deployment');
  expect(resolve?.if).toBeUndefined();
  expect(resolve?.run).toContain('--optional');
  expect(byName.get(PLAN_STEP)?.run).toContain('--placement-base "$BASE_SHA"');
  // A recovery run after rewritten history fetches that base by id before planning.
  const fetchBase = byName.get('Fetch the last edge deployment commit');
  expect(fetchBase?.run).toContain('fetch --no-tags --depth=1 origin "$BASE_SHA"');
  expect(names.indexOf('Fetch the last edge deployment commit')).toBeLessThan(names.indexOf(PLAN_STEP));
});

const TargetWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    'deploy-cloudflare': Schema.Struct({ needs: Schema.Array(Schema.String) }),
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
    'sync-edge-composition': Schema.Struct({
      environment: Schema.Struct({ deployment: Schema.Boolean, name: Schema.String }),
      if: Schema.String,
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
  Schema.decodeUnknownSync(TargetWorkflowSchema)(
    parse(
      readFileSync(new URL('../../../.github/workflows/ultramodern-workspace-gates.yml', import.meta.url), 'utf-8'),
    ),
  );

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
  const zerops = jobs['deploy-zerops'];
  expect(zerops.if).toContain("needs.deploy-target.outputs.configured == 'true'");
  // A skipped edge check (production) must not skip the job, so every gate is checked by name.
  expect(zerops.if).toMatch(/^!cancelled\(\)/u);
  for (const need of zerops.needs.filter((name) => ![DEPLOY_TARGET_JOB, EDGE_READINESS_JOB].includes(name))) {
    expect(zerops.if).toContain(`needs.${need}.result == 'success'`);
  }
  // The Cloudflare target mutates Zerops only once the edge deploy is configured.
  expect(zerops.if).toContain(
    "(needs.deploy-target.outputs.target == 'zerops' || needs.edge-deploy-readiness.outputs.configured == 'true')",
  );
  expect(zerops.needs).toContain(DEPLOY_TARGET_JOB);
  expect(zerops.needs).toContain(EDGE_READINESS_JOB);
  expect(zerops.concurrency.group).toBe(`zerops-${DEPLOY_ENVIRONMENT_EXPRESSION}`);
  expect(zerops.env.DEPLOY_TARGET).toBe(expression('needs.deploy-target.outputs.target'));
  expect(zerops.env.OUTBOX_WORKER_MODE).toBe(OUTBOX_WORKER_MODE_OUTPUT);
  // Every service ID comes from the deploying environment's own variables.
  for (const [name, value] of Object.entries(zerops.env).filter(([key]) => key.startsWith('ZEROPS_'))) {
    expect(value).toBe(expression(`vars.${name}`));
  }
  const byName = new Map(zerops.steps.map((step) => [step.name, step]));
  const planRun = byName.get('Generate topology-driven deployment impact plan')?.run;
  expect(byName.get("Resolve the environment's last successful deployment")?.run).toContain(
    '--environment "$DEPLOY_ENVIRONMENT"',
  );
  expect(planRun).toContain('--authorization-environment "$DEPLOY_ENVIRONMENT"');
  // The Outbox Worker mode, not the deploy target, chooses the workers the plan deploys and stops.
  expect(planRun).toContain('--outbox-worker-mode "$OUTBOX_WORKER_MODE"');
  expect(planRun).not.toContain('--deploy-target');
  const select = byName.get('Select the Zerops units of the deploy target');
  const plan = {
    MIGRATOR: 'false',
    PROVIDERS_JSON: '["contacts","contacts-worker"]',
    SHELL: 'true',
    SPICEDB: 'false',
    WORKERS_JSON: '["contacts-worker"]',
  };
  const units = (environment: Readonly<Record<string, string>>) => runStep(select?.run ?? 'exit 1', environment);
  expect(units({ ...plan, DEPLOY_TARGET: 'zerops' })).toEqual({
    any: 'true',
    providers: plan.PROVIDERS_JSON,
    shell: 'true',
  });
  expect(units({ ...plan, DEPLOY_TARGET: 'cloudflare' })).toEqual({
    any: 'true',
    providers: plan.WORKERS_JSON,
    shell: 'false',
  });
  expect(units({ ...plan, DEPLOY_TARGET: 'cloudflare', WORKERS_JSON: '[]' })).toEqual({
    any: 'false',
    providers: '[]',
    shell: 'false',
  });
  // Every Zerops push and publication after the selection follows the selected units.
  const selectedIndex = select === undefined ? -1 : zerops.steps.indexOf(select);
  expect(selectedIndex).toBeGreaterThan(0);
  for (const step of zerops.steps.slice(selectedIndex + 1)) {
    expect(`${step.if ?? ''}${JSON.stringify(step.env ?? {})}`).not.toMatch(
      /steps\.impact\.outputs\.(?:any|providers|shell)/u,
    );
    expect(step.run ?? '').not.toContain('--environment stage');
  }
  // Only stage deploys to the edge, after its Zerops services.
  expect(jobs['edge-deploy-readiness'].if).toBe("needs.deploy-target.outputs.environment == 'stage'");
  expect(jobs['deploy-cloudflare'].needs).toEqual([DEPLOY_TARGET_JOB, 'deploy-zerops', EDGE_READINESS_JOB]);
  // On Cloudflare the snapshot is published again from the new Workers, outside the deploy history.
  const publish = jobs['publish-edge-composition'];
  expect(publish.if).toBe("needs.deploy-target.outputs.target == 'cloudflare'");
  expect(publish.needs).toEqual(['deploy-target', 'deploy-cloudflare']);
  expect(publish.environment).toEqual({ deployment: false, name: 'stage' });
  expect(publish.env.DEPLOY_TARGET).toBe('cloudflare');
  expect(publish.env.OUTBOX_WORKER_MODE).toBe(OUTBOX_WORKER_MODE_OUTPUT);
  const edgePublication = publish.steps.find(
    ({ name }) => name === 'Publish the observed Workers and restart the Zerops consumers',
  );
  expect(edgePublication?.run).toContain('publish --environment stage --restart-consumers');
  expect(edgePublication?.run).toContain('--snapshot-file "$SNAPSHOT_FILE"');
  // A new Worker is unobservable before deploy-cloudflare ships it, so deploy-zerops leaves publication to it.
  expect(byName.get('Publish the complete active Application Composition and restart its consumers')?.if).toContain(
    "env.DEPLOY_TARGET == 'zerops'",
  );
  expect(byName.get('Publish the active Application Composition before its consumers deploy')?.run).toContain(
    'if [[ "$DEPLOY_TARGET" == cloudflare ]]; then',
  );
  // Placed Worker consumers get each publication as their Worker secret, from the one environment with the token.
  const sync = jobs['sync-edge-composition'];
  expect(sync.needs).toEqual(['publish-edge-composition']);
  expect(sync.environment).toEqual({ deployment: false, name: EDGE_ENVIRONMENT });
  expect(sync.steps.at(-1)?.run).toBe('app/scripts/put-edge-composition-snapshot.sh');
});

it('hands the edge deployment planner the Outbox Worker mode it requires', () => {
  const edge = readEdgeDeployJobs()['deploy-cloudflare'];
  const plan = edge.steps.find((step) => step.name === PLAN_STEP);
  expect(plan?.env?.OUTBOX_WORKER_MODE).toBe(OUTBOX_WORKER_MODE_OUTPUT);
  expect(plan?.run).toContain('--outbox-worker-mode "$OUTBOX_WORKER_MODE"');
});
