import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
    'deploy-stage': Schema.Struct({ environment: Schema.String }),
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
const DEPLOY_STEP = 'Deploy planned edge units in dependency order';
const RESTORE_STEP = 'Restore the edge Workers this run deployed';
const RETIRE_STEP = 'Retire Workers placement no longer deploys';
const BUILD_STEP = 'Build and verify planned edge units';
const PROOF_STEP = 'Prove the deployed edge units on their public URLs';

interface PlacementBuildInputs {
  readonly buildEnvironment: Readonly<Record<string, string>>;
  readonly units: readonly string[];
}

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
  expect(readiness.if).toContain("github.ref == 'refs/heads/main'");
  // Reading `stage-edge` secrets for the check must not add an entry to its deployment history.
  expect(readiness.environment).toEqual({ deployment: false, name: 'stage-edge' });
  const check = readiness.steps.find((step) => step.id === 'configuration');
  expect(readiness.steps.filter((step) => step.env?.CLOUDFLARE_API_TOKEN !== undefined)).toEqual([check]);
  expect(check?.env).toEqual({
    CLOUDFLARE_ACCOUNT_ID: expression('vars.CLOUDFLARE_ACCOUNT_ID'),
    CLOUDFLARE_API_TOKEN: expression('secrets.CLOUDFLARE_API_TOKEN'),
  });
  expect(check?.run).toContain('[[ -n "$CLOUDFLARE_ACCOUNT_ID" ]]');
  expect(check?.run).toContain('[[ -n "$CLOUDFLARE_API_TOKEN" ]]');
  expect(readiness.outputs.configured).toBe(expression('steps.configuration.outputs.configured'));
  // An incomplete reviewed build environment is not configured either: the Shell origin and every
  // placed Worker's public URL must be present before any Worker is built.
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
    'ULTRAMODERN_PUBLIC_URL_COMMERCE_CUSTOMER_CONTEXT',
    'ULTRAMODERN_PUBLIC_URL_SHELL_SUPER_APP',
  ]);
  expect(
    missingBuildVariables({
      buildEnvironment: {
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
  expect(jobs['deploy-stage'].environment).toBe('stage');
  expect(edge.environment).toBe('stage-edge');
  expect(edge.needs).toEqual(['deploy-stage', 'edge-deploy-readiness']);
  expect(edge.if).toBe("needs.edge-deploy-readiness.outputs.configured == 'true'");
  expect(edge.env).toBeUndefined();
  const byName = new Map(edge.steps.map((step) => [step.name, step]));
  expect(byName.get('Resolve the last successful edge deployment')?.run).toContain('--environment stage-edge');
  expect(byName.get('Plan the impacted edge units')?.id).toBe('impact');
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

it('bounds every edge step that changes or proves Workers and verifies retirements', () => {
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
  // Placement-retired Workers are deleted and verified absent.
  expect(retire?.env?.CLOUDFLARE_RETIREMENTS_JSON).toBe(expression('steps.impact.outputs.cloudflare_retirements'));
  expect(retire?.run).toContain('wrangler delete --name "$worker" --force');
});
