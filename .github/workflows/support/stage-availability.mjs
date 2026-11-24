// Read-only public stage checks. No credentials, recovery, or configurable CLI targets.
import { pathToFileURL } from 'node:url';

export const TARGETS = [
  { label: 'OAuth authorization metadata', url: 'https://ontos-stage.web-revolution.cz/.well-known/oauth-authorization-server' },
  { label: 'OAuth resource metadata', url: 'https://ontos-stage.web-revolution.cz/.well-known/oauth-protected-resource' },
  { label: 'AKROS', url: 'https://ontos-stage-akros.web-revolution.cz/cs', storefront: true },
  { label: 'shop', url: 'https://ontos-stage-shop.web-revolution.cz/cs', storefront: true },
  { label: 'N1', url: 'https://ontos-stage-n1.web-revolution.cz/cs', storefront: true },
];

// Same content contract as app/scripts/ops/stage-demo-verify.mjs, without app dependencies.
export function storefrontProblems(html) {
  const problems = [];
  if (!/<html[\s>]/iu.test(html) || !/<body[\s>]/iu.test(html)
      || !/<\/body\s*>/iu.test(html) || !/<\/html\s*>/iu.test(html)) {
    problems.push('not a complete HTML document');
  }
  if (!/href="[^"]*\/produkt\//u.test(html)) problems.push('lists no product');
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes < 100_000) problems.push(`${bytes} bytes, below the 100000-byte floor`);
  const marker = [
    'RecordsUnavailableProblem',
    'merchandise_persistence_unavailable',
    'read_handler_unavailable',
  ].find((entry) => html.includes(entry));
  if (marker) problems.push(`catalogue unavailable (${marker})`);
  return problems;
}

export function responseProblems(target, response, body) {
  const problems = [];
  if (response.url && new URL(response.url).origin !== new URL(target.url).origin) {
    problems.push('response came from the wrong origin');
  }
  if (response.status !== 200) problems.push(`HTTP ${response.status}`);
  if (response.status === 200 && target.storefront) problems.push(...storefrontProblems(body));
  if (response.status === 200 && !target.storefront) {
    try {
      const metadata = JSON.parse(body);
      const origin = new URL(target.url).origin;
      const issuer = `${origin}/shell-super-app-api/oauth`;
      if (target.url.endsWith('/oauth-authorization-server')) {
        if (metadata?.issuer !== issuer) problems.push('OAuth issuer is missing or incorrect');
      } else if (metadata?.resource !== `${origin}/mcp`
          || !Array.isArray(metadata?.authorization_servers)
          || !metadata.authorization_servers.includes(issuer)) {
        problems.push('OAuth resource or authorization server is missing or incorrect');
      }
    } catch {
      problems.push('OAuth metadata is not valid JSON');
    }
  }
  return problems;
}

export async function probeTarget(target, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`deadline exceeded (${timeoutMs}ms, including body)`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    const problems = await Promise.race([
      deadline,
      (async () => {
        // All redirects fail (non-200); never follow one, even to another public origin.
        const response = await fetchImpl(target.url, { redirect: 'manual', signal: controller.signal });
        if (response.status !== 200) return responseProblems(target, response, '');
        const body = await response.text();
        return responseProblems(target, response, body);
      })(),
    ]);
    return { label: target.label, problems };
  } catch (error) {
    return { label: target.label, problems: [String(error.message ?? error)] };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function checkAvailability({ targets = TARGETS, ...options } = {}) {
  // Each probe catches its own failures; a broken host cannot hide another host's diagnostics.
  return Promise.all(targets.map((target) => probeTarget(target, options)));
}

export async function failureDrill() {
  const target = TARGETS.find((entry) => entry.label === 'AKROS');
  const result = await probeTarget(target, {
    fetchImpl: async () => ({
      status: 502,
      url: target.url,
      text: async () => 'SIMULATED bad gateway',
    }),
  });
  return { ...result, label: 'SIMULATED AKROS 502' };
}

export function formatResults(results) {
  return results.map(({ label, problems }) =>
    problems.length === 0 ? `PASS ${label}` : `FAIL ${label}: ${problems.join('; ')}`,
  ).join('\n');
}

async function main(args) {
  if (args.length === 1 && args[0] === '--failure-drill') {
    const result = await failureDrill();
    console.log(formatResults([result]));
    console.log(result.problems.includes('HTTP 502')
      ? 'SIMULATED drill proved HTTP 502 is refused; deliberately failing this job. No public requests made.'
      : 'SIMULATED drill FAILED to prove HTTP 502 rejection. No public requests made.');
    process.exitCode = 1;
    return;
  }
  if (args.length !== 0) {
    console.error('Usage: node stage-availability.mjs [--failure-drill]; no target URLs accepted.');
    process.exitCode = 1;
    return;
  }
  const results = await checkAvailability();
  console.log(formatResults(results));
  process.exitCode = results.some(({ problems }) => problems.length > 0) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
