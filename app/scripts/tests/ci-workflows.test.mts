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

const EdgeDeployWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    'deploy-cloudflare': Schema.Struct({
      env: Schema.Record(Schema.String, Schema.String),
      if: Schema.String,
      needs: Schema.Array(Schema.String),
      steps: Schema.Array(
        Schema.Struct({
          id: Schema.optional(Schema.String),
          if: Schema.optional(Schema.String),
          run: Schema.optional(Schema.String),
        }),
      ),
    }),
    'deploy-stage': Schema.Struct({ outputs: Schema.Record(Schema.String, Schema.String) }),
  }),
});

it('deploys planned edge units to Cloudflare only after the stage migration and only with stage credentials', () => {
  const { jobs } = Schema.decodeUnknownSync(EdgeDeployWorkflowSchema)(
    parse(
      readFileSync(new URL('../../../.github/workflows/ultramodern-workspace-gates.yml', import.meta.url), 'utf-8'),
    ),
  );
  const edge = jobs['deploy-cloudflare'];
  expect(jobs['deploy-stage'].outputs.cloudflare).toBe(expression('steps.impact.outputs.cloudflare'));
  expect(edge.needs).toEqual(['deploy-stage']);
  expect(edge.if).toContain("github.ref == 'refs/heads/main'");
  expect(edge.if).toContain("needs.deploy-stage.outputs.cloudflare != '[]'");
  expect(edge.env).toEqual({
    CLOUDFLARE_ACCOUNT_ID: expression('vars.CLOUDFLARE_ACCOUNT_ID'),
    CLOUDFLARE_API_TOKEN: expression('secrets.CLOUDFLARE_API_TOKEN'),
  });
  const [, credentials, ...guarded] = edge.steps;
  expect(credentials?.id).toBe('credentials');
  for (const step of guarded) {
    expect(step.if).toBe("steps.credentials.outputs.enabled == 'true'");
  }
  const deploy = guarded.at(-1)?.run ?? '';
  expect(deploy).toContain('run cloudflare:deploy');
  expect(deploy).toContain('run cloudflare:proof');
  expect(deploy).toContain('wrangler rollback');
});
