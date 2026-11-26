import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

// Policy checks of the two sales-stable workflows. They read the YAML only; no workflow runs here.
const WORKFLOWS = new URL('../../.github/workflows/', import.meta.url);
const read = (file) => readFileSync(new URL(file, WORKFLOWS), 'utf-8');
const checksText = read('zerops-stable-checks.yml');
const stableText = read('zerops-stable.yml');
const checks = parse(checksText);
const stable = parse(stableText);
const jobs = (workflow) => Object.entries(workflow.jobs);
const steps = (workflow) => jobs(workflow).flatMap(([, job]) => job.steps ?? []);
const runs = (workflow) => steps(workflow).map((step) => step.run ?? '');

test('the checks run the sales-stable tests on demo pushes to the tooling and on dispatch only', () => {
  assert.deepEqual(Object.keys(checks.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(checks.on.push.branches, ['demo/sales-crm']);
  assert.deepEqual(checks.on.push.paths, [
    'ops/zerops-stable/**',
    '.github/workflows/zerops-stable.yml',
    '.github/workflows/zerops-stable-checks.yml',
  ]);
  assert.ok(runs(checks).some((run) => run === "node --test 'ops/zerops-stable/*.test.mjs'"));
  assert.ok(runs(checks).some((run) => run.startsWith('npm ci --prefix ops/zerops-stable')));
  assert.ok(!steps(checks).some((step) => step.uses === './.github/actions/install-app'));
});

test('the release workflow is manual only and exposes just the tag and the mode', () => {
  assert.deepEqual(Object.keys(stable.on), ['workflow_dispatch']);
  assert.doesNotMatch(stableText, /^\s*(schedule|push|pull_request|workflow_run|repository_dispatch):/m);
  assert.deepEqual(Object.keys(stable.on.workflow_dispatch.inputs).sort(), ['mode', 'tag']);
  assert.equal(stable.on.workflow_dispatch.inputs.tag.required, true);
  assert.deepEqual(stable.on.workflow_dispatch.inputs.mode.options, ['build', 'verify-candidate', 'verify-deployed']);
  assert.equal(stable.on.workflow_dispatch.inputs.mode.default, 'build');
});

test('the tag pin accepts only sales-stable dates with an optional counter', () => {
  const run = stable.jobs.pin.steps.find((step) => step.id === 'tag').run;
  const [, source] = /pattern='([^']+)'/.exec(run);
  const pattern = new RegExp(source);
  for (const tag of ['sales-stable/2026-11-26', 'sales-stable/2026-11-26-2']) assert.match(tag, pattern);
  for (const tag of ['sales-stable/2026-11-26-', 'sales-stable/26-11-26', 'demo/sales-crm', 'sales-stable/2026-11-26;id']) {
    assert.doesNotMatch(tag, pattern);
  }
});

test('the sales-stable config is a secret of the sales-stable environment, never of stage or demo', () => {
  assert.doesNotMatch(stableText, /stage-edge/);
  assert.doesNotMatch(stableText, /\bvars\./);
  for (const [name, job] of jobs(stable)) {
    if (!JSON.stringify(job).includes('secrets.')) continue;
    assert.equal(job.environment?.name, 'sales-stable', `${name} reads secrets outside sales-stable`);
  }
  assert.ok(jobs(stable).some(([, job]) => JSON.stringify(job).includes('secrets.STABLE_CONFIG_JSON')));
});

test('the build job never receives a Zerops token and never deploys', () => {
  const build = stable.jobs.build;
  assert.doesNotMatch(JSON.stringify(build), /ZEROPS_TOKEN/);
  const deployRuns = runs({ jobs: { build } }).filter((run) => run.includes('deploy.mjs'));
  assert.equal(deployRuns.length, 1);
  assert.match(deployRuns[0], /deploy\.mjs --build-only --config "\$STABLE_CONFIG" --tag "\$TAG" --output /);
  assert.doesNotMatch(runs(stable).join('\n'), /--maintenance-confirmed|--evidence|--backup|--emergency-reason/);
  assert.equal(build.if, "inputs.mode == 'build'");
});

test('the build and the verification run the pinned commit, never the moving branch', () => {
  for (const name of ['build', 'verify']) {
    const checkout = stable.jobs[name].steps.find((step) => step.uses?.startsWith('actions/checkout'));
    assert.equal(checkout.with.ref, '${{ needs.pin.outputs.sha }}', name);
    assert.equal(stable.jobs[name].needs, 'pin');
  }
});

test('run blocks never interpolate workflow values; they take them through env', () => {
  for (const workflow of [checks, stable]) {
    for (const run of runs(workflow)) assert.doesNotMatch(run, /\$\{\{/);
  }
});

test('every job has a timeout of at most an hour and every third-party action is pinned to a commit', () => {
  for (const workflow of [checks, stable]) {
    for (const [name, job] of jobs(workflow)) {
      assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 60, name);
    }
    for (const step of steps(workflow)) {
      if (!step.uses || step.uses.startsWith('./')) continue;
      assert.match(step.uses, /@[0-9a-f]{40}$/, step.uses);
    }
  }
  assert.deepEqual(stable.permissions, { contents: 'read' });
  assert.deepEqual(checks.permissions, { contents: 'read' });
});
