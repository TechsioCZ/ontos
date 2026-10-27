import { Config, ConfigProvider, Effect, Option, Schema } from 'effect';

import type { EmailEnvironment } from '../transport-runtime.ts';

// Which recipients are test/QA addresses. Their e-mails are still really sent over SMTP, but to a separate test
// capture (second Mailpit, SMTP 127.0.0.1:1026, UI http://localhost:8026), never to the presented demo inbox (:8025).

/** Reserved test domains (RFC 2606 / 6761 .invalid, .test) and the markers QA personas use in their addresses. */
export const isTestRecipient = (address: string): boolean => {
  const value = address.trim().toLowerCase();
  const at = value.lastIndexOf('@');
  const local = at === -1 ? value : value.slice(0, at);
  const domain = value.slice(at + 1);
  return (
    domain.endsWith('.invalid') ||
    domain.endsWith('.test') ||
    domain === 'audit.example' ||
    /(?:audit|critic|kritik|fixer|reqsol|reqx|test)/u.test(local)
  );
};

export interface TestCaptureRoute {
  readonly host: string;
  readonly port: number;
}

/**
 * Test capture SMTP server. Defaults to the second demo Mailpit (127.0.0.1:1026). `EMAIL_TEST_SMTP_HOST=none` turns the
 * separation off (test recipients then go to the main SMTP server like everyone else).
 */
export const TestCaptureEnvironmentSchema = Schema.Struct({
  EMAIL_TEST_SMTP_HOST: Schema.optionalKey(Schema.String),
  EMAIL_TEST_SMTP_PORT: Schema.optionalKey(Schema.String),
});
export type TestCaptureEnvironment = typeof TestCaptureEnvironmentSchema.Encoded;

const readTestCaptureConfiguration = Effect.fn('EmailRecipients.testCaptureConfiguration')(function* captureSettings(
  provider: ConfigProvider.ConfigProvider,
) {
  const host = yield* Config.schema(Schema.Trim, 'EMAIL_TEST_SMTP_HOST')
    .pipe(Config.withDefault('127.0.0.1'))
    .parse(provider);
  if (host === '' || host.toLowerCase() === 'none') {
    return Option.none<TestCaptureRoute>();
  }
  const port = yield* Config.Port('EMAIL_TEST_SMTP_PORT').pipe(Config.withDefault(1026)).parse(provider);
  return Option.some({ host, port });
});

export const testCaptureConfiguration = ConfigProvider.ConfigProvider.pipe(
  Effect.flatMap(readTestCaptureConfiguration),
);

export const testCaptureFromEnvironment = (environment: TestCaptureEnvironment) =>
  readTestCaptureConfiguration(ConfigProvider.fromUnknown(environment));

/**
 * Seeded demo and QA addresses (management@siampark.demo, ucetni@demo.ontos, demo@test.com…): no inbox exists, so
 * every runtime records them SKIPPED instead of sending. Suffix rules include the domain itself and its subdomains.
 */
export const SEEDED_UNDELIVERABLE_DOMAINS = 'demo,demo.ontos,test,test.com,invalid,local,localhost';
/** RFC 2606 documentation domains: undeliverable on the internet; the local Mailpit still captures them. */
const DOCUMENTATION_DOMAINS = 'example,example.com,example.net,example.org';

/** `ONTOS_EMAIL_UNDELIVERABLE_DOMAINS` replaces the list; otherwise Workers also skip the documentation domains. */
export const undeliverableDomainsFor = (transport: 'cloudflare' | 'smtp', env: EmailEnvironment): string =>
  env.ONTOS_EMAIL_UNDELIVERABLE_DOMAINS ??
  (transport === 'cloudflare'
    ? `${SEEDED_UNDELIVERABLE_DOMAINS},${DOCUMENTATION_DOMAINS}`
    : SEEDED_UNDELIVERABLE_DOMAINS);

export const isUndeliverableRecipient = (address: string, domains = SEEDED_UNDELIVERABLE_DOMAINS): boolean => {
  const value = address.trim().toLowerCase();
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(value)) {
    return true;
  }
  const domain = value.slice(value.lastIndexOf('@') + 1).replace(/\.+$/u, '');
  return domains.split(',').some((entry) => {
    const rule = entry
      .trim()
      .toLowerCase()
      .replace(/^\*?\./u, '')
      .replace(/\.+$/u, '');
    return rule !== '' && (domain === rule || domain.endsWith(`.${rule}`));
  });
};
