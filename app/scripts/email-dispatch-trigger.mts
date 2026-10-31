import { Clock, Config, Console, Context, Duration, Effect, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';

export class EmailDispatchConfigurationInvalid extends Schema.TaggedError<EmailDispatchConfigurationInvalid>()(
  'EmailDispatchConfigurationInvalid',
  {
    message: Schema.String,
  },
) {}

const invalidConfiguration = () =>
  new EmailDispatchConfigurationInvalid({
    message:
      'ONTOS_EMAIL_DISPATCH_URL (HTTPS Shell dispatch endpoint) and ONTOS_EMAIL_DISPATCH_SECRET must be configured together',
  });

// The host Scope interrupts this wait and clears its timer. Idle dispatch scheduling must
// not keep the Node host alive; tests provide Effect.sleep to use their owning TestClock.
export const EmailDispatchDelay = Context.Reference<(duration: Duration.Duration) => Effect.Effect<void>>(
  'ontos/EmailDispatchDelay',
  {
    defaultValue: () => (duration) =>
      Effect.callback((resume) => {
        const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(duration));
        timer.unref();
        return Effect.sync(() => clearTimeout(timer));
      }),
  },
);

// Stage-only by deployment configuration. This service receives no message content or mail database credentials.
// Its scheduler and requests belong to the host Scope; the host owns the process runtime and signal handlers.
export const startEmailDispatchTrigger = () =>
  Effect.gen(function* startDispatchTrigger() {
    const configuredUrl = yield* Config.option(Config.URL('ONTOS_EMAIL_DISPATCH_URL')).pipe(
      Effect.mapError(invalidConfiguration),
    );
    const configuredSecret = yield* Config.option(Config.Redacted('ONTOS_EMAIL_DISPATCH_SECRET'));
    if (Option.isNone(configuredUrl) && Option.isNone(configuredSecret)) {
      return yield* Effect.void;
    }
    if (Option.isNone(configuredUrl) || Option.isNone(configuredSecret)) {
      return yield* invalidConfiguration();
    }
    const url = configuredUrl.value;
    const secret = configuredSecret.value;
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.pathname !== '/shell-super-app-api/email/dispatch' ||
      Redacted.value(secret).trim() === ''
    ) {
      return yield* invalidConfiguration();
    }

    let inFlight = false;
    const dispatch = Effect.gen(function* dispatchOnce() {
      const fetch = yield* FetchHttpClient.Fetch;
      const signal = yield* Effect.abortSignal;
      const response = yield* Effect.tryPromise(
        fetch.bind(undefined, url, {
          headers: { authorization: `Bearer ${Redacted.value(secret)}` },
          method: 'POST',
          redirect: 'error',
          signal,
        }),
      );
      // Dispose of the acknowledgement without reading or logging upstream error bodies.
      if (response.body !== null) {
        const { body } = response;
        yield* Effect.tryPromise(body.cancel.bind(body));
      }
      if (!response.ok) {
        yield* Console.error(`[email-trigger] dispatch HTTP ${response.status}`);
      }
    }).pipe(
      Effect.scoped,
      Effect.timeout('30 seconds'),
      Effect.catchTags({
        TimeoutError: () => Console.error('[email-trigger] dispatch unavailable'),
        UnknownError: () => Console.error('[email-trigger] dispatch unavailable'),
      }),
    );

    const attempt = Effect.gen(function* attemptDispatch() {
      if (inFlight) {
        return;
      }
      inFlight = true;
      yield* dispatch.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            inFlight = false;
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
    });

    const intervalNanos = 10_000_000_000n;
    const delay = yield* EmailDispatchDelay;
    const started = yield* Clock.monotonicTimeNanos;
    yield* attempt;
    yield* Effect.gen(function* scheduleDispatch() {
      let next = started + intervalNanos;
      for (;;) {
        const now = yield* Clock.monotonicTimeNanos;
        yield* delay(Duration.nanos(next > now ? next - now : 0n));
        yield* attempt;
        const completed = yield* Clock.monotonicTimeNanos;
        // Missed windows are skipped; finishing a slow request never triggers a catch-up dispatch.
        next = started + ((completed - started) / intervalNanos + 1n) * intervalNanos;
      }
    }).pipe(Effect.forkScoped({ startImmediately: true }));
    return yield* Effect.void;
  });
