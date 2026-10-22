// One post-deploy verification pass of stage (no load: the stage Workers CPU budget is capped).
// Signs in as a persona, times three authenticated /cs documents, checks the OAuth metadata and the
// AKROS storefront home. Fails on any non-200 answer. usage: node scripts/ops/stage-demo-verify.mjs
const shell = process.env.STAGE_SHELL_URL ?? 'https://ontos-stage.bleeding.dev';
const storefront = process.env.STAGE_STOREFRONT_URL ?? 'https://ontos-stage-akros.bleeding.dev';
const email = process.env.STAGE_VERIFY_PERSONA ?? 'management@siampark.demo';
const failures = [];

const timed = async (label, url, init = {}) => {
  const started = performance.now();
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000), ...init });
  const ttfb = performance.now() - started;
  await response.arrayBuffer();
  const total = performance.now() - started;
  console.log(`${label} ${response.status} ttfb=${(ttfb / 1000).toFixed(2)}s total=${(total / 1000).toFixed(2)}s`);
  if (response.status !== 200) failures.push(`${label} answered ${response.status}`);
  return response;
};

await timed('oauth-authorization-server', `${shell}/.well-known/oauth-authorization-server`);
await timed('oauth-protected-resource', `${shell}/.well-known/oauth-protected-resource`);
const signIn = await timed('sign-in', `${shell}/shell-super-app-api/auth/sign-in`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: shell },
  body: JSON.stringify({ email, password: 'password1234' }),
});
const cookie = signIn.headers
  .getSetCookie()
  .map((value) => value.split(';')[0])
  .join('; ');
for (let attempt = 1; attempt <= 3; attempt++) {
  await timed(`/cs #${attempt} (${email})`, `${shell}/cs`, { headers: { cookie } });
}
await timed('storefront home', `${storefront}/`);

if (failures.length > 0) {
  console.error(`stage verification FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('stage verification PASS');
