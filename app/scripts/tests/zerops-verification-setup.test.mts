import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';
import { parse } from 'yaml';

import { collectToolingProcess } from './tooling-process-fixture.mts';

const OAUTH_INSTALL =
  'mise exec -- pnpm --config.verify-deps-before-run=false --filter @app/shell-super-app exec playwright install --with-deps chromium';
const WARMUP_INSTALL = 'mise exec -- pnpm --config.verify-deps-before-run=false exec playwright-core install chromium';
const RESTORE = 'Restore the pinned verification browsers';
const SAVE = 'Save the pinned verification browsers';
const WAIT_FOR_APP = 'Wait for the app deployment';
const CACHE_KEY = `zerops-verify-browsers-v1-\${{ runner.os }}-\${{ runner.arch }}-\${{ hashFiles('app/pnpm-lock.yaml', 'app/.mise.toml') }}`;
const Step = Schema.Struct({
  'continue-on-error': Schema.optionalKey(Schema.Boolean),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  if: Schema.optionalKey(Schema.String),
  name: Schema.String,
  run: Schema.optionalKey(Schema.String),
  uses: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))),
  'working-directory': Schema.optionalKey(Schema.String),
});
const Workflow = Schema.Struct({
  jobs: Schema.Struct({
    deploy: Schema.Struct({ steps: Schema.Array(Step) }),
    newsletter: Schema.Struct({ steps: Schema.Array(Step) }),
    plan: Schema.Struct({ steps: Schema.Array(Step) }),
    record: Schema.Struct({ if: Schema.String, steps: Schema.Array(Step) }),
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
    expect(index(RESTORE)).toBeGreaterThan(index('Install the verification dependencies'));
    expect(index(RESTORE)).toBeGreaterThan(index('Use the runner-owned verification browser cache'));
    expect(index(SAVE)).toBeGreaterThan(index('Install headless Chromium for the warm-up client'));
    expect(index(SAVE)).toBeLessThan(index('Warm declared reads and prove MCP over OAuth side by side'));
    for (const command of [
      'scripts/ops/stage-warmup.mts',
      'scripts/zerops/verify-service.mjs app',
      'scripts/demo/prove-mcp-oauth.mts',
    ]) {
      const proof = steps.findIndex((step) => step.run?.includes(command) === true);
      expect(proof, command).toBeGreaterThan(index('Install headless Chromium for the warm-up client'));
    }
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
    // Verify is prepared beside the app deploy; its proofs start only after that deploy succeeded.
    expect(jobs.verify['timeout-minutes']).toBe(95);
    expect(jobs.verify.if).toContain("needs.deploy.result == 'success'");
    const wait = jobs.verify.steps.findIndex((step) => step.name === WAIT_FOR_APP);
    expect(jobs.verify.steps[wait]?.if).toBe("needs.plan.outputs.app == 'true'");
    expect(jobs.verify.steps[wait]?.run).toBe(
      "bash scripts/wait-for-build-shards.sh finished 'Deploy and check app' 1",
    );
    expect(jobs.verify.steps[wait]?.['continue-on-error']).toBeUndefined();
    for (const command of ['scripts/zerops/verify-service.mjs app', 'scripts/demo/prove-mcp-oauth.mts']) {
      const proof = jobs.verify.steps.findIndex((step) => step.run?.includes(command) === true);
      expect(proof, command).toBeGreaterThan(wait);
    }
    expect(jobs.record.if).toContain("needs.verify.result == 'success'");
    expect(jobs.record.if).toContain("needs.deploy_app.result == 'success'");
    const probe = jobs.verify.steps.find(
      (step) => step.name === 'Time /cs and OAuth metadata without waiting for storefronts',
    );
    const oauth = jobs.verify.steps.find(
      (step) => step.run?.includes('scripts/demo/prove-mcp-oauth.mts --variant=1 --verification') === true,
    );
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

const workflowMise = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$SETUP_CALLS"
case "$*" in
  *"pnpm "*)
    if [[ "$*" != "exec -- pnpm --config.verify-deps-before-run=false "* ]]; then
      echo ERR_PNPM_VERIFY_DEPS_BEFORE_RUN >&2
      exit 97
    fi
    case "$*" in
      *"playwright-core --version") echo 'Version 1.64.0' ;;
      *"playwright --version") echo 'Version 1.61.0' ;;
      *) echo browser-installer-validated ;;
    esac
    ;;
  *"node -p "*) echo /fixture/playwright.mjs ;;
  *"scripts/ops/stage-warmup.mts")
    touch "$WARMUP_STARTED"
    # A serial implementation cannot complete the success case: OAuth must start before warm-up can finish.
    for ((attempt=0; attempt<100; attempt++)); do
      [ ! -f "$OAUTH_STARTED" ] || break
      sleep 0.01
    done
    test -f "$OAUTH_STARTED"
    echo warmup-output
    exit "$WARMUP_EXIT"
    ;;
  *"scripts/demo/prove-mcp-oauth.mts --variant=1 --verification")
    touch "$OAUTH_STARTED"
    echo oauth-output
    exit "$OAUTH_EXIT"
    ;;
  *"scripts/zerops/verify-service.mjs app") echo service-output ;;
  *) echo "unexpected mise invocation: $*" >&2; exit 98 ;;
esac
`;
const workflowFind = `#!/usr/bin/env bash
set -euo pipefail
args=()
for arg in "$@"; do
  case "$arg" in
    /var/cache/apt/archives | /var/cache/apt/archives/) arg="$APT_ARCHIVES/" ;;
  esac
  args+=("$arg")
done
printf 'find %s\\n' "$*" >>"$SETUP_CALLS"
exec /usr/bin/find "\${args[@]}"
`;
const workflowSudo = `#!/usr/bin/env bash
set -euo pipefail
printf 'sudo %s\\n' "$*" >>"$SETUP_CALLS"
exec "$@"
`;

for (const scenario of [
  { name: 'both succeed', oauth: 0, status: 0, warmup: 0 },
  { name: 'warm-up fails', oauth: 0, status: 1, warmup: 17 },
  { name: 'OAuth fails', oauth: 23, status: 1, warmup: 0 },
  { name: 'both fail', oauth: 23, status: 1, warmup: 17 },
]) {
  it.effect(`executes Verify scripts and newsletter installers under strict Bash when ${scenario.name}`, () =>
    Effect.gen(function* executeWorkflowScripts() {
      const fs = yield* FileSystem.FileSystem;
      const { jobs } = yield* readWorkflow;
      const steps = [...jobs.verify.steps, ...installerSteps(jobs.newsletter.steps)];
      const directory = yield* fs.makeTempDirectoryScoped();
      const app = path.join(directory, 'app');
      const bin = path.join(directory, 'bin');
      const home = path.join(directory, 'home');
      const archives = path.join(directory, 'apt-archives');
      const cached = path.join(home, '.cache/playwright-apt-debs');
      const calls = path.join(directory, 'calls');
      const githubEnv = path.join(directory, 'github-env');
      const githubOutput = path.join(directory, 'github-output');
      for (const folder of [bin, archives, cached, path.join(app, 'apps/shell-super-app')]) {
        yield* fs.makeDirectory(folder, { recursive: true });
      }
      yield* fs.writeFileString(path.join(cached, 'restored.deb'), 'restored package');
      yield* fs.writeFileString(path.join(archives, 'downloaded.deb'), 'downloaded package');
      for (const [name, source] of Object.entries({
        find: workflowFind,
        mise: workflowMise,
        sudo: workflowSudo,
      })) {
        const executable = path.join(bin, name);
        yield* fs.writeFileString(executable, source);
        yield* fs.chmod(executable, 0o700);
      }
      const environment = {
        APT_ARCHIVES: archives,
        E2E_OUT_DIR: path.join(directory, 'proof'),
        GITHUB_ENV: githubEnv,
        GITHUB_OUTPUT: githubOutput,
        HOME: home,
        ImageOS: 'ubuntu24',
        ImageVersion: '20261115',
        OAUTH_EXIT: String(scenario.oauth),
        OAUTH_STARTED: path.join(directory, 'oauth-started'),
        PATH: `${bin}:${yield* Config.String('PATH')}`,
        RUNNER_TEMP: directory,
        SETUP_CALLS: calls,
        WARMUP_EXIT: String(scenario.warmup),
        WARMUP_STARTED: path.join(directory, 'warmup-started'),
      };
      let proofRan = false;
      for (const step of steps) {
        // The deploy wait reads this run's jobs from the Actions API; the assertions above pin it.
        if (step.run === undefined || step.name === WAIT_FOR_APP) {
          continue;
        }
        // GitHub expands expressions before invoking Bash; leave all shell commands and substitutions untouched.
        const command = step.run.replace(
          `\${{ steps.verification-browser-versions.outputs.versions }}`,
          'Version-1.61.0-Version-1.64.0',
        );
        const options = {
          cwd: step['working-directory'] === 'app' ? app : directory,
          env: environment,
          extendEnv: true,
        };
        const syntax = yield* collectToolingProcess(ChildProcess.make('bash', ['-n', '-c', command], options));
        expect(syntax.status, step.name).toBe(0);
        const result = yield* collectToolingProcess(
          ChildProcess.make('bash', ['-e', '-u', '-o', 'pipefail', '-c', command], options),
        );
        const combined = step.run.includes('warmup_pid=$!');
        expect(result.status, `${step.name}: ${result.stderr}`).toBe(combined ? scenario.status : 0);
        if (combined) {
          proofRan = true;
          expect(result.stdout).toContain('warmup-output');
          expect(result.stdout).toContain('oauth-output');
          expect(result.stdout).toContain(`Warm-up exit: ${scenario.warmup}`);
          expect(result.stdout).toContain(`MCP OAuth exit: ${scenario.oauth}`);
          expect(yield* fs.readFileString(path.join(environment.E2E_OUT_DIR, 'warmup.log'))).toContain('warmup-output');
          expect(yield* fs.readFileString(path.join(environment.E2E_OUT_DIR, 'oauth.log'))).toContain('oauth-output');
        }
      }
      expect(proofRan).toBe(true);
      expect(yield* fs.readFileString(githubEnv)).toContain('PLAYWRIGHT_BROWSERS_PATH=');
      expect(yield* fs.readFileString(githubOutput)).toContain('versions=Version-1.61.0-Version-1.64.0');
      expect(yield* fs.readFileString(githubOutput)).toContain(
        'key=playwright-apt-debs-ubuntu24-20261115-Version-1.61.0-Version-1.64.0',
      );
      const recorded = yield* fs.readFileString(calls);
      const invocations = recorded.trim().split('\n');
      expect(invocations.filter((call) => call === OAUTH_INSTALL.replace('mise ', ''))).toHaveLength(2);
      expect(invocations.filter((call) => call === WARMUP_INSTALL.replace('mise ', ''))).toHaveLength(2);
      expect(recorded).toContain('exec -- node scripts/zerops/verify-service.mjs app');
      expect(recorded).toContain('sudo find ');
      expect(yield* fs.readFileString(path.join(archives, 'restored.deb'))).toBe('restored package');
      expect(yield* fs.readFileString(path.join(cached, 'downloaded.deb'))).toBe('downloaded package');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect('uses the proven full workspace install and bypasses pre-run verification in both browser jobs', () =>
  Effect.gen(function* completeVerificationSetup() {
    const { jobs } = yield* readWorkflow;
    for (const job of [jobs.verify, jobs.newsletter]) {
      expect(job.steps.find((step) => step.uses === './.github/actions/install-app')?.with?.['install-args']).toBe(
        '--trust-lockfile',
      );
    }
    for (const job of [jobs.plan, jobs.verify, jobs.newsletter]) {
      for (const step of job.steps) {
        for (const invocation of (step.run ?? '').matchAll(/mise exec -- pnpm (?<arguments>[^\n]+)/gu)) {
          expect(invocation.groups?.arguments, step.name).toMatch(/^--config\.verify-deps-before-run=false /u);
        }
      }
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
