import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { expect, it } from 'effect-rstest';

const script = new URL('repair-n1-portal-module-stage.sh', import.meta.url).pathname;
const privateFixture = 'fixture-private-value-never-printed';

// Exercise the real shell wrapper while replacing only its process boundary: never run native auth or Core here.
const captureMode = Effect.gen(function* captureModeFixture() {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'n1-stage-operator-' });
  const path = `${directory}/process-fixture.sh`;
  yield* fs.writeFileString(
    path,
    [
      'cd() { builtin cd "$N1_FIXTURE_WORKSPACE"; }',
      'node() {',
      '  local reviewed=missing',
      '  if [[ -v N1_MODULE_ACTIVATION_REVIEWED_SHA256 ]]; then',
      '    reviewed="$N1_MODULE_ACTIVATION_REVIEWED_SHA256"',
      '  fi',
      String.raw`  printf "mode=%s\nreviewed=%s\nactor=%s\n" "$N1_MODULE_ACTIVATION_MODE" "$reviewed" "$ONTOS_AGENT_SETUP_EMAIL"`,
      '}',
      '',
    ].join('\n'),
  );
  return {
    BASH_ENV: path,
    N1_FIXTURE_WORKSPACE: directory,
    ONTOS_AGENT_SETUP_EMAIL: 'another@example.test',
    ONTOS_AGENT_SETUP_PASSWORD: privateFixture,
    ONTOS_PUBLIC_ORIGIN: 'https://ontos-stage.web-revolution.cz',
    ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
  };
});

const invoke = Effect.fn('N1PortalRepairTest.invoke')(function* invoke(
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make('/bin/bash', [script, ...args], {
      env: environment,
      extendEnv: false,
      stderr: 'pipe',
      stdout: 'pipe',
    }),
  );
  const [code, stdout, stderr] = yield* Effect.all(
    [
      child.exitCode,
      child.stdout.pipe(Stream.decodeText, Stream.mkString),
      child.stderr.pipe(Stream.decodeText, Stream.mkString),
    ],
    { concurrency: 'unbounded' },
  );
  return { code, stderr, stdout };
});

it.live('explains the fixed Stage repair without requiring credentials', () =>
  Effect.gen(function* help() {
    const result = yield* invoke(['--help'], {});
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('commerce.customer-context');
    expect(result.stdout).toContain('apply <fingerprint>');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live('defaults to check despite inherited apply mode and fingerprint, using only the fixed N1 actor', () =>
  Effect.gen(function* safeDefault() {
    const environment = yield* captureMode;
    const result = yield* invoke([], {
      ...environment,
      N1_MODULE_ACTIVATION_MODE: 'apply',
      N1_MODULE_ACTIVATION_REVIEWED_SHA256: 'a'.repeat(64),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('mode=check\nreviewed=missing\nactor=admin@n1.ontos.demo');
    expect(result.stdout + result.stderr).not.toContain(privateFixture);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live('passes only the explicit apply fingerprint to the native Core operator', () =>
  Effect.gen(function* explicitApply() {
    const environment = yield* captureMode;
    const fingerprint = 'b'.repeat(64);
    const result = yield* invoke(['apply', fingerprint], {
      ...environment,
      N1_MODULE_ACTIVATION_REVIEWED_SHA256: 'a'.repeat(64),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`mode=apply\nreviewed=${fingerprint}\nactor=admin@n1.ontos.demo`);
    expect(result.stdout + result.stderr).not.toContain(privateFixture);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const args of [['apply'], ['apply', 'invalid'], ['check', 'unexpected'], ['other-mode']] as const) {
  it.live(`rejects invalid arguments before reading credentials: ${args.join(' ')}`, () =>
    Effect.gen(function* invalidArguments() {
      const result = yield* invoke(args, { ONTOS_AGENT_SETUP_PASSWORD: privateFixture });
      expect(result.code).toBe(64);
      expect(result.stderr).toContain('INVALID_ARGUMENTS');
      expect(result.stdout + result.stderr).not.toContain(privateFixture);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

for (const environment of [
  { ONTOS_PUBLIC_ORIGIN: 'https://ontos-stage.web-revolution.cz', ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' },
  { ONTOS_PUBLIC_ORIGIN: 'https://another.example', ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage' },
] as const) {
  it.live(`refuses ${environment.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT} at ${environment.ONTOS_PUBLIC_ORIGIN}`, () =>
    Effect.gen(function* refuseOtherEnvironment() {
      const result = yield* invoke([], {
        ...environment,
        ONTOS_AGENT_SETUP_PASSWORD: privateFixture,
        ONTOS_OWNER_SECRETS_JSON: '{malformed-and-must-not-be-read',
      });
      expect(result.code).toBe(78);
      expect(result.stderr).toContain('STAGE_ONLY');
      expect(result.stdout + result.stderr).not.toContain(privateFixture);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
