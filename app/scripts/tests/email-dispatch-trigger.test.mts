import { createHook } from 'node:async_hooks';

import { inProcessFetch } from '@app/shared-contracts/testing/http-double';
import { ConfigProvider, Console, Deferred, Duration, Effect, Exit, Fiber, Schema, Scope } from 'effect';
import { FetchHttpClient, HttpRouter, HttpServerResponse } from 'effect/http';
import { expect, it, rstest } from 'effect-rstest';
import { TestClock, TestConsole } from 'effect/testing';
import {
  EmailDispatchConfigurationInvalid,
  EmailDispatchDelay,
  startEmailDispatchTrigger,
} from '../email-dispatch-trigger.mts';

const unitNotification: Effect.Effect<Deferred.Deferred<void>> = Deferred.make();

const configuration = {
  ONTOS_EMAIL_DISPATCH_SECRET: 'fixture-secret',
  ONTOS_EMAIL_DISPATCH_URL: 'https://shell.stage.test/shell-super-app-api/email/dispatch',
};

const twoDispatchIntervals = '20 seconds';

type DispatchConfiguration = Partial<typeof configuration>;
const withConfiguration = (values: DispatchConfiguration) =>
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown(values, { preserveEmptyStrings: true }),
  );

const openTrigger = (values: DispatchConfiguration = configuration) =>
  Effect.gen(function* openScopedTrigger() {
    const scope = yield* Effect.acquireRelease(Scope.make(), (owned) => Scope.close(owned, Exit.void));
    yield* startEmailDispatchTrigger().pipe(
      withConfiguration(values),
      Effect.provideService(EmailDispatchDelay, Effect.sleep),
      Effect.provideService(Scope.Scope, scope),
    );
    return scope;
  });

// The recorder observes the injected transport before Request normalizes header whitespace.
const dispatchTransport = (answer = Effect.succeed(HttpServerResponse.empty({ status: 200 }))) =>
  Effect.gen(function* makeDispatchTransport() {
    const first = yield* unitNotification;
    const second = yield* unitNotification;
    const completed = yield* unitNotification;
    const requests: { init: RequestInit | undefined; url: RequestInfo | URL }[] = [];
    let arrivals = 0;
    const application = HttpRouter.add(
      'POST',
      '/shell-super-app-api/email/dispatch',
      Effect.gen(function* dispatchAcknowledgement() {
        arrivals += 1;
        yield* Deferred.complete(arrivals === 1 ? first : second, Effect.void);
        return yield* answer;
      }),
    );
    const fetch = yield* FetchHttpClient.Fetch.pipe(Effect.provide(inProcessFetch(application)));
    const recordedFetch: typeof globalThis.fetch = async (url, init) => {
      requests.push({ init, url });
      const response = await fetch(url, init);
      Deferred.doneUnsafe(completed, Effect.void);
      return response;
    };
    return {
      completed,
      first,
      provide: Effect.provideService(FetchHttpClient.Fetch, recordedFetch),
      requests,
      second,
    };
  });

const capturedConsole = Effect.gen(function* captureDiagnostics() {
  const output = yield* TestConsole.make;
  const logged = yield* unitNotification;
  const console: Console.Console = {
    ...output,
    error: (...values: readonly string[]) => {
      output.error(...values);
      Deferred.doneUnsafe(logged, Effect.void);
    },
  };
  return { logged, output, provide: Effect.provideService(Console.Console, console) };
});

it.effect('does nothing when dispatch is not configured; rejects partial or unsafe configuration', () =>
  Effect.gen(function* validateConfiguration() {
    const transport = yield* dispatchTransport();
    yield* openTrigger({}).pipe(transport.provide);
    expect(transport.requests).toHaveLength(0);
    for (const values of [
      { ONTOS_EMAIL_DISPATCH_SECRET: configuration.ONTOS_EMAIL_DISPATCH_SECRET },
      { ONTOS_EMAIL_DISPATCH_URL: configuration.ONTOS_EMAIL_DISPATCH_URL },
      { ...configuration, ONTOS_EMAIL_DISPATCH_URL: 'http://shell.stage.test/shell-super-app-api/email/dispatch' },
      { ...configuration, ONTOS_EMAIL_DISPATCH_URL: 'not-a-url' },
      { ...configuration, ONTOS_EMAIL_DISPATCH_URL: 'https://shell.stage.test/other' },
      { ...configuration, ONTOS_EMAIL_DISPATCH_URL: `${configuration.ONTOS_EMAIL_DISPATCH_URL}?unsafe=1` },
      { ...configuration, ONTOS_EMAIL_DISPATCH_URL: `${configuration.ONTOS_EMAIL_DISPATCH_URL}#unsafe` },
      {
        ...configuration,
        ONTOS_EMAIL_DISPATCH_URL: 'https://user:secret@shell.stage.test/shell-super-app-api/email/dispatch',
      },
      { ...configuration, ONTOS_EMAIL_DISPATCH_SECRET: '   ' },
      { ...configuration, ONTOS_EMAIL_DISPATCH_SECRET: '' },
      { ...configuration, ONTOS_EMAIL_DISPATCH_URL: '' },
      { ONTOS_EMAIL_DISPATCH_SECRET: '', ONTOS_EMAIL_DISPATCH_URL: '' },
    ]) {
      const failure = yield* startEmailDispatchTrigger().pipe(
        withConfiguration(values),
        transport.provide,
        Effect.scoped,
        Effect.flip,
      );
      expect(Schema.is(EmailDispatchConfigurationInvalid)(failure)).toBe(true);
      expect(failure.message).toContain('must be configured together');
    }
    expect(transport.requests).toHaveLength(0);
  }).pipe(Effect.scoped),
);

it.effect('posts an immediate bearer-authenticated tick every 10 seconds and stops with its Scope', () =>
  Effect.gen(function* dispatchCadence() {
    const transport = yield* dispatchTransport();
    const scope = yield* openTrigger().pipe(transport.provide);
    yield* Deferred.await(transport.first);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.url).toEqual(new URL(configuration.ONTOS_EMAIL_DISPATCH_URL));
    expect(transport.requests[0]?.init?.method).toBe('POST');
    expect(transport.requests[0]?.init?.redirect).toBe('error');
    expect(transport.requests[0]?.init?.headers).toEqual({ authorization: 'Bearer fixture-secret' });
    yield* TestClock.adjust('10 seconds');
    yield* Deferred.await(transport.second);
    expect(transport.requests).toHaveLength(2);
    yield* Scope.close(scope, Exit.void);
    yield* TestClock.adjust(twoDispatchIntervals);
    expect(transport.requests).toHaveLength(2);
  }).pipe(Effect.scoped),
);

it.live('the native dispatch delay unrefs its timer and releases it on interruption or completion', () =>
  Effect.gen(function* nativeDispatchDelayLifecycle() {
    // Node's own Timeout as the host hands it out: its delay, callback and whether it was cleared.
    const nativeTimerSchema = Schema.Struct({
      _destroyed: Schema.Boolean,
      _idleTimeout: Schema.Number,
      _onTimeout: Schema.Unknown,
    });
    const timers: { readonly callback: unknown; readonly duration: number; readonly resource: NodeJS.Timeout }[] = [];
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        createHook({
          init: (_id, type, _parent, resource: NodeJS.Timeout) => {
            if (type === 'Timeout') {
              const timer = Schema.decodeUnknownSync(nativeTimerSchema)(resource);
              if (timer._idleTimeout === 10_000) {
                timers.push({ callback: timer._onTimeout, duration: timer._idleTimeout, resource });
              }
            }
          },
        }).enable(),
      ),
      (hook) => Effect.sync(() => hook.disable()),
    );
    const delay = yield* EmailDispatchDelay;
    const cancelled = yield* delay(Duration.seconds(10)).pipe(Effect.forkChild({ startImmediately: true }));
    expect(timers).toHaveLength(1);
    expect(timers[0]?.callback).toEqual(expect.any(Function));
    expect(timers[0]?.duration).toBe(10_000);
    const [created] = timers;
    if (created === undefined) {
      expect.unreachable('expected an owned dispatch timer');
    }
    expect(created.resource.hasRef()).toBe(false);
    yield* Fiber.interrupt(cancelled);
    // Cleared by the interruption itself: the host has already destroyed the timer, so it never fires.
    expect(Schema.decodeUnknownSync(nativeTimerSchema)(created.resource)._destroyed).toBe(true);

    // Completion runs on fake timers: ten seconds pass at once, and no timer of the delay is left behind.
    yield* Effect.acquireRelease(
      Effect.sync(() => rstest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })),
      () => Effect.sync(() => rstest.useRealTimers()),
    );
    const completed = yield* delay(Duration.seconds(10)).pipe(Effect.forkChild({ startImmediately: true }));
    expect(rstest.getTimerCount()).toBe(1);
    yield* Effect.promise(() => rstest.advanceTimersByTimeAsync(10_000));
    yield* Fiber.join(completed);
    expect(rstest.getTimerCount()).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect('preserves the exact configured secret while validating its nonblank value', () =>
  Effect.gen(function* exactDispatchCredential() {
    const transport = yield* dispatchTransport();
    const scope = yield* openTrigger({
      ...configuration,
      ONTOS_EMAIL_DISPATCH_SECRET: ' fixture-secret ',
    }).pipe(transport.provide);
    yield* Deferred.await(transport.first);
    expect(transport.requests).toHaveLength(1);
    const [request] = transport.requests;
    expect(request?.url).toEqual(new URL(configuration.ONTOS_EMAIL_DISPATCH_URL));
    expect(request?.init?.headers).toEqual({ authorization: 'Bearer  fixture-secret ' });
    yield* Scope.close(scope, Exit.void);
  }).pipe(Effect.scoped),
);

it.effect('sanitizes a transport failure and retries at the next scheduled window', () =>
  Effect.gen(function* sanitizedTransportFailure() {
    const diagnostics = yield* capturedConsole;
    const second = yield* unitNotification;
    const fetch = yield* FetchHttpClient.Fetch.pipe(
      Effect.provide(
        inProcessFetch(
          HttpRouter.add(
            'POST',
            '/shell-super-app-api/email/dispatch',
            Effect.succeed(HttpServerResponse.empty({ status: 200 })),
          ),
        ),
      ),
    );
    const requests: (RequestInfo | URL)[] = [];
    // A rejected transport is injected through the script's explicit Fetch service, never the global.
    const failingFetch: typeof globalThis.fetch = async (url, init) => {
      requests.push(url);
      if (requests.length === 1) {
        throw new Error('private upstream details fixture-secret');
      }
      const response = await fetch(url, init);
      Deferred.doneUnsafe(second, Effect.void);
      return response;
    };
    const scope = yield* openTrigger().pipe(
      Effect.provideService(FetchHttpClient.Fetch, failingFetch),
      diagnostics.provide,
    );
    yield* Deferred.await(diagnostics.logged);
    expect(yield* diagnostics.output.errorLines).toEqual(['[email-trigger] dispatch unavailable']);
    yield* TestClock.adjust('10 seconds');
    yield* Deferred.await(second);
    expect(requests).toHaveLength(2);
    yield* Scope.close(scope, Exit.void);
    expect(yield* diagnostics.output.errorLines).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it.effect('skips busy windows without a catch-up request when a slow dispatch finishes', () =>
  Effect.gen(function* noOverlapOrCatchUp() {
    const pending = yield* unitNotification;
    let calls = 0;
    const transport = yield* dispatchTransport(
      Effect.gen(function* slowAcknowledgement() {
        calls += 1;
        if (calls === 1) {
          yield* Deferred.await(pending);
        }
        return HttpServerResponse.empty({ status: 200 });
      }),
    );
    yield* openTrigger().pipe(transport.provide);
    yield* Deferred.await(transport.first);
    yield* TestClock.adjust('25 seconds');
    expect(transport.requests).toHaveLength(1);
    yield* Deferred.complete(pending, Effect.void);
    yield* Deferred.await(transport.completed);
    yield* Effect.yieldNow;
    expect(transport.requests).toHaveLength(1);
    yield* TestClock.adjust('4 seconds');
    expect(transport.requests).toHaveLength(1);
    yield* TestClock.adjust('1 second');
    yield* Deferred.await(transport.second);
    expect(transport.requests).toHaveLength(2);
  }).pipe(Effect.scoped),
);

it.effect('aborts an owned in-flight request on Scope close without logging cancellation as unavailable', () =>
  Effect.gen(function* stopAbortsRequest() {
    const transport = yield* dispatchTransport(Effect.never);
    const diagnostics = yield* capturedConsole;
    const scope = yield* openTrigger().pipe(transport.provide, diagnostics.provide);
    yield* Deferred.await(transport.first);
    yield* TestClock.adjust(twoDispatchIntervals);
    expect(transport.requests).toHaveLength(1);
    yield* Scope.close(scope, Exit.void);
    expect(transport.requests[0]?.init?.signal?.aborted).toBe(true);
    expect(yield* diagnostics.output.errorLines).toEqual([]);
    yield* TestClock.adjust(twoDispatchIntervals);
    expect(transport.requests).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it.effect('times out a request after 30 seconds and logs only an unavailable acknowledgement', () =>
  Effect.gen(function* timeoutAbortsRequest() {
    const transport = yield* dispatchTransport(Effect.never);
    const diagnostics = yield* capturedConsole;
    const scope = yield* openTrigger().pipe(transport.provide, diagnostics.provide);
    yield* Deferred.await(transport.first);
    yield* TestClock.adjust('29 seconds');
    expect(transport.requests[0]?.init?.signal?.aborted).toBe(false);
    yield* TestClock.adjust('1 second');
    expect(transport.requests[0]?.init?.signal?.aborted).toBe(true);
    yield* Deferred.await(diagnostics.logged);
    expect(yield* diagnostics.output.errorLines).toContain('[email-trigger] dispatch unavailable');
    yield* Scope.close(scope, Exit.void);
    expect(yield* diagnostics.output.errorLines).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it.effect('cancels the response body and logs only the HTTP status for a failed acknowledgement', () =>
  Effect.gen(function* sanitizedHttpFailure() {
    const cancelled = yield* unitNotification;
    const diagnostics = yield* capturedConsole;
    const transport = yield* dispatchTransport(
      Effect.sync(() =>
        HttpServerResponse.fromWeb(
          new Response(
            new ReadableStream({
              cancel() {
                Deferred.doneUnsafe(cancelled, Effect.void);
              },
            }),
            { status: 503 },
          ),
        ),
      ),
    );
    const scope = yield* openTrigger().pipe(transport.provide, diagnostics.provide);
    yield* Deferred.await(cancelled);
    yield* Deferred.await(diagnostics.logged);
    expect(yield* diagnostics.output.errorLines).toContain('[email-trigger] dispatch HTTP 503');
    yield* Scope.close(scope, Exit.void);
    expect(yield* diagnostics.output.errorLines).toHaveLength(1);
  }).pipe(Effect.scoped),
);
