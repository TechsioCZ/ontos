import { readFileSync } from 'node:fs';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

const Step = Schema.Struct({
  env: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  if: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
  with: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))),
});
const Workflow = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      env: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      steps: Schema.Array(Step),
    }),
  ),
});
const evidenceVariable = 'ONTOS_LEGACY_COMPLETION_EVIDENCE_DIRECTORY';

it('gives every composition migration, publication and refresh private runner-owned retained evidence', () => {
  let invocations = 0;
  for (const name of ['ultramodern-workspace-gates.yml', 'active-application-composition-refresh.yml']) {
    const workflow = Schema.decodeUnknownSync(Workflow)(
      parse(readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf-8')),
    );
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      for (const [stepIndex, step] of job.steps.entries()) {
        if (!/active-composition:publish\s+(?:migrate|publish|refresh)(?:\s|$)/u.test(step.run ?? '')) {
          continue;
        }
        invocations += 1;
        // runner is unavailable in jobs.<job_id>.env; export the native runner path from an earlier step.
        expect(job.env?.[evidenceVariable], jobName).toBeUndefined();
        expect(step.env?.[evidenceVariable]).toBeUndefined();
        expect(
          job.steps.slice(0, stepIndex).some((candidate) => {
            const preparation = candidate.run ?? '';
            const assignment = preparation.indexOf(
              'ONTOS_LEGACY_COMPLETION_EVIDENCE_DIRECTORY="$RUNNER_TEMP/legacy-completion-evidence"',
            );
            const creation = preparation.indexOf('install -d -m 700 "$ONTOS_LEGACY_COMPLETION_EVIDENCE_DIRECTORY"');
            const publication = preparation.indexOf(
              String.raw`printf 'ONTOS_LEGACY_COMPLETION_EVIDENCE_DIRECTORY=%s\n' "$ONTOS_LEGACY_COMPLETION_EVIDENCE_DIRECTORY" >> "$GITHUB_ENV"`,
            );
            return assignment !== -1 && creation > assignment && publication > creation;
          }),
        ).toBe(true);
        expect(
          job.steps.some(
            (candidate) =>
              (candidate.uses ?? '').startsWith('actions/upload-artifact@') &&
              candidate.if === 'always()' &&
              candidate.with?.path === `\${{ runner.temp }}/legacy-completion-evidence` &&
              candidate.with?.['retention-days'] === 30,
          ),
        ).toBe(true);
      }
    }
  }
  expect(invocations).toBe(5);
});

it('keeps runner expressions out of job-level environment contexts', () => {
  for (const name of ['ultramodern-workspace-gates.yml', 'active-application-composition-refresh.yml']) {
    const workflow = Schema.decodeUnknownSync(Workflow)(
      parse(readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf-8')),
    );
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      expect(JSON.stringify(job.env ?? {}), jobName).not.toMatch(/\$\{\{[^}]*\brunner\s*(?:\.|\[)/u);
    }
  }
});

it('documents only native publication and renewal, not retired synchronization jobs or consumer restarts', () => {
  const deployment = readFileSync(new URL('../../docs/architecture/DEPLOYMENT.md', import.meta.url), 'utf-8');
  expect(deployment).not.toMatch(/sync-edge-composition|refresh-stage-edge|put-edge-composition-snapshot/u);
  expect(deployment).not.toContain('On `cloudflare` it restarts');
  expect(deployment).toContain('active-composition:publish refresh');
  expect(deployment).toContain('active-composition:publish publish');
});
