import { readFileSync } from 'node:fs';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

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
    'edge-build': JobSchema,
    'edge-plan': JobSchema,
    'finalize-edge-deployment': JobSchema,
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
const CANDIDATE_ARTIFACT = 'approved-application-composition-candidate';
const CANDIDATE_FILE = 'active-application-composition-candidate.json';
const SHELL_SCRIPT = 'immutable-shell-release.mts';
const SHELL_BUILD_ARTIFACT = 'edge-unit-shell-super-app';
const SHELL_RECEIPT_ARTIFACT = 'shell-artifact-release-receipt';
const SHELL_RECEIPT_FILE = 'shell-super-app.json';
const CHANGED_SHELL_CONDITION = "contains(fromJSON(needs.edge-plan.outputs.cloudflare).*.id, 'shell-super-app')";

it('selects the full reviewed module release before creating independent build shards', () => {
  const jobs = readJobs();
  const plan = jobs['edge-plan'];
  const selection = plan?.steps.find(({ run }) => run?.includes(`${IMMUTABLE_SCRIPT} select`) === true);
  expect(selection).toBeDefined();
  expect(selection?.run).toContain('--intent-file');
  expect(selection?.run).toContain('--impacted-units-file');
  expect(selection?.run).toContain('--selection-file');
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
  expect(candidate?.run).toContain('--candidate-file');
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
    ({ uses, with: settings }) =>
      uses?.startsWith('actions/upload-artifact@') === true && settings?.name === SHELL_RECEIPT_ARTIFACT,
  );
  expect(receiptUpload).toBeDefined();
  expect(receiptUpload?.if).toBe(CHANGED_SHELL_CONDITION);
  expect(receiptUpload?.with?.path).toBe(`\${{ runner.temp }}/application-release-receipts/${SHELL_RECEIPT_FILE}`);
  expect(receiptUpload?.with?.path).not.toContain('*');
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
  expect(ingress?.run).toContain(`$RUNNER_TEMP/shell-receipt/${SHELL_RECEIPT_FILE}`);
  expect(downloads.find(({ with: settings }) => settings?.name === SHELL_BUILD_ARTIFACT)?.with?.path).toBe(
    `\${{ runner.temp }}/shell-build`,
  );
  expect(downloads.find(({ with: settings }) => settings?.name === SHELL_RECEIPT_ARTIFACT)?.with?.path).toBe(
    `\${{ runner.temp }}/shell-receipt`,
  );
});

it('skips public Shell ingress when the reviewed release does not change the Shell', () => {
  const finalize = readJobs()['finalize-edge-deployment'];
  const ingress = finalize.steps.find(({ run }) => run?.includes(`${SHELL_SCRIPT} ingress-deploy`) === true);
  expect(ingress?.if).toBe(CHANGED_SHELL_CONDITION);
  expect(ingress?.if).not.toBe(finalize.if);
});

it('hands the exact archived candidate to publication instead of reconstructing mutable module URLs', () => {
  const jobs = readJobs();
  const upload = jobs['deploy-cloudflare']?.steps.find(
    ({ uses, with: settings }) =>
      uses?.startsWith('actions/upload-artifact@') === true && settings?.name === CANDIDATE_ARTIFACT,
  );
  expect(upload).toBeDefined();
  expect(upload?.with?.path).toContain(CANDIDATE_FILE);
  const publish = jobs['publish-edge-composition'];
  const download = publish?.steps.find(({ uses }) => uses?.startsWith('actions/download-artifact@') === true);
  expect(download?.with?.name).toBe(CANDIDATE_ARTIFACT);
  expect(publish?.concurrency?.group).toBe(SHARED_LOCK);
  const publication = publish?.steps.find(({ run }) => run?.includes('active-composition:publish publish') === true);
  expect(publication?.run).toContain('--candidate-file');
  expect(publish.env?.COMPOSITION_CANDIDATE_FILE).toContain(CANDIDATE_FILE);
});
