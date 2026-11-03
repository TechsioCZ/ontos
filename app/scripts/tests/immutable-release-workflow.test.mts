import { readFileSync } from 'node:fs';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

const CANDIDATE_FLAG = '--candidate-file';
const UPLOAD_ACTION = 'actions/upload-artifact@';
const MIGRATION_JOB = 'deploy-migrations';
const NODE_PLAN_JOB = 'node-release-plan';
const NODE_PREFLIGHT_JOB = 'prepare-node-composition';
const INTENT_FLAG = '--intent-file';
const SELECTION_FLAG = '--selection-file';
const StepSchema = Schema.Struct({
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  id: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.String),
  name: Schema.String,
  run: Schema.optionalKey(Schema.String),
  'timeout-minutes': Schema.optionalKey(Schema.Number),
  uses: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
const JobSchema = Schema.Struct({
  concurrency: Schema.optionalKey(Schema.Struct({ 'cancel-in-progress': Schema.Boolean, group: Schema.String })),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  environment: Schema.optionalKey(Schema.Json),
  if: Schema.optionalKey(Schema.String),
  needs: Schema.optionalKey(Schema.Array(Schema.String)),
  outputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  steps: Schema.Array(StepSchema),
});
const WorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    'deploy-cloudflare': JobSchema,
    'deploy-migrations': JobSchema,
    'deploy-node-backends': JobSchema,
    'deploy-zerops': JobSchema,
    'edge-build': JobSchema,
    'edge-plan': JobSchema,
    'finalize-edge-deployment': JobSchema,
    'node-release-build': JobSchema,
    'node-release-plan': JobSchema,
    'prepare-node-composition': JobSchema,
    'publish-edge-composition': JobSchema,
  }),
});
const readJobs = () =>
  Schema.decodeUnknownSync(WorkflowSchema)(
    parse(
      readFileSync(new URL('../../../.github/workflows/ultramodern-workspace-gates.yml', import.meta.url), 'utf-8'),
    ),
  ).jobs;
const IMMUTABLE_SCRIPT = 'immutable-application-release.mts';
const RECEIPT_FILE_FLAG = '--receipt-file';
const SHARED_LOCK = 'zerops-stage';
const CANDIDATE_ARTIFACT = 'prepared-application-release';
const CANDIDATE_FILE = 'candidate.json';
const SHELL_SCRIPT = 'immutable-shell-release.mts';
const SHELL_BUILD_ARTIFACT = `edge-unit-shell-super-app-\${{ github.run_attempt }}`;
const SHELL_RECEIPT_ARTIFACT = CANDIDATE_ARTIFACT;
const SHELL_RECEIPT_FILE = 'shell-super-app.json';
const CHANGED_SHELL_CONDITION = "contains(fromJSON(needs.edge-plan.outputs.cloudflare).*.id, 'shell-super-app')";

it('selects the full reviewed module release before creating independent build shards', () => {
  const jobs = readJobs();
  const plan = jobs['edge-plan'];
  const selection = plan?.steps.find(({ run }) => run?.includes(`${IMMUTABLE_SCRIPT} select`) === true);
  expect(selection).toBeDefined();
  expect(selection?.run).toContain(INTENT_FLAG);
  expect(selection?.run).toContain('--impacted-units-file');
  expect(selection?.run).toContain(SELECTION_FLAG);
  expect(selection?.env?.CLOUDFLARE_API_TOKEN).toBeUndefined();
  expect(JSON.stringify(plan)).not.toContain('secrets.');
});

it('derives the retained origin before each module build and transports the same plan with its output', () => {
  const jobs = readJobs();
  const steps = jobs['edge-build']?.steps ?? [];
  const origin = steps.find(({ run }) => run?.includes(`${IMMUTABLE_SCRIPT} plan`) === true);
  const build = steps.find(({ run }) => run?.includes('run cloudflare:build') === true);
  const archive = steps.find(({ run }) => run?.includes('tar ') === true && run.includes('--create'));
  expect(origin).toBeDefined();
  expect(build).toBeDefined();
  expect(archive).toBeDefined();
  expect(steps.findIndex(({ name }) => name === origin?.name)).toBeLessThan(
    steps.findIndex(({ name }) => name === build?.name),
  );
  expect(origin?.run).toContain('--workers-dev-subdomain');
  expect(origin?.run).toContain('--plan-file');
  expect(origin?.['timeout-minutes']).toBeGreaterThan(0);
  expect(build?.run).toContain('MODERN_ASSET_PREFIX');
  expect(archive?.run).toContain('plan');
  expect(JSON.stringify(jobs['edge-build'])).not.toContain('secrets.');
  expect(JSON.stringify(jobs['edge-build'])).not.toContain('CLOUDFLARE_API_TOKEN');
});

it('uses native immutable deployment receipts and leaves a failed release retained for investigation', () => {
  const jobs = readJobs();
  const edge = jobs['deploy-cloudflare'];
  const deploy = edge?.steps.find(({ id }) => id === 'deploy');
  const candidate = edge?.steps.find(({ id }) => id === 'candidate');
  expect(edge?.concurrency).toEqual({ 'cancel-in-progress': false, group: SHARED_LOCK });
  expect(deploy?.run).toContain(`${IMMUTABLE_SCRIPT} deploy`);
  expect(deploy?.run).not.toContain('--namespace');
  expect(deploy?.run).not.toContain('--dispatch-namespace');
  expect(deploy?.run).toContain(RECEIPT_FILE_FLAG);
  expect(candidate?.run).toContain(`${IMMUTABLE_SCRIPT} candidate`);
  expect(candidate?.run).toContain(RECEIPT_FILE_FLAG);
  expect(candidate?.run).toContain(CANDIDATE_FLAG);
  expect(candidate?.run).not.toContain('cloudflare-placement.json');
  const scripts = edge?.steps.map(({ run }) => run ?? '').join('\n') ?? '';
  expect(scripts).not.toMatch(/wrangler\s+(?:rollback|delete|versions\s+deploy)\b/u);
  expect(scripts).not.toContain('previous_version');
});

it('uploads retained Shell assets without changing public ingress or recording deployment success', () => {
  const jobs = readJobs();
  const edge = jobs['deploy-cloudflare'];
  const shell = edge?.steps.find(({ id }) => id === 'shell-deploy');
  expect(edge.environment).toEqual({ deployment: false, name: 'stage-edge' });
  expect(shell).toBeDefined();
  expect(shell?.run).toContain('shell-super-app');
  expect(shell?.run).toContain(`${SHELL_SCRIPT} deploy`);
  expect(shell?.run).not.toContain(`${SHELL_SCRIPT} ingress-deploy`);
  expect(shell?.run).toContain('--plan-file');
  expect(shell?.run).toContain(RECEIPT_FILE_FLAG);
  expect(shell?.['timeout-minutes']).toBeGreaterThan(0);
  const candidate = edge?.steps.find(({ id }) => id === 'candidate');
  expect(candidate?.run).toContain('--shell-receipt-file');
  const moduleDeploy = edge?.steps.find(({ id }) => id === 'deploy');
  expect(moduleDeploy?.run).toContain('shell-super-app');
  expect(moduleDeploy?.run).not.toContain('exec wrangler deploy');
  expect(edge.steps.map(({ run }) => run ?? '').join('\n')).not.toContain(`${SHELL_SCRIPT} ingress-deploy`);
});

it('finalizes deployment history and changed Shell ingress only after successful composition publication', () => {
  const jobs = readJobs();
  const finalize = jobs['finalize-edge-deployment'];
  expect(finalize.needs).toEqual(
    expect.arrayContaining(['deploy-target', 'edge-plan', 'deploy-cloudflare', 'publish-edge-composition']),
  );
  expect(finalize.if).toContain("needs.deploy-target.outputs.target == 'cloudflare'");
  expect(finalize.if).toContain("needs.publish-edge-composition.result == 'success'");
  expect(finalize.environment).toBe('stage-edge');
  expect(finalize.concurrency).toEqual({ 'cancel-in-progress': false, group: SHARED_LOCK });
  const ingress = finalize.steps.find(({ run }) => run?.includes(`${SHELL_SCRIPT} ingress-deploy`) === true);
  expect(ingress).toBeDefined();
  expect(ingress?.run).toContain('--app-directory apps/shell-super-app');
  expect(ingress?.run).toContain(RECEIPT_FILE_FLAG);
  expect(ingress?.['timeout-minutes']).toBeGreaterThan(0);
  expect(ingress?.env?.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL).toBe(
    `\${{ vars.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL }}`,
  );
  expect(finalize.steps.map(({ run }) => run ?? '').join('\n')).not.toMatch(
    /wrangler\s+(?:rollback|delete|versions\s+deploy)\b/u,
  );
});

it("hands the same run's native Shell build and exact static receipt to the changed ingress", () => {
  const jobs = readJobs();
  const receiptUpload = jobs['deploy-cloudflare'].steps.find(
    ({ uses, with: settings }) => uses?.startsWith(UPLOAD_ACTION) === true && settings?.name === CANDIDATE_ARTIFACT,
  );
  expect(receiptUpload).toBeDefined();
  expect(receiptUpload?.with?.path).toBe(`\${{ runner.temp }}/prepared-release`);
  expect(receiptUpload?.with?.['if-no-files-found']).toBe('error');
  const finalize = jobs['finalize-edge-deployment'];
  const downloads = finalize.steps.filter(({ uses }) => uses?.startsWith('actions/download-artifact@') === true);
  expect(downloads).toHaveLength(2);
  expect(downloads.map(({ with: settings }) => settings?.name)).toEqual(
    expect.arrayContaining([SHELL_BUILD_ARTIFACT, SHELL_RECEIPT_ARTIFACT]),
  );
  for (const download of downloads) {
    expect(download.if).toBe(CHANGED_SHELL_CONDITION);
    expect(download.with?.['run-id']).toBeUndefined();
    expect(download.with?.repository).toBeUndefined();
  }
  const unpack = finalize.steps.find(({ run }) => run?.includes('tar --extract --zstd') === true);
  const ingress = finalize.steps.find(({ run }) => run?.includes(`${SHELL_SCRIPT} ingress-deploy`) === true);
  expect(unpack).toBeDefined();
  expect(unpack?.run).toContain('$RUNNER_TEMP/shell-build/edge-unit.tar.zst');
  expect(unpack?.run).toContain('.codex/reports/releases/shell-super-app/plan.json');
  expect(unpack?.if).toBe(ingress?.if);
  expect(downloads.every((download) => download.if === ingress?.if)).toBe(true);
  expect(finalize.steps.findIndex(({ name }) => name === unpack?.name)).toBeLessThan(
    finalize.steps.findIndex(({ name }) => name === ingress?.name),
  );
  expect(ingress?.run).toContain(`$RUNNER_TEMP/prepared-release/receipts/${SHELL_RECEIPT_FILE}`);
  expect(downloads.find(({ with: settings }) => settings?.name === SHELL_BUILD_ARTIFACT)?.with?.path).toBe(
    `\${{ runner.temp }}/shell-build`,
  );
  expect(downloads.find(({ with: settings }) => settings?.name === SHELL_RECEIPT_ARTIFACT)?.with?.path).toBe(
    `\${{ runner.temp }}/prepared-release`,
  );
});

it('skips public Shell ingress when the reviewed release does not change the Shell', () => {
  const finalize = readJobs()['finalize-edge-deployment'];
  const ingress = finalize.steps.find(({ run }) => run?.includes(`${SHELL_SCRIPT} ingress-deploy`) === true);
  expect(ingress?.if).toBe(CHANGED_SHELL_CONDITION);
  expect(ingress?.if).not.toBe(finalize.if);
});

it('hands the exact original prepared candidate and expected target to CF publication', () => {
  const jobs = readJobs();
  const upload = jobs['deploy-cloudflare'].steps.find(
    ({ uses, with: settings }) => uses?.startsWith(UPLOAD_ACTION) === true && settings?.name === CANDIDATE_ARTIFACT,
  );
  expect(upload?.with?.path).toContain('prepared-release');
  const publish = jobs['publish-edge-composition'];
  const download = publish.steps.find(
    ({ uses, with: settings }) =>
      uses?.startsWith('actions/download-artifact@') === true && settings?.name === CANDIDATE_ARTIFACT,
  );
  expect(download?.with?.name).toBe(CANDIDATE_ARTIFACT);
  expect(publish.concurrency?.group).toBe(SHARED_LOCK);
  const publication = publish.steps.find(({ run }) => run?.includes('active-composition:publish publish') === true);
  for (const flag of [CANDIDATE_FLAG, '--expected-composition-file', SELECTION_FLAG, INTENT_FLAG]) {
    expect(publication?.run).toContain(flag);
  }
  expect(publication?.run).toContain(`prepared-release/${CANDIDATE_FILE}`);
  expect(publication?.run).toContain('.intentFile');
});

const NODE_DEPLOY_JOB = 'deploy-node-backends';
const PREPARED_PATH = '$RUNNER_TEMP/prepared-release';
const DEPLOYED_PATH = '$RUNNER_TEMP/deployed-node-release';
const jobScript = (job: typeof JobSchema.Type) => job.steps.map(({ run }) => run ?? '').join('\n');

it('keeps the two staging branches before independent migrations and avoids a deployment DAG cycle', () => {
  const jobs = readJobs();
  expect(jobs['deploy-cloudflare'].needs).not.toContain(MIGRATION_JOB);
  expect(jobs[NODE_PREFLIGHT_JOB].needs).not.toContain(MIGRATION_JOB);
  expect(jobs[MIGRATION_JOB].needs).toEqual(expect.arrayContaining(['deploy-cloudflare', NODE_PREFLIGHT_JOB]));
  expect(jobs[NODE_DEPLOY_JOB].needs).toContain(MIGRATION_JOB);
  expect(jobs['deploy-zerops'].needs).toContain(NODE_DEPLOY_JOB);
  expect(jobs['deploy-zerops'].if).toContain(
    "needs.deploy-target.outputs.target == 'cloudflare' || needs.deploy-node-backends.result == 'success'",
  );
  const graph = Schema.decodeUnknownSync(
    Schema.Struct({
      jobs: Schema.Record(
        Schema.String,
        Schema.Struct({ needs: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])) }),
      ),
    }),
  )(
    parse(
      readFileSync(new URL('../../../.github/workflows/ultramodern-workspace-gates.yml', import.meta.url), 'utf-8'),
    ),
  ).jobs;
  const pending = new Map(
    Object.entries(graph).map(([id, node]) => [
      id,
      Schema.is(Schema.String)(node.needs) ? [node.needs] : (node.needs ?? []),
    ]),
  );
  const completed = new Set<string>();
  while (pending.size > 0) {
    const ready = [...pending].filter(([, dependencies]) =>
      dependencies.every((dependency) => completed.has(dependency)),
    );
    expect(ready.length).toBeGreaterThan(0);
    for (const [id] of ready) {
      completed.add(id);
      pending.delete(id);
    }
  }
});

it('uses original source plans and selection for retry matrices and carries their reviewed intent into preflight', () => {
  const jobs = readJobs();
  const plan = jobs[NODE_PLAN_JOB];
  expect(plan.outputs?.['fresh-units']).toBe(`\${{ steps.original-selection.outputs.fresh }}`);
  expect(jobScript(plan)).toContain('node-release-plans/selection.json');
  expect(jobScript(plan)).toContain('reviewed-release-input.json');
  expect(jobScript(plan)).toContain('.sourceRevision == $source');
  expect(jobs['node-release-build'].if).toContain("needs.node-release-plan.outputs.fresh-units != '[]'");
  expect(JSON.stringify(jobs['node-release-build'])).not.toContain('secrets.');
  const preflight = jobScript(jobs[NODE_PREFLIGHT_JOB]);
  expect(preflight).toContain('node-release-plans/metadata.json');
  expect(preflight).toContain('node-candidate --phase preflight');
  expect(preflight).toContain('--approved-baseline-file');
  expect(preflight).toContain('application-release-receipts-$BASELINE_REVISION');
  expect(preflight).toContain('.workflow_run.head_branch ==');
});

it('deploys business slots then Shell using actual same-attempt artifacts and guarded source pushes', () => {
  const deploy = readJobs()[NODE_DEPLOY_JOB];
  expect(deploy.environment).toEqual({
    deployment: false,
    name: `\${{ needs.deploy-target.outputs.environment == 'stage' && 'stage-edge' || needs.deploy-target.outputs.environment }}`,
  });
  const download = deploy.steps.find(
    ({ with: settings }) => settings?.pattern === `node-release-unit-*-\${{ github.run_attempt }}`,
  );
  expect(download?.if).toContain("needs.node-release-plan.outputs.fresh-units != '[]'");
  const push = deploy.steps.find(({ run }) => run?.includes(' node-deploy ') === true);
  expect(push?.run).toContain('plans/deployment-order.json');
  expect(jobScript(readJobs()[NODE_PLAN_JOB])).toContain('deployment-impact:plan');
  expect(jobScript(readJobs()[NODE_PLAN_JOB])).toContain('select(.kind == "provider")');
  expect(jobScript(readJobs()[NODE_PLAN_JOB])).toContain('$selection.shell.unit');
  for (const flag of [
    '--assets-receipt-file',
    CANDIDATE_FLAG,
    SELECTION_FLAG,
    '--expected-composition-file',
    INTENT_FLAG,
    '--zerops-yaml-path',
    '--receipt-file',
  ]) {
    expect(push?.run).toContain(flag);
  }
  expect(push?.run).toContain(`${PREPARED_PATH}/candidate.json`);
  expect(jobScript(deploy)).not.toContain('push-zerops-units.sh');
  expect(jobScript(deploy)).not.toMatch(/zcli\s+push/u);
  expect(deploy.env?.CLOUDFLARE_API_TOKEN).toBeUndefined();
  expect(push?.env?.CLOUDFLARE_API_TOKEN).toContain('secrets.CLOUDFLARE_API_TOKEN');
});

it('allows zero fresh Node slots without downloading missing build shards while still verifying complete receipts', () => {
  const deploy = readJobs()[NODE_DEPLOY_JOB];
  expect(deploy.if).not.toContain("fresh-units != '[]'");
  const verify = deploy.steps.find(({ id }) => id === 'candidate');
  expect(verify?.if).toBeUndefined();
  expect(verify?.run).toContain('node-candidate --phase deployed');
  expect(verify?.run).toContain('.complete[].id');
  expect(verify?.run).toContain('--shell-receipt-file');
  expect(verify?.run).not.toContain('--assets-receipt-file');
  expect(verify?.run).toContain('cmp <(jq -S .');
  expect(verify?.run).toContain(`${PREPARED_PATH}/candidate.json`);
});

it('recovers a complete original deployed handoff before retry effects and archives it before exact-R receipts', () => {
  const deploy = readJobs()[NODE_DEPLOY_JOB];
  const recover = deploy.steps.find(({ with: settings }) => settings?.name === 'deployed-node-release');
  const push = deploy.steps.find(({ run }) => run?.includes(' node-deploy ') === true);
  expect(recover?.if).toContain("steps.recovery.outputs.complete == 'true'");
  expect(push?.if).toBe("steps.recovery.outputs.complete != 'true'");
  expect(jobScript(deploy)).toContain('receipt_archive');
  expect(jobScript(deploy)).toContain('refusing a new backend push');
  expect(deploy.steps.indexOf(recover ?? deploy.steps[0])).toBeLessThan(deploy.steps.indexOf(push ?? deploy.steps[0]));
  const upload = deploy.steps.find(
    ({ uses, with: settings }) =>
      uses?.startsWith(UPLOAD_ACTION) === true && settings?.name === 'deployed-node-release',
  );
  const archive = deploy.steps.find(
    ({ with: settings }) => settings?.name === `application-release-receipts-\${{ steps.identity.outputs.revision }}`,
  );
  expect(deploy.steps.indexOf(upload ?? deploy.steps[0])).toBeLessThan(
    deploy.steps.indexOf(archive ?? deploy.steps[0]),
  );
  expect(archive?.if).toBe("steps.identity.outputs.archived != 'true'");
  expect(archive?.with?.path).toContain('deployed-node-release/receipts');
  expect(archive?.with?.overwrite).toBeUndefined();
  expect(upload?.with?.overwrite).toBeUndefined();
  expect(jobScript(deploy)).toContain('application-release-receipts-$revision');
  expect(jobScript(deploy)).toContain('.revision');
  expect(
    deploy.steps.some(({ with: settings }) => settings?.name === `node-deployment-evidence-\${{ github.run_attempt }}`),
  ).toBe(true);
});

it('keeps legacy pushes worker-only and publishes Node only after those workers using the original handoff', () => {
  const workers = readJobs()['deploy-zerops'];
  const pushes = workers.steps.filter(({ run }) => run?.includes('push-zerops-units.sh') === true);
  expect(pushes).toHaveLength(1);
  expect(pushes[0]?.env?.UNITS_JSON).toContain('needs.deploy-plan.outputs.providers');
  expect(workers.steps.some(({ name }) => name === 'Deploy Shell after affected providers')).toBe(false);
  const publication = workers.steps.find(({ run }) => run?.includes('active-composition:publish publish') === true);
  const stop = workers.steps.find(({ run }) => run?.includes('stop-service') === true);
  expect(workers.steps.indexOf(stop ?? workers.steps[0])).toBeLessThan(
    workers.steps.indexOf(publication ?? workers.steps[0]),
  );
  expect(publication?.run).toContain(`${DEPLOYED_PATH}/candidate.json`);
  expect(publication?.run).toContain(`${DEPLOYED_PATH}/expected-composition.json`);
  expect(publication?.run).toContain('.intentFile');
  expect(publication?.env?.COMPOSITION_CANDIDATE_FILE).toBeUndefined();
  expect(publication?.run).not.toContain('put-edge-composition');
});
