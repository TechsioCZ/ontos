import { ConfigProvider, Console, Deferred, Effect, Fiber, Redacted, Schema } from 'effect';
import { TestClock, TestConsole } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { SignInPayloadSchema } from '../../apps/shell-super-app/shared/api.ts';
import {
  DOCUMENT_ACCEPTANCE_MS,
  StageTransportError,
  StageVerificationFailure,
  verifyStage,
  verifyStageFromConfig,
} from '../ops/stage-demo-verify.mjs';
import type { StageResponse, StageTransport } from '../ops/stage-demo-verify.mjs';

const shellUrl = 'https://shell.stage.test';
const storefrontUrl = 'https://storefront.stage.test';
const persona = 'management@siampark.demo';
const SIGN_IN = '/shell-super-app-api/auth/sign-in';
const SIGN_OUT = '/shell-super-app-api/auth/sign-out';
const CS = '/cs';
const SIGN_OUT_LINE = 'sign-out 200';
const OAUTH_AUTHORIZATION_SERVER = '/.well-known/oauth-authorization-server';
const OAUTH_PROTECTED_RESOURCE = '/.well-known/oauth-protected-resource';
const SLOW_DOCUMENT = '1600 millis';

const pathOf = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

const record = (url: string, init: RequestInit) => ({
  body: init.body,
  cookie: new Headers(init.headers).get('cookie'),
  method: init.method ?? 'GET',
  path: pathOf(url),
  signal: init.signal,
  url,
});

const response = (status = 200, body: StageResponse['body'] = Effect.void, headers = new Headers()): StageResponse => ({
  body,
  headers,
  status,
});

const signInResponse = (body: StageResponse['body'] = Effect.void) =>
  response(200, body, new Headers({ 'set-cookie': 'ontos.session=issued; Path=/; HttpOnly' }));

const defaultTransport = (url: string) => Effect.succeed(pathOf(url) === SIGN_IN ? signInResponse() : response());

const fixture = (respond: StageTransport = defaultTransport) =>
  Effect.gen(function* makeFixture() {
    const calls: ReturnType<typeof record>[] = [];
    const console = yield* TestConsole.make;
    const transport: StageTransport = (url, init) =>
      Effect.suspend(() => {
        calls.push(record(url, init));
        return respond(url, init);
      });
    return {
      calls,
      command: verifyStageFromConfig(transport).pipe(Effect.provideService(Console.Console, console)),
      console,
      errors: console.errorLines,
      output: console.logLines,
      run: verifyStage({ persona, shellUrl, storefrontUrl, transport }).pipe(
        Effect.provideService(Console.Console, console),
      ),
      transport,
    };
  });

it.effect('signs the persona out through the native action after a passing verification pass', () =>
  Effect.gen(function* signsOutAfterPassingPass() {
    const test = yield* fixture();
    const { failures } = yield* test.run;

    expect(failures).toEqual([]);
    expect(test.calls.map((call) => call.path)).toEqual([
      OAUTH_AUTHORIZATION_SERVER,
      OAUTH_PROTECTED_RESOURCE,
      SIGN_IN,
      CS,
      CS,
      CS,
      '/',
      SIGN_OUT,
    ]);
    const signOutCall = test.calls.at(-1);
    expect(signOutCall?.method).toBe('POST');
    expect(signOutCall?.cookie).toBe('ontos.session=issued');
    expect(signOutCall?.signal).toBeInstanceOf(AbortSignal);
    expect(signOutCall?.signal?.aborted).toBe(true);
    expect((yield* test.output).at(-1)).toContain(SIGN_OUT_LINE);
  }),
);

it.effect('still signs the session out when a document probe fails', () =>
  Effect.gen(function* signsOutAfterFailedProbe() {
    let csAttempts = 0;
    const test = yield* fixture((url) => {
      const path = pathOf(url);
      if (path === CS) {
        csAttempts += 1;
        return csAttempts === 2
          ? Effect.fail(new StageTransportError({ message: 'Error: socket hang up' }))
          : Effect.succeed(response());
      }
      return path === '/' ? Effect.succeed(response(503)) : defaultTransport(url);
    });
    const { failures } = yield* test.run;

    expect(failures.map((failure) => failure.message)).toEqual([
      '/cs #2 (management@siampark.demo) failed: Error: socket hang up',
      'storefront home answered 503',
    ]);
    expect(failures[0]).toBeInstanceOf(StageVerificationFailure);
    expect(failures[1]).toBeInstanceOf(StageVerificationFailure);
    expect(failures.map((failure) => failure.reason)).toEqual(['transport', 'status']);
    expect((yield* test.output).at(-1)).toContain(SIGN_OUT_LINE);
    expect(test.calls.at(-1)?.path).toBe(SIGN_OUT);
    expect(csAttempts).toBe(3);
  }),
);

it.effect('rejects a page document over the acceptance budget but never a slow auth write', () =>
  Effect.gen(function* rejectsOverBudgetPage() {
    let csAttempts = 0;
    const test = yield* fixture((url) => {
      const path = pathOf(url);
      if (path === SIGN_IN) {
        return Effect.sleep('5 seconds').pipe(Effect.as(signInResponse()));
      }
      if (path === CS) {
        csAttempts += 1;
        if (csAttempts === 1) {
          return Effect.sleep(SLOW_DOCUMENT).pipe(Effect.as(response()));
        }
      }
      return defaultTransport(url);
    });
    const fiber = yield* Effect.forkChild(test.run);
    yield* TestClock.adjust('6600 millis');
    const { failures } = yield* Fiber.join(fiber);

    expect((yield* test.output).at(-1)).toContain(SIGN_OUT_LINE);
    expect(yield* test.output).toContain('sign-in 200 ttfb=5.00s total=5.00s');
    expect(DOCUMENT_ACCEPTANCE_MS).toBe(1500);
    expect(failures.map((failure) => failure.message)).toEqual([
      '/cs #1 (management@siampark.demo) took 1600ms, over the 1500ms page budget',
    ]);
  }),
);

it.effect('includes the complete document body in the page budget and reports failed cleanup', () =>
  Effect.gen(function* rejectsSlowBodyAndFailedCleanup() {
    const test = yield* fixture((url) => {
      const path = pathOf(url);
      if (path === SIGN_OUT) {
        return Effect.succeed(response(503));
      }
      return path === '/' ? Effect.succeed(response(200, Effect.sleep(SLOW_DOCUMENT))) : defaultTransport(url);
    });
    const fiber = yield* Effect.forkChild(test.run);
    yield* TestClock.adjust(SLOW_DOCUMENT);
    const { failures } = yield* Fiber.join(fiber);

    expect(failures.map((failure) => failure.message)).toEqual([
      'storefront home took 1600ms, over the 1500ms page budget',
      'sign-out answered 503',
    ]);
    expect(yield* test.output).toContain('storefront home 200 ttfb=0.00s total=1.60s');
    expect(test.calls.at(-1)?.path).toBe(SIGN_OUT);
  }),
);

it.effect.each([1500, 1501])('enforces the fixed document-body budget at %i milliseconds', (duration) =>
  Effect.gen(function* checksDocumentBoundary() {
    const test = yield* fixture((url) =>
      pathOf(url) === '/' ? Effect.succeed(response(200, Effect.sleep(duration))) : defaultTransport(url),
    );
    const fiber = yield* Effect.forkChild(test.run);
    yield* TestClock.adjust(duration);
    const { failures } = yield* Fiber.join(fiber);

    expect(failures.map((failure) => failure.reason)).toEqual(duration === 1500 ? [] : ['budget']);
    expect(test.calls.at(-1)?.path).toBe(SIGN_OUT);
  }),
);

it.effect.each(['request', 'body'] as const)('bounds a stalled sign-out %s independently at ten seconds', (phase) =>
  Effect.gen(function* boundsSignOut() {
    const started = yield* Deferred.make<boolean>();
    const stalled = Deferred.succeed(started, true).pipe(Effect.andThen(Effect.never));
    const test = yield* fixture((url) => {
      if (pathOf(url) === SIGN_OUT) {
        return phase === 'request' ? stalled : Effect.succeed(response(200, stalled));
      }
      return defaultTransport(url);
    });
    let completed = false;
    const fiber = yield* Effect.forkChild(
      test.run.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            completed = true;
          }),
        ),
      ),
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust('9999 millis');
    expect(completed).toBe(false);
    yield* TestClock.adjust('1 millis');
    const { failures } = yield* Fiber.join(fiber);

    expect(completed).toBe(true);
    expect(failures.map((failure) => failure.message)).toEqual(['sign-out timed out after 10000ms']);
    expect(failures[0]?.reason).toBe('timeout');
    expect(test.calls.at(-1)?.signal?.aborted).toBe(true);
  }),
);

it.effect('releases an issued session even if the sign-in body never finishes', () =>
  Effect.gen(function* ownsSessionBeforeBodyRead() {
    const test = yield* fixture((url) =>
      pathOf(url) === SIGN_IN ? Effect.succeed(signInResponse(Effect.never)) : defaultTransport(url),
    );
    const fiber = yield* Effect.forkChild(test.run);
    yield* TestClock.adjust('60 seconds');
    const { failures } = yield* Fiber.join(fiber);

    expect(failures.map((failure) => failure.message)).toEqual(['sign-in timed out after 60000ms']);
    expect(test.calls.at(-1)?.path).toBe(SIGN_OUT);
    expect(test.calls.find((call) => call.path === SIGN_IN)?.signal?.aborted).toBe(true);
    expect((yield* test.output).at(-1)).toContain(SIGN_OUT_LINE);
  }),
);

it.effect('signs out exactly once when verification is interrupted after sign-in', () =>
  Effect.gen(function* finalizesInterruptedVerification() {
    const started = yield* Deferred.make<boolean>();
    const test = yield* fixture((url) =>
      pathOf(url) === CS ? Deferred.succeed(started, true).pipe(Effect.andThen(Effect.never)) : defaultTransport(url),
    );
    const fiber = yield* Effect.forkChild(test.run);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);

    expect(test.calls.filter((call) => call.path === SIGN_OUT)).toHaveLength(1);
    expect(test.calls.at(-1)?.path).toBe(SIGN_OUT);
    expect(test.calls.find((call) => call.path === CS)?.signal?.aborted).toBe(true);
    expect((yield* test.output).at(-1)).toContain(SIGN_OUT_LINE);
  }),
);

it.effect('retains a typed body-consumption failure and still signs out', () =>
  Effect.gen(function* reportsBodyFailure() {
    const test = yield* fixture((url) =>
      pathOf(url) === '/'
        ? Effect.succeed(response(200, Effect.fail(new StageTransportError({ message: 'Error: broken stream' }))))
        : defaultTransport(url),
    );
    const { failures } = yield* test.run;

    expect(failures.map((failure) => failure.message)).toEqual(['storefront home body failed: Error: broken stream']);
    expect(failures[0]?.reason).toBe('body');
    expect(test.calls.at(-1)?.path).toBe(SIGN_OUT);
  }),
);

it.effect.each(['no-cookie', 'transport'] as const)('does not invent a session after sign-in %s failure', (failure) =>
  Effect.gen(function* requiresIssuedSession() {
    const test = yield* fixture((url) => {
      if (pathOf(url) === SIGN_IN) {
        return failure === 'no-cookie'
          ? Effect.succeed(response())
          : Effect.fail(new StageTransportError({ message: 'Error: connection refused' }));
      }
      return defaultTransport(url);
    });
    const { failures } = yield* test.run;

    expect(failures.map((entry) => entry.message)).toEqual([
      failure === 'no-cookie'
        ? 'sign-in answered without a session cookie'
        : 'sign-in failed: Error: connection refused',
    ]);
    expect(test.calls.some((call) => call.path === CS || call.path === SIGN_OUT)).toBe(false);
    expect(test.calls.at(-1)?.path).toBe('/');
  }),
);

it.effect('reads CLI configuration and encodes the redacted credentials with the Shell public contract', () =>
  Effect.gen(function* readsConfiguredCommand() {
    const test = yield* fixture();
    yield* test.command.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            STAGE_SHELL_URL: shellUrl,
            STAGE_STOREFRONT_URL: storefrontUrl,
            STAGE_VERIFY_PERSONA: 'configured@siampark.demo',
          }),
        ),
      ),
    );
    const body = test.calls.find((call) => call.path === SIGN_IN)?.body;
    const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.toCodecJson(SignInPayloadSchema)))(
      body,
    );

    expect(payload.email).toBe('configured@siampark.demo');
    expect(Redacted.value(payload.password)).toBe('password1234');
    expect(test.calls[0]?.url).toBe(`${shellUrl}${OAUTH_AUTHORIZATION_SERVER}`);
    expect(test.calls.find((call) => call.path === '/')?.url).toBe(`${storefrontUrl}/`);
    expect((yield* test.output).at(-1)).toBe('stage verification PASS');
    expect((yield* test.output).join('\n')).not.toContain('password1234');
    expect((yield* test.output).join('\n')).not.toContain('ontos.session=issued');
    expect(yield* test.errors).toEqual([]);
  }),
);

it.effect('keeps CLI defaults and reports a typed failure after native cleanup fails', () =>
  Effect.gen(function* reportsFailedCommand() {
    const test = yield* fixture((url) =>
      pathOf(url) === SIGN_OUT ? Effect.succeed(response(503)) : defaultTransport(url),
    );
    const failure = yield* test.command.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      Effect.flip,
    );

    expect(failure).toBeInstanceOf(StageVerificationFailure);
    expect(failure.message).toBe('stage verification FAILED: sign-out answered 503');
    expect(test.calls[0]?.url).toBe(`https://ontos-stage.bleeding.dev${OAUTH_AUTHORIZATION_SERVER}`);
    expect(test.calls.find((call) => call.path === '/')?.url).toBe('https://ontos-stage-akros.bleeding.dev/');
    expect(test.calls.at(-1)?.path).toBe(SIGN_OUT);
    expect(yield* test.output).not.toContain('stage verification PASS');
    expect(yield* test.errors).toEqual(['stage verification FAILED: sign-out answered 503']);
  }),
);

it.effect('rejects an invalid credential payload without disclosing credentials or sending the sign-in request', () =>
  Effect.gen(function* validatesCredentialPayload() {
    const test = yield* fixture();
    const { failures } = yield* verifyStage({
      password: Redacted.make(''),
      persona,
      shellUrl,
      storefrontUrl,
      transport: test.transport,
    }).pipe(Effect.provideService(Console.Console, test.console));

    expect(failures.map((failure) => failure.message)).toEqual(['sign-in payload did not match the Shell contract']);
    expect(failures[0]?.reason).toBe('payload');
    expect(test.calls.some((call) => call.path === SIGN_IN)).toBe(false);
  }),
);
