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
});
const EdgeDeployWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    'deploy-cloudflare': Schema.Struct({
      env: Schema.optional(Schema.Unknown),
      environment: Schema.String,
      if: Schema.String,
      needs: Schema.Array(Schema.String),
      steps: Schema.Array(WorkflowStepSchema),
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
  const [check] = readiness.steps;
  expect(readiness.steps).toHaveLength(1);
  expect(check?.env).toEqual({
    CLOUDFLARE_ACCOUNT_ID: expression('vars.CLOUDFLARE_ACCOUNT_ID'),
    CLOUDFLARE_API_TOKEN: expression('secrets.CLOUDFLARE_API_TOKEN'),
  });
  expect(check?.run).toContain('-n "$CLOUDFLARE_ACCOUNT_ID" && -n "$CLOUDFLARE_API_TOKEN"');
  expect(readiness.outputs.configured).toBe(expression(`steps.${check?.id ?? ''}.outputs.configured`));
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
  const build = byName.get('Build and verify planned edge units');
  const deploy = byName.get('Deploy planned edge units in dependency order');
  const proof = byName.get('Prove the deployed edge units on their public URLs');
  const restore = byName.get('Restore the edge Workers this run deployed');
  for (const step of [build, deploy, proof]) {
    expect(step?.env?.CLOUDFLARE_UNITS_JSON).toBe(expression('steps.impact.outputs.cloudflare'));
  }
  // The build step is each unit's `cloudflare:deploy` without its final `wrangler deploy`.
  expect(build?.run).toContain('run cloudflare:build');
  expect(build?.run).toContain('cloudflare-output-verify --app "$id" --require-public-urls');
  expect(deploy?.run).toContain('exec wrangler deploy --config .output/wrangler.json');
  expect(proof?.run).toContain('run cloudflare:proof');
  // The placed units' CORS allowlist needs the real Shell origin before any Worker is built.
  const buildRun = build?.run ?? '';
  // Build configuration comes from the reviewed placement document, not from environment
  // variables a Git diff cannot see.
  for (const step of [build, proof]) {
    expect(step?.run).toContain(
      ".buildEnvironment | to_entries[] | [.key, .value] | @tsv' topology/cloudflare-placement.json",
    );
    expect(JSON.stringify(step?.env)).not.toContain('vars');
  }
  expect(buildRun).toContain('ULTRAMODERN_MF_DEV_ORIGIN');
  expect(buildRun.indexOf('ULTRAMODERN_MF_DEV_ORIGIN')).toBeLessThan(buildRun.indexOf('run cloudflare:build'));
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
  expect(tokenSteps.map((step) => step.name)).toEqual([
    'Deploy planned edge units in dependency order',
    'Restore the edge Workers this run deployed',
  ]);
  expect(tokenSteps.flatMap(packageCommands).filter((command) => !WRANGLER_COMMAND.test(command))).toEqual([]);
});
