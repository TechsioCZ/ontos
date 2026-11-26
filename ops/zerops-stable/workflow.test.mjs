import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const { parse } = createRequire(new URL('../../app/package.json', import.meta.url))('yaml');

const text = readFileSync(new URL('../../.github/workflows/zerops-stable.yml', import.meta.url), 'utf8');
const workflow = parse(text);
const jobs = Object.entries(workflow.jobs);
const steps = jobs.flatMap(([, job]) => job.steps ?? []);
const runs = (name) => workflow.jobs[name].steps.map((step) => step.run ?? '').join('\n');

test('demo pushes test the release tooling and nothing else runs on a push', () => {
  assert.deepEqual(workflow.on.push.branches, ['demo/sales-crm']);
  for (const source of ['ops/zerops-stable/**', 'app/zerops.yaml', 'app/scripts/zerops/push-service.sh', 'app/scripts/zerops/route-stage-domains.sh']) {
    assert.ok(workflow.on.push.paths.includes(source), source);
  }
  assert.ok(runs('test').includes("node --test --test-concurrency=1 'ops/zerops-stable/*.test.mjs'"));
  for (const [name, job] of jobs) {
    const onPush = name === 'test' || name === 'shared-runtime';
    assert.equal(job.if?.includes("github.event_name == 'push'") ?? false, onPush, name);
  }
});

test('a dispatch takes a tag or ref and one mode, and each mode runs its own jobs after the pin', () => {
  const { ref, mode } = workflow.on.workflow_dispatch.inputs;
  assert.equal(ref.default, 'demo/sales-crm');
  assert.deepEqual(mode.options, ['build', 'deploy', 'verify']);
  assert.match(workflow.jobs.pin.if, /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/demo\/sales-crm'/u);
  assert.equal(workflow.jobs.build.if, "inputs.mode != 'verify'");
  assert.equal(workflow.jobs.deploy.if, "inputs.mode == 'deploy'");
  assert.deepEqual(workflow.jobs.deploy.needs, ['pin', 'build']);
  assert.equal(workflow.jobs.verify.if, "inputs.mode == 'verify'");
  assert.ok(runs('pin').includes('release.mjs pin --tag "$tag" --ref "$commit" --push'));
  assert.ok(runs('pin').includes('release.mjs inspect --tag "$tag"'));
  assert.equal(workflow.jobs.pin.permissions.contents, 'write');
  assert.equal(workflow.concurrency['cancel-in-progress'], "${{ github.event_name == 'push' }}");
});

test('the jobs run deploy.mjs build, install and verify on the pinned commit, and bootstrap a fresh project for real', () => {
  for (const name of ['build', 'deploy', 'verify']) {
    const checkout = workflow.jobs[name].steps.find((step) => step.uses?.startsWith('actions/checkout'));
    assert.equal(checkout.with.ref, '${{ needs.pin.outputs.sha }}');
    assert.equal(checkout.with['fetch-depth'], 0);
    assert.equal(checkout.with['persist-credentials'], false);
  }
  assert.ok(runs('build').includes('deploy.mjs build --config'));
  const upload = workflow.jobs.build.steps.find((step) => step.uses?.startsWith('actions/upload-artifact'));
  assert.equal(upload.with['include-hidden-files'], true, 'the storefront packages are dotfiles');
  const deploy = runs('deploy');
  assert.ok(deploy.includes('deploy.mjs install --config "$STABLE_CONFIG" --tag "$TAG" --artifacts "$ARTIFACTS" --execute'));
  assert.ok(deploy.includes('gha-bootstrap.mjs before-app --config "$STABLE_CONFIG" --tag "$TAG" --apply'));
  assert.ok(deploy.includes('gha-bootstrap.mjs after-app --config "$STABLE_CONFIG" --tag "$TAG" --apply'));
  assert.ok(deploy.includes('route-stage-domains.sh'));
  assert.ok(deploy.includes('deploy.mjs verify'));
  assert.ok(runs('verify').includes('deploy.mjs verify'));
  const names = workflow.jobs.deploy.steps.map((step) => step.name);
  const order = ['Join the stable project VPN', 'Bootstrap the project before the first app deploy', 'Install', 'Route the installed hostnames',
    'Wait for the Shell origin to answer HTTPS', 'Bootstrap the project after the first app deploy', 'Install the fronts', "Clear this runner's VPN key and configuration"];
  const positions = order.map((name) => names.indexOf(name));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])), positions.join(','));
});

test('the VPN joins with the proven zcli setup and always clears its own key', () => {
  const vpn = workflow.jobs.deploy.steps.find((step) => step.name === 'Join the stable project VPN');
  for (const piece of ['wireguard-tools systemd-resolved iputils-ping', 'systemctl start systemd-resolved', '@zerops/zcli@1.1.3', '--mtu 1350', 'sudo --preserve-env=ZEROPS_TOKEN']) {
    assert.ok(vpn.run.includes(piece), piece);
  }
  assert.doesNotMatch(vpn.run, /login "\$ZEROPS_TOKEN"/u);
  const clear = workflow.jobs.deploy.steps.find((step) => step.name === "Clear this runner's VPN key and configuration");
  assert.match(clear.if, /^always\(\)/u);
  assert.ok(clear.run.includes('vpn clear --project-id'));
});

test('credentials reach only sales-stable jobs, through env, and never shell source or the build', () => {
  for (const [name, job] of jobs) {
    if (JSON.stringify(job).includes('secrets.')) assert.equal(job.environment?.name, 'sales-stable', name);
  }
  for (const step of steps) {
    assert.doesNotMatch(step.run ?? '', /\$\{\{/u, step.name);
    assert.doesNotMatch(JSON.stringify(step.with ?? {}), /secrets\./u, step.name);
  }
  assert.doesNotMatch(JSON.stringify(workflow.jobs.build), /ZEROPS_TOKEN|CLOUDFLARE_API_TOKEN/u);
  assert.doesNotMatch(text, /set -x/u);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  for (const step of steps) {
    if (step.uses && !step.uses.startsWith('./')) assert.match(step.uses, /@[0-9a-f]{40}$/u);
  }
});
