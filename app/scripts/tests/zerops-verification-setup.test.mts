import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';
import { parse } from 'yaml';

import { MUTATION_MARKER } from '../zerops/delivery-plan.mts';
import { collectToolingProcess } from './tooling-process-fixture.mts';

// Hotfix delivery (6c6620eafb, 5b13f3af9b, 0fcf2ae30d): the stage delivery installs no browsers and runs no warm-up,
// MCP OAuth or N1 checkout proof; it checks that every public origin answers. Every built run delivers, superseded or
// not, and skips only when stage already runs a newer commit. The tests of the removed browser setup, proof steps and
// stale-head refusal went with them; stage-proofs.sh itself stays, and its own contract below still holds.
const PROOFS_SCRIPT = path.resolve(import.meta.dirname, '../zerops/stage-proofs.sh');
const OAUTH_SIGNAL = 'oauth-started';
const CHECKOUT_SIGNAL = 'checkout-started';
const SERVICE_SIGNAL = 'service-started';
const PACKAGED_BUILD_FLAG = '--expect-build-id=-packaged-build';
const ORIGINS_CHECK = 'Check that the stage origins answer';
const DELIVER_STAGE = './.github/actions/deliver-stage';
const SKIP_NEWER = 'Skip when stage already runs a newer commit';
const SUPERSEDED = 'End here when a newer push superseded this run';
const Step = Schema.Struct({
  'continue-on-error': Schema.optionalKey(Schema.Boolean),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  id: Schema.optionalKey(Schema.String),
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
/** The delivery deliver_app runs (.github/actions/deliver-stage): pushes, waits, then the origin check. */
const readDelivery = Effect.gen(function* readDeliveryAction() {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.readFileString(path.join(repository, '.github/actions/deliver-stage/action.yml'));
  return (yield* Schema.decodeUnknownEffect(Action)(parse(source))).runs.steps;
});

it.effect('installs no verification browser and runs no proof in the stage delivery', () =>
  Effect.gen(function* noProofs() {
    for (const step of yield* readDelivery) {
      expect(step.run ?? '', step.name).not.toMatch(/playwright|stage-proofs\.sh|stage-warmup|prove-mcp-oauth/u);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('checks every origin after every wait, unconditionally, in the one delivering job', () =>
  Effect.gen(function* originsAfterWaits() {
    const { jobs } = yield* readWorkflow;
    expect(jobs.deliver['timeout-minutes']).toBe(95);
    expect(jobs.deliver_app['timeout-minutes']).toBe(95);
    // Only deliver_app delivers; the planning job never mutates stage.
    expect(jobs.deliver.steps.some((step) => step.uses === DELIVER_STAGE)).toBe(false);
    expect(jobs.deliver.steps.some((step) => step.name === MUTATION_MARKER)).toBe(false);
    expect(jobs.deliver_app.steps.some((step) => step.uses === DELIVER_STAGE)).toBe(true);
    const steps = yield* readDelivery;
    const index = (name: string) => steps.findIndex((step) => step.name === name);
    const waitApp = index('Wait for the app deployment');
    const waitStorefronts = index('Wait for the storefront deployments');
    expect(steps[waitApp]?.run).toBe('bash app/scripts/zerops/stage-push.sh wait app');
    expect(steps[waitApp]?.['continue-on-error']).toBeUndefined();
    const superseded = index(SUPERSEDED);
    expect(superseded).toBeGreaterThan(Math.max(waitApp, waitStorefronts));
    const check = steps[index(ORIGINS_CHECK)];
    expect(index(ORIGINS_CHECK)).toBeGreaterThan(superseded);
    expect(check?.if).toBeUndefined();
    expect(check?.['continue-on-error']).toBeUndefined();
  }).pipe(Effect.provide(NodeServices.layer)),
);

const fakeCurl = `#!/usr/bin/env bash
url="\${!#}"
printf '%s\\n' "$url" >>"$CALLS"
case "$url" in
  *ontos-stage-shop*) printf '%s' "\${SHOP_CODE:-200}" ;;
  *) printf '200' ;;
esac
`;

it.effect(
  'requests every public origin under strict Bash and warns, without failing, on one that does not answer',
  () =>
    Effect.gen(function* originsAnswer() {
      const fs = yield* FileSystem.FileSystem;
      const command = (yield* readDelivery).find((step) => step.name === ORIGINS_CHECK)?.run;
      if (command === undefined) {
        return yield* Effect.die('The delivery must check the stage origins');
      }
      for (const shop of ['200', '503']) {
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(path.join(directory, 'curl'), fakeCurl);
        yield* fs.chmod(path.join(directory, 'curl'), 0o700);
        const calls = path.join(directory, 'calls');
        const result = yield* collectToolingProcess(
          ChildProcess.make('bash', ['-e', '-u', '-o', 'pipefail', '-c', command], {
            env: {
              CALLS: calls,
              PATH: `${directory}:${yield* Config.String('PATH')}`,
              SHOP_CODE: shop,
              STAGE_N1_URL: 'https://ontos-stage-n1.example.test',
              STAGE_SHELL_URL: 'https://ontos-stage.example.test',
              STAGE_SHOP_URL: 'https://ontos-stage-shop.example.test',
              STAGE_STOREFRONT_URL: 'https://ontos-stage-akros.example.test',
            },
          }),
        );
        expect(result.status, result.stderr).toBe(0);
        expect((yield* fs.readFileString(calls)).trim().split('\n')).toEqual([
          'https://ontos-stage.example.test',
          'https://ontos-stage-akros.example.test',
          'https://ontos-stage-shop.example.test',
          'https://ontos-stage-n1.example.test',
        ]);
        if (shop === '503') {
          expect(result.stdout).toContain('::warning::https://ontos-stage-shop.example.test answered 503');
        } else {
          expect(result.stdout).not.toContain('::warning::');
        }
      }
      return yield* Effect.void;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const HEAD = 'a'.repeat(40);
const NEWER = 'c'.repeat(40);
const OLDER = 'd'.repeat(40);
/** The Zerops service read: the commit the service runs, or an API failure. */
const fakeZeropsCurl = `#!/usr/bin/env bash
printf '%s\\n' "\${!#}" >>"$CALLS"
[ "$DEPLOYED" != unreadable ] || exit 22
printf '{"userData":[{"key":"appVersionName","content":"%s"}]}' "$DEPLOYED"
`;
/** The compare read (gh api …/compare/<this run>...<deployed> --jq .status): ahead when the deployed one is newer. */
const fakeGh = `#!/usr/bin/env bash
case "$2" in
  *"/compare/$GITHUB_SHA...$NEWER") echo ahead ;;
  *"/compare/$GITHUB_SHA...$OLDER") echo behind ;;
  *) echo diverged ;;
esac
`;

for (const scenario of [
  { current: true, deployed: HEAD, name: 'stage runs this commit', planned: 'app' },
  { current: true, deployed: OLDER, name: 'stage runs an older commit', planned: 'app' },
  { current: true, deployed: 'unreadable', name: 'the service cannot be read', planned: 'app' },
  { current: false, deployed: NEWER, name: 'stage runs a newer commit', planned: 'app' },
  { current: false, deployed: NEWER, name: 'the first planned storefront runs a newer commit', planned: 'storefront' },
]) {
  it.effect(`deliver_app delivers a superseded run, and skips only when stage runs newer: ${scenario.name}`, () =>
    Effect.gen(function* skipOnlyNewer() {
      const fs = yield* FileSystem.FileSystem;
      const { steps } = (yield* readWorkflow).jobs.deliver_app;
      const index = (name: string) => steps.findIndex((step) => step.name === name);
      const skip = steps[index(SKIP_NEWER)];
      const mark = steps[index(MUTATION_MARKER)];
      const delivery = steps.findIndex((step) => step.uses === DELIVER_STAGE);
      if (skip?.run === undefined || mark === undefined) {
        return yield* Effect.die('deliver_app must decide whether to deliver and mark its attempt');
      }
      // The decision precedes the mark, and the mark every secret sync and push; both follow the decision.
      expect(index(SKIP_NEWER)).toBeLessThan(index(MUTATION_MARKER));
      expect(index(MUTATION_MARKER)).toBeLessThan(delivery);
      expect(mark.if).toBe("steps.head.outputs.current == 'true'");
      expect(steps[delivery]?.if).toBe(mark.if);
      expect(mark.run ?? '').not.toMatch(/ls-remote|current_head/u);
      const directory = yield* fs.makeTempDirectoryScoped();
      for (const [name, source] of Object.entries({ curl: fakeZeropsCurl, gh: fakeGh })) {
        yield* fs.writeFileString(path.join(directory, name), source);
        yield* fs.chmod(path.join(directory, name), 0o700);
      }
      const output = path.join(directory, 'output');
      yield* fs.writeFileString(output, '');
      const result = yield* collectToolingProcess(
        ChildProcess.make('/bin/bash', ['-e', '-o', 'pipefail', '-c', skip.run], {
          env: {
            CALLS: path.join(directory, 'calls'),
            DEPLOYED: scenario.deployed,
            GITHUB_OUTPUT: output,
            GITHUB_REPOSITORY: 'owner/repo',
            GITHUB_SHA: HEAD,
            NEWER,
            OLDER,
            PATH: `${directory}:${yield* Config.String('PATH')}`,
            PLANNED: `app:app-id:${String(scenario.planned === 'app')} storefront:storefront-id:true shop:shop-id:true n1:n1-id:false`,
          },
        }),
      );
      expect(result.status, result.stderr).toBe(0);
      expect((yield* fs.readFileString(output)).includes('current=true')).toBe(scenario.current);
      // Only the first planned service decides.
      expect((yield* fs.readFileString(path.join(directory, 'calls'))).trim().split('\n')).toEqual([
        `https://api.app-prg1.zerops.io/api/rest/public/service-stack/${scenario.planned}-id`,
      ]);
      return yield* Effect.void;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

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
    IFS= read -r started <"$OAUTH_STARTED"
    test "$started" = oauth-started
    echo warmup-output
    exit "$WARMUP_EXIT"
    ;;
  *"scripts/demo/prove-mcp-oauth.mts --variant=1 --verification")
    printf 'oauth-started\\n' >"$OAUTH_STARTED"
    echo oauth-output
    exit "$OAUTH_EXIT"
    ;;
  *"scripts/ops/stage-n1-checkout.mts quote "*)
    exec 3<>"$CHECKOUT_STARTED"
    exec 4<>"$SERVICE_STARTED"
    printf 'checkout-started\\n' >&3
    IFS= read -r -t 2 started <&4
    test "$started" = service-started
    echo checkout-output
    exit "$CHECKOUT_EXIT"
    ;;
  *"scripts/zerops/verify-service.mjs "*)
    if [[ "$*" == *"verify-service.mjs app" ]]; then
      # Open read/write so opening the FIFO cannot block. A serial quote cannot release this service probe.
      exec 3<>"$CHECKOUT_STARTED"
      exec 4<>"$SERVICE_STARTED"
      IFS= read -r -t 2 started <&3
      test "$started" = checkout-started
      printf 'service-started\\n' >&4
    fi
    echo "service-output $*"
    exit "$SERVICE_EXIT"
    ;;
  *) echo "unexpected mise invocation: $*" >&2; exit 98 ;;
esac
`;
it.effect('the native checkout CLI accepts a leading-dash build identity as one attached flag value', () =>
  Effect.gen(function* checkoutBuildIdentity() {
    const result = yield* collectToolingProcess(
      ChildProcess.make(
        process.execPath,
        ['scripts/ops/stage-n1-checkout.mts', 'quote', PACKAGED_BUILD_FLAG, '--help'],
        { cwd: path.join(repository, 'app') },
      ),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('--expect-build-id');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('fails the verdict when the proofs never started, and refuses to start them twice', () =>
  Effect.gen(function* unstartedProofs() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const bin = path.join(directory, 'bin');
    yield* fs.makeDirectory(path.join(directory, 'apps/shell-super-app'), { recursive: true });
    yield* fs.makeDirectory(bin);
    yield* fs.writeFileString(path.join(bin, 'mise'), workflowMise);
    yield* fs.chmod(path.join(bin, 'mise'), 0o700);
    const searchPath = `${bin}:${yield* Config.String('PATH')}`;
    expect(
      (yield* collectToolingProcess(
        ChildProcess.make(
          'mkfifo',
          [OAUTH_SIGNAL, CHECKOUT_SIGNAL, SERVICE_SIGNAL].map((name) => path.join(directory, name)),
        ),
      )).status,
    ).toBe(0);
    const run = (command: string) =>
      collectToolingProcess(
        ChildProcess.make('bash', [PROOFS_SCRIPT, command], {
          cwd: directory,
          env: {
            CHECKOUT_EXIT: '0',
            CHECKOUT_STARTED: path.join(directory, CHECKOUT_SIGNAL),
            OAUTH_EXIT: '0',
            OAUTH_STARTED: path.join(directory, OAUTH_SIGNAL),
            PATH: searchPath,
            PUSH_N1: 'false',
            RUNNER_TEMP: directory,
            SERVICE_EXIT: '0',
            SERVICE_STARTED: path.join(directory, SERVICE_SIGNAL),
            SETUP_CALLS: path.join(directory, 'calls'),
            STAGE_N1_BUILD_ID: 'packaged-build',
            STAGE_N1_URL: 'https://n1.example.test',
            STAGE_SHELL_URL: 'https://shell.example.test',
            WARMUP_EXIT: '0',
            WARMUP_STARTED: path.join(directory, 'warmup-started'),
          },
          extendEnv: true,
        }),
      );
    const unstarted = yield* run('finish');
    expect(unstarted.status).toBe(1);
    expect(unstarted.stdout).toContain('never started');
    expect((yield* run('start')).status).toBe(0);
    expect((yield* run('start')).status).toBe(1);
    expect((yield* run('finish')).status).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

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
