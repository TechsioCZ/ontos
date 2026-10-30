import { CreateCounterpartyPurchasingProfileActionUnavailableProblemSchema } from '../../shared/apis/create-counterparty-purchasing-profile-action.ts';
import { readFile } from 'node:fs/promises';

import { NodeServices } from '@effect/platform-node';
import { Cause, Effect, Exit, Option, Schema } from 'effect';
import { expect, it, rs } from 'effect-rstest';

import { openNativeChild } from '../support/preproposal-basis-native.ts';

const secret = 'dummy-auth-secret-never-report';
const credential = ['dummy', 'db', 'credential', 'never', 'report'].join('-');
const privateFrame = JSON.stringify({ operation: 'PRIVATE_FIXTURE', value: 'private-frame-never-report' });
const source = String.raw`
  import { createReadStream } from 'node:fs';
  import { NodeRuntime } from '@effect/platform-node';
  import { Cause, Effect, Schema } from 'effect';
  class DummyIdentityError extends Schema.TaggedError()('DummyIdentityError', {
    message: Schema.String, stage: Schema.String,
  }) {}
  let frame = '';
  for await (const chunk of createReadStream('', { fd: 4 })) frame += chunk;
  process.stderr.write('x'.repeat(20000));
  process.stderr.write(process.env.BETTER_AUTH_SECRET.slice(0, 10));
  setTimeout(() => {
    process.stderr.write(process.env.BETTER_AUTH_SECRET.slice(10) + '\n');
    process.stderr.write(process.env.DATABASE_URL + '\n' + frame);
    process.stderr.write(new URL(process.env.DATABASE_URL).password + '\n');
    process.stderr.write(JSON.parse(process.env.ONTOS_GATEWAY_PRIVATE_JWK).d + '\n');
    NodeRuntime.runMain(Effect.fail(new DummyIdentityError({
      message: 'provider creation failed at actual boundary', stage: 'create-provider',
    })).pipe(Effect.tapCause(cause => Effect.sync(() => {
      process.stderr.write(Cause.pretty(cause) + '\n' + JSON.stringify(cause) + '\n');
    }))), { disableErrorReporting: true });
  }, 10);
`;

for (const boundary of ['public', 'private', 'exit'] as const) {
  it.live(`preserves typed child stderr and exit at the ${boundary} boundary without credentials`, () =>
    Effect.scoped(
      Effect.gen(function* childErrorBoundary() {
        const child = yield* openNativeChild({
          args: ['--input-type=module', '-e', source],
          cwd: new URL('../../', import.meta.url).pathname,
          environment: {
            BETTER_AUTH_SECRET: secret,
            DATABASE_URL: `postgres://ontos_runtime:${credential}@localhost/private_database`,
            ONTOS_GATEWAY_PRIVATE_JWK: JSON.stringify({ d: 'dummy-private-key-material' }),
          },
          stage: 'shell-identity',
        });
        yield* child.send(privateFrame, 'private', true);
        const failure = yield* (boundary === 'exit' ? child.exit : child.read(Schema.String, boundary)).pipe(
          Effect.flip,
        );
        const diagnostic = Cause.pretty(Cause.fail(failure));
        expect(diagnostic).toContain('DummyIdentityError');
        expect(diagnostic).toContain('provider creation failed at actual boundary');
        expect(diagnostic).toContain('create-provider');
        expect(diagnostic).toContain('exited with 1');
        expect(diagnostic).toContain('at ');
        expect(diagnostic).toContain('shell-identity');
        expect(diagnostic).not.toContain(secret);
        expect(diagnostic).not.toContain(credential);
        expect(diagnostic).not.toContain('dummy-private-key-material');
        expect(diagnostic).not.toContain(privateFrame);
        expect(diagnostic).not.toContain('private-frame-never-report');
        expect(diagnostic.length).toBeLessThan(18_000);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}

for (const channel of ['public', 'private'] as const) {
  it.live(`fails promptly and reaps a live child after ${channel} protocol EOF with stderr still open`, () =>
    Effect.gen(function* liveChildEof() {
      let pid = 0;
      yield* Effect.scoped(
        Effect.gen(function* closedProtocolChild() {
          const child = yield* openNativeChild({
            args: [
              '-e',
              `
              const fs = require('node:fs');
              process.stdout.write(JSON.stringify(process.pid) + '\\n', () => {
                process.stderr.write('DummyIdentityError: live-child-stage failed\\n');
                ${channel === 'private' ? 'fs.closeSync(3);' : 'process.stdout.end();'}
              });
              setInterval(() => {}, 1000);
            `,
            ],
            environment: {},
            stage: 'live-child-eof',
          });
          pid = yield* child.read(Schema.Int, 'public');
          const failure = yield* child.read(Schema.String, channel).pipe(Effect.flip);
          expect(Cause.pretty(Cause.fail(failure))).toContain('DummyIdentityError: live-child-stage failed');
          expect(Cause.pretty(Cause.fail(failure))).toContain('child exit pending');
        }),
      ).pipe(Effect.timeout('2 seconds'));
      const stillRunning = yield* Effect.try(() => process.kill(pid, 0)).pipe(Effect.option);
      expect(Option.isNone(stillRunning)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

const signature = 'private_signature_fragment_'.repeat(40);
const jwt = `eyJhbGciOiJIUzI1NiJ9.${'private_payload_'.repeat(20)}.${signature}`;
const longSecret = 'private_dummy_fragment_'.repeat(50);
const stderrCases = [
  { chunks: [`${jwt}\n`, `${'x'.repeat(16_100)}\n`], name: 'JWT followed by diagnostics across the retained cap' },
  { chunks: [jwt.slice(0, 12), `${jwt.slice(12)}\n`], name: 'chunk-split JWT' },
  { chunks: [`eyJ${'a'.repeat(17_000)}`, `.${signature}.${signature}\n`], name: 'oversized chunk-split JWT line' },
  {
    chunks: [`${'x'.repeat(16_100)}${longSecret.slice(0, 10)}`, `${longSecret.slice(10)}\n`],
    name: 'configured secret straddling the raw line cap',
  },
];

for (const fixture of stderrCases) {
  it.live(`retains the real error without fragments from ${fixture.name}`, () =>
    Effect.scoped(
      Effect.gen(function* boundedCredentialDiagnostics() {
        const child = yield* openNativeChild({
          args: [
            '--input-type=module',
            '-e',
            String.raw`
            import { setTimeout } from 'node:timers/promises';
            let document = '';
            for await (const chunk of process.stdin) document += chunk;
            for (const chunk of JSON.parse(document)) {
              process.stderr.write(chunk);
              await setTimeout(5);
            }
            process.stderr.write('DummyIdentityError: real failure after credential line; stage=create-provider\n');
            process.exitCode = 17;
          `,
          ],
          environment: { BETTER_AUTH_SECRET: fixture.name.startsWith('configured') ? longSecret : secret },
          stage: 'credential-cap',
        });
        yield* child.send(JSON.stringify(fixture.chunks), 'stdin', true);
        const failure = yield* child.read(Schema.String, 'public').pipe(Effect.flip);
        const diagnostic = Cause.pretty(Cause.fail(failure));
        expect(diagnostic).toContain('DummyIdentityError: real failure after credential line');
        expect(diagnostic).toContain('stage=create-provider');
        expect(diagnostic).toContain('exited with 17');
        expect(diagnostic).not.toContain('private_signature_fragment_');
        expect(diagnostic).not.toContain('private_payload_');
        expect(diagnostic).not.toContain('private_dummy_fragment_');
        expect(diagnostic).not.toContain(jwt);
        expect(diagnostic).not.toContain(longSecret);
        expect(diagnostic.length).toBeLessThan(18_000);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}

const stopSource = String.raw`
  import { createReadStream, writeSync } from 'node:fs';
  import { NodeRuntime, NodeServices, NodeStream } from '@effect/platform-node';
  import { Effect, Stream } from 'effect';
  NodeRuntime.runMain(Effect.scoped(Effect.gen(function* stopPrivateProtocol() {
    writeSync(3, JSON.stringify({ operation: 'STARTED', pid: process.pid }) + '\n');
    yield* NodeStream.fromReadable({
      evaluate: () => createReadStream('', { autoClose: false, fd: 4 }),
      onError: error => error,
    }).pipe(
      Stream.decodeText(), Stream.splitLines, Stream.map(line => JSON.parse(line)),
      Stream.takeUntil(command => command.operation === 'STOP'),
      Stream.runForEach(command => Effect.sync(() => {
        if (command.operation === 'STOP') writeSync(3, JSON.stringify({ operation: 'STOPPED' }) + '\n');
      })),
    );
  })).pipe(Effect.provide(NodeServices.layer)));
`;

it.effect('the identity STOP source caller ends the private command stream', () =>
  Effect.gen(function* stopCallerControl() {
    const caller = yield* Effect.tryPromise(() =>
      readFile(new URL('../support/preproposal-basis-native.ts', import.meta.url), 'utf-8'),
    );
    expect(caller).toContain(
      "identityChild.send(JSON.stringify({ operation: 'STOP', protocol: identityProtocol }), 'private', true)",
    );
  }),
);

it.live('closed private STOP input receives STOPPED, exits zero and reaps the actual child', () =>
  Effect.gen(function* identityStopLifecycle() {
    let pid = 0;
    let stopped = false;
    let exitObserved = false;
    yield* Effect.scoped(
      Effect.gen(function* actualStopChild() {
        const child = yield* openNativeChild({
          args: ['--input-type=module', '-e', stopSource],
          cwd: new URL('../../', import.meta.url).pathname,
          environment: {},
          stage: 'identity-stop',
        });
        const started = yield* child.read(
          Schema.Struct({ operation: Schema.Literal('STARTED'), pid: Schema.Int }),
          'private',
        );
        ({ pid } = started);
        yield* child.send(JSON.stringify({ operation: 'STOP' }), 'private', true);
        yield* child.read(Schema.Struct({ operation: Schema.Literal('STOPPED') }), 'private');
        stopped = true;
        // child.exit preserves the helper's existing zero-exit assertion.
        yield* child.exit;
        exitObserved = true;
      }),
    );
    const stillRunning = yield* Effect.try(() => process.kill(pid, 0)).pipe(Effect.option);
    expect(stopped).toBe(true);
    expect(Option.isNone(stillRunning)).toBe(true);
    expect(exitObserved).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  'retains safe child stderr on HTTP failure with protocol still open and reaps within a bound',
  () =>
    Effect.gen(function* httpFailureCleanup() {
      const diagnostics: string[] = [];
      const capture = rs.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        diagnostics.push(String(chunk));
        return true;
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => capture.mockRestore()));
      let pid = 0;
      const problem = Schema.decodeUnknownSync(CreateCounterpartyPurchasingProfileActionUnavailableProblemSchema)({
        _tag: 'CreateCounterpartyPurchasingProfileActionUnavailableProblem',
        code: 'DEPENDENCY_UNAVAILABLE',
        detail: 'The Action capability is temporarily unavailable.',
        retryable: true,
        status: 503,
        title: 'Action unavailable',
        type: 'https://ontos.dev/problems/action-unavailable',
      });
      const result = yield* Effect.scoped(
        Effect.gen(function* failHttpWithLiveChild() {
          const child = yield* openNativeChild({
            args: [
              '-e',
              `
          process.stderr.write('OriginalOwnerError: real inner failure stage\\n');
          process.stderr.write(process.env.BETTER_AUTH_SECRET.slice(0, 8));
          process.stderr.write(process.env.BETTER_AUTH_SECRET.slice(8) + '\\n');
          process.stderr.write('eyJ' + 'x'.repeat(20000));
          process.stderr.write('.payload.secret-signature\\n');
          process.stderr.write('OriginalOwnerError: still useful after oversized credential\\n', () => {
            process.stdout.write(JSON.stringify(process.pid) + '\\n');
          });
          setInterval(() => {}, 1000);
        `,
            ],
            environment: { BETTER_AUTH_SECRET: secret },
            stage: 'http-failure-child',
          });
          pid = yield* child.read(Schema.Int, 'public');
          return yield* Effect.fail(problem);
        }),
      ).pipe(Effect.exit);
      expect(result).toEqual(Exit.fail(problem));
      const diagnostic = diagnostics.join('');
      expect(diagnostic).toContain('OriginalOwnerError: real inner failure stage');
      expect(diagnostic).toContain('still useful after oversized credential');
      expect(diagnostic).toContain('[stderr oversized line omitted]');
      expect(diagnostic).not.toContain(secret);
      expect(diagnostic).not.toContain('secret-signature');
      expect(diagnostic).not.toContain('eyJ');
      expect(diagnostic.length).toBeLessThan(18_000);
      const running = yield* Effect.try(() => process.kill(pid, 0)).pipe(Effect.option);
      expect(Option.isNone(running)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 2000 },
);
