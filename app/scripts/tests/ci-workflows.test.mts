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

import { CiTemplatesSchema, integrationPhases } from '../plan-ci-checks.mts';

const BASELINE_CAPTURE_JOB = 'capture-application-baseline';
const DEPLOY_PLAN_JOB = 'deploy-plan';

const CF_TOKEN_SOURCE = 'secrets.CLOUDFLARE_API_TOKEN';
const COMPOSITION_URL_SOURCE = 'vars.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL';
const SHELL_APP_ID = 'shell-super-app';
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

/** The GitHub environment that holds the Cloudflare account token. */
const EDGE_ENVIRONMENT = 'stage-edge';
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
const SERVICE_SETUP_JOB = 'service-integration-setup';
const WORKSPACE_GATE_JOB = 'workspace-gate';

/** Expand only matrix references for the full-run contract tests; separately test the actual planner. */
const readGateWorkflow = () => {
  const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
  const workflow = record(parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8')));
  const jobs = { ...record(workflow.jobs) };
  const templates = Schema.decodeUnknownSync(Schema.fromJsonString(CiTemplatesSchema))(
    readFileSync(new URL('../ci-matrices.json', import.meta.url), 'utf-8'),
  );
  const phases = integrationPhases(templates.integration);
  const matrices = { ...templates, integration: phases.work, integrationSetup: phases.prerequisites };
  for (const [job, key] of [
    [WORKSPACE_GATE_JOB, 'source'],
    [WORKSPACE_UNIT_JOB, 'unit'],
    [SERVICE_INTEGRATION_JOB, 'integration'],
    [SERVICE_SETUP_JOB, 'integrationSetup'],
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
const INSTALL_APP_STEP = 'Install the app workspace';
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
const REVIEWED_RELEASE_INTENT_EXPRESSION = expression(
  "vars.ONTOS_APPLICATION_COMPOSITION_CANDIDATE_FILE || 'topology/application-release-intent.json'",
);
const STAGE_REFRESH_ENVIRONMENT_EXPRESSION = expression(
  "needs.stage-target.outputs.target == 'cloudflare' && 'stage-edge' || 'stage'",
);

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
const INITIAL_CUTOVER_GUARD_JOB = 'initial-composition-cutover-guard';

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
/** The artifact that carries ci-plan's exact changed-path list to the format and lint gate. */
const CHANGED_PATHS_ARTIFACT = 'ci-changed-paths';
const SCRIPTS_TEST_COMMAND = 'pnpm test:scripts';
const UNPACK_NATIVE_ARTIFACTS_SCRIPT = 'bash scripts/unpack-unit-build-outputs.sh';
const UNPACK_NATIVE_ARTIFACTS_COMMAND = `${UNPACK_NATIVE_ARTIFACTS_SCRIPT} "$RUNNER_TEMP/native-composition-units" .output`;

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

const readEdgeDeployJobs = () => Schema.decodeUnknownSync(EdgeDeployWorkflowSchema)(readGateWorkflow()).jobs;

it('retains configuration checks for the disabled Cloudflare deployment', () => {
  const jobs = readEdgeDeployJobs();
  const readiness = jobs['edge-deploy-readiness'];
  // Workers deployment is retired, even if its old account and credentials remain configured.
  expect(readiness.if).toBe(expression('false'));
  // Reading `stage-edge` secrets for the check must not add an entry to its deployment history.
  expect(readiness.environment).toEqual({ deployment: false, name: EDGE_ENVIRONMENT });
  const check = readiness.steps.find((step) => step.id === 'configuration');
  expect(readiness.steps.filter((step) => step.env?.CLOUDFLARE_API_TOKEN !== undefined)).toEqual([check]);
  expect(check?.env).toEqual({
    CLOUDFLARE_ACCOUNT_ID: expression('vars.CLOUDFLARE_ACCOUNT_ID'),
    CLOUDFLARE_API_TOKEN: expression(CF_TOKEN_SOURCE),
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
  expect(runStep(check?.run ?? 'exit 1', { DEPLOY_TARGET: 'zerops' })).toEqual({
    assets_configured: 'false',
    configured: 'false',
    workers_dev_subdomain: '',
  });
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
  expect(missingBuildVariables({ buildEnvironment: {}, units: ['commerce-customer-context', SHELL_APP_ID] })).toEqual([
    'ULTRAMODERN_MF_DEV_ORIGIN',
    'ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID',
    'ULTRAMODERN_CLOUDFLARE_PARTY_REGISTRY_HYPERDRIVE_ID',
    'ULTRAMODERN_CLOUDFLARE_GATEWAY_ISSUER_HYPERDRIVE_ID',
    'ULTRAMODERN_CLOUDFLARE_SPICEDB_VPC_SERVICE_ID',
    'ULTRAMODERN_CLOUDFLARE_COMPOSITION_KV_ID',
    'ULTRAMODERN_PUBLIC_URL_COMMERCE_CUSTOMER_CONTEXT',
    'ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP',
  ]);
  expect(
    missingBuildVariables({
      buildEnvironment: {
        ULTRAMODERN_CLOUDFLARE_COMPOSITION_KV_ID: 'composition-kv-id',
        ULTRAMODERN_CLOUDFLARE_GATEWAY_ISSUER_HYPERDRIVE_ID: 'gateway-issuer-hyperdrive-id',
        ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID: 'hyperdrive-id',
        ULTRAMODERN_CLOUDFLARE_PARTY_REGISTRY_HYPERDRIVE_ID: 'party-registry-hyperdrive-id',
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
          ULTRAMODERN_CLOUDFLARE_GATEWAY_ISSUER_HYPERDRIVE_ID: 'test-gateway-issuer-hyperdrive',
          ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID: 'test-hyperdrive',
          ULTRAMODERN_CLOUDFLARE_PARTY_REGISTRY_HYPERDRIVE_ID: 'test-party-registry-hyperdrive',
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
    expect(resolve(configured)).toEqual({
      assets_configured: 'true',
      configured: 'true',
      workers_dev_subdomain: 'workers-subdomain',
    });
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
  expect(plan.needs).toEqual([DEPLOY_TARGET_JOB, EDGE_READINESS_JOB, BASELINE_CAPTURE_JOB, DEPLOY_PLAN_JOB]);
  expect(plan.if).toContain("needs.edge-deploy-readiness.outputs.configured == 'true'");
  expect(plan.if).toContain("needs.capture-application-baseline.result == 'success'");
  expect(plan.environment).toEqual({ deployment: false, name: EDGE_ENVIRONMENT });
  expect(builds.needs).toEqual([EDGE_PLAN_JOB]);
  expect(builds.environment).toBeUndefined();
  expect(builds.strategy.matrix.unit).toBe(expression('fromJSON(needs.edge-plan.outputs.cloudflare)'));
  expect(builds.strategy['fail-fast']).toBe(true);
  expect(builds.if).toBe(
    expression("!cancelled() && needs.edge-plan.result == 'success' && needs.edge-plan.outputs.cloudflare != '[]'"),
  );
  expect(edge.needs).toEqual([
    DEPLOY_TARGET_JOB,
    INITIAL_CUTOVER_GUARD_JOB,
    EDGE_PLAN_JOB,
    EDGE_BUILD_JOB,
    BASELINE_CAPTURE_JOB,
  ]);
  expect(edge.if).toBe(
    expression(
      "!cancelled() && needs.initial-composition-cutover-guard.result == 'success' && needs.edge-plan.result == 'success' && (needs.edge-build.result == 'success' || (needs.edge-build.result == 'skipped' && needs.edge-plan.outputs.cloudflare == '[]'))",
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
    ULTRAMODERN_SOURCE_REVISION: CURRENT_SOURCE_REVISION,
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

const COMPOSITION_CANDIDATE_ARTIFACT = 'prepared-application-release';
const INITIAL_CUTOVER_RECEIPT_ARTIFACT = 'initial-composition-cutover-receipt';
const DATABASE_MIGRATION_STEP = 'Run the exact migration prerequisite closure and verifiers';
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

const assertPublicationEvidenceFlags = (step: typeof PublicationWorkflowStepSchema.Type | undefined) => {
  for (const flag of ['--candidate-file', '--expected-composition-file', '--selection-file', '--intent-file']) {
    expect(step?.run).toContain(flag);
  }
};

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

const readTargetWorkflow = () => Schema.decodeUnknownSync(TargetWorkflowSchema)(readGateWorkflow());

const VpnWorkflowStepSchema = Schema.Struct({
  ...PublicationWorkflowStepSchema.fields,
  env: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number]))),
});
const VpnWorkflowJobsSchema = Schema.Struct({
  jobs: Schema.Record(Schema.String, Schema.Struct({ steps: Schema.optional(Schema.Array(VpnWorkflowStepSchema)) })),
});
const VpnWorkflowEntriesSchema = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      steps: Schema.optional(
        Schema.Array(
          Schema.Union([Schema.Struct({ parallel: Schema.Array(VpnWorkflowStepSchema) }), VpnWorkflowStepSchema]),
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
  'deploy-node-backends',
  'prepare-node-composition',
  EDGE_RELEASE_JOB,
  EDGE_PUBLISH_JOB,
  'finalize-edge-deployment',
] as const;

const PRIVATE_REFRESH_JOBS = ['refresh-stage', 'refresh-production'] as const;

const readVpnWorkflowJobs = (
  name: string,
  source = readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf-8'),
) => {
  const { jobs } = Schema.decodeUnknownSync(VpnWorkflowEntriesSchema)(parse(source));
  return Schema.decodeUnknownSync(VpnWorkflowJobsSchema)({
    jobs: Object.fromEntries(
      Object.entries(jobs).map(([jobName, job]) => {
        // Private network operations require ordered steps, not siblings in a parallel group.
        if ([...PRIVATE_DELIVERY_JOBS, ...PRIVATE_REFRESH_JOBS].some((privateJob) => privateJob === jobName)) {
          expect(
            job.steps?.some((step) => 'parallel' in step),
            jobName,
          ).not.toBe(true);
        }
        return [jobName, { steps: job.steps?.flatMap((step) => ('parallel' in step ? step.parallel : [step])) }];
      }),
    ),
  }).jobs;
};

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

it('rejects parallel private operations rather than inventing an order while reading them', () => {
  expect(() =>
    readVpnWorkflowJobs(
      GATES_WORKFLOW,
      'jobs:\n  deploy-zerops:\n    steps:\n      - parallel:\n          - name: Connect VPN\n          - name: Deploy private service\n',
    ),
  ).toThrow();
});

it('connects every private deployment and refresh runner through native Zerops VPN and always clears it', () => {
  const deploymentJobs = readVpnWorkflowJobs(GATES_WORKFLOW);
  const refreshJobs = readVpnWorkflowJobs('active-application-composition-refresh.yml');
  const jobs = [
    ...PRIVATE_DELIVERY_JOBS.map((name) => ({ name, steps: deploymentJobs[name]?.steps ?? [] })),
    ...PRIVATE_REFRESH_JOBS.map((name) => ({ name, steps: refreshJobs[name]?.steps ?? [] })),
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
      /active-composition:publish (?:verify-initial-cutover|capture-approved-snapshot|migrate|publish|refresh)\b|immutable-(?:application|shell)-release\.mts (?:deploy|ingress-deploy|node-assets|node-deploy)\b/u.test(
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
  expect(prepare?.run).toContain('npm install --global @zerops/zcli@1.1.3');
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
  expect(connected.calls[1]).toBe('native=vpn up --project-id test-project --mtu 1350');
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

it('preserves the production workflow revision of the native VPN action before checkout and restores it after git clean', () => {
  const jobs = readVpnWorkflowJobs(REFRESH_WORKFLOW);
  for (const name of ['refresh-production']) {
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

it('accepts only Zerops deployment and rejects the retired Cloudflare target in every environment', () => {
  const workflow = readTargetWorkflow();
  const { 'deploy-target': target } = workflow.jobs;
  // Stage deploys from demo/sales-crm, so main deploys nothing unless MAIN_DEPLOY_ENABLED turns it back on.
  // When enabled, pushes deploy stage and production deploys only on an explicit dispatch.
  expect(workflow.on.workflow_dispatch.inputs.environment).toEqual({
    default: 'stage',
    options: ['stage', 'production'],
  });
  expect(target.if).toBe(
    "vars.MAIN_DEPLOY_ENABLED == 'true' && inputs.force-ci-full != true && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main'",
  );
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
  // A stale target must fail before credential checks, not finish green without a deployment.
  for (const DEPLOY_ENVIRONMENT of ['stage', 'production']) {
    for (const credentials of [CONFIGURED, {}]) {
      expect(resolve({ ...credentials, ...HOST, DEPLOY_ENVIRONMENT, DEPLOY_TARGET: 'cloudflare' })).toBe('failed');
    }
  }
  expect(resolve({ ...CONFIGURED, ...HOST, DEPLOY_ENVIRONMENT: 'stage', DEPLOY_TARGET: 'workers' })).toBe('failed');
});

it('requires each configured environment to choose its Outbox Worker mode, independent of the deploy target', () => {
  const step = readTargetWorkflow().jobs['deploy-target'].steps.find(({ id }) => id === 'target');
  const resolve = (environment: Readonly<Record<string, string>>) => runStep(step?.run ?? 'exit 1', environment);
  // Both supported Outbox Worker modes remain available on Zerops.
  for (const [DEPLOY_TARGET, OUTBOX_WORKER_MODE] of [
    ['zerops', 'host'],
    ['zerops', 'dedicated'],
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
  expect(plan.needs).toEqual([DEPLOY_TARGET_JOB, EDGE_READINESS_JOB, BASELINE_CAPTURE_JOB]);
  // Only deploy-zerops records the environment's deployment, so a plan or migration before a failed deploy
  // never moves the diff base.
  expect(plan.environment).toEqual({ deployment: false, name: DEPLOY_ENVIRONMENT_OUTPUT });
  expect(migrations.environment).toEqual({ deployment: false, name: PROTECTED_DEPLOY_ENVIRONMENT });
  expect(zerops.environment).toBe(DEPLOY_ENVIRONMENT_OUTPUT);
  // Nothing changes on Zerops before the gates pass or prove skipped on the merge queue's proof.
  expect(migrations.needs).toEqual([
    'workspace-gates',
    DEPLOY_TARGET_JOB,
    DEPLOY_PLAN_JOB,
    INITIAL_CUTOVER_GUARD_JOB,
    EDGE_RELEASE_JOB,
    'prepare-node-composition',
  ]);
  expect(migrations.if).toContain("needs.workspace-gates.result == 'success'");
  expect(migrations.if).toContain("needs.initial-composition-cutover-guard.result == 'success'");
  expect(migrations.if).toContain("needs.deploy-cloudflare.result == 'success'");
  expect(migrations.if).toContain("needs.prepare-node-composition.result == 'success'");
  expect(zerops.needs).toEqual([DEPLOY_TARGET_JOB, DEPLOY_PLAN_JOB, MIGRATIONS_JOB, 'deploy-node-backends']);
  expect(zerops.if).toContain(`needs.${MIGRATIONS_JOB}.result == 'success'`);
  expect(zerops.if).toContain("needs.deploy-node-backends.result == 'success'");
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
  expect(migrationSteps.get(DATABASE_MIGRATION_STEP)?.if).toBeUndefined();
  expect(migrationSteps.get(SPICEDB_DEPLOYMENT_STEP)?.if).toBe("needs.deploy-plan.outputs.spicedb == 'true'");
  expect(migrations.env.INFRASTRUCTURE).toBeUndefined();
  expect(zerops.steps.map(({ name }) => name)).not.toContain(DATABASE_MIGRATION_STEP);
  expect(zerops.steps.map(({ name }) => name)).not.toContain(SPICEDB_DEPLOYMENT_STEP);
  const byName = new Map(plan.steps.map((step) => [step.name, step]));
  const planRun = byName.get('Generate topology-driven deployment impact plan')?.run;
  expect(byName.get("Resolve the environment's last successful deployment")?.run).toContain(
    DEPLOY_ENVIRONMENT_ARGUMENT,
  );
  // The plan carries no authorization promotion gate: v2 replaced the rollout contract (O62).
  expect(planRun).not.toContain('--authorization-environment');
  // The Outbox Worker mode, not the deploy target, chooses the workers the plan deploys and stops.
  expect(planRun).toContain('--outbox-worker-mode "$OUTBOX_WORKER_MODE"');
  expect(planRun).not.toContain('--deploy-target');
  expect(plan.outputs).toEqual({
    any: expression('steps.units.outputs.any'),
    'fresh-units': expression('steps.selection.outputs.fresh'),
    migrator: expression('steps.impact.outputs.migrator'),
    plan: expression('steps.impact.outputs.plan'),
    providers: expression('steps.units.outputs.providers'),
    shell: expression('steps.units.outputs.shell'),
    spicedb: expression('steps.impact.outputs.spicedb'),
    'stopped-workers': expression('steps.impact.outputs.stopped_workers'),
    'worker-drift': expression('steps.worker-drift.outputs.drift'),
  });
  const select = byName.get('Select the Zerops units of the deploy target');
  const impact = {
    FRESH_UNITS_JSON: '[{"id":"contacts"},{"id":"shell-super-app"}]',
    MIGRATOR: 'false',
    PROVIDERS_JSON: '["contacts","contacts-worker"]',
    SHELL: 'true',
    SPICEDB: 'false',
    WORKERS_JSON: '["contacts-worker"]',
  };
  const units = (environment: Readonly<Record<string, string>>) => runStep(select?.run ?? 'exit 1', environment);
  expect(units({ ...impact, DEPLOY_TARGET: 'zerops' })).toEqual({
    any: 'true',
    providers: impact.WORKERS_JSON,
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
  // The retired edge deploy chain stays disabled.
  expect(jobs['edge-deploy-readiness'].if).toBe(expression('false'));
  expect(jobs['deploy-cloudflare'].needs).toEqual([
    DEPLOY_TARGET_JOB,
    INITIAL_CUTOVER_GUARD_JOB,
    EDGE_PLAN_JOB,
    EDGE_BUILD_JOB,
    BASELINE_CAPTURE_JOB,
  ]);
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
  expect(publish.env.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL).toBe(expression(COMPOSITION_URL_SOURCE));
  expect(publish.env.DATABASE_ADMIN_URL).toBe(DATABASE_ADMIN_EXPRESSION);
  expect(publish.env.COMPOSITION_CANDIDATE_FILE).toBeUndefined();
  const candidateDownload = publish.steps.find(
    (step) => step.uses?.startsWith(DOWNLOAD_ARTIFACT) === true && step.with?.name === COMPOSITION_CANDIDATE_ARTIFACT,
  );
  expect(candidateDownload?.with).toEqual({
    name: COMPOSITION_CANDIDATE_ARTIFACT,
    path: `${RUNNER_TEMP_EXPRESSION}/prepared-release`,
  });
  const edgePublication = publish.steps.find(
    ({ name }) => name === 'Publish the complete observed release without restarting consumers',
  );
  expect(edgePublication?.run).toContain('publish --environment stage');
  assertPublicationEvidenceFlags(edgePublication);
  expect(edgePublication?.run).toContain('$RUNNER_TEMP/prepared-release/candidate.json');
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

it('captures the whole original approved baseline before staging and migrations', () => {
  const workflow = Schema.decodeUnknownSync(
    Schema.Struct({
      jobs: Schema.Record(
        Schema.String,
        Schema.Struct({
          needs: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
          steps: Schema.Array(
            Schema.Struct({
              run: Schema.optionalKey(Schema.String),
              with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
            }),
          ),
        }),
      ),
    }),
  )(readGateWorkflow());
  const capture = workflow.jobs[BASELINE_CAPTURE_JOB];
  expect(capture?.steps.some(({ run }) => run?.includes('capture-approved-snapshot') === true)).toBe(true);
  expect(
    capture?.steps.some(({ with: settings }) => settings?.name === 'approved-application-composition-baseline'),
  ).toBe(true);
  expect(workflow.jobs[EDGE_RELEASE_JOB]?.needs).toContain(BASELINE_CAPTURE_JOB);
  expect(workflow.jobs['prepare-node-composition']?.needs).toContain(BASELINE_CAPTURE_JOB);
});

it('recovers complete retained receipts by the captured exact revision without fabricating a Shell receipt', () => {
  const edge = readTargetWorkflow().jobs[EDGE_RELEASE_JOB];
  const recovery = edge.steps.find(({ run }) => run?.includes('original-receipts.zip') === true);
  expect(recovery?.run).toContain('BASELINE_REVISION');
  expect(recovery?.run).toContain('application-release-receipts-');
  expect(recovery?.run).toContain('.workflow_run.head_branch ==');
  expect(recovery?.run).toContain('Receipt archive');
  const candidate = edge.steps.find(({ id }) => id === 'candidate');
  expect(candidate?.run).toContain('--approved-baseline-file');
  expect(candidate?.run).toContain('shell-super-app.json');
  expect(candidate?.run).not.toContain('--retained-shell-snapshot-file');
});

it('observes actual CF backends before DDL using trusted candidate credentials', () => {
  const candidate = readTargetWorkflow().jobs[EDGE_RELEASE_JOB].steps.find(({ id }) => id === 'candidate');
  expect(candidate?.run).toContain('prepare --environment stage --observe-backends');
  expect(candidate?.env?.CLOUDFLARE_API_TOKEN).toBe(expression(CF_TOKEN_SOURCE));
  expect(candidate?.env?.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL).toBe(expression(COMPOSITION_URL_SOURCE));
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
  expect(migration?.name).toBe('Run the exact migration prerequisite closure and verifiers');
  expect(migration?.id).toBe('migrator');
  expect(migration?.if).toBeUndefined();
  expect(migration?.['working-directory']).toBe('app');
  assertPublicationEvidenceFlags(migration);
  for (const argument of ['--zerops-yaml-path', '--project-id', '--service-id', '--version-name']) {
    expect(migration?.run).toContain(argument);
  }
  expect(migration?.run).toContain('.intentFile');
  expect(migration?.run).toContain(DEPLOY_ENVIRONMENT_ARGUMENT);
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
  expect(receipt?.if).toBe("vars.ONTOS_INITIAL_COMPOSITION_CUTOVER_RUN_ID != ''");
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
const COMPOSITION_SOURCE_EXPRESSION = expression(COMPOSITION_URL_SOURCE);
const CLOUDFLARE_TOKEN_EXPRESSION = expression(CF_TOKEN_SOURCE);

it('refreshes a Node-only stage from current workflow source without requiring deployment history', () => {
  const refresh = readRefreshPublicationJobs()['refresh-stage'];
  const renew = refresh.steps.find((step) => step.name === 'Renew the complete approved Application Composition');
  const runs = refresh.steps.map((step) => step.run ?? '').join('\n');
  expect(runs).not.toMatch(/deployment-base:resolve|git (?:checkout|clean)|DEPLOYED_SHA/u);
  expect(
    refresh.steps.filter((step) => step.uses?.startsWith('actions/checkout@') === true).map(({ name }) => name),
  ).toEqual(['Checkout main']);
  expect(refresh.steps.filter((step) => step.uses === './.github/actions/install-app')).toHaveLength(1);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-node-stage-refresh-'));
  try {
    const mise = path.join(directory, 'mise');
    writeFileSync(
      mise,
      `#!/bin/bash
set -euo pipefail
if [[ "$*" != 'exec -- pnpm active-composition:publish refresh --environment stage' ]]; then
  exit 1
fi
printf 'renewed=approved-snapshot\\n' >> "$GITHUB_OUTPUT"
`,
    );
    chmodSync(mise, 0o755);
    // History is unavailable for a Node-only stage. A newer failed/Worker-only rollout's
    // source must also remain irrelevant: the publisher reobserves the approved payload.
    for (const deployedSource of ['', 'newer-worker-only-source', 'newer-failed-edge-source']) {
      expect(
        runStep(renew?.run ?? 'exit 1', {
          DEPLOY_TARGET: refresh.env.DEPLOY_TARGET,
          DEPLOYED_SHA: deployedSource,
          PATH: `${directory}:${STEP_PATH}`,
        }),
      ).toEqual({ renewed: 'approved-snapshot' });
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

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
  expect(refresh['refresh-stage'].environment).toEqual({
    deployment: false,
    name: STAGE_REFRESH_ENVIRONMENT_EXPRESSION,
  });
  expect(refresh['refresh-stage'].env.DEPLOY_TARGET).toBe(expression('needs.stage-target.outputs.target'));
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

it('refreshes stage with the same configured target as deployment and defaults to Zerops', () => {
  const schema = Schema.Struct({
    jobs: Schema.Struct({
      'refresh-stage': Schema.Struct({ needs: Schema.Array(Schema.String) }),
      'stage-target': Schema.Struct({
        environment: Schema.Struct({ deployment: Schema.Boolean, name: Schema.String }),
        steps: Schema.Array(WorkflowStepSchema),
      }),
    }),
  });
  const { jobs } = Schema.decodeUnknownSync(schema)(
    parse(readFileSync(new URL(`../../../.github/workflows/${REFRESH_WORKFLOW}`, import.meta.url), 'utf-8')),
  );
  expect(jobs['stage-target'].environment).toEqual({ deployment: false, name: 'stage' });
  expect(jobs['refresh-stage'].needs).toContain('stage-target');
  const step = jobs['stage-target'].steps.find(({ id }) => id === 'target');
  expect(step?.env?.DEPLOY_TARGET).toBe(expression('vars.DEPLOY_TARGET'));
  for (const [configured, target] of [
    ['', 'zerops'],
    ['zerops', 'zerops'],
    ['cloudflare', 'cloudflare'],
  ]) {
    expect(runStep(step?.run ?? 'exit 1', { DEPLOY_TARGET: configured ?? '' })).toEqual({ target });
  }
  expect(runStep(step?.run ?? 'exit 1', { DEPLOY_TARGET: 'invalid' })).toBe('failed');
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
      name: environment === 'stage' ? STAGE_REFRESH_ENVIRONMENT_EXPRESSION : environment,
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
/** The integration matrix row that proves the stage-shaped deployment bootstrap from a scratch cluster. */
const BOOTSTRAP_SUITE = 'bootstrap';
const BOOTSTRAP_CONDITION = `matrix.suite == '${BOOTSTRAP_SUITE}'`;
const NON_BOOTSTRAP_CONDITION = "matrix.suite != 'bootstrap'";
const BOOTSTRAP_MIGRATOR_STEP = 'Run the assembled stage migrator artifact against the fresh database';
const NODE_BUILD_ARTIFACT_PATTERN = 'node-units-*';
/**
 * Every row that reads built Node artifacts: the suites and the whole-topology proof. The browser row
 * drives a deployed release instead, and the bootstrap row assembles the migrator and Outbox Worker host
 * from their own zerops.yaml build commands — making it wait for a build shard is what put the whole
 * bootstrap proof in front of the integration wave before it became a row.
 */
const BACKEND_ARTIFACT_CONDITION = "matrix.suite != 'browser'";
const BACKEND_ARTIFACT_DOWNLOAD_STEP = 'Download the same-run Node artifacts for native owner fixtures';
const BACKEND_INTEGRATION_CONDITION = "matrix.suite == 'integration'";
/** The integration matrix row that proves the built topology of every delivery unit. */
const NODE_PROOF_SUITE = BOOTSTRAP_SUITE;
const NODE_PROOF_CONDITION = `matrix.suite == '${NODE_PROOF_SUITE}'`;
const CLOUDFLARE_ARTIFACT_BUILD_JOB = 'cloudflare-artifact-build';
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
/** What each gate job waits for. The bootstrap proof is a row of the suites, so it adds no `needs` edge. */
const GATE_JOB_NEEDS = {
  [FORMAT_AND_LINT_JOB]: [CI_PLAN_JOB],
  [NODE_ARTIFACT_BUILD_JOB]: [CI_PLAN_JOB],
  [SERVICE_INTEGRATION_JOB]: [CI_PLAN_JOB, NODE_ARTIFACT_BUILD_JOB, SERVICE_SETUP_JOB, FORMAT_AND_LINT_JOB],
  'static-contracts': [CI_PLAN_JOB],
  [WORKSPACE_GATE_JOB]: [CI_PLAN_JOB],
  [WORKSPACE_UNIT_JOB]: [CI_PLAN_JOB, NODE_ARTIFACT_BUILD_JOB],
} satisfies Readonly<Record<string, readonly string[]>>;
/** Every gate job; each target's artifact proofs run inside its own build shards. */
const GATE_JOBS = ROOT_GATE_JOBS;
const GatedJobsSchema = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({ if: Schema.optional(Schema.String), needs: Schema.optional(Schema.Array(Schema.String)) }),
  ),
});

it('disables retired Cloudflare builds, proofs and deployment without gating Node delivery', () => {
  const source: unknown = parse(readFileSync(GATES_WORKFLOW_URL, 'utf-8'));
  const { jobs } = Schema.decodeUnknownSync(GatedJobsSchema)(source);
  expect(jobs[CLOUDFLARE_ARTIFACT_BUILD_JOB]?.if).toBe(expression('false'));
  expect(jobs[EDGE_READINESS_JOB]?.if).toBe(expression('false'));
  expect(jobs['workspace-gates']?.needs).not.toContain(CLOUDFLARE_ARTIFACT_BUILD_JOB);
  // The workerd regression guard for the whole Catalog client barrel carried `if: false` and therefore
  // never ran; its target is the retired Cloudflare delivery path, so the step is gone.
  expect(readFileSync(GATES_WORKFLOW_URL, 'utf-8')).not.toContain('cloudflare:build:full-catalog-client-guard');
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
    // Every producer this gate waits for must have succeeded: a failed producer leaves the gate
    // 'skipped' against an expected 'success', which check-ci-gates.sh rejects.
    const producers = needed
      .filter((job) => job !== CI_PLAN_JOB)
      .map((job) => `needs.${job}.result == 'success' && `)
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
  expect(readTargetWorkflow().jobs['deploy-target'].if).toContain('inputs.force-ci-full != true');
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
  expect(steps.some(({ uses }) => uses === './.github/actions/install-app')).toBe(false);
  // Only the planner's changed-path list leaves this job; $RUNNER_TEMP is job-local.
  const publish = steps.find(({ name }) => name === 'Publish the exact changed-path list');
  expect(publish?.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/u);
  expect(publish?.with).toEqual({
    'if-no-files-found': 'warn',
    name: CHANGED_PATHS_ARTIFACT,
    path: `${RUNNER_TEMP_EXPRESSION}/${CHANGED_PATHS_ARTIFACT}`,
    'retention-days': 1,
  });
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
  expect(afterGates).toContain(EDGE_RELEASE_JOB);
  expect(afterGates).toContain('publish-edge-composition');
  expect(jobs).not.toHaveProperty('sync-edge-composition');
  for (const job of afterGates) {
    // The job name leads the subject, so a failure names the job.
    expect(`${job}: ${jobs[job]?.if ?? ''}`).toMatch(/^[a-z-]+: \$\{\{ (?:!cancelled\(\)|always\(\))/u);
  }
});

const ArtifactBuildJobSchema = Schema.Struct({
  env: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number])),
  name: Schema.String,
  // Only a job whose shards read their siblings' results needs `actions: read`.
  permissions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  steps: Schema.Array(
    Schema.Struct({
      env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      id: Schema.optional(Schema.String),
      if: Schema.optional(Schema.String),
      name: Schema.String,
      run: Schema.optional(Schema.String),
      uses: Schema.optional(Schema.String),
      with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
  strategy: Schema.Struct({
    matrix: Schema.Struct({
      include: Schema.Array(
        Schema.Struct({
          proof: Schema.optional(Schema.String),
          shard: Schema.Number,
          units: Schema.String,
        }),
      ),
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

it('supplies a placeholder public URL for every unit in Cloudflare builds and output proofs', () => {
  const { jobs } = Schema.decodeUnknownSync(ArtifactBuildWorkflowSchema)(readGateWorkflow());
  const topology = Schema.decodeUnknownSync(TopologyUnitsSchema)(
    JSON.parse(readFileSync(new URL('../../topology/reference-topology.json', import.meta.url), 'utf-8')),
  );
  for (const name of [
    "Build the shard's Cloudflare artifacts one unit at a time",
    'Generate federated types, verify the Worker outputs and prove their SSR',
  ]) {
    const step = jobs[CLOUDFLARE_ARTIFACT_BUILD_JOB].steps.find((candidate) => candidate.name === name);
    expect(step, name).toBeDefined();
    for (const { id } of [topology.shell, ...topology.verticals]) {
      const variable = `ULTRAMODERN_PUBLIC_URL_${id.replaceAll('-', '_').toUpperCase()}`;
      expect(step?.env?.[variable], `${name}: ${variable}`).toBe(`https://${id}.invalid`);
    }
  }
});

const readArtifactBuildJobs = () => Schema.decodeUnknownSync(ArtifactBuildWorkflowSchema)(readGateWorkflow()).jobs;

it('builds Node artifacts on four independent runners without waiting for or proving the topology', () => {
  const { permissions, steps, strategy } = readArtifactBuildJobs()[NODE_ARTIFACT_BUILD_JOB];
  // Nothing in this job reads another job's results or artifacts any more, so it needs no extra scope.
  expect(permissions).toBeUndefined();
  expect(strategy.matrix.include.every(({ proof }) => proof === undefined)).toBe(true);
  for (const forbidden of [
    'wait-for-build-shards.sh',
    DOWNLOAD_ARTIFACT,
    'pnpm node:proof',
    'pnpm mf:types',
    'active-composition:publish',
    'pnpm db:migrate',
  ]) {
    expect(
      steps.filter(({ run, uses }) => (run ?? '').includes(forbidden) || (uses ?? '').includes(forbidden)),
      forbidden,
    ).toEqual([]);
  }
  // The upload still fails rather than publishing an empty archive the suites would silently trust.
  const upload = steps.find(({ name }) => name === UPLOAD_STEP);
  expect(upload?.if).toBeUndefined();
  expect(upload?.with).toEqual({
    'compression-level': 0,
    'if-no-files-found': 'error',
    name: `node-units-${expression(MATRIX_SHARD)}`,
    path: `${RUNNER_TEMP_EXPRESSION}/units.tar.zst`,
    'retention-days': 1,
  });
});

it('builds every Node release from this commit rather than restoring another release identity', () => {
  const { env: environment, steps, strategy } = readArtifactBuildJobs()[NODE_ARTIFACT_BUILD_JOB];
  expect(strategy.matrix.shard).toEqual([1, 2, 3, 4]);
  expect(environment.ULTRAMODERN_SOURCE_REVISION).toBe(CURRENT_SOURCE_REVISION);
  const compilerCache = steps.find(({ uses }) => uses?.startsWith('actions/cache@') === true);
  expect(compilerCache?.with?.path).toBe('app/apps/*/node_modules/.cache\napp/verticals/*/node_modules/.cache\n');
  expect(compilerCache?.with?.key).toContain('app/pnpm-lock.yaml');
  expect(compilerCache?.with?.key).toContain('app/**/tsconfig*.json');
  expect(compilerCache?.with?.key).toContain('app/patches/**');
  const build = steps.findIndex(({ name }) => name === "Build the shard's Node artifacts");
  const pack = steps.findIndex(({ name }) => name === "Pack the shard's build outputs");
  const upload = steps.findIndex(({ name }) => name === UPLOAD_STEP);
  expect(build).toBeGreaterThan(-1);
  expect(build < pack && pack < upload).toBe(true);
  expect(steps[build]?.if).toBeUndefined();
  expect(steps[pack]?.if).toBeUndefined();
  expect(steps[build]?.run).toContain(`--workspace-concurrency=2 "\${filters[@]}" run build`);
  expect(steps[build]?.env).toMatchObject({
    NODE_OPTIONS: '--max-old-space-size=2048',
    ONTOS_CI_TYPECHECK_SEPARATE: '1',
  });
  expect(steps[pack]?.run).toContain('--file "$RUNNER_TEMP/units.tar.zst"');
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

/** Runs the shard wait with a `gh` that answers the jobs API with these jobs, as `gh api --jq` would. */
const waitForBuildShards = (jobs: readonly { conclusion: string | null; name: string }[], own = 'Build x (1/3)') => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-wait-shards-'));
  try {
    const gh = path.join(directory, 'gh');
    writeFileSync(gh, '#!/bin/sh\n[ "$1" = api ] && [ "$3" = --jq ] || exit 2\nprintf %s "$FAKE_JOBS" | jq -r "$4"\n');
    chmodSync(gh, 0o755);
    execFileSync(
      '/bin/bash',
      [fileURLToPath(new URL('../wait-for-build-shards.sh', import.meta.url)), 'Build x (', own ? '3' : '2', own],
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
  expect(waitForBuildShards(others, '')).toBe(true);
  expect(waitForBuildShards([{ ...others[0], conclusion: 'failure' }, others[1]], '')).toBe(false);
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
          uses: Schema.optional(Schema.String),
          with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        }),
      ),
      strategy: Schema.optional(Schema.Unknown),
    }),
    'static-contracts': Schema.Struct({
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
    [WORKSPACE_GATE_JOB]: Schema.Struct({
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
    }),
    [WORKSPACE_UNIT_JOB]: Schema.Struct({
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
  return ([WORKSPACE_GATE_JOB, WORKSPACE_UNIT_JOB] as const).flatMap((job) =>
    jobs[job].strategy.matrix.include.map(({ commands }) => commands.split('\n').filter(Boolean)),
  );
};

it('verifies the exact Tunnel download and checksum before allowing a deployment', () => {
  const step = readGateCommandJobs()['static-contracts'].steps.find(
    ({ name }) => name === 'Verify the pinned Cloudflare Tunnel binary',
  );
  expect(step?.run).toContain('readFileSync("zerops.yaml", "utf8")');
  expect(step?.run).toContain(String.raw`service.build.buildCommands.join("\n")`);
  expect(step?.run).toContain('bash -euo pipefail -c "$commands"');
  expect(step?.run).toContain('app/.zerops/runtime/cloudflared/cloudflared --version');
  expect(step?.run).toContain('mktemp -d "$RUNNER_TEMP/ontos-cloudflared.XXXXXX"');
  expect(step?.run).toContain('trap \'rm -rf -- "$scratch"\' EXIT');
});

it('runs every workspace gate check in some workspace-gate entry', () => {
  const commands = gateCommands().flat();
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
  const staticChecks = readGateCommandJobs()['static-contracts'].steps.flatMap(({ parallel, run }) =>
    parallel ? parallel.map((step) => step.run) : [run ?? ''],
  );
  expect(staticChecks).toContain('mise exec -- pnpm database-access:check');
});

it('runs every static contract check on exactly one row of the static contracts job', () => {
  const job = readGateCommandJobs()['static-contracts'];
  const rows = job.strategy.matrix.row;
  expect(rows).toEqual(['contracts']);
  expect(
    gateCommands()
      .flat()
      .filter((command) => command.endsWith(' pnpm api:check')),
  ).toEqual(['NODE_OPTIONS=--max-old-space-size=6144 pnpm api:check']);
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
  const rows = job.strategy.matrix.include;
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
    'pnpm -r --no-sort --if-present run test:unit && pnpm -r --no-sort --if-present run test:component && pnpm --filter @app/shared-contracts test:types',
  );
  const shards = gateCommands().flatMap((commands) => {
    const [unit, component, ...rest] = commands;
    if (unit === undefined || !unit.endsWith(' run test:unit --pool.maxWorkers 1')) {
      return [];
    }
    const filters = unit
      .replace(/^pnpm -r --no-sort --workspace-concurrency=4 --if-present /u, '')
      .replace(/ run test:unit --pool.maxWorkers 1$/u, '');
    // Each shard runs test:component over the same packages, after test:unit, and nothing else.
    expect(component).toBe(
      `pnpm -r --no-sort --workspace-concurrency=4 --if-present ${filters} run test:component --pool.maxWorkers 1`,
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
          'native-preproposal': Schema.optional(Schema.Boolean),
          'package-filters': Schema.optional(Schema.String),
          'package-partition': Schema.optional(Schema.String),
          'preproposal-case': Schema.optional(Schema.String),
          'root-rstest-shard': Schema.optional(Schema.String),
          'root-suite': Schema.optional(Schema.Boolean),
          suite: Schema.Literals([BOOTSTRAP_SUITE, 'integration', 'browser']),
          'whole-owner-proofs': Schema.optional(Schema.String),
        }),
      ),
    }),
  }),
});
const IntegrationShardsWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    [SERVICE_INTEGRATION_JOB]: IntegrationRunnerSchema,
    [SERVICE_SETUP_JOB]: IntegrationRunnerSchema,
  }),
});

const shardFilters = (shard: { readonly 'package-filters'?: string | undefined }) =>
  [...(shard['package-filters'] ?? '').matchAll(/--filter (?<filter>\S+)/gu)].map(({ groups }) => groups?.filter ?? '');

it('passes the reviewed release intent into the remote Zerops worker host build', () => {
  const schema = Schema.Struct({
    jobs: Schema.Struct({
      'deploy-zerops': Schema.Struct({
        env: Schema.Record(Schema.String, Schema.String),
        steps: Schema.Array(WorkflowStepSchema),
      }),
    }),
  });
  const job = Schema.decodeUnknownSync(schema)(readGateWorkflow()).jobs['deploy-zerops'];
  expect(job.env.COMPOSITION_INTENT_FILE).toBe(REVIEWED_RELEASE_INTENT_EXPRESSION);
  const materialize = job.steps.find(({ run }) => run?.includes('materialize_arguments=') === true);
  expect(materialize?.run).toContain('export COMPOSITION_INTENT_FILE');
  expect(materialize?.run).toContain(
    'COMPOSITION_INTENT_FILE="$(jq -er \'.intentFile\' "$RUNNER_TEMP/deployed-node-release/metadata.json")"',
  );
});

it('uses the selected release intent when either deployment planner detects hosted-worker changes', () => {
  const job = Schema.Struct({ steps: Schema.Array(WorkflowStepSchema) });
  const schema = Schema.Struct({ jobs: Schema.Struct({ 'deploy-plan': job, 'edge-plan': job }) });
  const { jobs } = Schema.decodeUnknownSync(schema)(readGateWorkflow());
  for (const planner of [jobs[DEPLOY_PLAN_JOB], jobs[EDGE_PLAN_JOB]]) {
    const step = planner.steps.find(({ id }) => id === 'impact');
    expect(step?.env?.COMPOSITION_INTENT_FILE).toBe(REVIEWED_RELEASE_INTENT_EXPRESSION);
  }
});

it('reconciles the same worker-mode drift in both deployment planners before selecting releases', () => {
  const schema = Schema.Struct({
    jobs: Schema.Struct({
      'deploy-plan': Schema.Struct({ outputs: Schema.Record(Schema.String, Schema.String) }),
      'edge-plan': Schema.Struct({
        if: Schema.String,
        needs: Schema.Array(Schema.String),
        steps: Schema.Array(WorkflowStepSchema),
      }),
    }),
  });
  const { jobs } = Schema.decodeUnknownSync(schema)(readGateWorkflow());
  expect(jobs[DEPLOY_PLAN_JOB].outputs['worker-drift']).toBe(expression('steps.worker-drift.outputs.drift'));
  const edge = jobs['edge-plan'];
  expect(edge.needs).toContain(DEPLOY_PLAN_JOB);
  expect(edge.if).toContain("needs.deploy-plan.result == 'success'");
  const impact = edge.steps.find(({ id }) => id === 'impact');
  expect(impact?.env?.WORKER_DRIFT).toBe(expression('needs.deploy-plan.outputs.worker-drift'));
  expect(impact?.run).toContain('if [[ "$WORKER_DRIFT" == \'true\' ]]; then');
  expect(impact?.run).toContain('base_arguments+=(--reconcile-workers)');
});

it('uses the reviewed membership for worker drift checks during deployment and refresh', () => {
  const job = Schema.Struct({ env: Schema.Record(Schema.String, Schema.String) });
  const deploy = Schema.decodeUnknownSync(Schema.Struct({ jobs: Schema.Struct({ 'deploy-plan': job }) }))(
    readGateWorkflow(),
  ).jobs[DEPLOY_PLAN_JOB];
  const refresh = Schema.decodeUnknownSync(
    Schema.Struct({ jobs: Schema.Struct({ 'refresh-production': job, 'refresh-stage': job }) }),
  )(parse(readFileSync(new URL(`../../../.github/workflows/${REFRESH_WORKFLOW}`, import.meta.url), 'utf-8')));
  for (const step of [deploy, refresh.jobs['refresh-production'], refresh.jobs['refresh-stage']]) {
    expect(step.env.COMPOSITION_INTENT_FILE).toBe(REVIEWED_RELEASE_INTENT_EXPRESSION);
  }
});

it('runs retained-release browser recovery separately with one worker and its publication flag enabled', () => {
  const source: unknown = readGateWorkflow();
  const { steps } = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(source).jobs[SERVICE_INTEGRATION_JOB];
  const normal = steps.findIndex(({ run }) => run === 'mise exec -- pnpm --filter @app/shell-super-app test:e2e');
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

it('supplies same-run built Composition to selected native owner integration shards before their tests', () => {
  const source: unknown = readGateWorkflow();
  const { jobs } = Schema.decodeUnknownSync(GatedJobsSchema)(source);
  const integration = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(source).jobs[SERVICE_INTEGRATION_JOB];
  // The producers have no integration dependency: integration -> Node artifacts -> queue proof is acyclic.
  expect(integration.needs).toEqual(GATE_JOB_NEEDS[SERVICE_INTEGRATION_JOB]);
  expect(jobs[NODE_ARTIFACT_BUILD_JOB]?.needs).toEqual([CI_PLAN_JOB]);
  const selected = integration.strategy.matrix.include.filter((shard) => shard['native-composition'] === true);
  const rootShards = integration.strategy.matrix.include.filter((shard) => shard['root-suite'] === true);
  // Derived instead of a literal count, so a reshard cannot be "fixed" by editing a number here: every root
  // shard must derive the fresh Composition, the same row may carry named owners, and only integration
  // rows may carry it (a browser or proof row would have no Composition to derive).
  expect(selected.length).toBeGreaterThan(0);
  expect(selected.every(({ suite }) => suite === 'integration')).toBe(true);
  expect(selected.filter((shard) => shard['root-suite'] === true)).toEqual(rootShards);
  expect(selected.some((shard) => shardFilters(shard).includes('./verticals/pricing'))).toBe(true);
  expect(selected.some((shard) => shardFilters(shard).includes('./verticals/inventory'))).toBe(true);
  const { steps } = integration;
  const download = steps.findIndex(({ with: inputs }) => inputs?.pattern === NODE_BUILD_ARTIFACT_PATTERN);
  const unpack = steps.findIndex(({ run }) => run?.startsWith(UNPACK_NATIVE_ARTIFACTS_SCRIPT) === true);
  const derive = steps.findIndex(({ run }) => run?.includes('prove-build --snapshot-output') === true);
  const tests = steps.findIndex(({ env }) => env?.ROOT_SUITE !== undefined);
  const wait = steps.findIndex(({ run }) => run === "bash scripts/wait-for-build-shards.sh 'Build node artifacts (' 4");
  const workers = steps.findIndex(({ run }) => run === 'bash scripts/ci/start-integration-workers.sh');
  const sourceProof = steps.findIndex(
    ({ run }) => run === 'bash scripts/ci/run-integration-suites.sh --task whole:migrations',
  );
  expect(workers).toBeGreaterThan(-1);
  expect(workers < sourceProof && sourceProof < wait && wait < download).toBe(true);
  expect(steps[sourceProof]?.if).toBe("matrix.root-suite == true && matrix.root-rstest-shard == '4/12'");
  expect(steps[sourceProof]?.background).toBe(true);
  expect(steps[sourceProof]?.env?.ONTOS_CI_WORKER_SLOT).toBe('3');
  expect(steps.some((step) => step.wait === 'scoped-migrations')).toBe(true);
  expect(rootShards.filter((shard) => shard['root-rstest-shard'] === '4/12')).toHaveLength(1);
  expect(rootShards.find((shard) => shard['root-rstest-shard'] === '4/12')?.lanes).toBe(2);
  expect(steps[wait]?.if).toBe(BOOTSTRAP_CONDITION);
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
  for (const index of [download, unpack]) {
    expect(steps[index]?.if).toBe(BACKEND_ARTIFACT_CONDITION);
  }
  expect(steps[derive]?.if).toBe('matrix.native-composition == true');
  expect(steps.filter(({ if: condition }) => condition === 'matrix.native-composition == true')).toHaveLength(1);
});

it('proves the built topology of every delivery unit in one row of the integration matrix', () => {
  const integration = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(readGateWorkflow()).jobs[
    SERVICE_SETUP_JOB
  ];
  // One prerequisite row proves all built outputs before late-wave admission;
  // its success is required by the unchanged service-integration gate.
  const rows = integration.strategy.matrix.include.filter(({ suite }) => suite === NODE_PROOF_SUITE);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.['package-filters']).toBeUndefined();
  expect(rows[0]?.['root-suite']).toBeUndefined();
  expect(rows[0]?.['native-composition']).toBeUndefined();
  expect(rows[0]?.['native-preproposal']).toBeUndefined();
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
  expect(steps[named(BACKEND_ARTIFACT_DOWNLOAD_STEP)]?.if).toBe(BACKEND_ARTIFACT_CONDITION);
  expect(named(BACKEND_ARTIFACT_DOWNLOAD_STEP)).toBeLessThan(indexes[0] ?? -1);
  const migrations = named('Apply and verify Core, Auth, and Contacts migrations, plus Party Registry');
  expect(steps[migrations]?.if).toBe(NON_BOOTSTRAP_CONDITION);
  const bootstrap = named(BOOTSTRAP_MIGRATOR_STEP);
  expect(steps[bootstrap]?.if).toBe(BOOTSTRAP_CONDITION);
  expect(bootstrap).toBeLessThan(indexes[0] ?? -1);
  expect(migrations).toBeLessThan(indexes[0] ?? -1);
  expect(steps[named('Start fresh PostgreSQL and SpiceDB services')]?.if).toBeUndefined();
  // The suites never run on this row, and its steps never run on a suite row.
  const tests = steps.find(({ env }) => env?.ROOT_SUITE !== undefined);
  expect(tests?.if).toBe(BACKEND_INTEGRATION_CONDITION);
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

it('covers every root integration shard and assigns each package integration suite once', () => {
  const { scripts } = readRootScripts();
  // The shards run exactly what the root script runs, split by package.
  expect(scripts['test:integration']).toBe(
    'rstest --project integration --pool.maxWorkers 1 && pnpm -r --no-sort --workspace-concurrency 1 --if-present run test:integration --pool.maxWorkers 1',
  );
  const job = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(readGateWorkflow()).jobs[
    SERVICE_INTEGRATION_JOB
  ];
  const run = job.steps.find(({ env }) => env?.ROOT_SUITE !== undefined);
  expect(run?.if).toBe(BACKEND_INTEGRATION_CONDITION);
  expect(run?.env).toMatchObject({
    APP_ENV_PATH: '/dev/null',
    ONTOS_CI_ISOLATED_WORKERS: '4',
    SPICEDB_DATABASE_PASSWORD: 'spicedb',
  });
  const isolate = job.steps.findIndex((step) => step.run === 'bash scripts/ci/start-integration-workers.sh');
  expect(isolate).toBeGreaterThan(-1);
  expect(isolate).toBeLessThan(job.steps.findIndex(({ env }) => env?.ROOT_SUITE !== undefined));
  expect(job.steps[isolate]?.if).toBe(BACKEND_INTEGRATION_CONDITION);
  expect(run?.run?.trim()).toBe('bash scripts/ci/run-integration-suites.sh');
  // Opted-in native proofs supplement (not replace or shard) the ordinary package suites.
  const nativeShards = job.strategy.matrix.include.filter((shard) => shard['native-preproposal'] === true);
  expect(nativeShards).toHaveLength(2);
  expect(nativeShards.map((shard) => shard['preproposal-case'])).toEqual(['basis', 'approval']);
  expect(nativeShards[0]?.suite).toBe('integration');
  expect(run?.env?.NATIVE_PREPROPOSAL).toBe(expression('matrix.native-preproposal'));
  expect(run?.env?.NATIVE_PREPROPOSAL_CASE).toBe(expression('matrix.preproposal-case'));
  const scheduler = readFileSync(new URL('../ci/run-integration-suites.sh', import.meta.url), 'utf-8');
  expect(scheduler).toContain('tasks+=("whole:preproposal-basis" "whole:preproposal-approval")');
  expect(scheduler).toContain(
    "exec timeout --kill-after=3s 20m mise exec -- pnpm --filter @app/commerce-customer-context run test:integration:native-preproposal -t 'produces an exact preproposal basis'",
  );
  const commerceScripts = Schema.decodeUnknownSync(RootScriptsSchema)(
    JSON.parse(
      readFileSync(new URL('../../verticals/commerce-customer-context/package.json', import.meta.url), 'utf-8'),
    ),
  ).scripts;
  expect(commerceScripts['test:integration:native-preproposal']).toBe(
    'ONTOS_PREPROPOSAL_STANDALONE=true ONTOS_PREPROPOSAL_NATIVE=true ONTOS_APPROVAL_NATIVE=true rstest --project integration --pool.maxWorkers 1 tests/integration/preproposal-basis-postgres.test.ts --testTimeout 1200000',
  );
  const shards = job.strategy.matrix.include.filter(({ suite }) => suite === 'integration');
  const roots = shards.filter((shard) => shard['root-suite'] === true);
  expect(roots.map((row) => row['root-rstest-shard'])).toEqual(
    Array.from({ length: 12 }, (_, index) => `${index + 1}/12`),
  );
  const packages = shards.filter((shard) => shardFilters(shard).length > 0);
  // Every row names exactly the packages it runs; none negates, so no row silently inherits a package
  // a reshard forgot.
  const named = packages.filter((shard) => shardFilters(shard).every((filter) => !filter.startsWith('!')));
  expect(named).toEqual(packages);
  const namedPackages = named.flatMap(shardFilters);
  const counts = new Map<string, number>();
  for (const name of namedPackages) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const [name, count] of counts) {
    if (name === CUSTOMER_CONTEXT_SELECTOR || name === './verticals/privacy' || name === './apps/shell-super-app') {
      const expected = name === CUSTOMER_CONTEXT_SELECTOR ? ['1/3', '2/3', '3/3'] : ['1/2', '2/2'];
      expect(count).toBe(expected.length);
      expect(packages.filter((row) => shardFilters(row).includes(name)).map((row) => row['package-partition'])).toEqual(
        expected,
      );
    } else {
      expect(count, name).toBe(1);
    }
  }
  for (const filter of namedPackages) {
    expect(filter).toMatch(/^\.\/(?:apps|packages|verticals)\/[a-z-]+$/u);
    const manifest = Schema.decodeUnknownSync(RootScriptsSchema)(
      JSON.parse(readFileSync(new URL(`../../${filter}/package.json`, import.meta.url), 'utf-8')),
    );
    expect(manifest.scripts['test:integration']).toBeDefined();
  }
  // Resharding these rows is how a package falls out of the gate without anything failing, so every
  // package whose own manifest defines an integration suite must be named by exactly one row.
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
  expect(sorted(tested)).toEqual(sorted([...new Set(namedPackages)]));
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
  expect(step?.env).toEqual({
    FULL_SWEEP: expression("github.event_name == 'schedule'"),
    PLAN_MODE: expression('needs.ci-plan.outputs.mode'),
  });
  const run = step?.run ?? 'exit 1';
  // The hook sees the selected files, and a file it fixes fails the gate.
  expect(run).toContain('lefthook run pre-commit --files-from-stdin --no-auto-install');
  expect(run.trimEnd().endsWith('git diff --exit-code HEAD')).toBe(true);
  const select = run.slice(0, run.indexOf('if [[ "$sweep" == all ]]; then\n  # Directory arguments'));
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
      env: { FULL_SWEEP: 'false', PATH: STEP_PATH, PLAN_MODE: 'affected', RUNNER_TEMP: directory, ...environment },
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
    // A changed formatter, linter or hook configuration reformats files nobody touched.
    for (const configuration of [
      LEFTHOOK_CONFIG,
      'app/.oxlintrc.json',
      'app/oxfmt.config.ts',
      'app/packages/core-runtime/.prettierrc',
      'app/tools/oxlint/effect-native/rules/no-native-timers.ts',
      'app/patches/linter.patch',
      'app/tsconfig.base.json',
      'app/pnpm-lock.yaml',
      'app/pnpm-workspace.yaml',
      'app/.mise.toml',
    ]) {
      expect(sorted(selectFiles([configuration, CHANGED_SOURCE_PATH])), configuration).toEqual(sorted(tracked));
    }
    // Test-runner configuration does not alter formatting or lint semantics.
    for (const configuration of [
      'app/rstest.config.ts',
      'vitest.config.mts',
      'app/verticals/catalog/rstest.config.ts',
    ]) {
      expect(selectFiles([configuration, CHANGED_SOURCE_PATH])).toEqual([CHANGED_SOURCE_PATH]);
    }
    // The nightly cron keeps the whole-tree sweep.
    expect(sorted(selectFiles([CHANGED_SOURCE_PATH], { FULL_SWEEP: 'true' }))).toEqual(sorted(tracked));
    // An unavailable comparison sweeps everything rather than proving nothing.
    expect(sorted(selectFiles([], { PLAN_MODE: 'full' }))).toEqual(sorted(tracked));
    // An empty list where the planner selected from the diff, and a missing list, both fail.
    expect(() => selectFiles([], { PLAN_MODE: 'affected' })).toThrow();
    expect(() => selectFiles()).toThrow();
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
    'cloudflare-artifact-build': IdentityGateJobSchema,
    [SERVICE_INTEGRATION_JOB]: IdentityGateJobSchema,
  }),
});

it('gives every CI database tool a separate login per runtime identity and audits their grants', () => {
  const source = readFileSync(GATES_WORKFLOW_URL, 'utf-8');
  const { jobs } = Schema.decodeUnknownSync(IdentityGateJobsSchema)(parse(source));
  const integration = jobs[SERVICE_INTEGRATION_JOB];
  const proofValues = jobs['cloudflare-artifact-build'].steps.find(
    ({ name }) => name === 'Set the development-only service values of the Worker proofs',
  );
  for (const environment of [integration.env, proofValues?.env]) {
    for (const [key, role] of Object.entries(RUNTIME_IDENTITY_URLS)) {
      expect(environment?.[key]).toBe(`postgresql://${role}:${role}@localhost:5433/ontos_ci`);
    }
  }
  // Both dotenv writers pass exactly the identity URLs through, and nothing that merely shares a prefix.
  const filters = Array.from(source.matchAll(IDENTITY_STEP_ENV_FILTER), (match) => match.groups?.pattern ?? '');
  expect(filters).toHaveLength(2);
  for (const filter of filters) {
    const pattern = new RegExp(filter, 'u');
    for (const key of Object.keys(RUNTIME_IDENTITY_URLS)) {
      expect(pattern.test(`${key}=postgresql://identity`)).toBe(true);
      expect(pattern.test(`${key}_EXTRA=value`)).toBe(false);
    }
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
  // Bootstrap and federation share this row, so it restores the same-run Node artifacts too.
  for (const name of [BACKEND_ARTIFACT_DOWNLOAD_STEP, 'Unpack the Node artifacts for native owner fixtures']) {
    expect(steps.find((candidate) => candidate.name === name)?.if, name).toBe(BACKEND_ARTIFACT_CONDITION);
  }
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

it('gives the workerd SSR proof every dedicated Hyperdrive connection from the canonical identity URL', () => {
  const { jobs } = Schema.decodeUnknownSync(IdentityGateJobsSchema)(readGateWorkflow());
  const outputs = jobs['cloudflare-artifact-build'].steps.find(
    ({ run }) => run?.includes('pnpm cloudflare:ssr-proof') === true,
  );
  expect(outputs).toBeDefined();
  for (const identity of DATABASE_IDENTITIES.filter(({ id }) => id !== 'shared_runtime')) {
    if (identity.cloudflareHyperdrive !== null) {
      expect(outputs?.run).toContain(
        `export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${identity.cloudflareHyperdrive.binding}="$${identity.urlKey}"`,
      );
    }
  }
});

it('filters fresh Node owners through the existing full planner order, including new owners, with Shell last', () => {
  const { jobs } = Schema.decodeUnknownSync(
    Schema.Struct({
      jobs: Schema.Record(
        Schema.String,
        Schema.Struct({ steps: Schema.Array(Schema.Struct({ run: Schema.optionalKey(Schema.String) })) }),
      ),
    }),
  )(readGateWorkflow());
  const source =
    jobs['node-release-plan']?.steps.find(({ run }) => run?.includes('provider-order.json') === true)?.run ?? '';
  const projection = source.slice(source.indexOf('jq --slurpfile selection'), source.indexOf('mapfile -t units'));
  expect(projection).toContain('deployment-order.json');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-node-deploy-order-'));
  const plans = path.join(directory, 'node-release-plans');
  try {
    mkdirSync(plans);
    writeFileSync(
      path.join(plans, 'provider-order.json'),
      JSON.stringify({
        phases: [
          { id: 'foundation', kind: 'provider' },
          { id: 'consumer', kind: 'provider' },
          { id: 'new-owner', kind: 'provider' },
          { id: SHELL_APP_ID, kind: 'shell' },
        ],
      }),
    );
    for (const fresh of [true, false]) {
      const shell = { id: SHELL_APP_ID, path: 'apps/shell-super-app' };
      const selection = {
        fresh: fresh
          ? [
              { id: 'new-owner', path: 'verticals/new-owner' },
              { id: 'consumer', path: 'verticals/consumer' },
              { id: 'foundation', path: 'verticals/foundation' },
            ]
          : [],
        shell: { mode: fresh ? 'fresh' : 'retained', unit: shell },
      };
      writeFileSync(path.join(plans, 'selection.json'), JSON.stringify(selection));
      execFileSync('/bin/bash', ['-eo', 'pipefail', '-c', projection], {
        env: { PATH: STEP_PATH, RUNNER_TEMP: directory },
      });
      const ordered = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String }))),
      )(readFileSync(path.join(plans, 'deployment-order.json'), 'utf-8'));
      expect(ordered.map(({ id }) => id)).toEqual(fresh ? ['foundation', 'consumer', 'new-owner', SHELL_APP_ID] : []);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it('restores same-run Node artifacts for every backend integration fixture and excludes browser rows', () => {
  const source: unknown = readGateWorkflow();
  const { jobs } = Schema.decodeUnknownSync(GatedJobsSchema)(source);
  const integration = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(source).jobs[SERVICE_INTEGRATION_JOB];
  expect(integration.needs).toEqual(GATE_JOB_NEEDS[SERVICE_INTEGRATION_JOB]);
  // The producer depends only on queue proof, so waiting for its complete matrix cannot create a cycle.
  expect(jobs[NODE_ARTIFACT_BUILD_JOB]?.needs).toEqual([CI_PLAN_JOB]);
  const roots = integration.strategy.matrix.include.filter((shard) => shard['root-suite'] === true);
  // Shard counts are reshard-dependent and their completeness is proved where the shard ids are checked
  // as a derived 1..n set; here the contract is only that these fixtures exist and are backend rows.
  expect(roots.length).toBeGreaterThan(0);
  expect(roots.every(({ suite }) => suite === 'integration')).toBe(true);
  const customerContext = integration.strategy.matrix.include.filter((shard) =>
    shardFilters(shard).includes(CUSTOMER_CONTEXT_SELECTOR),
  );
  expect(customerContext.length).toBeGreaterThan(0);
  expect(customerContext.every(({ suite }) => suite === 'integration')).toBe(true);
  const setup = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(source).jobs[SERVICE_SETUP_JOB];
  expect(setup.strategy.matrix.include.some(({ suite }) => suite === 'browser')).toBe(true);
  const { steps } = integration;
  const download = steps.findIndex(({ with: inputs }) => inputs?.pattern === NODE_BUILD_ARTIFACT_PATTERN);
  const unpack = steps.findIndex(({ run }) => run?.startsWith(UNPACK_NATIVE_ARTIFACTS_SCRIPT) === true);
  expect(steps.some(({ run }) => run?.includes('zerops:materialize --app commerce-customer-context') === true)).toBe(
    false,
  );
  const tests = steps.findIndex(({ env }) => env?.ROOT_SUITE !== undefined);
  expect(download).toBeGreaterThan(-1);
  expect(download < unpack && unpack < tests).toBe(true);
  expect(steps[download]?.uses).toMatch(/^actions\/download-artifact@[a-f0-9]{40}$/u);
  // No run-id, repository or token override: the artifacts must belong to this workflow run.
  expect(steps[download]?.with).toEqual({
    path: `${RUNNER_TEMP_EXPRESSION}/native-composition-units`,
    pattern: NODE_BUILD_ARTIFACT_PATTERN,
  });
  expect(steps[unpack]?.run).toBe(UNPACK_NATIVE_ARTIFACTS_COMMAND);
  for (const index of [download, unpack]) {
    expect(steps[index]?.if).toBe(BACKEND_ARTIFACT_CONDITION);
  }
  const preproposal = integration.strategy.matrix.include.filter((shard) => shard['native-preproposal'] === true);
  expect(preproposal).toHaveLength(2);
  expect(preproposal[0]?.suite).toBe('integration');
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

it('leaves two organization slots free in both dependency-bounded runner waves', () => {
  const commands = readGateCommandJobs();
  const { jobs } = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(readGateWorkflow());
  const builds = readArtifactBuildJobs()[NODE_ARTIFACT_BUILD_JOB].strategy.matrix.shard.length;
  const source = commands[WORKSPACE_GATE_JOB].strategy.matrix.include.length;
  const staticRows = commands['static-contracts'].strategy.matrix.row.length;
  const setup = jobs[SERVICE_SETUP_JOB];
  const work = jobs[SERVICE_INTEGRATION_JOB];
  expect(source + staticRows + 1 + builds + setup.strategy.matrix.include.length).toBeLessThanOrEqual(18);
  expect(
    source +
      staticRows +
      commands[WORKSPACE_UNIT_JOB].strategy.matrix.include.length +
      work.strategy.matrix.include.length,
  ).toBeLessThanOrEqual(18);
  expect(setup.needs).toEqual([CI_PLAN_JOB]);
  expect(work.needs).toEqual(GATE_JOB_NEEDS[SERVICE_INTEGRATION_JOB]);
});

it('proves each target on its own shards only after every other shard of the target uploaded its outputs', () => {
  const jobs = readArtifactBuildJobs();
  for (const [job, proofs, artifacts] of [
    [CLOUDFLARE_ARTIFACT_BUILD_JOB, ['outputs', 'topology'], 'cloudflare-units-*'],
  ] as const) {
    const { name, permissions, steps, strategy } = jobs[job];
    // Each proof runs on exactly one shard; the other shards only build.
    const hosted = strategy.matrix.include.map(({ proof }) => proof).filter((proof) => proof !== 'none');
    expect(sorted(hosted.map((proof) => proof ?? ''))).toEqual([...proofs]);
    expect(permissions).toEqual({ actions: 'read', contents: 'read' });
    // The proving shard waits for every other shard of this job, by the job's own name, before it
    // downloads them; every step after the shard's own upload runs only on a proving shard.
    const prefix = name.slice(0, name.indexOf('${{'));
    const upload = steps.findIndex((step) => step.name === UPLOAD_STEP);
    const wait = steps.findIndex(({ run }) => run?.startsWith('bash scripts/wait-for-build-shards.sh') === true);
    const download = steps.findIndex(({ uses }) => uses?.startsWith(DOWNLOAD_ARTIFACT) === true);
    expect(steps[wait]?.run).toBe(
      `bash scripts/wait-for-build-shards.sh '${prefix}' ${strategy.matrix.shard.length} '${name}'`,
    );
    expect(upload).toBeGreaterThan(-1);
    expect(upload < wait && wait < download).toBe(true);
    for (const step of steps.slice(upload + 1)) {
      expect(`${step.name}: ${step.if ?? ''}`).toMatch(/matrix\.proof (?:!= 'none'|== '[a-z]+')$/u);
    }
    // This target proves on more than one shard, so its download compares by `!= 'none'` rather than
    // naming a single proof.
    expect(proofs.length).toBeGreaterThan(1);
    expect(steps[download]?.if).toBe("matrix.proof != 'none'");
    expect(steps[download]?.with?.pattern).toBe(artifacts);
  }
});

it('runs excluded whole-owner scenarios exactly once in isolated integration lanes', () => {
  const job = Schema.decodeUnknownSync(IntegrationShardsWorkflowSchema)(readGateWorkflow()).jobs[
    SERVICE_INTEGRATION_JOB
  ];
  const scheduler = readFileSync(new URL('../ci/run-integration-suites.sh', import.meta.url), 'utf-8');
  const proofs = job.strategy.matrix.include.flatMap((row) =>
    (row['whole-owner-proofs'] ?? '').split(' ').filter(Boolean),
  );
  expect(sorted(proofs)).toEqual(['organization', 'pricing', 'privacy']);
  for (const file of [
    'scripts/integration/organization-source-customer-owner-conformance.test.mts',
    'tests/integration/market-revision-whole-current-pricing-postgres.test.ts',
    'tests/integration/privacy-composition-drain.test.ts',
  ]) {
    expect(scheduler).toContain(`--exclude ${file}`);
    expect(job.steps.some(({ run }) => run?.includes(file) === true)).toBe(false);
    expect(scheduler).toContain(file);
  }
  const run = job.steps.find(({ env }) => env?.ROOT_SUITE !== undefined);
  expect(run?.env?.WHOLE_OWNER_PROOFS).toBe(expression('matrix.whole-owner-proofs'));
});
