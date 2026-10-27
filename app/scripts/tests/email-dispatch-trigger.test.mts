import { ConfigProvider, Console, Deferred, Effect, Exit, FiberSet, Scope } from 'effect';
import { flow } from 'effect/Function';
import { afterEach, expect, it, rstest } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import { EmailDispatchConfigurationInvalid, startEmailDispatchTrigger } from '../email-dispatch-trigger.mts';

const unitNotification: Effect.Effect<Deferred.Deferred<void>> = Deferred.make();

afterEach(() => {
  rstest.restoreAllMocks();
  rstest.unstubAllGlobals();
});

const configuration = {
  ONTOS_EMAIL_DISPATCH_SECRET: 'fixture-secret',
  ONTOS_EMAIL_DISPATCH_URL: 'https://shell.stage.test/shell-super-app-api/email/dispatch',
};

const twoDispatchIntervals = '20 seconds';

type DispatchConfiguration = Partial<typeof configuration>;
const withConfiguration = (values: DispatchConfiguration) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values));

const openTrigger = (values: DispatchConfiguration = configuration) =>
  Effect.gen(function* openScopedTrigger() {
    const scope = yield* Effect.acquireRelease(Scope.make(), (owned) => Scope.close(owned, Exit.void));
    yield* startEmailDispatchTrigger().pipe(withConfiguration(values), Effect.provideService(Scope.Scope, scope));
    return scope;
  });

it.effect('does nothing when dispatch is not configured; rejects partial or unsafe configuration', () =>
  Effect.gen(function* validateConfiguration() {
    const fetch = rstest.fn();
    rstest.stubGlobal('fetch', fetch);
    yield* openTrigger({});
    expect(fetch).not.toHaveBeenCalled();
    for (const values of [
      { ONTOS_EMAIL_DISPATCH_SECRET: 'fixture-secret' },
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
    ]) {
      const failure = yield* startEmailDispatchTrigger().pipe(withConfiguration(values), Effect.scoped, Effect.flip);
      expect(failure).toBeInstanceOf(EmailDispatchConfigurationInvalid);
      expect(failure.message).toContain('must be configured together');
    }
    expect(fetch).not.toHaveBeenCalled();
  }).pipe(Effect.scoped),
);

it.effect('posts an immediate bearer-authenticated tick every 10 seconds and stops with its Scope', () =>
  Effect.gen(function* dispatchCadence() {
    const first = yield* unitNotification;
    const second = yield* unitNotification;
    const requests: { init: RequestInit; url: URL }[] = [];
    const fetch = rstest.fn(
      flow(
        (url: URL, init: RequestInit) => {
          requests.push({ init, url });
          if (requests.length === 1) {
            Deferred.doneUnsafe(first, Effect.void);
          }
          if (requests.length === 2) {
            Deferred.doneUnsafe(second, Effect.void);
          }
        },
        rstest.fn<() => Promise<Response>>().mockResolvedValue(new Response(null, { status: 200 })),
      ),
    );
    rstest.stubGlobal('fetch', fetch);
    const scope = yield* openTrigger();
    yield* Deferred.await(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requests[0]?.url.href).toBe(configuration.ONTOS_EMAIL_DISPATCH_URL);
    expect(requests[0]?.init.method).toBe('POST');
    expect(requests[0]?.init.redirect).toBe('error');
    expect(requests[0]?.init.headers).toEqual({ authorization: 'Bearer fixture-secret' });
    yield* TestClock.adjust('10 seconds');
    yield* Deferred.await(second);
    expect(fetch).toHaveBeenCalledTimes(2);
    yield* Scope.close(scope, Exit.void);
    yield* TestClock.adjust(twoDispatchIntervals);
    expect(fetch).toHaveBeenCalledTimes(2);
  }).pipe(Effect.scoped),
);

it.effect('skips busy windows without a catch-up request when a slow dispatch finishes', () =>
  Effect.gen(function* noOverlapOrCatchUp() {
    const first = yield* unitNotification;
    const completed = yield* unitNotification;
    const pending = yield* Deferred.make<Response>();
    const toFetchPromise = yield* FiberSet.makeRuntimePromise<never, Response, never>();
    let calls = 0;
    const responses = rstest
      .fn<() => Promise<Response>>()
      .mockReturnValueOnce(
        toFetchPromise(Deferred.await(pending).pipe(Effect.tap(() => Deferred.complete(completed, Effect.void)))),
      )
      .mockResolvedValue(new Response(null, { status: 200 }));
    const fetch = rstest.fn(
      flow(() => {
        calls += 1;
        if (calls === 1) {
          Deferred.doneUnsafe(first, Effect.void);
        }
      }, responses),
    );
    rstest.stubGlobal('fetch', fetch);
    yield* openTrigger();
    yield* Deferred.await(first);
    yield* TestClock.adjust('25 seconds');
    expect(fetch).toHaveBeenCalledTimes(1);
    yield* Deferred.succeed(pending, new Response(null, { status: 200 }));
    yield* Deferred.await(completed);
    yield* Effect.yieldNow;
    expect(fetch).toHaveBeenCalledTimes(1);
    yield* TestClock.adjust('4 seconds');
    expect(fetch).toHaveBeenCalledTimes(1);
    yield* TestClock.adjust('1 second');
    expect(fetch).toHaveBeenCalledTimes(2);
  }).pipe(Effect.scoped),
);

it.effect('aborts an owned in-flight request on Scope close without logging cancellation as unavailable', () =>
  Effect.gen(function* stopAbortsRequest() {
    const started = yield* unitNotification;
    const pending: Promise<Response> = Promise.race([]);
    let signal: AbortSignal | null | undefined;
    const output = yield* Console.consoleWith((current) => Effect.succeed(current));
    const errors = rstest.spyOn(output, 'error').mockImplementation(() => {
      // This test inspects sanitized dispatcher diagnostics without writing them to stderr.
    });
    const fetch = rstest.fn(
      flow((_url: URL, init: RequestInit) => {
        ({ signal } = init);
        Deferred.doneUnsafe(started, Effect.void);
      }, rstest.fn<() => Promise<Response>>().mockReturnValue(pending)),
    );
    rstest.stubGlobal('fetch', fetch);
    const scope = yield* openTrigger();
    yield* Deferred.await(started);
    yield* TestClock.adjust(twoDispatchIntervals);
    expect(fetch).toHaveBeenCalledTimes(1);
    yield* Scope.close(scope, Exit.void);
    expect(signal?.aborted).toBe(true);
    expect(errors).not.toHaveBeenCalled();
    yield* TestClock.adjust(twoDispatchIntervals);
    expect(fetch).toHaveBeenCalledTimes(1);
  }).pipe(Effect.scoped),
);

it.effect('times out a request after 30 seconds and logs only an unavailable acknowledgement', () =>
  Effect.gen(function* timeoutAbortsRequest() {
    const started = yield* unitNotification;
    const pending: Promise<Response> = Promise.race([]);
    let firstSignal: AbortSignal | null | undefined;
    const logged = yield* unitNotification;
    const output = yield* Console.consoleWith((current) => Effect.succeed(current));
    const errors = rstest.spyOn(output, 'error').mockImplementation(() => {
      Deferred.doneUnsafe(logged, Effect.void);
    });
    const fetch = rstest.fn(
      flow((_url: URL, init: RequestInit) => {
        firstSignal ??= init.signal;
        Deferred.doneUnsafe(started, Effect.void);
      }, rstest.fn<() => Promise<Response>>().mockReturnValue(pending)),
    );
    rstest.stubGlobal('fetch', fetch);
    const scope = yield* openTrigger();
    yield* Deferred.await(started);
    yield* TestClock.adjust('29 seconds');
    expect(firstSignal?.aborted).toBe(false);
    yield* TestClock.adjust('1 second');
    expect(firstSignal?.aborted).toBe(true);
    yield* Deferred.await(logged);
    expect(errors).toHaveBeenCalledWith('[email-trigger] dispatch unavailable');
    yield* Scope.close(scope, Exit.void);
    expect(errors).toHaveBeenCalledTimes(1);
  }).pipe(Effect.scoped),
);

it.effect('cancels the response body and logs only the HTTP status for a failed acknowledgement', () =>
  Effect.gen(function* sanitizedHttpFailure() {
    const cancelled = yield* unitNotification;
    const logged = yield* unitNotification;
    const output = yield* Console.consoleWith((current) => Effect.succeed(current));
    const errors = rstest.spyOn(output, 'error').mockImplementation(() => {
      Deferred.doneUnsafe(logged, Effect.void);
    });
    const fetch = rstest.fn<() => Promise<Response>>().mockResolvedValue(
      new Response(
        new ReadableStream({
          cancel() {
            Deferred.doneUnsafe(cancelled, Effect.void);
          },
        }),
        { status: 503 },
      ),
    );
    rstest.stubGlobal('fetch', fetch);
    const scope = yield* openTrigger();
    yield* Deferred.await(cancelled);
    yield* Deferred.await(logged);
    expect(errors).toHaveBeenCalledWith('[email-trigger] dispatch HTTP 503');
    yield* Scope.close(scope, Exit.void);
    expect(errors).toHaveBeenCalledTimes(1);
  }).pipe(Effect.scoped),
);
