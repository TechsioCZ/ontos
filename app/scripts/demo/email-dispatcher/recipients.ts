// @effect-diagnostics *:off
// Which recipients are test/QA addresses. Their e-mails are still really sent over SMTP, but to a separate test
// capture (second Mailpit, SMTP 127.0.0.1:1026, UI http://localhost:8026), never to the presented demo inbox (:8025).

/** Reserved test domains (RFC 2606 / 6761 .invalid, .test) and the markers QA personas use in their addresses. */
export const isTestRecipient = (address: string): boolean => {
  const value = address.trim().toLowerCase();
  const at = value.lastIndexOf('@');
  const local = at < 0 ? value : value.slice(0, at);
  const domain = value.slice(at + 1);
  return (
    domain.endsWith('.invalid') ||
    domain.endsWith('.test') ||
    domain === 'audit.example' ||
    /(audit|critic|kritik|fixer|reqsol|reqx|test)/u.test(local)
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
export const testCaptureFromEnvironment = (env: Readonly<Record<string, string | undefined>>): TestCaptureRoute | null => {
  const host = (env['EMAIL_TEST_SMTP_HOST'] ?? '127.0.0.1').trim();
  if (host === '' || host.toLowerCase() === 'none') return null;
  return { host, port: Number(env['EMAIL_TEST_SMTP_PORT'] ?? 1026) };
};
