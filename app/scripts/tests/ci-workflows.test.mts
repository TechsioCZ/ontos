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
  }),
});

it('deploys planned edge units to Cloudflare after the stage migration, with their own deployment history', () => {
  const { jobs } = Schema.decodeUnknownSync(EdgeDeployWorkflowSchema)(
    parse(
      readFileSync(new URL('../../../.github/workflows/ultramodern-workspace-gates.yml', import.meta.url), 'utf-8'),
    ),
  );
  const edge = jobs['deploy-cloudflare'];
  // A separate environment keeps a failed or skipped edge deploy from hiding behind a successful
  // Zerops deployment of the same revision.
  expect(jobs['deploy-stage'].environment).toBe('stage');
  expect(edge.environment).toBe('stage-edge');
  expect(edge.needs).toEqual(['deploy-stage']);
  expect(edge.if).toContain("github.ref == 'refs/heads/main'");
  // Unconfigured repositories skip the job, so it records no deployment at all.
  expect(edge.if).toContain("vars.CLOUDFLARE_ACCOUNT_ID != ''");
  expect(edge.env).toBeUndefined();
  const byName = new Map(edge.steps.map((step) => [step.name, step]));
  expect(byName.get('Resolve the last successful edge deployment')?.run).toContain('--environment stage-edge');
  expect(byName.get('Plan the impacted edge units')?.id).toBe('impact');
  const deploy = byName.get('Deploy planned edge units in dependency order');
  expect(deploy?.env?.CLOUDFLARE_UNITS_JSON).toBe(expression('steps.impact.outputs.cloudflare'));
  expect(deploy?.run).toContain('run cloudflare:deploy');
  expect(deploy?.run).toContain('run cloudflare:proof');
  // Rollback returns each Worker to the version recorded before its deploy and verifies it.
  expect(deploy?.run).toContain('wrangler deployments status');
  expect(deploy?.run).toContain('wrangler rollback "$previous_version"');
  expect(deploy?.run).not.toMatch(/wrangler rollback[^\n]*\|\| true/u);
  // The placed units' CORS allowlist needs the real Shell origin before any Worker changes.
  expect(deploy?.run).toContain('ULTRAMODERN_MF_DEV_ORIGIN');
  const deployRun = deploy?.run ?? '';
  expect(deployRun.indexOf('ULTRAMODERN_MF_DEV_ORIGIN')).toBeLessThan(deployRun.indexOf('mapfile'));
  // A Worker this run created is removed again, so a failed first deploy leaves nothing public.
  expect(deploy?.run).toContain('wrangler delete --name "$deployed_worker"');
  // The account token reaches only the steps that use it.
  const tokenSteps = edge.steps.filter((step) => step.env?.CLOUDFLARE_API_TOKEN !== undefined).map((step) => step.name);
  expect(tokenSteps).toEqual(['Require the Cloudflare deploy token', 'Deploy planned edge units in dependency order']);
});
