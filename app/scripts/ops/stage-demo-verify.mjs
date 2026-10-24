// One post-deploy verification pass of stage (no load: the stage Workers CPU budget is capped).
// Signs in as a persona, times three authenticated /cs documents, checks the OAuth metadata and the
// AKROS storefront home, then signs the session out through the native action even when a check
// failed. Each page document must answer within DOCUMENT_ACCEPTANCE_MS; OAuth metadata and the auth
// writes are checked for status only, because the page budget is not their contract.
// usage: node scripts/ops/stage-demo-verify.mjs
const DEFAULT_SHELL_URL = 'https://ontos-stage.bleeding.dev';
const DEFAULT_STOREFRONT_URL = 'https://ontos-stage-akros.bleeding.dev';
const DEFAULT_PERSONA = 'management@siampark.demo';
const REQUEST_TIMEOUT_MS = 60_000;
const SIGN_OUT_TIMEOUT_MS = 10_000;

/** Page acceptance for a document response. Deliberately has no environment or flag override. */
export const DOCUMENT_ACCEPTANCE_MS = 1500;

/**
 * The persona's session cookies as one request Cookie value; the session is what sign-out must end.
 * @param {Response} response The sign-in answer whose Set-Cookie headers carry the session.
 * @returns {string} A Cookie request header value.
 */
const sessionCookie = (response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');

/**
 * The pass takes its transport as one narrow function so a test can drive it without the global.
 * @param {string} url The absolute request URL.
 * @param {RequestInit | undefined} init The request options.
 * @returns {Promise<Response>} The page, metadata or auth answer.
 */
const defaultTransport = async (url, init) => await fetch(url, init);

/**
 * Runs the verification pass against the given transport and clock, and returns every failure it saw
 * so the caller decides the exit code; the tests inject both dependencies to drive each branch.
 * @param {object} options The pass configuration.
 * @param {(line: string) => void} [options.log] Receives one timing line per probe.
 * @param {() => number} [options.now] Monotonic clock in milliseconds.
 * @param {string} [options.password] The persona's password.
 * @param {string} [options.persona] The account the pass signs in with.
 * @param {string} [options.shellUrl] The Shell origin.
 * @param {string} [options.storefrontUrl] The storefront origin.
 * @param {(url: string, init?: RequestInit) => Promise<Response>} [options.transport] The HTTP transport.
 * @returns {Promise<{failures: string[]}>} The failure descriptions, in the order they happened.
 */
export const verifyStage = async ({
  log = console.log,
  now = () => performance.now(),
  password = 'password1234',
  persona = DEFAULT_PERSONA,
  shellUrl = DEFAULT_SHELL_URL,
  storefrontUrl = DEFAULT_STOREFRONT_URL,
  transport = defaultTransport,
}) => {
  /** @type {string[]} */
  const failures = [];

  /**
   * Times one request and records its failure, if any.
   * @param {string} label The probe name used in the log line and failure text.
   * @param {string} url The absolute request URL.
   * @param {{ budgetMs?: number, init?: RequestInit }} [options] The page budget and request options.
   * @returns {Promise<Response | null>} The answer, or null when the transport itself failed.
   */
  const probe = async (label, url, options) => {
    const { budgetMs, init } = options ?? {};
    const started = now();
    let response;
    try {
      response = await transport(url, { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...init });
    } catch (error) {
      failures.push(`${label} failed: ${String(error)}`);
      return null;
    }
    // Report first-byte timing separately; acceptance includes reading the complete document.
    const elapsed = now() - started;
    try {
      await response.arrayBuffer();
    } catch (error) {
      failures.push(`${label} body failed: ${String(error)}`);
    }
    const total = now() - started;
    log(`${label} ${response.status} ttfb=${(elapsed / 1000).toFixed(2)}s total=${(total / 1000).toFixed(2)}s`);
    if (response.status !== 200) {
      failures.push(`${label} answered ${response.status}`);
    } else if (budgetMs !== undefined && total > budgetMs) {
      failures.push(`${label} took ${Math.round(total)}ms, over the ${budgetMs}ms page budget`);
    }
    return response;
  };

  await probe('oauth-authorization-server', `${shellUrl}/.well-known/oauth-authorization-server`);
  await probe('oauth-protected-resource', `${shellUrl}/.well-known/oauth-protected-resource`);
  const signIn = await probe('sign-in', `${shellUrl}/shell-super-app-api/auth/sign-in`, {
    init: {
      body: JSON.stringify({ email: persona, password }),
      headers: { 'content-type': 'application/json', origin: shellUrl },
      method: 'POST',
    },
  });
  /** @type {string} */
  const cookie = signIn === null ? '' : sessionCookie(signIn);

  try {
    if (cookie === '') {
      // A transport failure already named its own probe; only an answered sign-in can be cookie-less.
      if (signIn !== null) {
        failures.push('sign-in answered without a session cookie');
      }
    } else {
      /** @type {{ budgetMs: number, init: RequestInit }} */
      const documentProbe = { budgetMs: DOCUMENT_ACCEPTANCE_MS, init: { headers: { cookie } } };
      await probe(`/cs #1 (${persona})`, `${shellUrl}/cs`, documentProbe);
      await probe(`/cs #2 (${persona})`, `${shellUrl}/cs`, documentProbe);
      await probe(`/cs #3 (${persona})`, `${shellUrl}/cs`, documentProbe);
    }
    await probe('storefront home', `${storefrontUrl}/`, { budgetMs: DOCUMENT_ACCEPTANCE_MS });
  } finally {
    // The pass must not leave the persona's session behind, whatever the checks above did, and the
    // sign-out keeps its own bounded timeout so a stalled cleanup cannot hang the job either.
    if (cookie !== '') {
      await probe('sign-out', `${shellUrl}/shell-super-app-api/auth/sign-out`, {
        init: {
          headers: { cookie, origin: shellUrl },
          method: 'POST',
          signal: AbortSignal.timeout(SIGN_OUT_TIMEOUT_MS),
        },
      });
    }
  }

  return { failures };
};

if (import.meta.main) {
  const { failures } = await verifyStage({
    persona: process.env.STAGE_VERIFY_PERSONA ?? DEFAULT_PERSONA,
    shellUrl: process.env.STAGE_SHELL_URL ?? DEFAULT_SHELL_URL,
    storefrontUrl: process.env.STAGE_STOREFRONT_URL ?? DEFAULT_STOREFRONT_URL,
  });
  if (failures.length > 0) {
    console.error(`stage verification FAILED: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('stage verification PASS');
}
