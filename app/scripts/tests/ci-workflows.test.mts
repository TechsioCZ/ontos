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

const StepSchema = Schema.Struct({ name: Schema.String, run: Schema.optionalKey(Schema.String) });
const GateJobsSchema = Schema.Struct({
  jobs: Schema.Struct({ 'cloudflare-runtime': Schema.Struct({ steps: Schema.Array(StepSchema) }) }),
});

it('builds Commerce for Cloudflare against the full Catalog client barrel', () => {
  const workflow = Schema.decodeUnknownSync(GateJobsSchema)(
    parse(
      readFileSync(new URL('../../../.github/workflows/ultramodern-workspace-gates.yml', import.meta.url), 'utf-8'),
    ),
  );
  const guard = workflow.jobs['cloudflare-runtime'].steps.find(
    (step) => step.run?.includes("from '@app/catalog/api/client'") === true,
  );
  expect(guard?.run).toContain('src/integrations/catalog-quantity.ts');
  expect(guard?.run).toContain('MODERNJS_DEPLOY=cloudflare modern build');
  expect(guard?.run).not.toMatch(/RUST_MIN_STACK|ulimit/u);
});
