import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';
import { parse } from 'yaml';

import { collectToolingProcess } from './tooling-process-fixture.mts';

const OAUTH_INSTALL = 'mise exec -- pnpm --filter @app/shell-super-app exec playwright install --with-deps chromium';
const WARMUP_INSTALL = 'mise exec -- pnpm exec playwright-core install chromium';
const RESTORE = 'Restore the pinned verification browsers';
const SAVE = 'Save the pinned verification browsers';
const CACHE_KEY = `zerops-verify-browsers-v1-\${{ runner.os }}-\${{ runner.arch }}-\${{ hashFiles('app/pnpm-lock.yaml', 'app/.mise.toml') }}`;
const Step = Schema.Struct({
  'continue-on-error': Schema.optionalKey(Schema.Boolean),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  if: Schema.optionalKey(Schema.String),
  name: Schema.String,
  run: Schema.optionalKey(Schema.String),
  uses: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))),
});
const Workflow = Schema.Struct({
  jobs: Schema.Struct({
    deploy: Schema.Struct({ steps: Schema.Array(Step) }),
    record: Schema.Struct({ if: Schema.String, steps: Schema.Array(Step) }),
    newsletter: Schema.Struct({ steps: Schema.Array(Step) }),
    verify: Schema.Struct({
      if: Schema.String,
      steps: Schema.Array(Step),
      'timeout-minutes': Schema.Number,
    }),
  }),
});
const readWorkflow = Effect.gen(function* readVerificationWorkflow() {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.readFileString(
    path.resolve(import.meta.dirname, '../../../.github/workflows/zerops-stage.yml'),
  );
  return yield* Schema.decodeUnknownEffect(Workflow)(parse(source));
});
const installerSteps = (steps: readonly (typeof Step.Type)[]) =>
  steps.filter((step) => step.run === OAUTH_INSTALL || step.run === WARMUP_INSTALL);

it.effect('keys the shared browser cache to the frozen graph, toolchain and runner platform with no fallback', () =>
  Effect.gen(function* exactBrowserCache() {
    const { verify } = (yield* readWorkflow).jobs;
    const configure = verify.steps.find((step) => step.name === 'Use the runner-owned verification browser cache');
    expect(configure?.run).toBe(
      `printf 'PLAYWRIGHT_BROWSERS_PATH=%s/zerops-verify-browsers\\n' "$RUNNER_TEMP" >>"$GITHUB_ENV"`,
    );
    expect(configure?.if).toBeUndefined();
    for (const name of [RESTORE, SAVE]) {
      const step = verify.steps.find((entry) => entry.name === name);
      expect(step?.with?.key).toBe(CACHE_KEY);
      expect(step?.with?.path).toBe(`\${{ env.PLAYWRIGHT_BROWSERS_PATH }}`);
      expect(step?.with?.['restore-keys']).toBeUndefined();
      expect(step?.uses).toContain('@55cc8345863c7cc4c66a329aec7e433d2d1c52a9');
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect('always validates both pinned clients and keeps OS dependency installation on hits as well as misses', () =>
  Effect.gen(function* installerOrdering() {
    const { steps } = (yield* readWorkflow).jobs.verify;
    const installers = installerSteps(steps);
    expect(installers.map((step) => step.run)).toEqual([OAUTH_INSTALL, WARMUP_INSTALL]);
    for (const step of installers) {
      expect(step.if).toBeUndefined();
      expect(step['continue-on-error']).toBeUndefined();
      expect(step.env).toBeUndefined();
    }
    const index = (name: string) => steps.findIndex((step) => step.name === name);
    expect(index(RESTORE)).toBeGreaterThan(index('Install the app workspace'));
    expect(index(RESTORE)).toBeGreaterThan(index('Use the runner-owned verification browser cache'));
    expect(index(SAVE)).toBeGreaterThan(index('Install headless Chromium for the warm-up client'));
    expect(index(SAVE)).toBeLessThan(index('Warm real login, declared reads and federation assets'));
    expect(steps.find((step) => step.name === SAVE)?.if).toBe(
      "steps.verification-browsers.outputs.cache-hit != 'true'",
    );
    for (const step of steps) {
      expect(step.run ?? '').not.toContain('executablePath');
      expect(step.env?.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD).toBeUndefined();
      expect(step.env?.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined();
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
const retryHead = 'a'.repeat(40);
const retryReceipt = {
  lastAttempt: { runAttempt: 1, runId: 123, sourceRevision: retryHead },
  runAttempt: 1,
  runId: 123,
  schemaVersion: 1,
  services: { app: retryHead, storefront: 'b'.repeat(40) },
  validatedHead: retryHead,
};

for (const scenario of [
  { expectedStatus: 0, name: 'same-source job retry', remoteHead: retryHead, runId: '123', source: retryHead },
  { expectedStatus: 1, name: 'superseded source', remoteHead: 'c'.repeat(40), runId: '123', source: retryHead },
  { expectedStatus: 1, name: 'wrong planned source', remoteHead: retryHead, runId: '123', source: 'd'.repeat(40) },
  { expectedStatus: 1, name: 'another run', remoteHead: retryHead, runId: '456', source: retryHead },
]) {
  it.effect(`checks real source identity for ${scenario.name} instead of requiring a matching attempt number`, () =>
    Effect.gen(function* retrySourceAdmission() {
      const fs = yield* FileSystem.FileSystem;
      const { steps } = (yield* readWorkflow).jobs.deploy;
      const command = steps.find((step) => step.name === 'Mark the actual deployment attempt')?.run;
      if (command === undefined) {
        return yield* Effect.die('The deploy must check the attempted source');
      }
      const directory = yield* fs.makeTempDirectoryScoped();
      const git = path.join(directory, 'git');
      yield* fs.writeFileString(git, '#!/bin/bash\nprintf \'%s\\trefs/heads/demo/sales-crm\\n\' "$REMOTE_HEAD"\n');
      yield* fs.chmod(git, 0o700);
      const receipt = { ...retryReceipt, validatedHead: scenario.source };
      const result = yield* collectToolingProcess(
        ChildProcess.make('/bin/bash', ['-e', '-o', 'pipefail', '-c', command], {
          env: {
            GITHUB_RUN_ATTEMPT: '2',
            GITHUB_RUN_ID: scenario.runId,
            GITHUB_SHA: retryHead,
            PATH: `${directory}:${yield* Config.String('PATH')}`,
            PLANNED_RECEIPT: JSON.stringify(receipt),
            REMOTE_HEAD: scenario.remoteHead,
            RUNNER_TEMP: directory,
          },
        }),
      );
      expect(result.status).toBe(scenario.expectedStatus);
      const marker = path.join(directory, 'zerops-delivery/last-attempt/attempt.json');
      if (scenario.expectedStatus === 0) {
        expect(
          Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(yield* fs.readFileString(marker)),
        ).toEqual({
          runAttempt: 2,
          runId: 123,
          sourceRevision: retryHead,
        });
      } else {
        expect(yield* fs.exists(marker)).toBe(false);
      }
      return yield* Effect.void;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect('records the verified retry while preserving the actual per-service source pins', () =>
  Effect.gen(function* recordVerifiedRetry() {
    const fs = yield* FileSystem.FileSystem;
    const { jobs } = yield* readWorkflow;
    const command = jobs.record.steps.find((step) => step.name === 'Write the verified ledger')?.run;
    if (command === undefined) {
      return yield* Effect.die('The verified delivery must retain its source pins');
    }
    const directory = yield* fs.makeTempDirectoryScoped();
    const result = yield* collectToolingProcess(
      ChildProcess.make('/bin/bash', ['-e', '-o', 'pipefail', '-c', command], {
        env: {
          GITHUB_RUN_ATTEMPT: '2',
          GITHUB_RUN_ID: '123',
          GITHUB_SHA: retryHead,
          PATH: yield* Config.String('PATH'),
          RECEIPT: JSON.stringify(retryReceipt),
          RUNNER_TEMP: directory,
        },
      }),
    );
    expect(result.status).toBe(0);
    const recorded = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
      yield* fs.readFileString(path.join(directory, 'zerops-delivery/last-success/receipt.json')),
    );
    expect(recorded).toEqual({
      ...retryReceipt,
      lastAttempt: { runAttempt: 2, runId: 123, sourceRevision: retryHead },
      runAttempt: 2,
    });
    const persistence = jobs.deploy.steps.find(
      (step) => step.name === 'Persist the attempted delivery before any remote mutation',
    );
    expect(persistence?.['continue-on-error']).toBe(true);
    expect(jobs.deploy.steps.some((step) => step.name.includes('durable attempt marker'))).toBe(false);
    return yield* Effect.void;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const fakeMise = `#!/bin/bash
printf '%s\\n' "$*" >>"$SETUP_CALLS"
if [ "\${FAIL_SETUP:-}" = yes ]; then exit 31; fi
`;
for (const cacheState of ['miss', 'hit', 'partial-or-wrong-revision']) {
  it.effect(`runs both native installers for ${cacheState} before allowing proofs`, () =>
    Effect.gen(function* cacheRecoveryCommands() {
      const fs = yield* FileSystem.FileSystem;
      const { steps } = (yield* readWorkflow).jobs.verify;
      const directory = yield* fs.makeTempDirectoryScoped();
      const bin = path.join(directory, 'mise');
      yield* fs.writeFileString(bin, fakeMise);
      yield* fs.chmod(bin, 0o700);
      const calls = path.join(directory, 'calls');
      const commands = installerSteps(steps)
        .map((step) => step.run)
        .join('\n');
      const result = yield* collectToolingProcess(
        ChildProcess.make('/bin/bash', ['-e', '-c', `${commands}\necho proofs-ready`], {
          env: { CACHE_STATE: cacheState, PATH: directory, SETUP_CALLS: calls },
        }),
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('proofs-ready');
      expect((yield* fs.readFileString(calls)).trim().split('\n')).toEqual([
        OAUTH_INSTALL.replace('mise ', ''),
        WARMUP_INSTALL.replace('mise ', ''),
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
it.effect('keeps browser setup failures blocking rather than running proofs with an absent binary', () =>
  Effect.gen(function* installFailure() {
    const fs = yield* FileSystem.FileSystem;
    const { steps } = (yield* readWorkflow).jobs.verify;
    const directory = yield* fs.makeTempDirectoryScoped();
    const bin = path.join(directory, 'mise');
    yield* fs.writeFileString(bin, fakeMise);
    yield* fs.chmod(bin, 0o700);
    const commands = installerSteps(steps)
      .map((step) => step.run)
      .join('\n');
    const result = yield* collectToolingProcess(
      ChildProcess.make('/bin/bash', ['-e', '-c', `${commands}\necho proofs-ready`], {
        env: { FAIL_SETUP: 'yes', PATH: directory, SETUP_CALLS: path.join(directory, 'calls') },
      }),
    );
    expect(result.status).toBe(31);
    expect(result.stdout).not.toContain('proofs-ready');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect('preserves mandatory verification, source-pin publication and honest newsletter failure reporting', () =>
  Effect.gen(function* proofGatesUnchanged() {
    const { jobs } = yield* readWorkflow;
    expect(jobs.verify['timeout-minutes']).toBe(20);
    expect(jobs.verify.if).toContain("needs.deploy_app.result == 'success'");
    expect(jobs.record.if).toContain("needs.verify.result == 'success'");
    const probe = jobs.verify.steps.find(
      (step) => step.name === 'Time /cs and OAuth metadata without waiting for storefronts',
    );
    const oauth = jobs.verify.steps.find((step) => step.name === 'Prove MCP over OAuth end to end');
    for (const step of [probe, oauth]) {
      expect(step).toBeDefined();
      expect(step?.if).toBeUndefined();
      expect(step?.['continue-on-error']).toBeUndefined();
    }
    expect(probe?.run).toBe('mise exec -- node scripts/zerops/verify-service.mjs app');
    expect(oauth?.run).toContain('scripts/demo/prove-mcp-oauth.mts --variant=1 --verification');
    for (const id of ['Read native newsletter evidence', 'Prove the native newsletter grant and withdrawal']) {
      expect(jobs.newsletter.steps.find((step) => step.name === id)?.['continue-on-error']).toBe(true);
    }
    const warning = jobs.newsletter.steps.find((step) => step.name === 'Warn about a failed newsletter proof');
    expect(warning?.if).toContain("steps.newsletter-evidence.outcome == 'failure'");
    expect(warning?.if).toContain("steps.newsletter-proof.outcome == 'failure'");
    expect(warning?.run).toContain('not verified');
  }).pipe(Effect.provide(NodeServices.layer)),
);
