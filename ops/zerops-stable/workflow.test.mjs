import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const text = readFileSync(new URL('../../.github/workflows/zerops-stable.yml', import.meta.url), 'utf8');
const workflow = parse(text);
const jobs = Object.values(workflow.jobs);
const steps = jobs.flatMap((job) => job.steps ?? []);
const runs = steps.map((step) => step.run ?? '');

test('demo pushes test the standalone deployment tools without installing or deploying the app', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push.branches, ['demo/sales-crm']);
  for (const source of ['ops/zerops-stable/**', 'app/zerops.yaml', 'app/zerops-import.yaml', 'app/scripts/zerops/push-service.sh']) {
    assert.ok(workflow.on.push.paths.includes(source));
  }
  const testSteps = workflow.jobs.test.steps;
  assert.ok(testSteps.some((step) => step.run === "node --test 'ops/zerops-stable/*.test.mjs'"));
  assert.ok(testSteps.some((step) => step.run?.startsWith('npm ci --prefix ops/zerops-stable')));
  assert.ok(!testSteps.some((step) => step.uses === './.github/actions/install-app'));
});

test('candidate work is manually dispatched, follows the tooling checks, and never installs a release', () => {
  assert.match(workflow.jobs.pin.if, /github.event_name == 'workflow_dispatch'/u);
  assert.equal(workflow.jobs.pin.needs, 'test');
  assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options, ['build', 'verify-candidate', 'verify-deployed']);
  assert.doesNotMatch(runs.join('\n'), /--execute|--maintenance-confirmed|--confirm-paid-resources/u);
  assert.doesNotMatch(text, /^\s*schedule:/mu);
});

test('release builds have full tag history, exact pinned source, and no live deployment token', () => {
  for (const name of ['build', 'verify']) {
    const checkout = workflow.jobs[name].steps.find((step) => step.uses?.startsWith('actions/checkout'));
    assert.equal(checkout.with.ref, '${{ needs.pin.outputs.sha }}');
    assert.equal(checkout.with['fetch-depth'], 0);
    assert.equal(checkout.with['persist-credentials'], false);
    assert.equal(workflow.jobs[name].needs, 'pin');
  }
  assert.doesNotMatch(JSON.stringify(workflow.jobs.build), /ZEROPS_TOKEN/u);
  assert.ok(workflow.jobs.build.steps.some((step) => step.run?.includes('deploy.mjs --build-only')));
});

test('verification gets dedicated credentials and evidence instead of demo credentials or fabricated passes', () => {
  assert.doesNotMatch(text, /stage-edge/u);
  for (const job of jobs) {
    if (JSON.stringify(job).includes('secrets.')) assert.equal(job.environment?.name, 'sales-stable');
  }
  const verification = JSON.stringify(workflow.jobs.verify);
  for (const name of ['STABLE_CONFIG_JSON', 'STABLE_VERIFICATION_JSON', 'MIGRATION_EVIDENCE_JSON', 'WALKTHROUGH_EVIDENCE_JSON']) {
    assert.ok(verification.includes(`secrets.${name}`));
  }
  const command = workflow.jobs.verify.steps.find((step) => step.run?.includes('verify.mjs')).run;
  for (const arg of ['--tag "$TAG"', '--migration-evidence', '--walkthrough-evidence']) assert.ok(command.includes(arg));
});

test('workflow inputs never enter shell source and all third-party actions are pinned', () => {
  for (const run of runs) assert.doesNotMatch(run, /\$\{\{/u);
  for (const step of steps) {
    if (step.uses && !step.uses.startsWith('./')) assert.match(step.uses, /@[0-9a-f]{40}$/u);
  }
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  for (const job of jobs) assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 60);
});
