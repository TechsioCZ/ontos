import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  TARGETS, checkAvailability, failureDrill, formatResults, probeTarget, storefrontProblems,
} from './stage-availability.mjs';

const storefront = TARGETS.find(({ label }) => label === 'AKROS');
const metadata = TARGETS[0];
const validHtml = `<html><body><a href="/produkt/test">Product</a>${' '.repeat(100_000)}</body></html>`;
const metadataBody = (target) => JSON.stringify(target.url.endsWith('/oauth-authorization-server')
  ? { issuer: 'https://ontos-stage.web-revolution.cz/shell-super-app-api/oauth' }
  : { resource: 'https://ontos-stage.web-revolution.cz/mcp',
    authorization_servers: ['https://ontos-stage.web-revolution.cz/shell-super-app-api/oauth'] });
const fakeResponse = (target, {
  status = 200, body = target.storefront ? validHtml : metadataBody(target), url = target.url, text,
} = {}) => ({
  status, url, text: text ?? (async () => body),
});
const probe = (response, target = storefront) =>
  probeTarget(target, { fetchImpl: async () => response });

test('200 valid storefronts and metadata pass independently with read-only requests', async () => {
  const requested = [];
  const results = await checkAvailability({
    fetchImpl: async (url, init) => {
      requested.push(url);
      assert.equal(init.redirect, 'manual');
      assert.equal(init.method ?? 'GET', 'GET');
      assert.equal(init.headers, undefined);
      return fakeResponse(TARGETS.find((entry) => entry.url === url));
    },
  });
  assert.equal(requested.length, 5);
  assert.ok(results.every(({ problems }) => problems.length === 0));
  assert.equal(formatResults(results).split('\n').length, 5);
});

test('502, other non-200 statuses and wrong-origin redirects fail', async () => {
  for (const status of [502, 503, 404, 204, 301, 302, 307, 308]) {
    const result = await probe(fakeResponse(storefront, { status, url: 'https://wrong.example/cs' }));
    assert.ok(result.problems.includes(`HTTP ${status}`));
    assert.ok(result.problems.includes('response came from the wrong origin'));
  }
  assert.ok((await probe(fakeResponse(storefront, { url: 'https://wrong.example/cs' }))).problems.length > 0);
});

test('empty, near-empty, productless and malformed storefront 200 responses fail', async () => {
  for (const body of ['', '<html><body></body></html>', validHtml.replace('/produkt/', '/other/'),
    validHtml.replace('</html>', ''), 'x'.repeat(110_000)]) {
    assert.ok((await probe(fakeResponse(storefront, { body }))).problems.length > 0);
  }
  assert.deepEqual(storefrontProblems(`<html><body><a href="/produkt/a">${'x'.repeat(99_948)}</a></body></html>`),
    ['99999 bytes, below the 100000-byte floor']);
  assert.deepEqual(storefrontProblems(`<html><body><a href="/produkt/a">${'x'.repeat(99_949)}</a></body></html>`), []);
});

test('all existing catalogue-unavailable markers fail even a full product-bearing 200', async () => {
  for (const marker of ['RecordsUnavailableProblem', 'merchandise_persistence_unavailable', 'read_handler_unavailable']) {
    const result = await probe(fakeResponse(storefront, { body: validHtml.replace('Product', marker) }));
    assert.ok(result.problems.some((problem) => problem.includes(marker)));
  }
});

test('deadline bounds headers AND body, even when injected fetch ignores abort', async () => {
  for (const stuckBody of [false, true]) {
    let signal;
    const result = await probeTarget(storefront, {
      timeoutMs: 10,
      fetchImpl: async (_, init) => {
        signal = init.signal;
        if (!stuckBody) return new Promise(() => {});
        return fakeResponse(storefront, { text: () => new Promise(() => {}) });
      },
    });
    assert.match(result.problems.join('; '), /deadline exceeded.*including body/u);
    assert.equal(signal.aborted, true);
  }
});

test('transport and body failures are failures, not healthy status 200', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('connection refused'); },
    async () => fakeResponse(storefront, { text: async () => { throw new Error('body reset'); } }),
  ]) {
    assert.ok((await probeTarget(storefront, { fetchImpl })).problems.length > 0);
  }
});

test('metadata failure does not skip any storefront or lose other diagnostics', async () => {
  const results = await checkAvailability({
    fetchImpl: async (url) => {
      const target = TARGETS.find((entry) => entry.url === url);
      if (url === metadata.url) throw new Error('metadata connection refused');
      return fakeResponse(target, { status: target.label === 'AKROS' ? 502 : 200 });
    },
  });
  assert.equal(results.length, 5);
  assert.match(results[0].problems.join('; '), /metadata connection refused/u);
  assert.deepEqual(results[2].problems, ['HTTP 502']);
  assert.deepEqual(results.slice(3).map(({ problems }) => problems), [[], []]);
  assert.deepEqual((await probe(fakeResponse(metadata, { status: 502 }), metadata)).problems, ['HTTP 502']);
});

test('metadata HTTP 200 must identify the real OAuth issuer and resource', async () => {
  for (const target of TARGETS.filter((entry) => !entry.storefront)) {
    for (const body of ['', '<html>proxy error</html>', '{}', 'null',
      '{"issuer":"https://wrong.example","resource":"https://wrong.example/mcp","authorization_servers":[]}']) {
      assert.ok((await probe(fakeResponse(target, { body }), target)).problems.length > 0);
    }
  }
});

test('deterministic drill uses the checker and deliberately exits nonzero, clearly simulated', async () => {
  assert.deepEqual((await failureDrill()).problems, ['HTTP 502']);
  const cli = spawnSync(process.execPath, [new URL('./stage-availability.mjs', import.meta.url).pathname, '--failure-drill'],
    { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /FAIL SIMULATED AKROS 502: HTTP 502/u);
  assert.match(cli.stdout, /proved HTTP 502 is refused; deliberately failing.*No public requests made/u);
});

test('CLI refuses arbitrary URL inputs without probing', () => {
  const cli = spawnSync(process.execPath, [new URL('./stage-availability.mjs', import.meta.url).pathname, 'https://wrong.example'],
    { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /no target URLs accepted/u);
  assert.equal(cli.stdout, '');
});
