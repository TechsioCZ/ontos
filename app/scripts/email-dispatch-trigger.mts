import { Clock, Config, Console, Duration, Effect, Option, Redacted, Schema } from 'effect';

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

// Stage-only by deployment configuration. This service receives no message content or mail database credentials.
// Its scheduler and requests belong to the host Scope; the host owns the process runtime and signal handlers.
export const startEmailDispatchTrigger = () =>
  Effect.gen(function* startDispatchTrigger() {
    const configuredUrl = yield* Config.option(Config.String('ONTOS_EMAIL_DISPATCH_URL'));
    const configuredSecret = yield* Config.option(Config.Redacted('ONTOS_EMAIL_DISPATCH_SECRET'));
    if (Option.isNone(configuredUrl) && Option.isNone(configuredSecret)) {
      return yield* Effect.void;
    }
    if (Option.isNone(configuredUrl) || Option.isNone(configuredSecret)) {
      return yield* invalidConfiguration();
    }
    const url = yield* Effect.try({ catch: invalidConfiguration, try: () => new URL(configuredUrl.value) });
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
      const response = yield* Effect.tryPromise(
        async (signal) =>
          await fetch(url, {
            headers: { authorization: `Bearer ${Redacted.value(secret)}` },
            method: 'POST',
            redirect: 'error',
            signal,
          }),
      );
      // Dispose of the acknowledgement without reading or logging upstream error bodies.
      if (response.body !== null) {
        const { body } = response;
        yield* Effect.tryPromise(async () => await body.cancel());
      }
      if (!response.ok) {
        yield* Console.error(`[email-trigger] dispatch HTTP ${response.status}`);
      }
    }).pipe(
      Effect.timeout('30 seconds'),
      // oxlint-disable promise/prefer-await-to-then -- Approved demo/sales-crm policy: Effect.catch is typed Effect recovery, not Promise chaining.
      Effect.catch(() => Console.error('[email-trigger] dispatch unavailable')),
      // oxlint-enable promise/prefer-await-to-then
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
    const started = yield* Clock.monotonicTimeNanos;
    yield* attempt;
    yield* Effect.gen(function* scheduleDispatch() {
      let next = started + intervalNanos;
      for (;;) {
        const now = yield* Clock.monotonicTimeNanos;
        yield* Effect.sleep(Duration.nanos(next > now ? next - now : 0n));
        yield* attempt;
        const completed = yield* Clock.monotonicTimeNanos;
        // Missed windows are skipped; finishing a slow request never triggers a catch-up dispatch.
        next = started + ((completed - started) / intervalNanos + 1n) * intervalNanos;
      }
    }).pipe(Effect.forkScoped({ startImmediately: true }));
    return yield* Effect.void;
  });
