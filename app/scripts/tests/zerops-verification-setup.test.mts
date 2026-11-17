import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';
import { parse } from 'yaml';

import { MUTATION_MARKER } from '../zerops/delivery-plan.mts';
import { collectToolingProcess } from './tooling-process-fixture.mts';

const OAUTH_INSTALL =
  'mise exec -- pnpm --config.verify-deps-before-run=false --filter @app/shell-super-app exec playwright install --with-deps chromium';
const WARMUP_INSTALL = 'mise exec -- pnpm --config.verify-deps-before-run=false exec playwright-core install chromium';
const RESTORE = 'Restore the pinned verification browsers';
const BROWSER_CACHE = 'Use the runner-owned verification browser cache';
const WARMUP_CLIENT = 'Install headless Chromium for the warm-up client';
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
  'working-directory': Schema.optionalKey(Schema.String),
});
const Job = Schema.Struct({ steps: Schema.Array(Step), 'timeout-minutes': Schema.Number });
const Workflow = Schema.Struct({ jobs: Schema.Struct({ deliver: Job, deliver_app: Job }) });
const Action = Schema.Struct({ runs: Schema.Struct({ steps: Schema.Array(Step) }) });
const repository = path.resolve(import.meta.dirname, '../../..');
const readWorkflow = Effect.gen(function* readVerificationWorkflow() {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.readFileString(path.join(repository, '.github/workflows/zerops-stage.yml'));
  return yield* Schema.decodeUnknownEffect(Workflow)(parse(source));
});
/** The delivery both delivering jobs run (.github/actions/deliver-stage): pushes, then every proof. */
const readDelivery = Effect.gen(function* readDeliveryAction() {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.readFileString(path.join(repository, '.github/actions/deliver-stage/action.yml'));
  return (yield* Schema.decodeUnknownEffect(Action)(parse(source))).runs.steps;
});
/** The verification steps of the delivery: browser setup and the proofs, without its pushes and waits. */
const VERIFICATION_STEPS = new Set([
  BROWSER_CACHE,
  'Name the pinned verification browsers',
  'Name the Chromium system-library package cache',
  'Seed apt with the cached Chromium system-library packages',
  'Install headless Chromium for the OAuth consent screens',
  WARMUP_CLIENT,
  'Collect the Chromium system-library packages',
  'Verify every service against the live app',
  'Warm declared reads and prove MCP over OAuth side by side',
]);
const installerSteps = (steps: readonly (typeof Step.Type)[]) =>
  steps.filter((step) => step.run === OAUTH_INSTALL || step.run === WARMUP_INSTALL);

it.effect('keys the shared browser cache to the frozen graph, toolchain and runner platform with no fallback', () =>
  Effect.gen(function* exactBrowserCache() {
    const verify = { steps: yield* readDelivery };
    const configure = verify.steps.find((step) => step.name === BROWSER_CACHE);
    expect(configure?.run).toBe(
      `printf 'PLAYWRIGHT_BROWSERS_PATH=%s/zerops-verify-browsers\\n' "$RUNNER_TEMP" >>"$GITHUB_ENV"`,
    );
    expect(configure?.if).toBeUndefined();
    for (const name of [RESTORE, SAVE]) {
      const step = verify.steps.find((entry) => entry.name === name);
      expect(step?.with?.key).toBe(CACHE_KEY);
      // The path the exported PLAYWRIGHT_BROWSERS_PATH names.
      expect(step?.with?.path).toBe(`\${{ runner.temp }}/zerops-verify-browsers`);
      expect(step?.with?.['restore-keys']).toBeUndefined();
      expect(step?.uses).toContain('@55cc8345863c7cc4c66a329aec7e433d2d1c52a9');
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect('always validates both pinned clients and keeps OS dependency installation on hits as well as misses', () =>
  Effect.gen(function* installerOrdering() {
    const steps = yield* readDelivery;
    const installers = installerSteps(steps);
    expect(installers.map((step) => step.run)).toEqual([OAUTH_INSTALL, WARMUP_INSTALL]);
    for (const step of installers) {
      expect(step.if).toBeUndefined();
      expect(step['continue-on-error']).toBeUndefined();
      expect(step.env).toBeUndefined();
    }
    const index = (name: string) => steps.findIndex((step) => step.name === name);
    expect(index(RESTORE)).toBeGreaterThan(index('Install the app workspace'));
    // After the last upload: the browser downloads never share the runner's bandwidth with one.
    expect(index(BROWSER_CACHE)).toBeGreaterThan(index('Push the N1 storefront'));
    expect(index(RESTORE)).toBeGreaterThan(index(BROWSER_CACHE));
    expect(index(SAVE)).toBeGreaterThan(index(WARMUP_CLIENT));
    expect(index(SAVE)).toBeLessThan(index('Warm declared reads and prove MCP over OAuth side by side'));
    for (const command of [
      'scripts/ops/stage-warmup.mts',
      'scripts/zerops/verify-service.mjs app',
      'scripts/demo/prove-mcp-oauth.mts',
    ]) {
      const proof = steps.findIndex((step) => step.run?.includes(command) === true);
      expect(proof, command).toBeGreaterThan(index(WARMUP_CLIENT));
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
const HEAD = 'a'.repeat(40);
for (const scenario of [
  { marks: true, name: 'the planned head', remoteHead: HEAD },
  { marks: false, name: 'a superseded head', remoteHead: 'c'.repeat(40) },
  { marks: false, name: 'an unreadable head', remoteHead: '' },
]) {
  for (const job of ['deliver', 'deliver_app'] as const) {
    it.effect(`${job} marks the attempt only for ${scenario.name}`, () =>
      Effect.gen(function* markAttempt() {
        const fs = yield* FileSystem.FileSystem;
        const { steps } = (yield* readWorkflow).jobs[job];
        const command = steps.find((step) => step.name === MUTATION_MARKER)?.run;
        if (command === undefined) {
          return yield* Effect.die('The delivery must mark its attempt');
        }
        const directory = yield* fs.makeTempDirectoryScoped();
        const git = path.join(directory, 'git');
        yield* fs.writeFileString(
          git,
          '#!/bin/bash\n[ -n "$REMOTE_HEAD" ] || exit 2\nprintf \'%s\\trefs/heads/demo/sales-crm\\n\' "$REMOTE_HEAD"\n',
        );
        yield* fs.chmod(git, 0o700);
        const result = yield* collectToolingProcess(
          ChildProcess.make('/bin/bash', ['-e', '-o', 'pipefail', '-c', command], {
            env: {
              GITHUB_SHA: HEAD,
              PATH: `${directory}:${yield* Config.String('PATH')}`,
              REMOTE_HEAD: scenario.remoteHead,
            },
          }),
        );
        expect(result.status === 0).toBe(scenario.marks);
        return yield* Effect.void;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
}

const fakeMise = `#!/bin/bash
printf '%s\\n' "$*" >>"$SETUP_CALLS"
if [ "\${FAIL_SETUP:-}" = yes ]; then exit 31; fi
`;
for (const cacheState of ['miss', 'hit', 'partial-or-wrong-revision']) {
  it.effect(`runs both native installers for ${cacheState} before allowing proofs`, () =>
    Effect.gen(function* cacheRecoveryCommands() {
      const fs = yield* FileSystem.FileSystem;
      const steps = yield* readDelivery;
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
    const steps = yield* readDelivery;
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
it.effect('verifies every service only after the app is live, with no condition on any proof', () =>
  Effect.gen(function* proofGatesUnchanged() {
    const { jobs } = yield* readWorkflow;
    expect(jobs.deliver['timeout-minutes']).toBe(95);
    expect(jobs.deliver_app['timeout-minutes']).toBe(95);
    const steps = yield* readDelivery;
    const index = (name: string) => steps.findIndex((step) => step.name === name);
    const waitApp = index('Wait for the app deployment');
    const waitStorefronts = index('Wait for the storefront deployments');
    expect(steps[waitApp]?.run).toBe('bash app/scripts/zerops/stage-push.sh wait app');
    expect(steps[waitApp]?.['continue-on-error']).toBeUndefined();
    // A superseded run ends after its own Zerops processes and before its proofs.
    const superseded = index('End here when a newer push superseded this run');
    expect(superseded).toBeGreaterThan(Math.max(waitApp, waitStorefronts));
    for (const command of [
      'scripts/zerops/verify-service.mjs app',
      'scripts/zerops/verify-service.mjs "$service"',
      'scripts/ops/stage-warmup.mts',
      'scripts/demo/prove-mcp-oauth.mts --variant=1 --verification',
    ]) {
      const proof = steps.findIndex((step) => step.run?.includes(command) === true);
      expect(proof, command).toBeGreaterThan(superseded);
      expect(steps[proof]?.if, command).toBeUndefined();
      expect(steps[proof]?.['continue-on-error'], command).toBeUndefined();
    }
    expect(steps[index('Verify every service against the live app')]?.run).toContain(
      'for service in storefront shop n1',
    );
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
  *"scripts/zerops/verify-service.mjs "*) echo "service-output $*" ;;
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
  it.effect(`executes Verify scripts under strict Bash when ${scenario.name}`, () =>
    Effect.gen(function* executeWorkflowScripts() {
      const fs = yield* FileSystem.FileSystem;
      const steps = (yield* readDelivery).filter((step) => VERIFICATION_STEPS.has(step.name));
      expect(steps.map((step) => step.name).toSorted()).toEqual([...VERIFICATION_STEPS].toSorted());
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
        STAGE_SHELL_URL: 'https://shell.example.test',
        WARMUP_EXIT: String(scenario.warmup),
        WARMUP_STARTED: path.join(directory, 'warmup-started'),
      };
      let proofRan = false;
      for (const step of steps) {
        if (step.run === undefined) {
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
      expect(invocations.filter((call) => call === OAUTH_INSTALL.replace('mise ', ''))).toHaveLength(1);
      expect(invocations.filter((call) => call === WARMUP_INSTALL.replace('mise ', ''))).toHaveLength(1);
      for (const service of ['app', 'storefront', 'shop', 'n1']) {
        expect(recorded).toContain(`exec -- node scripts/zerops/verify-service.mjs ${service}`);
      }
      expect(recorded).toContain('sudo find ');
      expect(yield* fs.readFileString(path.join(archives, 'restored.deb'))).toBe('restored package');
      expect(yield* fs.readFileString(path.join(cached, 'downloaded.deb'))).toBe('downloaded package');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect('installs the whole workspace once and bypasses pre-run verification for every pnpm command it runs', () =>
  Effect.gen(function* completeVerificationSetup() {
    const steps = yield* readDelivery;
    expect(steps.find((step) => step.name === 'Install the app workspace')?.run).toBe(
      'mise exec -- pnpm install --frozen-lockfile --trust-lockfile',
    );
    for (const step of steps) {
      for (const invocation of (step.run ?? '').matchAll(/mise exec -- pnpm (?<arguments>[^\n]+)/gu)) {
        if (invocation.groups?.arguments?.startsWith('install ') === true) {
          continue;
        }
        expect(invocation.groups?.arguments, step.name).toMatch(/^--config\.verify-deps-before-run=false /u);
      }
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
