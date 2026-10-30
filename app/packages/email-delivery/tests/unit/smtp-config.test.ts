import { Effect, Option, Predicate, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { testCaptureFromEnvironment } from '../../src/dispatcher/recipients.ts';
import { smtpConfigurationFromEnvironment } from '../../src/smtp.ts';
import type { SmtpEnvironment } from '../../src/smtp.ts';

const maximumTimeoutMs = 2_147_483_647;

it.effect.each([
  { expected: false, settings: {} },
  { expected: false, settings: { SMTP_SECURE: 'false' } },
  { expected: true, settings: { SMTP_SECURE: 'true' } },
])('only the exact true setting enables TLS: %j', ({ expected, settings }) =>
  Effect.gen(function* exactSecureSetting() {
    expect((yield* smtpConfigurationFromEnvironment(settings)).secure).toBe(expected);
  }),
);

it.effect.each(['', ' ', 'TRUE', 'FALSE', ' true ', 'false ', 'yes', 'no', 'on', 'off', '1', '0', 'y', 'n', 'unknown'])(
  'fails closed on a noncanonical SMTP_SECURE value: %j',
  (value) =>
    Effect.gen(function* rejectedSecureSetting() {
      const error = yield* Effect.flip(smtpConfigurationFromEnvironment({ SMTP_SECURE: value }));
      expect(Predicate.isTagged(error, 'ConfigError')).toBe(true);
    }),
);

it.effect.each(['', ' ', '0', '-1', '65536', '1025.5', 'NaN', 'Infinity', '1025abc'])(
  'rejects a malformed or out-of-range SMTP_PORT: %j',
  (value) =>
    Effect.gen(function* rejectedPortSetting() {
      const error = yield* Effect.flip(smtpConfigurationFromEnvironment({ SMTP_PORT: value }));
      expect(Predicate.isTagged(error, 'ConfigError')).toBe(true);
    }),
);

it.effect.each([
  { expected: 1025, settings: {} },
  { expected: 1025, settings: { SMTP_PORT: ' 1025 ' } },
  { expected: 1, settings: { SMTP_PORT: '1' } },
  { expected: 65_535, settings: { SMTP_PORT: '65535' } },
])('keeps valid integer port values without rounding: %j', ({ expected, settings }) =>
  Effect.gen(function* validPortSetting() {
    expect((yield* smtpConfigurationFromEnvironment(settings)).port).toBe(expected);
  }),
);

it.effect.each([
  '',
  ' ',
  '0',
  '-1',
  '0.5',
  '1.5',
  'NaN',
  'Infinity',
  '1e309',
  '2147483648',
  '9007199254740993',
  '10ms',
])('rejects unbounded, fractional or malformed SMTP_TIMEOUT_MS: %j', (value) =>
  Effect.gen(function* rejectedTimeoutSetting() {
    const error = yield* Effect.flip(smtpConfigurationFromEnvironment({ SMTP_TIMEOUT_MS: value }));
    expect(Predicate.isTagged(error, 'ConfigError')).toBe(true);
  }),
);

it.effect.each([
  { expected: 10_000, settings: {} },
  { expected: 10_000, settings: { SMTP_TIMEOUT_MS: ' 10000 ' } },
  { expected: 1000, settings: { SMTP_TIMEOUT_MS: '1e3' } },
  { expected: 1, settings: { SMTP_TIMEOUT_MS: '1' } },
  { expected: maximumTimeoutMs, settings: { SMTP_TIMEOUT_MS: '2147483647' } },
])('keeps bounded integer millisecond timeouts without rounding: %j', ({ expected, settings }) =>
  Effect.gen(function* validTimeoutSetting() {
    expect((yield* smtpConfigurationFromEnvironment(settings)).timeoutMs).toBe(expected);
  }),
);

const blankEndpoints: readonly SmtpEnvironment[] = [
  { SMTP_HOST: '' },
  { SMTP_HOST: '   ' },
  { SMTP_FROM: '' },
  { SMTP_FROM: '   ' },
];
it.effect.each(blankEndpoints)('does not replace explicit blank endpoints with defaults: %j', (settings) =>
  Effect.gen(function* blankEndpointConfiguration() {
    const config = yield* smtpConfigurationFromEnvironment(settings);
    expect(config.host).toBe(settings.SMTP_HOST ?? '127.0.0.1');
    expect(config.from).toBe(settings.SMTP_FROM ?? 'OntOS <oznameni@ontos.demo>');
  }),
);

it.effect('redacts SMTP credentials without changing their content', () =>
  Effect.gen(function* redactedCredentials() {
    const password = ['private', 'password'].join('-');
    const config = yield* smtpConfigurationFromEnvironment({
      SMTP_PASSWORD: password,
      SMTP_SECURE: 'true',
      SMTP_USER: 'user',
    });
    expect(config.password === undefined ? undefined : Redacted.value(config.password)).toBe(password);
    expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(config.password)).not.toContain(password);
  }),
);

it.effect.each(['', ' ', ' NONE '])('does not parse an unused test-capture port: %j', (host) =>
  Effect.gen(function* disabledCapture() {
    expect(
      Option.isNone(yield* testCaptureFromEnvironment({ EMAIL_TEST_SMTP_HOST: host, EMAIL_TEST_SMTP_PORT: 'invalid' })),
    ).toBe(true);
  }),
);

it.effect.each(['', ' ', '0', '-1', '65536', '1026.5', 'invalid'])(
  'fails closed on a malformed enabled test-capture port: %j',
  (port) =>
    Effect.gen(function* invalidCapture() {
      const error = yield* Effect.flip(
        testCaptureFromEnvironment({ EMAIL_TEST_SMTP_HOST: '127.0.0.1', EMAIL_TEST_SMTP_PORT: port }),
      );
      expect(Predicate.isTagged(error, 'ConfigError')).toBe(true);
    }),
);

it.effect('preserves numeric whitespace at the test-capture boundary', () =>
  Effect.gen(function* capturePortWhitespace() {
    expect(
      yield* testCaptureFromEnvironment({ EMAIL_TEST_SMTP_HOST: ' capture ', EMAIL_TEST_SMTP_PORT: ' 1026 ' }),
    ).toEqual(Option.some({ host: 'capture', port: 1026 }));
  }),
);
