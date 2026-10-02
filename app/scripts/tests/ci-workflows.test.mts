import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const EdgeDeployWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    'deploy-cloudflare': Schema.Struct({
      concurrency: Schema.Struct({ 'cancel-in-progress': Schema.Boolean, group: Schema.String }),
      env: Schema.optional(Schema.Unknown),
      environment: Schema.Struct({ deployment: Schema.Boolean, name: Schema.String }),
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
    'finalize-edge-deployment': Schema.Struct({
      concurrency: Schema.Struct({ 'cancel-in-progress': Schema.Boolean, group: Schema.String }),
      environment: Schema.String,
      if: Schema.String,
      needs: Schema.Array(Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
      'timeout-minutes': Schema.Number,
    }),
  }),
});

const PLAN_STEP = 'Plan the impacted edge units';
const BUILD_STEP = 'Build and verify the planned edge unit';
const UNPACK_STEP = "Unpack the planned edge units' build outputs";
const EDGE_PLAN_JOB = 'edge-plan';
const EDGE_BUILD_JOB = 'edge-build';
const EDGE_RELEASE_JOB = 'deploy-cloudflare';
const EDGE_PUBLISH_JOB = 'publish-edge-composition';
const EDGE_PUBLICATION_LOCK = 'zerops-stage';
const EDGE_UNITS_OUTPUT = expression('needs.edge-plan.outputs.cloudflare');

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
const PROTECTED_DEPLOY_ENVIRONMENT = expression(
  "needs.deploy-target.outputs.target == 'cloudflare' && needs.deploy-target.outputs.environment == 'stage' && 'stage-edge' || needs.deploy-target.outputs.environment",
);
const DEPLOY_ENVIRONMENT_ARGUMENT = '--environment "$DEPLOY_ENVIRONMENT"';
const ZEROPS_TOKEN_EXPRESSION = expression('secrets.ZEROPS_TOKEN');
const ZEROPS_PROJECT_EXPRESSION = expression('vars.ZEROPS_PROJECT_ID');
const DATABASE_ADMIN_EXPRESSION = expression('secrets.DATABASE_ADMIN_URL');
const RUNNER_TEMP_EXPRESSION = expression('runner.temp');

const runStep = (script: string, environment: Readonly<Record<string, string>>, workingDirectory?: string) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-workflow-step-'));
  const outputPath = path.join(directory, 'output');
  try {
    execFileSync('/bin/bash', ['-eo', 'pipefail', '-c', script], {
      cwd: workingDirectory,
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

it('deploys to Cloudflare only when the account, retained artifact origin, backend secrets, and database are configured', () => {
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
    CLOUDFLARE_WORKERS_DEV_SUBDOMAIN: expression('vars.CLOUDFLARE_WORKERS_DEV_SUBDOMAIN'),
    DATABASE_ADMIN_URL: DATABASE_ADMIN_EXPRESSION,
    DATABASE_URL: expression('secrets.DATABASE_URL'),
    DEPLOY_TARGET: DEPLOY_TARGET_OUTPUT,
    ONTOS_IMMUTABLE_RELEASE_SECRETS: expression('secrets.ONTOS_IMMUTABLE_RELEASE_SECRETS'),
    ZEROPS_PROJECT_ID: ZEROPS_PROJECT_EXPRESSION,
    ZEROPS_TOKEN: ZEROPS_TOKEN_EXPRESSION,
  });
  // A stage that deploys to Zerops only skips the edge; one that targets Cloudflare fails before any
  // Zerops change, since deploy-zerops would otherwise migrate and swap workers beside the old Workers.
  expect(runStep(check?.run ?? 'exit 1', { DEPLOY_TARGET: 'zerops' })).toEqual({ configured: 'false' });
  expect(runStep(check?.run ?? 'exit 1', { DEPLOY_TARGET: 'cloudflare' })).toBe('failed');
  expect(check?.run).toContain('[[ -n "$CLOUDFLARE_ACCOUNT_ID" ]]');
  expect(check?.run).toContain('[[ -n "$CLOUDFLARE_API_TOKEN" ]]');
  expect(check?.run).toContain('[[ -n "$CLOUDFLARE_WORKERS_DEV_SUBDOMAIN" ]]');
  expect(check?.run).toContain('[[ -n "$ONTOS_IMMUTABLE_RELEASE_SECRETS" ]]');
  expect(check?.run).toContain('[[ -n "$DATABASE_URL" && -n "$DATABASE_ADMIN_URL" ]]');
  expect(check?.run).toContain('[[ -n "$ZEROPS_PROJECT_ID" && -n "$ZEROPS_TOKEN" ]]');
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

it('fails edge readiness before migrations when either private-network credential is missing', () => {
  const check = readEdgeDeployJobs()['edge-deploy-readiness'].steps.find((step) => step.id === 'configuration');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-edge-network-readiness-'));
  try {
    const topology = path.join(directory, 'app', 'topology');
    mkdirSync(topology, { recursive: true });
    writeFileSync(
      path.join(topology, 'cloudflare-placement.json'),
      JSON.stringify({
        buildEnvironment: {
          ULTRAMODERN_CLOUDFLARE_COMPOSITION_KV_ID: 'test-kv',
          ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID: 'test-hyperdrive',
          ULTRAMODERN_CLOUDFLARE_SPICEDB_VPC_SERVICE_ID: 'test-vpc',
          ULTRAMODERN_MF_DEV_ORIGIN: 'https://shell.test',
        },
        units: [],
      }),
    );
    const configured = {
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_API_TOKEN: 'edge-token',
      CLOUDFLARE_WORKERS_DEV_SUBDOMAIN: 'workers-subdomain',
      DATABASE_ADMIN_URL: 'postgres://admin@private-db/ontos',
      DATABASE_URL: 'postgres://runtime@private-db/ontos',
      DEPLOY_TARGET: 'cloudflare',
      ONTOS_IMMUTABLE_RELEASE_SECRETS: '{}',
      ZEROPS_PROJECT_ID: 'project',
      ZEROPS_TOKEN: 'vpn-token',
    };
    const resolve = (environment: Readonly<Record<string, string>>) =>
      runStep(check?.run ?? 'exit 1', environment, directory);
    expect(resolve(configured)).toEqual({ configured: 'true', workers_dev_subdomain: 'workers-subdomain' });
    expect(resolve({ ...configured, ZEROPS_PROJECT_ID: '' })).toBe('failed');
    expect(resolve({ ...configured, ZEROPS_TOKEN: '' })).toBe('failed');
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it('deploys retained edge releases after migrations under the shared environment publication lock', () => {
  const jobs = readEdgeDeployJobs();
  const plan = jobs[EDGE_PLAN_JOB];
  const builds = jobs[EDGE_BUILD_JOB];
  const edge = jobs['deploy-cloudflare'];
  expect(jobs['deploy-zerops'].environment).toBe(DEPLOY_ENVIRONMENT_OUTPUT);
  expect(edge.environment).toEqual({ deployment: false, name: EDGE_ENVIRONMENT });
  expect(plan.needs).toEqual([DEPLOY_TARGET_JOB, EDGE_READINESS_JOB]);
  expect(plan.if).toBe(expression("!cancelled() && needs.edge-deploy-readiness.outputs.configured == 'true'"));
  expect(plan.environment).toBeUndefined();
  expect(builds.needs).toEqual([EDGE_PLAN_JOB]);
  expect(builds.environment).toBeUndefined();
  expect(builds.strategy.matrix.unit).toBe(expression('fromJSON(needs.edge-plan.outputs.cloudflare)'));
  expect(builds.strategy['fail-fast']).toBe(true);
  expect(builds.if).toBe(
    expression("!cancelled() && needs.edge-plan.result == 'success' && needs.edge-plan.outputs.cloudflare != '[]'"),
  );
  expect(edge.needs).toEqual([DEPLOY_TARGET_JOB, MIGRATIONS_JOB, EDGE_PLAN_JOB, EDGE_BUILD_JOB]);
  expect(edge.if).toBe(
    expression(
      "!cancelled() && needs.deploy-migrations.result == 'success' && needs.edge-plan.result == 'success' && (needs.edge-build.result == 'success' || (needs.edge-build.result == 'skipped' && needs.edge-plan.outputs.cloudflare == '[]'))",
    ),
  );
  expect(edge.concurrency).toEqual({ 'cancel-in-progress': false, group: EDGE_PUBLICATION_LOCK });
  const planSteps = new Map(plan.steps.map((step) => [step.name, step]));
  expect(planSteps.get('Resolve the last successful edge deployment')?.run).toContain('--environment stage-edge');
  expect(planSteps.get(PLAN_STEP)?.id).toBe('impact');
  expect(plan.outputs.cloudflare).toBe(expression('steps.selection.outputs.cloudflare'));
  const unpack = edge.steps.find((step) => step.name === UNPACK_STEP);
  const deploy = edge.steps.find((step) => step.run?.includes('immutable-application-release.mts deploy') === true);
  expect(unpack?.env?.CLOUDFLARE_UNITS_JSON).toBe(EDGE_UNITS_OUTPUT);
  expect(deploy?.env?.CLOUDFLARE_UNITS_JSON).toBe(EDGE_UNITS_OUTPUT);
  expect(unpack?.run).toContain('test -f .output/wrangler.json');
  expect(unpack?.run).toContain('.codex/reports/releases/$id/plan.json');
  expect(edge.steps.findIndex(({ name }) => name === unpack?.name)).toBeLessThan(
    edge.steps.findIndex(({ name }) => name === deploy?.name),
  );
  expect(deploy?.run).not.toContain('--namespace');
  expect(deploy?.run).toContain('--plan-file');
  expect(deploy?.run).toContain('--receipt-file');
  expect(JSON.stringify([plan, builds])).not.toContain('secrets.');
  const finalize = jobs['finalize-edge-deployment'];
  expect(finalize.environment).toBe(EDGE_ENVIRONMENT);
  expect(finalize.needs).toEqual([DEPLOY_TARGET_JOB, EDGE_PLAN_JOB, EDGE_RELEASE_JOB, EDGE_PUBLISH_JOB]);
  expect(finalize.if).toContain("needs.publish-edge-composition.result == 'success'");
  expect(finalize.concurrency).toEqual({ 'cancel-in-progress': false, group: EDGE_PUBLICATION_LOCK });
  const ingress = finalize.steps.find(({ id }) => id === 'shell-ingress');
  expect(ingress?.run).toContain('immutable-shell-release.mts ingress-deploy');
  expect(ingress?.if).toContain("contains(fromJSON(needs.edge-plan.outputs.cloudflare).*.id, 'shell-super-app')");
  expect(edge.steps.map(({ run }) => run ?? '').join('\n')).not.toContain('ingress-deploy');
});

it('builds each edge unit with its retained asset origin and archives the exact plan without account credentials', () => {
  const builds = readEdgeDeployJobs()[EDGE_BUILD_JOB];
  const build = builds.steps.find((step) => step.name === BUILD_STEP);
  expect(build?.env).toMatchObject({
    ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
    ULTRAMODERN_SOURCE_REVISION: expression('github.sha'),
    UNIT_ID: expression('matrix.unit.id'),
    UNIT_PACKAGE: expression('matrix.unit.packageName'),
  });
  const origin = builds.steps.find(({ run }) => run?.includes('immutable-application-release.mts plan') === true);
  expect(origin?.run).toContain('--plan-file');
  expect(build?.run).toContain('MODERN_ASSET_PREFIX');
  expect(build?.run).toContain('run cloudflare:build');
  expect(build?.run).toContain('cloudflare-output-verify --app "$UNIT_ID" --require-public-urls');
  expect(build?.run).toContain('.codex/reports/releases/$UNIT_ID/plan.json');
  expect(JSON.stringify(builds)).not.toContain('secrets.');
  expect(JSON.stringify(builds)).not.toContain('CLOUDFLARE_API_TOKEN');
});

it('bounds edge release publication and never automatically rolls back or deletes retained releases', () => {
  const jobs = readEdgeDeployJobs();
  const edge = jobs['deploy-cloudflare'];
  const builds = jobs[EDGE_BUILD_JOB];
  const build = builds.steps.find((step) => step.name === BUILD_STEP);
  expect(build?.['timeout-minutes']).toBeLessThan(builds['timeout-minutes']);
  const releaseSteps = edge.steps.filter(
    (step) =>
      step.run?.includes('immutable-application-release.mts') === true ||
      step.run?.includes('immutable-shell-release.mts') === true ||
      step.run?.includes('cloudflare:proof') === true,
  );
  expect(releaseSteps.length).toBeGreaterThan(0);
  for (const step of releaseSteps) {
    expect(step['timeout-minutes']).toBeGreaterThan(0);
    expect(step['timeout-minutes']).toBeLessThan(edge['timeout-minutes']);
  }
  expect(edge.steps.map((step) => step.run ?? '').join('\n')).not.toMatch(
    /wrangler (?:rollback|delete|versions deploy)\b/u,
  );
  expect(edge.steps.some((step) => step.name.startsWith('Restore '))).toBe(false);
  const planSteps = new Map(jobs[EDGE_PLAN_JOB].steps.map((step) => [step.name, step]));
  expect(planSteps.get(PLAN_STEP)?.run).toContain('--placement-base "$BASE_SHA"');
  const fetchBase = planSteps.get('Fetch the last edge deployment commit');
  expect(fetchBase?.run).toContain('fetch --no-tags --depth=1 origin "$BASE_SHA"');
});

const DEPLOY_PLAN_JOB = 'deploy-plan';
const INITIAL_CUTOVER_GUARD_JOB = 'initial-composition-cutover-guard';
const COMPOSITION_CANDIDATE_ARTIFACT = 'approved-application-composition-candidate';
const INITIAL_CUTOVER_RECEIPT_ARTIFACT = 'initial-composition-cutover-receipt';
const RETAINED_APPROVED_SHELL_ARTIFACT = 'retained-approved-shell-snapshot';
const DATABASE_MIGRATION_STEP = 'Run verified database migrations';
const SPICEDB_DEPLOYMENT_STEP = 'Deploy SpiceDB when affected';
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
    'deploy-cloudflare': Schema.Struct({
      needs: Schema.Array(Schema.String),
      steps: Schema.Array(PublicationWorkflowStepSchema),
    }),
    'deploy-migrations': Schema.Struct({
      concurrency: Schema.Struct({ group: Schema.String }),
      env: Schema.Record(Schema.String, Schema.String),
      environment: Schema.Struct({ deployment: Schema.Boolean, name: Schema.String }),
      if: Schema.String,
      needs: Schema.Array(Schema.String),
      permissions: Schema.Record(Schema.String, Schema.String),
      steps: Schema.Array(PublicationWorkflowStepSchema),
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
      permissions: Schema.Record(Schema.String, Schema.String),
      steps: Schema.Array(PublicationWorkflowStepSchema),
    }),
    'edge-deploy-readiness': Schema.Struct({ if: Schema.String }),
    'initial-composition-cutover-guard': Schema.Struct({
      concurrency: Schema.Struct({ 'cancel-in-progress': Schema.Boolean, group: Schema.String }),
      env: Schema.Record(Schema.String, Schema.String),
      environment: Schema.Struct({ deployment: Schema.Boolean, name: Schema.String }),
      if: Schema.String,
      needs: Schema.Array(Schema.String),
      permissions: Schema.Record(Schema.String, Schema.String),
      steps: Schema.Array(PublicationWorkflowStepSchema),
    }),
    'publish-edge-composition': Schema.Struct({
      concurrency: Schema.Struct({ 'cancel-in-progress': Schema.Boolean, group: Schema.String }),
      env: Schema.Record(Schema.String, Schema.String),
      environment: Schema.Struct({ deployment: Schema.Boolean, name: Schema.String }),
      if: Schema.String,
      needs: Schema.Array(Schema.String),
      steps: Schema.Array(PublicationWorkflowStepSchema),
    }),
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

const VpnWorkflowJobsSchema = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      steps: Schema.optional(
        Schema.Array(
          Schema.Struct({
            ...PublicationWorkflowStepSchema.fields,
            env: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number]))),
          }),
        ),
      ),
    }),
  ),
});
const ZEROPS_VPN_ACTION = './.github/actions/zerops-vpn';
const PRIVATE_DELIVERY_JOBS = [
  INITIAL_CUTOVER_GUARD_JOB,
  MIGRATIONS_JOB,
  'deploy-zerops',
  EDGE_RELEASE_JOB,
  EDGE_PUBLISH_JOB,
  'finalize-edge-deployment',
] as const;

const readVpnWorkflowJobs = (name: string) =>
  Schema.decodeUnknownSync(VpnWorkflowJobsSchema)(
    parse(readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf-8')),
  ).jobs;

const NativeVpnActionSchema = Schema.Struct({
  inputs: Schema.Record(Schema.String, Schema.Struct({ required: Schema.Boolean })),
  outputs: Schema.Record(Schema.String, Schema.Struct({ value: Schema.String })),
  runs: Schema.Struct({
    steps: Schema.Array(Schema.Struct({ ...PublicationWorkflowStepSchema.fields, shell: Schema.String })),
    using: Schema.Literal('composite'),
  }),
});
const readNativeVpnAction = () =>
  Schema.decodeUnknownSync(NativeVpnActionSchema)(
    parse(readFileSync(new URL('../../../.github/actions/zerops-vpn/action.yml', import.meta.url), 'utf-8')),
  );
const VPN_CONNECT_STEP = "Connect to the protected project's private network";
const VPN_CLEAR_STEP = "Clear only this runner's native VPN key and configuration";
const VPN_DATABASE_STEP = 'Verify both private database endpoints';
const VPN_STATE_OUTPUT = expression('steps.composition-vpn.outputs.state-directory');
const VPN_CLI_OUTPUT = expression('steps.composition-vpn.outputs.cli-path');
// Actions runs Linux Bash; macOS's system Bash 3.2 does not stop on a failed [[ ... ]] under errexit.
const VPN_TEST_BASH = os.platform() === 'darwin' ? '/opt/homebrew/bin/bash' : '/bin/bash';
const FAKE_BASH_SHEBANG = '#!/bin/bash';
const VPN_INTERFACE_CALL = 'sudo=ip link show dev zerops';
const VPN_OWNED_CLEANUP_CALL = 'sudo=rm --recursive --force -- <runner>/ontos-zerops-vpn.test';
const nativeVpnScript = (name: string) =>
  readNativeVpnAction().runs.steps.find((step) => step.name === name)?.run ?? 'exit 1';

const FAKE_VPN_SUDO = [
  FAKE_BASH_SHEBANG,
  'if [[ "$1" == --preserve-env=* ]]; then',
  String.raw`  printf "preserve=%s\n" "$1" >>"$VPN_CALLS"`,
  '  shift',
  '  exec "$@"',
  'fi',
  String.raw`printf "sudo=%s\n" "$*" >>"$VPN_CALLS"`,
  'case "$1" in',
  '  ip) if [[ "$VPN_INTERFACE_STATUS" == 0 && ! -f "$VPN_INTERFACE_FILE" ]]; then exit 0; fi; exit 1 ;;',
  '  rm) exit 0 ;;',
  '  *) exit 77 ;;',
  'esac',
].join('\n');
const FAKE_VPN_CLI = [
  FAKE_BASH_SHEBANG,
  String.raw`printf "native=%s\n" "$*" >>"$VPN_CALLS"`,
  '[[ "$ZEROPS_TOKEN" == test-token ]] || exit 67',
  '[[ "$ZEROPS_CLI_DATA_FILE_PATH" == "$VPN_STATE_DIRECTORY/cli.data" ]] || exit 68',
  '[[ "$ZEROPS_WG_CONFIG_FILE_PATH" == "$VPN_STATE_DIRECTORY/zerops.conf" ]] || exit 69',
  '[[ "$ZEROPS_CLI_YAML_FILE_PATH" == "$VPN_STATE_DIRECTORY/.zcli.yml" ]] || exit 70',
  '[[ "$ZEROPS_CLI_LOG_FILE_PATH" == /dev/null ]] || exit 71',
  '[[ "$2" != "$VPN_NATIVE_FAILURE" ]] || exit 72',
  'if [[ "$2" == down ]]; then : >"$VPN_INTERFACE_FILE"; fi',
].join('\n');
const FAKE_VPN_PYTHON = [
  '#!/usr/bin/python3',
  'import os, socket, sys, time',
  'class Connection:',
  '    def __enter__(self): return self',
  '    def __exit__(self, *_): return False',
  'def connect(address, timeout):',
  '    with open(os.environ["VPN_CALLS"], "a") as output:',
  String.raw`        output.write(f"tcp={address[0]}:{address[1]},timeout={timeout}\n")`,
  '    if address[0] == os.environ.get("VPN_UNREACHABLE_HOST"): raise OSError("fake DNS or TCP failure")',
  '    return Connection()',
  'socket.create_connection = connect',
  'ticks = iter(range(0, 10000, 31))',
  'time.monotonic = lambda: next(ticks)',
  'time.sleep = lambda _: None',
  'exec(compile(sys.stdin.read(), "<native-vpn-endpoints>", "exec"))',
].join('\n');

/** Executes the real action script with local native-command and socket substitutes. */
const runNativeVpnScript = (script: string, environment: Readonly<Record<string, string | undefined>> = {}) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-native-vpn-test-'));
  const stateDirectory = path.join(directory, 'ontos-zerops-vpn.test');
  const callsPath = path.join(directory, 'calls');
  try {
    mkdirSync(stateDirectory);
    writeFileSync(callsPath, '');
    for (const [name, source] of [
      ['sudo', FAKE_VPN_SUDO],
      ['zcli', FAKE_VPN_CLI],
      ['python3', FAKE_VPN_PYTHON],
    ]) {
      const executable = path.join(directory, name);
      writeFileSync(executable, source);
      chmodSync(executable, 0o755);
    }
    let passed = true;
    try {
      execFileSync(VPN_TEST_BASH, ['-eo', 'pipefail', '-c', script], {
        env: {
          DATABASE_ADMIN_URL: 'postgres://admin@admin-private:5433/ontos',
          DATABASE_URL: 'postgresql://runtime@runtime-private/ontos',
          PATH: `${directory}:${STEP_PATH}`,
          RUNNER_OS: 'Linux',
          RUNNER_TEMP: directory,
          VPN_CALLS: callsPath,
          VPN_CLI_PATH: path.join(directory, 'zcli'),
          VPN_INTERFACE_FILE: path.join(directory, 'interface-down'),
          VPN_OPERATION: 'connect',
          VPN_PROJECT_ID: 'test-project',
          VPN_STATE_DIRECTORY: stateDirectory,
          ZEROPS_TOKEN: 'test-token',
          ...environment,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      });
    } catch {
      passed = false;
    }
    return {
      calls: readFileSync(callsPath, 'utf-8').replaceAll(directory, '<runner>').split('\n').filter(Boolean),
      passed,
    };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

it('connects every private deployment and refresh runner through native Zerops VPN and always clears it', () => {
  const deploymentJobs = readVpnWorkflowJobs(GATES_WORKFLOW);
  const refreshJobs = readVpnWorkflowJobs('active-application-composition-refresh.yml');
  const jobs = [
    ...PRIVATE_DELIVERY_JOBS.map((name) => ({ name, steps: deploymentJobs[name]?.steps ?? [] })),
    ...['refresh-stage', 'refresh-production'].map((name) => ({ name, steps: refreshJobs[name]?.steps ?? [] })),
  ];
  for (const { name, steps } of jobs) {
    const connections = steps.filter((step) => step.uses === ZEROPS_VPN_ACTION && step.with?.operation === 'connect');
    const cleanups = steps.filter((step) => step.uses === ZEROPS_VPN_ACTION && step.with?.operation === 'clear');
    expect(connections, name).toHaveLength(1);
    expect(cleanups, name).toHaveLength(1);
    const [connection] = connections;
    const [cleanup] = cleanups;
    expect(connection?.id, name).toBe('composition-vpn');
    expect(connection?.with, name).toMatchObject({
      'database-admin-url': DATABASE_ADMIN_EXPRESSION,
      'database-url': expression('secrets.DATABASE_URL'),
      'project-id': ZEROPS_PROJECT_EXPRESSION,
      token: ZEROPS_TOKEN_EXPRESSION,
    });
    expect(cleanup?.if, name).toBe("always() && steps.composition-vpn.outputs.state-directory != ''");
    expect(cleanup?.with, name).toEqual({
      'cli-path': VPN_CLI_OUTPUT,
      operation: 'clear',
      'project-id': ZEROPS_PROJECT_EXPRESSION,
      'state-directory': VPN_STATE_OUTPUT,
      token: ZEROPS_TOKEN_EXPRESSION,
    });
    const stepNames = steps.map((step) => step.name);
    const connectIndex = stepNames.indexOf(connection?.name ?? '');
    const clearIndex = stepNames.indexOf(cleanup?.name ?? '');
    const privateOperations = steps.filter((step) =>
      /active-composition:publish (?:verify-initial-cutover|capture-approved-snapshot|migrate|publish|refresh)\b|immutable-(?:application|shell)-release\.mts (?:deploy|ingress-deploy)\b/u.test(
        step.run ?? '',
      ),
    );
    expect(privateOperations.length, name).toBeGreaterThan(0);
    for (const operation of privateOperations) {
      const operationIndex = stepNames.indexOf(operation.name);
      expect(connectIndex, `${name}: ${operation.name}`).toBeLessThan(operationIndex);
      expect(clearIndex, `${name}: ${operation.name}`).toBeGreaterThan(operationIndex);
    }
  }
});

it('pins the native VPN client and preserves cleanup outputs after a failed connection', () => {
  const action = readNativeVpnAction();
  expect(action.inputs.operation?.required).toBe(true);
  expect(action.inputs['project-id']?.required).toBe(true);
  expect(action.inputs.token?.required).toBe(true);
  expect(action.outputs['state-directory']?.value).toBe(expression('steps.prepare.outputs.state-directory'));
  expect(action.outputs['cli-path']?.value).toBe(expression('steps.prepare.outputs.cli-path'));
  const prepare = action.runs.steps.find((step) => step.id === 'prepare');
  expect(prepare?.run).toContain('npm install --global @zerops/zcli@1.1.0');
  expect(prepare?.run).toContain('wireguard-tools systemd-resolved iputils-ping');
  expect(prepare?.run).toContain('getBinaryPath()');
  expect(prepare?.run).toContain('chmod 700 "$state_directory"');
  expect(action.runs.steps.every((step) => step.shell === 'bash')).toBe(true);
  const clear = action.runs.steps.find((step) => step.name === VPN_CLEAR_STEP);
  expect(clear?.if).toBe("always() && inputs.operation == 'clear'");
  expect(action.runs.steps[0]?.if).toBe('always()');
  expect(runNativeVpnScript(nativeVpnScript(VPN_CONNECT_STEP), { VPN_NATIVE_FAILURE: 'up' }).passed).toBe(false);
  expect(runNativeVpnScript(nativeVpnScript(VPN_CLEAR_STEP)).passed).toBe(true);
});

it('requires Linux, a supported VPN operation and both native credentials before connecting or clearing', () => {
  const validate = nativeVpnScript('Validate the native VPN operation');
  expect(runNativeVpnScript(validate).passed).toBe(true);
  expect(runNativeVpnScript(validate, { VPN_OPERATION: 'clear' }).passed).toBe(true);
  for (const environment of [
    { RUNNER_OS: 'Darwin' },
    { VPN_OPERATION: 'delete' },
    { VPN_PROJECT_ID: '' },
    { ZEROPS_TOKEN: '' },
  ]) {
    expect(runNativeVpnScript(validate, environment)).toEqual({ calls: [], passed: false });
  }
});

it('runs native VPN up and clear with the exact project and isolated credential registry', () => {
  const connected = runNativeVpnScript(nativeVpnScript(VPN_CONNECT_STEP));
  expect(connected.passed).toBe(true);
  expect(connected.calls[0]).toBe(
    'preserve=--preserve-env=ZEROPS_TOKEN,ZEROPS_CLI_DATA_FILE_PATH,ZEROPS_WG_CONFIG_FILE_PATH,ZEROPS_CLI_YAML_FILE_PATH,ZEROPS_CLI_LOG_FILE_PATH',
  );
  expect(connected.calls[1]).toBe('native=vpn up --project-id test-project');
  expect(connected.calls).toHaveLength(2);
  const cleared = runNativeVpnScript(nativeVpnScript(VPN_CLEAR_STEP));
  expect(cleared.passed).toBe(true);
  expect(cleared.calls.slice(1)).toEqual([
    'native=vpn clear --project-id test-project',
    VPN_INTERFACE_CALL,
    VPN_INTERFACE_CALL,
    VPN_OWNED_CLEANUP_CALL,
  ]);
});

it('removes only owned state even when native clearing fails and reports the native failure', () => {
  const clear = nativeVpnScript(VPN_CLEAR_STEP);
  for (const environment of [
    { VPN_NATIVE_FAILURE: 'clear' },
    { VPN_INTERFACE_STATUS: '0', VPN_NATIVE_FAILURE: 'down' },
  ]) {
    const result = runNativeVpnScript(clear, environment);
    expect(result.passed).toBe(false);
    expect(result.calls.at(-1)).toBe(VPN_OWNED_CLEANUP_CALL);
  }
  expect(runNativeVpnScript(clear, { VPN_STATE_DIRECTORY: '/foreign/ontos-zerops-vpn.test' })).toEqual({
    calls: [],
    passed: false,
  });
});

it('uses native VPN down when the interface survives clearing and verifies its removal before local cleanup', () => {
  const result = runNativeVpnScript(nativeVpnScript(VPN_CLEAR_STEP), { VPN_INTERFACE_STATUS: '0' });
  expect(result.passed).toBe(true);
  expect(result.calls.slice(1).filter((call) => !call.startsWith('preserve='))).toEqual([
    'native=vpn clear --project-id test-project',
    VPN_INTERFACE_CALL,
    'native=vpn down',
    VPN_INTERFACE_CALL,
    VPN_OWNED_CLEANUP_CALL,
  ]);
});

const REFRESH_VPN_PRESERVE_STEP = "Preserve the workflow's native VPN action";
const REFRESH_REVISION_STEP = 'Check out the deployed revision';
const REFRESH_WORKFLOW = 'active-application-composition-refresh.yml';

/** Simulates an older revision and git clean both removing the local action, without touching the repository. */
const refreshPreservesNativeAction = (preserveScript: string, checkoutScript: string) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-refresh-vpn-action-'));
  const workspace = path.join(directory, 'workspace');
  const runnerTemp = path.join(directory, 'runner-temp');
  const actionDirectory = path.join(workspace, '.github', 'actions', 'zerops-vpn');
  const actionPath = path.join(actionDirectory, 'action.yml');
  const actionSource = readFileSync(
    new URL('../../../.github/actions/zerops-vpn/action.yml', import.meta.url),
    'utf-8',
  );
  try {
    mkdirSync(actionDirectory, { recursive: true });
    mkdirSync(runnerTemp);
    writeFileSync(actionPath, actionSource);
    const git = path.join(directory, 'git');
    writeFileSync(
      git,
      [
        FAKE_BASH_SHEBANG,
        '[[ -f "$RUNNER_TEMP/composition-workflow-actions/zerops-vpn.yml" ]] || exit 77',
        '[[ "$1" == checkout || "$1" == clean ]] || exit 78',
        'rm -rf -- "$GITHUB_WORKSPACE/.github/actions/zerops-vpn"',
      ].join('\n'),
    );
    chmodSync(git, 0o755);
    const environment = {
      DEPLOYED_SHA: 'older-deployed-revision',
      GITHUB_WORKSPACE: workspace,
      PATH: `${directory}:${STEP_PATH}`,
      RUNNER_TEMP: runnerTemp,
    };
    for (const script of [preserveScript, checkoutScript]) {
      execFileSync(VPN_TEST_BASH, ['-eo', 'pipefail', '-c', script], {
        cwd: workspace,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      });
    }
    return readFileSync(actionPath, 'utf-8') === actionSource;
  } catch {
    return false;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

it('preserves this workflow revision of the native VPN action before checkout and restores it after git clean', () => {
  const jobs = readVpnWorkflowJobs(REFRESH_WORKFLOW);
  for (const name of ['refresh-stage', 'refresh-production']) {
    const steps = jobs[name]?.steps ?? [];
    const preserve = steps.find((step) => step.name === REFRESH_VPN_PRESERVE_STEP);
    const checkout = steps.find((step) => step.name === REFRESH_REVISION_STEP);
    const connect = steps.find((step) => step.with?.operation === 'connect');
    expect(preserve?.if, name).toBe(checkout?.if);
    expect(checkout?.if, name).toBe(connect?.if);
    const stepNames = steps.map((step) => step.name);
    expect(stepNames.indexOf(REFRESH_VPN_PRESERVE_STEP), name).toBeLessThan(stepNames.indexOf(REFRESH_REVISION_STEP));
    expect(stepNames.indexOf(REFRESH_REVISION_STEP), name).toBeLessThan(stepNames.indexOf(connect?.name ?? ''));
    expect(refreshPreservesNativeAction(preserve?.run ?? 'exit 1', checkout?.run ?? 'exit 1'), name).toBe(true);
  }
});

it('checks DNS and TCP for both private PostgreSQL endpoints before admitting database operations', () => {
  expect(runNativeVpnScript(nativeVpnScript(VPN_DATABASE_STEP))).toEqual({
    calls: ['tcp=runtime-private:5432,timeout=3', 'tcp=admin-private:5433,timeout=3'],
    passed: true,
  });
  for (const host of ['runtime-private', 'admin-private']) {
    const result = runNativeVpnScript(nativeVpnScript(VPN_DATABASE_STEP), { VPN_UNREACHABLE_HOST: host });
    expect(result.passed).toBe(false);
    expect(result.calls.filter((call) => call.includes(host))).toHaveLength(2);
  }
});

it('rejects malformed runtime or administrative database URIs before a private socket attempt', () => {
  const verify = nativeVpnScript(VPN_DATABASE_STEP);
  for (const environment of [
    { DATABASE_URL: '' },
    { DATABASE_URL: 'https://runtime-private/ontos' },
    { DATABASE_URL: 'postgres://runtime-private:not-a-port/ontos' },
  ]) {
    expect(runNativeVpnScript(verify, environment)).toEqual({ calls: [], passed: false });
  }
  const missingAdmin = runNativeVpnScript(verify, { DATABASE_ADMIN_URL: '' });
  expect(missingAdmin).toEqual({ calls: ['tcp=runtime-private:5432,timeout=3'], passed: false });
});

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
    ZEROPS_PROJECT_ID: ZEROPS_PROJECT_EXPRESSION,
    ZEROPS_TOKEN: ZEROPS_TOKEN_EXPRESSION,
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
  const plan = jobs[DEPLOY_PLAN_JOB];
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
  expect(migrations.environment).toEqual({ deployment: false, name: PROTECTED_DEPLOY_ENVIRONMENT });
  expect(zerops.environment).toBe(DEPLOY_ENVIRONMENT_OUTPUT);
  // Nothing changes on Zerops before the gates pass or prove skipped on the merge queue's proof.
  expect(migrations.needs).toEqual(['workspace-gates', DEPLOY_TARGET_JOB, DEPLOY_PLAN_JOB, INITIAL_CUTOVER_GUARD_JOB]);
  expect(migrations.if).toBe(
    expression(
      "!cancelled() && needs.workspace-gates.result == 'success' && needs.deploy-plan.result == 'success' && needs.initial-composition-cutover-guard.result == 'success'",
    ),
  );
  expect(zerops.needs).toEqual([DEPLOY_TARGET_JOB, DEPLOY_PLAN_JOB, MIGRATIONS_JOB]);
  expect(zerops.if).toBe(expression(`!cancelled() && needs.${MIGRATIONS_JOB}.result == 'success'`));
  // Publication shares the environment lock; migrations lock on their own after the initial guard.
  expect(zerops.concurrency.group).toBe(`zerops-${DEPLOY_ENVIRONMENT_EXPRESSION}`);
  expect(migrations.concurrency.group).toBe(`zerops-migrations-${DEPLOY_ENVIRONMENT_EXPRESSION}`);
  expect(plan.env.DEPLOY_TARGET).toBe(DEPLOY_TARGET_OUTPUT);
  expect(plan.env.OUTBOX_WORKER_MODE).toBe(OUTBOX_WORKER_MODE_OUTPUT);
  expect(zerops.env.DEPLOY_TARGET).toBe(DEPLOY_TARGET_OUTPUT);
  expect(zerops.env.OUTBOX_WORKER_MODE).toBe(OUTBOX_WORKER_MODE_OUTPUT);
  // Every service ID comes from the deploying environment's own variables.
  for (const [name, value] of Object.entries({ ...migrations.env, ...zerops.env }).filter(
    ([key]) => key.startsWith('ZEROPS_') && key !== 'ZEROPS_TOKEN',
  )) {
    expect(value).toBe(expression(`vars.${name}`));
  }
  expect(migrations.env.ZEROPS_TOKEN).toBe(ZEROPS_TOKEN_EXPRESSION);
  // Migrations and SpiceDB run alone, before the edge and the Zerops units; a plan without them only skips steps.
  const migrationSteps = new Map(migrations.steps.map((step) => [step.name, step]));
  expect(migrationSteps.get(DATABASE_MIGRATION_STEP)?.if).toBe("needs.deploy-plan.outputs.migrator == 'true'");
  expect(migrationSteps.get(SPICEDB_DEPLOYMENT_STEP)?.if).toBe("needs.deploy-plan.outputs.spicedb == 'true'");
  expect(migrations.env.INFRASTRUCTURE).toBe(
    expression("needs.deploy-plan.outputs.migrator == 'true' || needs.deploy-plan.outputs.spicedb == 'true'"),
  );
  expect(zerops.steps.map(({ name }) => name)).not.toContain(DATABASE_MIGRATION_STEP);
  expect(zerops.steps.map(({ name }) => name)).not.toContain(SPICEDB_DEPLOYMENT_STEP);
  const byName = new Map(plan.steps.map((step) => [step.name, step]));
  const planRun = byName.get('Generate topology-driven deployment impact plan')?.run;
  expect(byName.get("Resolve the environment's last successful deployment")?.run).toContain(
    DEPLOY_ENVIRONMENT_ARGUMENT,
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
  // One publisher admits the complete approved release after both providers finish.
  const publish = jobs['publish-edge-composition'];
  expect(publish.if).toBe(
    expression(
      "!cancelled() && needs.deploy-zerops.result == 'success' && needs.deploy-cloudflare.result == 'success' && needs.deploy-target.outputs.target == 'cloudflare'",
    ),
  );
  expect(publish.needs).toEqual(['deploy-target', 'deploy-zerops', EDGE_RELEASE_JOB]);
  expect(publish.environment).toEqual({ deployment: false, name: EDGE_ENVIRONMENT });
  expect(publish.env.DEPLOY_TARGET).toBe('cloudflare');
  expect(publish.env.OUTBOX_WORKER_MODE).toBe(OUTBOX_WORKER_MODE_OUTPUT);
  expect(publish.concurrency).toEqual({ 'cancel-in-progress': false, group: 'zerops-stage' });
  expect(publish.env.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL).toBe(
    expression('vars.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL'),
  );
  expect(publish.env.DATABASE_ADMIN_URL).toBe(DATABASE_ADMIN_EXPRESSION);
  expect(publish.env.COMPOSITION_CANDIDATE_FILE).toBe(
    '.composition-candidate/active-application-composition-candidate.json',
  );
  const candidateDownload = publish.steps.find(
    (step) =>
      step.uses?.startsWith('actions/download-artifact@') === true &&
      step.with?.name === COMPOSITION_CANDIDATE_ARTIFACT,
  );
  expect(candidateDownload?.with).toEqual({
    name: COMPOSITION_CANDIDATE_ARTIFACT,
    path: 'app/.composition-candidate',
  });
  const edgePublication = publish.steps.find(
    ({ name }) => name === 'Publish the complete observed release without restarting consumers',
  );
  expect(edgePublication?.run).toContain('publish --environment stage --candidate-file "$COMPOSITION_CANDIDATE_FILE"');
  const publicationStepNames = publish.steps.map((step) => step.name);
  const candidateIndex = publicationStepNames.indexOf(candidateDownload?.name ?? '');
  const publicationIndex = publicationStepNames.indexOf(edgePublication?.name ?? '');
  expect(candidateIndex).toBeGreaterThanOrEqual(0);
  expect(candidateIndex).toBeLessThan(publicationIndex);
  expect(
    publish.steps.filter((step) => step.run?.includes('active-composition:publish publish') === true),
  ).toHaveLength(1);
  expect(publish.steps.map((step) => step.run ?? '').join('\n')).not.toMatch(
    /restart-consumers|recover-consumers|put-edge-composition-snapshot/u,
  );
  // A new Worker is unobservable before deploy-cloudflare ships it, so deploy-zerops leaves publication to it.
  const zeropsSteps = new Map(zerops.steps.map((step) => [step.name, step]));
  expect(zeropsSteps.get('Publish the complete active Application Composition')?.if).toContain(
    "env.DEPLOY_TARGET == 'zerops'",
  );
  expect(zerops.steps.map((step) => step.run ?? '').join('\n')).not.toMatch(/restart-consumers|recover-consumers/u);
});

it('requires first-cutover provider quiescence before incompatible migrations', () => {
  const { jobs } = readTargetWorkflow();
  const guard = jobs[INITIAL_CUTOVER_GUARD_JOB];
  const publish = jobs['publish-edge-composition'];
  expect(guard.needs).toEqual(['workspace-gates', DEPLOY_TARGET_JOB, DEPLOY_PLAN_JOB, EDGE_PLAN_JOB]);
  expect(guard.if).toBe(
    expression(
      "!cancelled() && needs.workspace-gates.result == 'success' && needs.deploy-plan.result == 'success' && (needs.deploy-target.outputs.target == 'zerops' || needs.edge-plan.result == 'success')",
    ),
  );
  expect(guard.environment).toEqual({ deployment: false, name: PROTECTED_DEPLOY_ENVIRONMENT });
  expect(guard.permissions.actions).toBe('read');
  expect(guard.concurrency).toEqual({
    'cancel-in-progress': false,
    group: `zerops-${DEPLOY_ENVIRONMENT_EXPRESSION}`,
  });
  for (const binding of [
    'ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL',
    'DATABASE_URL',
    'DATABASE_ADMIN_URL',
    'CLOUDFLARE_API_TOKEN',
  ] as const) {
    expect(guard.env[binding]).toBe(publish.env[binding]);
  }
  expect(guard.env.ONTOS_INITIAL_COMPOSITION_EXECUTION_INVENTORY_FILE).toBe(
    expression('vars.ONTOS_INITIAL_COMPOSITION_EXECUTION_INVENTORY_FILE'),
  );
  expect(guard.env.ONTOS_INITIAL_COMPOSITION_CUTOVER_RECEIPT_FILE).toBe(
    '.initial-composition-cutover/initial-composition-cutover-receipt.json',
  );
  const receipt = guard.steps.find((step) => step.with?.name === INITIAL_CUTOVER_RECEIPT_ARTIFACT);
  expect(receipt?.if).toBe("vars.ONTOS_INITIAL_COMPOSITION_CUTOVER_RUN_ID != ''");
  expect(receipt?.uses).toMatch(/^actions\/download-artifact@/u);
  expect(receipt?.with).toEqual({
    'github-token': expression('github.token'),
    name: INITIAL_CUTOVER_RECEIPT_ARTIFACT,
    path: 'app/.initial-composition-cutover',
    'run-id': expression('vars.ONTOS_INITIAL_COMPOSITION_CUTOVER_RUN_ID'),
  });
  const verification = guard.steps.filter(
    (step) => step.run?.includes('active-composition:publish verify-initial-cutover') === true,
  );
  expect(verification).toHaveLength(1);
  expect(verification[0]?.run).toContain('verify-initial-cutover --environment "$DEPLOY_ENVIRONMENT"');
  expect(guard.steps.map((step) => step.name).indexOf(receipt?.name ?? '')).toBeLessThan(
    guard.steps.map((step) => step.name).indexOf(verification[0]?.name ?? ''),
  );
});

it('captures an admitted retained Shell before migrations and archives its exact pins', () => {
  const { jobs } = readTargetWorkflow();
  const guard = jobs[INITIAL_CUTOVER_GUARD_JOB];
  const edge = jobs[EDGE_RELEASE_JOB];
  const captures = guard.steps.filter(
    (step) => step.run?.includes('active-composition:publish capture-approved-snapshot') === true,
  );
  expect(captures).toHaveLength(1);
  const [capture] = captures;
  expect(capture?.['working-directory']).toBe('app');
  expect(capture?.run).toContain(DEPLOY_ENVIRONMENT_ARGUMENT);
  expect(capture?.run).toContain('--snapshot-file "$RUNNER_TEMP/retained-approved-shell-snapshot.json"');
  expect(capture?.if).toContain("needs.deploy-target.outputs.target == 'cloudflare'");
  expect(capture?.if).toContain("!contains(fromJSON(needs.edge-plan.outputs.cloudflare).*.id, 'shell-super-app')");

  const uploads = guard.steps.filter((step) => step.with?.name === RETAINED_APPROVED_SHELL_ARTIFACT);
  expect(uploads).toHaveLength(1);
  const [upload] = uploads;
  expect(upload?.uses).toMatch(/^actions\/upload-artifact@/u);
  expect(upload?.if).toBe(capture?.if);
  expect(upload?.with).toMatchObject({
    'if-no-files-found': 'error',
    name: RETAINED_APPROVED_SHELL_ARTIFACT,
    path: `${RUNNER_TEMP_EXPRESSION}/retained-approved-shell-snapshot.json`,
  });
  const guardStepNames = guard.steps.map((step) => step.name);
  const captureIndex = guardStepNames.indexOf(capture?.name ?? '');
  const uploadIndex = guardStepNames.indexOf(upload?.name ?? '');
  expect(captureIndex).toBeGreaterThanOrEqual(0);
  expect(captureIndex).toBeLessThan(uploadIndex);
  // Job dependencies keep both admission and durable artifact upload ahead of incompatible schema writes.
  expect(jobs[MIGRATIONS_JOB].needs).toContain(INITIAL_CUTOVER_GUARD_JOB);
  expect(edge.needs).toContain(MIGRATIONS_JOB);
  expect(edge.steps.map((step) => step.run ?? '').join('\n')).not.toContain('capture-approved-snapshot');
});

it('hands only the same-run captured Shell artifact to candidate assembly after migrations', () => {
  const edge = readTargetWorkflow().jobs[EDGE_RELEASE_JOB];
  const downloads = edge.steps.filter((step) => step.with?.name === RETAINED_APPROVED_SHELL_ARTIFACT);
  expect(downloads).toHaveLength(1);
  const [download] = downloads;
  expect(download?.uses).toMatch(/^actions\/download-artifact@/u);
  expect(download?.if).toContain("!contains(fromJSON(needs.edge-plan.outputs.cloudflare).*.id, 'shell-super-app')");
  expect(download?.with).toEqual({
    name: RETAINED_APPROVED_SHELL_ARTIFACT,
    path: `${RUNNER_TEMP_EXPRESSION}/retained-approved-shell`,
  });
  // Omitting run-id intentionally restricts the handoff to this deployment, even after a delayed migration.
  expect(download?.with).not.toHaveProperty('run-id');
  const candidate = edge.steps.find((step) => step.id === 'candidate');
  const edgeStepNames = edge.steps.map((step) => step.name);
  const downloadIndex = edgeStepNames.indexOf(download?.name ?? '');
  expect(downloadIndex).toBeGreaterThanOrEqual(0);
  expect(downloadIndex).toBeLessThan(edgeStepNames.indexOf(candidate?.name ?? ''));
  expect(candidate?.env).not.toHaveProperty('DATABASE_URL');
  expect(candidate?.env).not.toHaveProperty('DATABASE_ADMIN_URL');
  expect(candidate?.run).not.toMatch(/capture-approved-snapshot|jq[^\n]*>[^\n]*shell-super-app\.json/u);
  expect(candidate?.run).toContain(
    '--retained-shell-snapshot-file "$RUNNER_TEMP/retained-approved-shell/retained-approved-shell-snapshot.json"',
  );
});

/** Execute the genuine workflow selection script without any provider, database, or release mutation. */
const candidateShellArguments = (script: string, shellSelected: boolean): readonly string[] => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-retained-shell-handoff-'));
  const binaryDirectory = path.join(directory, 'bin');
  const argumentsFile = path.join(directory, 'arguments');
  try {
    mkdirSync(binaryDirectory);
    const git = path.join(binaryDirectory, 'git');
    const mise = path.join(binaryDirectory, 'mise');
    writeFileSync(git, '#!/bin/sh\n[ "$1" = ls-files ] && [ "$2" = --error-unmatch ]\n');
    writeFileSync(mise, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$ARGUMENTS_FILE"\n');
    chmodSync(git, 0o700);
    chmodSync(mise, 0o700);
    writeFileSync(path.join(directory, 'intent.json'), JSON.stringify({ modules: [{ appId: 'pricing' }] }));
    execFileSync('/bin/bash', ['-eo', 'pipefail', '-c', script], {
      cwd: directory,
      env: {
        ARGUMENTS_FILE: argumentsFile,
        COMPOSITION_INTENT_FILE: 'intent.json',
        PATH: `${binaryDirectory}:${STEP_PATH}`,
        RUNNER_TEMP: directory,
        SHELL_SELECTED: String(shellSelected),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return readFileSync(argumentsFile, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((argument) => argument.replaceAll(directory, '$RUNNER_TEMP'));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

it('selects a genuine Shell receipt or the admitted retained snapshot without fabricating a replacement receipt', () => {
  const candidate = readTargetWorkflow().jobs[EDGE_RELEASE_JOB].steps.find((step) => step.id === 'candidate');
  expect(candidate?.env?.SHELL_SELECTED).toBe(
    expression("contains(fromJSON(needs.edge-plan.outputs.cloudflare).*.id, 'shell-super-app')"),
  );
  const retained = candidateShellArguments(candidate?.run ?? 'exit 1', false);
  expect(retained).toContain('--retained-shell-snapshot-file');
  expect(retained).toContain('$RUNNER_TEMP/retained-approved-shell/retained-approved-shell-snapshot.json');
  expect(retained).not.toContain('--shell-receipt-file');
  expect(retained).toContain('$RUNNER_TEMP/application-release-receipts/pricing.json');
  // A selected Shell with no generated receipt still selects the receipt path, so the real pure-file CLI fails closed.
  const selected = candidateShellArguments(candidate?.run ?? 'exit 1', true);
  expect(selected).toContain('--shell-receipt-file');
  expect(selected).toContain('$RUNNER_TEMP/application-release-receipts/shell-super-app.json');
  expect(selected).not.toContain('--retained-shell-snapshot-file');
});

it('downloads the verified first-cutover receipt onto the Node deployment runner before provider writes', () => {
  const { jobs } = readTargetWorkflow();
  const zerops = jobs['deploy-zerops'];
  const guard = jobs[INITIAL_CUTOVER_GUARD_JOB];
  expect(zerops.needs).toContain(MIGRATIONS_JOB);
  expect(jobs[MIGRATIONS_JOB].needs).toContain(INITIAL_CUTOVER_GUARD_JOB);
  expect(zerops.permissions.actions).toBe('read');
  for (const binding of [
    'ONTOS_INITIAL_COMPOSITION_EXECUTION_INVENTORY_FILE',
    'ONTOS_INITIAL_COMPOSITION_CUTOVER_RECEIPT_FILE',
  ] as const) {
    expect(zerops.env[binding]).toBe(guard.env[binding]);
  }
  const receipt = zerops.steps.find((step) => step.with?.name === INITIAL_CUTOVER_RECEIPT_ARTIFACT);
  const guardReceipt = guard.steps.find((step) => step.with?.name === INITIAL_CUTOVER_RECEIPT_ARTIFACT);
  expect(receipt?.uses).toMatch(/^actions\/download-artifact@/u);
  expect(receipt?.if).toBe(
    "needs.deploy-plan.outputs.any == 'true' && env.DEPLOY_TARGET == 'zerops' && vars.ONTOS_INITIAL_COMPOSITION_CUTOVER_RUN_ID != ''",
  );
  expect(receipt?.with).toEqual(guardReceipt?.with);
  expect(path.posix.join('app', zerops.env.ONTOS_INITIAL_COMPOSITION_CUTOVER_RECEIPT_FILE ?? '')).toBe(
    path.posix.join(String(receipt?.with?.path), `${INITIAL_CUTOVER_RECEIPT_ARTIFACT}.json`),
  );
  const zeropsStepNames = zerops.steps.map((step) => step.name);
  const receiptIndex = zeropsStepNames.indexOf(receipt?.name ?? '');
  expect(receiptIndex).toBeGreaterThanOrEqual(0);
  for (const [index, step] of zerops.steps.entries()) {
    if (step.run?.includes('push-zerops-units.sh') === true) {
      expect(receiptIndex).toBeLessThan(index);
    }
  }
  const publication = zerops.steps.filter((step) => step.run?.includes('active-composition:publish publish') === true);
  expect(publication).toHaveLength(1);
  expect(publication[0]?.['working-directory']).toBe('app');
  expect(publication[0]?.run).toContain(DEPLOY_ENVIRONMENT_ARGUMENT);
  expect(receiptIndex).toBeLessThan(zeropsStepNames.indexOf(publication[0]?.name ?? ''));
});

it('delegates migration and migrator retirement to one native publication session', () => {
  const { jobs } = readTargetWorkflow();
  const migrations = jobs[MIGRATIONS_JOB];
  const guard = jobs[INITIAL_CUTOVER_GUARD_JOB];
  const migrationCommands = migrations.steps.filter(
    (step) => step.run?.includes('active-composition:publish migrate') === true,
  );
  expect(migrationCommands).toHaveLength(1);
  const [migration] = migrationCommands;
  expect(migration?.name).toBe(DATABASE_MIGRATION_STEP);
  expect(migration?.id).toBe('migrator');
  expect(migration?.if).toBe("needs.deploy-plan.outputs.migrator == 'true'");
  expect(migration?.['working-directory']).toBe('app');
  expect(migration?.run?.replaceAll(/\s+/gu, ' ')).toBe(
    'mise exec -- pnpm active-composition:publish migrate --environment "$DEPLOY_ENVIRONMENT" --zerops-yaml-path "$ZEROPS_YAML_PATH" --project-id "$ZEROPS_PROJECT_ID" --service-id "$ZEROPS_MIGRATOR_SERVICE_ID" --version-name "$GITHUB_SHA"',
  );
  for (const binding of [
    'ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL',
    'ONTOS_INITIAL_COMPOSITION_EXECUTION_INVENTORY_FILE',
    'ONTOS_INITIAL_COMPOSITION_CUTOVER_RECEIPT_FILE',
    'DATABASE_URL',
    'DATABASE_ADMIN_URL',
    'CLOUDFLARE_API_TOKEN',
  ] as const) {
    expect(migrations.env[binding]).toBe(guard.env[binding]);
  }
  const receipt = migrations.steps.find((step) => step.with?.name === INITIAL_CUTOVER_RECEIPT_ARTIFACT);
  expect(migrations.permissions.actions).toBe('read');
  expect(receipt?.uses).toMatch(/^actions\/download-artifact@/u);
  expect(receipt?.if).toBe(
    "needs.deploy-plan.outputs.migrator == 'true' && vars.ONTOS_INITIAL_COMPOSITION_CUTOVER_RUN_ID != ''",
  );
  expect(receipt?.with).toEqual({
    'github-token': expression('github.token'),
    name: INITIAL_CUTOVER_RECEIPT_ARTIFACT,
    path: 'app/.initial-composition-cutover',
    'run-id': expression('vars.ONTOS_INITIAL_COMPOSITION_CUTOVER_RUN_ID'),
  });
  const receiptIndex = migrations.steps.findIndex(({ name }) => name === receipt?.name);
  const migrationIndex = migrations.steps.findIndex(({ name }) => name === migration?.name);
  expect(receiptIndex).toBeGreaterThanOrEqual(0);
  expect(receiptIndex).toBeLessThan(migrationIndex);
  const providerMutations = migrations.steps.filter((step) => /zcli (?:push|service stop)\b/u.test(step.run ?? ''));
  expect(providerMutations.map((step) => step.name)).toEqual([SPICEDB_DEPLOYMENT_STEP]);
  expect(providerMutations[0]?.run).not.toContain('ZEROPS_MIGRATOR_SERVICE_ID');
});

const RefreshPublicationJobSchema = Schema.Struct({
  concurrency: Schema.Struct({ 'cancel-in-progress': Schema.Boolean, group: Schema.String }),
  env: Schema.Record(Schema.String, Schema.String),
  environment: Schema.Struct({ deployment: Schema.Boolean, name: Schema.String }),
  steps: Schema.Array(PublicationWorkflowStepSchema),
});
const RefreshPublicationWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    'refresh-production': RefreshPublicationJobSchema,
    'refresh-stage': RefreshPublicationJobSchema,
  }),
});

const InitialCutoverWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    quiesce: Schema.Struct({
      concurrency: Schema.Struct({ 'cancel-in-progress': Schema.Boolean, group: Schema.String }),
      env: Schema.Record(Schema.String, Schema.String),
      environment: Schema.Struct({ deployment: Schema.Boolean, name: Schema.String }),
      steps: Schema.Array(PublicationWorkflowStepSchema),
    }),
  }),
});
const INITIAL_CUTOVER_WORKFLOW = 'initial-composition-cutover.yml';
const readInitialCutoverJob = () =>
  Schema.decodeUnknownSync(InitialCutoverWorkflowSchema)(
    parse(readFileSync(new URL(`../../../.github/workflows/${INITIAL_CUTOVER_WORKFLOW}`, import.meta.url), 'utf-8')),
  ).jobs.quiesce;
const readRefreshPublicationJobs = () =>
  Schema.decodeUnknownSync(RefreshPublicationWorkflowSchema)(
    parse(readFileSync(new URL(`../../../.github/workflows/${REFRESH_WORKFLOW}`, import.meta.url), 'utf-8')),
  ).jobs;
const CONFIGURE_SOURCE_COMMAND = 'mise exec -- pnpm active-composition:publish configure-source';
const COMPOSITION_SOURCE_EXPRESSION = expression('vars.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL');
const CLOUDFLARE_TOKEN_EXPRESSION = expression('secrets.CLOUDFLARE_API_TOKEN');

it('selects protected edge credentials while preserving the logical stage, production fallback and publication locks', () => {
  const quiesce = readInitialCutoverJob();
  const { jobs } = readTargetWorkflow();
  const refresh = readRefreshPublicationJobs();
  expect(quiesce.environment).toEqual({
    deployment: false,
    name: expression("inputs.environment == 'stage' && 'stage-edge' || inputs.environment"),
  });
  expect(quiesce.env.DEPLOY_ENVIRONMENT).toBe(expression('inputs.environment'));
  expect(quiesce.concurrency).toEqual({
    'cancel-in-progress': false,
    group: `zerops-${expression('inputs.environment')}`,
  });
  for (const job of [jobs[INITIAL_CUTOVER_GUARD_JOB], jobs[MIGRATIONS_JOB]]) {
    expect(job.environment).toEqual({ deployment: false, name: PROTECTED_DEPLOY_ENVIRONMENT });
    expect(job.env.DEPLOY_ENVIRONMENT).toBe(DEPLOY_ENVIRONMENT_OUTPUT);
    expect(job.env.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL).toBe(COMPOSITION_SOURCE_EXPRESSION);
    expect(job.env.CLOUDFLARE_API_TOKEN).toBe(CLOUDFLARE_TOKEN_EXPRESSION);
    expect(job.env.ZEROPS_TOKEN).toBe(ZEROPS_TOKEN_EXPRESSION);
  }
  expect(jobs[EDGE_PUBLISH_JOB].environment).toEqual({ deployment: false, name: EDGE_ENVIRONMENT });
  expect(jobs[EDGE_PUBLISH_JOB].concurrency.group).toBe(EDGE_PUBLICATION_LOCK);
  expect(refresh['refresh-stage'].environment).toEqual({ deployment: false, name: EDGE_ENVIRONMENT });
  expect(refresh['refresh-stage'].env.DEPLOY_TARGET).toBe('cloudflare');
  expect(refresh['refresh-stage'].env.OUTBOX_WORKER_MODE).toBe(expression('vars.OUTBOX_WORKER_MODE'));
  expect(refresh['refresh-stage'].concurrency.group).toBe(EDGE_PUBLICATION_LOCK);
  expect(refresh['refresh-production'].environment).toEqual({ deployment: false, name: 'production' });
  expect(refresh['refresh-production'].env.DEPLOY_TARGET).toBe('zerops');
  expect(refresh['refresh-production'].concurrency.group).toBe('zerops-production');
  for (const job of [jobs[EDGE_PUBLISH_JOB], refresh['refresh-stage'], refresh['refresh-production']]) {
    expect(job.env.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL).toBe(COMPOSITION_SOURCE_EXPRESSION);
    expect(job.env.CLOUDFLARE_API_TOKEN).toBe(CLOUDFLARE_TOKEN_EXPRESSION);
    expect(job.steps.map((step) => step.run ?? '').join('\n')).not.toContain('configure-source');
  }
});

it('archives successful native retirement before configuring the protected source once with environment-only credentials', () => {
  const quiesce = readInitialCutoverJob();
  const retirement = quiesce.steps.find((step) => step.run?.includes('quiesce-initial-cutover') === true);
  const archive = quiesce.steps.find((step) => step.with?.name === INITIAL_CUTOVER_RECEIPT_ARTIFACT);
  const configurations = quiesce.steps.filter((step) => step.run?.trim() === CONFIGURE_SOURCE_COMMAND);
  expect(configurations).toHaveLength(1);
  const [configuration] = configurations;
  const names = quiesce.steps.map((step) => step.name);
  const retirementIndex = names.indexOf(retirement?.name ?? '');
  expect(retirementIndex).toBeGreaterThanOrEqual(0);
  expect(names.indexOf(archive?.name ?? '')).toBe(retirementIndex + 1);
  expect(names.indexOf(configuration?.name ?? '')).toBe(retirementIndex + 2);
  expect(retirement?.run).toContain(DEPLOY_ENVIRONMENT_ARGUMENT);
  expect(retirement?.env?.CUTOVER_RECEIPT_FILE).toBe(
    `${RUNNER_TEMP_EXPRESSION}/initial-composition-cutover-receipt.json`,
  );
  expect(archive?.uses).toMatch(/^actions\/upload-artifact@/u);
  expect(archive?.with).toMatchObject({
    'if-no-files-found': 'error',
    name: INITIAL_CUTOVER_RECEIPT_ARTIFACT,
    path: `${RUNNER_TEMP_EXPRESSION}/initial-composition-cutover-receipt.json`,
  });
  for (const step of [retirement, archive, configuration]) {
    expect(step?.if).toBeUndefined();
  }
  expect(configuration?.['working-directory']).toBe('app');
  expect(configuration?.env).toEqual({
    ONTOS_ACTIVE_APPLICATION_COMPOSITION_READ_TOKEN: CLOUDFLARE_TOKEN_EXPRESSION,
    ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: COMPOSITION_SOURCE_EXPRESSION,
    ZEROPS_PROJECT_ID: ZEROPS_PROJECT_EXPRESSION,
    ZEROPS_TOKEN: ZEROPS_TOKEN_EXPRESSION,
  });
  expect(configuration?.run).not.toContain('--environment');
  expect(quiesce.env.CLOUDFLARE_API_TOKEN).toBe(CLOUDFLARE_TOKEN_EXPRESSION);
  expect(quiesce.env.ZEROPS_TOKEN).toBe(ZEROPS_TOKEN_EXPRESSION);
});

it('renews the approved release through the same authority and publication lock as deployment', () => {
  const publish = readTargetWorkflow().jobs['publish-edge-composition'];
  const { jobs } = Schema.decodeUnknownSync(RefreshPublicationWorkflowSchema)(
    parse(
      readFileSync(
        new URL('../../../.github/workflows/active-application-composition-refresh.yml', import.meta.url),
        'utf-8',
      ),
    ),
  );
  for (const environment of ['stage', 'production'] as const) {
    const refresh = jobs[`refresh-${environment}`];
    expect(refresh.concurrency).toEqual({ 'cancel-in-progress': false, group: `zerops-${environment}` });
    expect(refresh.environment).toEqual({
      deployment: false,
      name: environment === 'stage' ? EDGE_ENVIRONMENT : environment,
    });
    for (const binding of [
      'ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL',
      'DATABASE_URL',
      'DATABASE_ADMIN_URL',
      'CLOUDFLARE_API_TOKEN',
    ] as const) {
      expect(refresh.env[binding]).toBe(publish.env[binding]);
    }
    const renewals = refresh.steps.filter((step) => step.run?.includes('active-composition:publish refresh') === true);
    expect(renewals).toHaveLength(1);
    expect(renewals[0]?.run?.replaceAll(/\s+/gu, ' ')).toContain(`refresh --environment ${environment}`);
    expect(refresh.steps.map((step) => step.run ?? '').join('\n')).not.toMatch(
      /restart-consumers|recover-consumers|put-edge-composition-snapshot/u,
    );
  }
  expect(jobs['refresh-stage'].concurrency).toEqual(publish.concurrency);
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
  expect(afterGates).toContain(EDGE_RELEASE_JOB);
  expect(afterGates).toContain('publish-edge-composition');
  expect(jobs).not.toHaveProperty('sync-edge-composition');
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

it('proves each target on its own shards only after every other shard of the target uploaded its outputs', () => {
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
