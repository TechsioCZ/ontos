import nodeProcess from 'node:process';

import { NodeServices } from '@effect/platform-node';
import { Effect, Layer, Match, Redacted, Schema } from 'effect';
import { systemError } from 'effect/PlatformError';
import { expect, it } from 'effect-rstest';
import { ChildProcessSpawner } from 'effect/unstable/process';

import { OpsCommandError } from '../ops/ops-command-error.mts';
import { OpsShellLive, renderCommand, runCommand } from '../ops/ops-shell.mts';
import type { OpsCommand } from '../ops/ops-shell.mts';

const ACCOUNT_ID = 'a'.repeat(32);
const PROVIDER_PATH = `/accounts/${ACCOUNT_ID}/workers/workers/ontos-test-worker`;
const FIXTURE_SECRET = 'redacted-native-stderr-fixture-secret';
const NONZERO_CHILD_SOURCE =
  'let stderr = ""; for await (const chunk of process.stdin) stderr += chunk; process.stderr.write(stderr); process.exitCode = 17;';
const SUCCESS_CHILD_SOURCE = String.raw`let stderr = ""; for await (const chunk of process.stdin) stderr += chunk; process.stderr.write(stderr); process.stdout.write("native stdout\n");`;
const nativeLayer = OpsShellLive.pipe(Layer.provide(NodeServices.layer));

const nativeCommand = (stderr: string, source = NONZERO_CHILD_SOURCE): OpsCommand => ({
  args: ['--input-type=module', '-e', source],
  captureProviderFailure: true,
  command: nodeProcess.execPath,
  stdin: Redacted.make(stderr),
});

const providerFailure = (path = PROVIDER_PATH, code = '10007'): string =>
  `A request to the Cloudflare API (${path}) failed.\nWorker not found [code: ${code}]\n`;

const checkNativeFailure = (stderr: string) =>
  Effect.gen(function* nativeFailure() {
    const command = nativeCommand(stderr);
    const failure = yield* runCommand(command).pipe(Effect.flip);
    expect(Schema.is(OpsCommandError)(failure)).toBe(true);
    expect(failure.command).toBe(renderCommand(command));
    expect(failure.message).toBe(`${renderCommand(command)} exited with 17`);
    expect(renderCommand(command)).not.toContain(FIXTURE_SECRET);
    expect(JSON.stringify(failure)).not.toContain(FIXTURE_SECRET);
    return failure;
  });

it.live('extracts only the provider path and code from ANSI native stderr', () =>
  Effect.gen(function* coloredProviderFailure() {
    const stderr =
      `\u001B[31mA request to the Cloudflare API (${PROVIDER_PATH}) failed.\u001B[0m\n` +
      `\u001B[1mWorker not found [code: 10007]\u001B[0m\n${FIXTURE_SECRET}\n`;
    const failure = yield* checkNativeFailure(stderr);
    expect(failure.cause).toEqual({ providerCode: 10_007, providerPath: PROVIDER_PATH });
    expect(Object.keys(failure.cause ?? {})).toHaveLength(2);
    expect(JSON.stringify(failure)).not.toContain('Worker not found');
    expect(JSON.stringify(failure)).not.toContain('\u001B');
  }).pipe(Effect.provide(nativeLayer)),
);

for (const providerCode of [10_008, Number.MAX_SAFE_INTEGER]) {
  it.live(`preserves safe provider code ${providerCode} without interpreting it`, () =>
    Effect.gen(function* otherProviderCode() {
      const failure = yield* checkNativeFailure(providerFailure(PROVIDER_PATH, String(providerCode)));
      expect(failure.cause).toEqual({ providerCode, providerPath: PROVIDER_PATH });
    }).pipe(Effect.provide(nativeLayer)),
  );
}

it.live('accepts the maximum safe worker name length through native stderr', () =>
  Effect.gen(function* maximumWorkerName() {
    const providerPath = `/accounts/${ACCOUNT_ID}/workers/workers/${'a'.repeat(63)}`;
    const failure = yield* checkNativeFailure(providerFailure(providerPath));
    expect(failure.cause).toEqual({ providerCode: 10_007, providerPath });
  }).pipe(Effect.provide(nativeLayer)),
);

const genericFailures = [
  { name: 'an unrelated failure', stderr: `native command failed\n${FIXTURE_SECRET}\n` },
  { name: 'a request without a code', stderr: `A request to the Cloudflare API (${PROVIDER_PATH}) failed.\n` },
  { name: 'a code without a request', stderr: 'Worker not found [code: 10007]\n' },
  {
    name: 'a code before the request',
    stderr: `[code: 10007]\nA request to the Cloudflare API (${PROVIDER_PATH}) failed.\n`,
  },
  { name: 'a malformed request sentence', stderr: providerFailure().replace('failed.', 'failed') },
  { name: 'a nonnumeric code', stderr: providerFailure(PROVIDER_PATH, 'worker-not-found') },
  { name: 'a fractional code', stderr: providerFailure(PROVIDER_PATH, '10007.5') },
  { name: 'a negative code', stderr: providerFailure(PROVIDER_PATH, '-10007') },
  { name: 'a code with a leading zero', stderr: providerFailure(PROVIDER_PATH, '010007') },
  { name: 'an unsafe integer code', stderr: providerFailure(PROVIDER_PATH, '9007199254740992') },
  {
    name: 'a different provider endpoint',
    stderr: providerFailure(PROVIDER_PATH.replace('/workers/workers/', '/workers/scripts/')),
  },
  { name: 'an absolute URL', stderr: providerFailure(`https://api.cloudflare.com/client/v4${PROVIDER_PATH}`) },
  {
    name: 'a credential URL',
    stderr: providerFailure(`https://user:${FIXTURE_SECRET}@api.cloudflare.com${PROVIDER_PATH}`),
  },
  { name: 'a query with credentials', stderr: providerFailure(`${PROVIDER_PATH}?api_token=${FIXTURE_SECRET}`) },
  { name: 'a path fragment', stderr: providerFailure(`${PROVIDER_PATH}#credential`) },
  { name: 'a malformed account', stderr: providerFailure(PROVIDER_PATH.replace(ACCOUNT_ID, 'g'.repeat(32))) },
  { name: 'an empty worker name', stderr: providerFailure(`/accounts/${ACCOUNT_ID}/workers/workers/`) },
  {
    name: 'a worker name starting with a hyphen',
    stderr: providerFailure(`/accounts/${ACCOUNT_ID}/workers/workers/-worker`),
  },
  { name: 'an uppercase worker name', stderr: providerFailure(`/accounts/${ACCOUNT_ID}/workers/workers/Worker`) },
  {
    name: 'a worker name with an underscore',
    stderr: providerFailure(`/accounts/${ACCOUNT_ID}/workers/workers/test_worker`),
  },
  { name: 'an encoded worker separator', stderr: providerFailure(`${PROVIDER_PATH}%2Fsecret`) },
  {
    name: 'a worker name longer than 63 characters',
    stderr: providerFailure(`/accounts/${ACCOUNT_ID}/workers/workers/${'a'.repeat(64)}`),
  },
  { name: 'an extra worker path segment', stderr: providerFailure(`${PROVIDER_PATH}/secret`) },
  { name: 'duplicate identical provider failures', stderr: providerFailure() + providerFailure() },
  {
    name: 'different provider failures',
    stderr: providerFailure() + providerFailure(`/accounts/${ACCOUNT_ID}/workers/workers/other-worker`, '10008'),
  },
  { name: 'multiple codes for one request', stderr: `${providerFailure()}[code: 10008]\n` },
  { name: 'a numeric and malformed code marker', stderr: `${providerFailure()}[code: invalid]\n` },
  {
    name: 'an extra malformed request prefix',
    stderr: `${providerFailure()}A request to the Cloudflare API (invalid) failed.\n`,
  },
];

for (const fixture of genericFailures) {
  it.live(`keeps ${fixture.name} as a generic native command error`, () =>
    Effect.gen(function* genericNativeFailure() {
      const failure = yield* checkNativeFailure(fixture.stderr);
      expect(failure.cause).toBeUndefined();
    }).pipe(Effect.provide(nativeLayer)),
  );
}

it.live('drains native stderr larger than a pipe buffer without retaining it in the error', () =>
  Effect.gen(function* largeNativeStderr() {
    const stderr = `unrecognized native failure\n`.repeat(8192) + FIXTURE_SECRET;
    const failure = yield* checkNativeFailure(stderr);
    expect(failure.cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain('unrecognized native failure');
  }).pipe(Effect.provide(nativeLayer)),
);

it.live('returns successful native stdout when stderr looks like a provider failure', () =>
  Effect.gen(function* successfulNativeCommand() {
    const command = nativeCommand(`${providerFailure()}${FIXTURE_SECRET}\n`, SUCCESS_CHILD_SOURCE);
    const stdout = yield* runCommand(command);
    expect(stdout).toBe('native stdout\n');
    expect(stdout).not.toContain(FIXTURE_SECRET);
    expect(stdout).not.toContain(PROVIDER_PATH);
    expect(renderCommand(command)).not.toContain(FIXTURE_SECRET);
  }).pipe(Effect.provide(nativeLayer)),
);

it.live('keeps default native commands on inherited stderr and returns their stdout', () => {
  let forwardedCommands = 0;
  const forwardingSpawner = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* inheritedStderrSpawner() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make((command) =>
        Match.value(command).pipe(
          Match.tag('StandardCommand', (standard) => {
            expect(standard.options.stderr).toBe('inherit');
            forwardedCommands += 1;
            return spawner.spawn(standard);
          }),
          Match.tag('PipedCommand', () => Effect.die('unexpected piped native fixture')),
          Match.exhaustive,
        ),
      );
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  return Effect.gen(function* defaultNativeCommands() {
    const command: OpsCommand = {
      args: ['--input-type=module', '-e', 'process.stdout.write("default stdout");'],
      command: nodeProcess.execPath,
    };
    expect(yield* runCommand(command)).toBe('default stdout');
    expect(yield* runCommand({ ...command, captureProviderFailure: false })).toBe('default stdout');
    expect(forwardedCommands).toBe(2);
  }).pipe(Effect.provide(OpsShellLive.pipe(Layer.provide(forwardingSpawner))));
});

it.effect('preserves the existing platform error cause when spawning fails', () => {
  const cause = systemError({
    _tag: 'NotFound',
    method: 'spawn',
    module: 'ChildProcessSpawner',
    pathOrDescriptor: 'missing-native-command',
  });
  const command: OpsCommand = { args: ['argument'], command: 'missing-native-command' };
  const failingSpawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.fail(cause)),
  );
  return Effect.gen(function* failedSpawn() {
    const failure = yield* runCommand(command).pipe(Effect.flip);
    expect(Schema.is(OpsCommandError)(failure)).toBe(true);
    expect(failure.command).toBe(renderCommand(command));
    expect(failure.message).toBe(`${renderCommand(command)} could not run`);
    expect(failure.cause).toBe(cause);
  }).pipe(Effect.provide(OpsShellLive.pipe(Layer.provide(failingSpawner))));
});
