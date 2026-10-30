import { ConfigProvider, Deferred, Effect, Fiber } from 'effect';
import { expect, it } from 'effect-rstest';
import { emailEnvironment, emailTransport } from '../../src/transport.node.ts';

const configured = ConfigProvider.fromUnknown(
  {
    EMAIL_PROVIDER: 'smtp',
    EMAIL_TEST_SMTP_HOST: 'none',
    ONTOS_EMAIL_DISPATCH_SECRET: 'request-private',
    SMTP_HOST: 'first.example',
    SMTP_PORT: ' 2525 ',
    SMTP_SECURE: 'false',
  },
  { preserveEmptyStrings: true },
);
const disabled = ConfigProvider.fromUnknown(
  { EMAIL_PROVIDER: 'none', EMAIL_TEST_SMTP_HOST: 'none', SMTP_HOST: 'second.example' },
  { preserveEmptyStrings: true },
);

it.effect('the same native transport program decodes each request provider without retaining credentials', () =>
  Effect.gen(function* requestConfiguration() {
    let reads = 0;
    const provider = ConfigProvider.make((path) =>
      Effect.suspend(() => {
        reads += 1;
        return configured.load(path);
      }),
    );
    const first = emailTransport.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider));
    expect(reads).toBe(0);
    expect((yield* first).provider).toEqual({ configured: true, label: 'SMTP server first.example:2525' });
    const second = yield* emailTransport.pipe(Effect.provideService(ConfigProvider.ConfigProvider, disabled));
    expect(second.provider).toEqual({ configured: false, label: null });
    expect((yield* first).provider).toEqual({ configured: true, label: 'SMTP server first.example:2525' });
    expect(reads).toBeGreaterThan(0);
  }),
);

it.effect('a pending request configuration does not hold another request or leak its provider', () =>
  Effect.gen(function* independentConfiguration() {
    const started = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    const pending = ConfigProvider.make((path) =>
      Deferred.succeed(started, true).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(configured.load(path)),
      ),
    );
    const first = yield* emailTransport.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, pending),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    const second = yield* emailTransport.pipe(Effect.provideService(ConfigProvider.ConfigProvider, disabled));
    expect(second.provider).toEqual({ configured: false, label: null });
    yield* Deferred.succeed(release, true);
    expect((yield* Fiber.join(first)).provider).toEqual({
      configured: true,
      label: 'SMTP server first.example:2525',
    });
  }),
);

it.effect('an explicit empty dispatch credential remains empty, not a cached previous request credential', () =>
  Effect.gen(function* emptyCredential() {
    const environment = yield* emailEnvironment.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ ONTOS_EMAIL_DISPATCH_SECRET: '' }, { preserveEmptyStrings: true }),
      ),
    );
    expect(environment.ONTOS_EMAIL_DISPATCH_SECRET).toBeDefined();
    const absent = yield* emailEnvironment.pipe(Effect.provideService(ConfigProvider.ConfigProvider, disabled));
    expect(absent.ONTOS_EMAIL_DISPATCH_SECRET).toBeUndefined();
  }),
);
