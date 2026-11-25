import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Redacted } from 'effect';

import {
  AKROS_SYMMY_STAGE_ORIGIN,
  loadSymmyNegativeProofConfig,
  parseSymmyNegativeProofArguments,
  runSymmyNegativeProof,
  symmyNegativeProofFailureLine,
} from './stage-symmy-negative-proof.mts';

const secret = 'test-only-never-print-this-key';
const missingId = '77777777-7777-4777-8777-777777777777';
const config = { origin: AKROS_SYMMY_STAGE_ORIGIN, apiKey: Redacted.make(secret) };
const page = {
  count: 1, limit: 1, offset: 0,
  orders: [{
    id: 'persisted-order-42', partyId: 'persisted-party-9', customerId: 'persisted-party-9',
    number: 'OBJ-2026-0042', status: 'NEW', currencyCode: 'CZK', pricesIncludeVat: false,
    createdAt: '2026-11-22T10:00:00.000Z', updatedAt: '2026-11-22T10:00:00.000Z',
    totalMinor: 12100, totalVatMinor: 2100, totalNetMinor: 10000,
    lines: [{
      productId: 'persisted-product-7', productName: 'Private product', sku: 'SKU-7',
      quantity: 1, unitPriceMinor: 10000, vatRate: 21, totalMinor: 12100, totalVatMinor: 2100,
    }],
  }],
};
const problemHeaders = { 'content-type': 'application/problem+json' };
const challenge = 'ApiKey realm="ontos-gateway"';
const authProblem = { _tag: 'GatewayAuthenticationRequiredProblem', status: 401,
  type: 'https://ontos.dev/problems/gateway-authentication-required', title: 'Unauthorized', detail: 'Key required' };
const missingProblem = { _tag: 'SymmyDemoOrderNotFoundProblem', status: 404,
  type: 'https://ontos.dev/problems/symmy-order-not-found', title: 'Not found', detail: 'Order absent' };
const fixture = (statuses = [401, 401, 404, 200], body: unknown = page, overrides: Record<number, Response> = {}) => {
  const calls: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
  const lines: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const index = calls.length - 1;
    const status = statuses[index] ?? 500;
    return overrides[index] ?? (index < 2
      ? Response.json(authProblem, { status, headers: { ...problemHeaders, 'www-authenticate': challenge } })
      : index === 2 ? Response.json(missingProblem, { status, headers: problemHeaders }) : Response.json(body, { status }));
  };
  return { calls, lines, fetch, newOrderId: () => missingId, writeLine: (line: string) => lines.push(line) };
};

test('executes only the four GET checks, authenticates only the last two, and prints no data or key', async () => {
  const current = fixture();
  await runSymmyNegativeProof(config, current);
  assert.deepEqual(current.calls.map(({ url }) => url), [
    `${config.origin}/api/symmy/v1/orders`,
    `${config.origin}/api/symmy/v1/catalog/revision`,
    `${config.origin}/api/symmy/v1/orders/${missingId}`,
    `${config.origin}/api/symmy/v1/orders?limit=1&offset=0`,
  ]);
  for (const [index, { init }] of current.calls.entries()) {
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.body, undefined);
    assert.equal(new Headers(init?.headers).get('x-api-key'), index < 2 ? null : secret);
  }
  assert.deepEqual(current.lines, [
    'PASS orders-unauthenticated status=401', 'PASS catalog-revision-unauthenticated status=401',
    'PASS missing-order status=404', 'PASS orders-list status=200',
  ]);
  assert.equal(current.lines.join('\n').includes(secret), false);
  assert.equal(current.lines.join('\n').includes('persisted'), false);
});

test('requires explicit run/origin/file arguments and refuses N1, storefront, injected paths and credentials', async () => {
  assert.throws(() => parseSymmyNegativeProofArguments([]));
  const args = parseSymmyNegativeProofArguments([
    '--run', '--origin', config.origin, '--key-file', '/private/key',
  ]);
  assert.equal(args.origin, config.origin);
  for (const origin of [
    'https://ontos-stage-n1.web-revolution.cz', 'https://ontos-stage-akros.web-revolution.cz',
    `${config.origin}/`, `${config.origin}/api`, `${config.origin}?key=${secret}`,
    'https://user:password@ontos-stage.web-revolution.cz', 'http://ontos-stage.web-revolution.cz',
  ]) {
    let reads = 0;
    await assert.rejects(loadSymmyNegativeProofConfig({ origin, keyFile: '/private/key' }, async () => {
      reads += 1;
      return secret;
    }));
    assert.equal(reads, 0);
  }
});

test('reads a key only when explicitly loading configuration and sanitizes file errors', async () => {
  let reads = 0;
  const loaded = await loadSymmyNegativeProofConfig({ origin: config.origin, keyFile: '/private/key' }, async () => {
    reads += 1;
    return `${secret}\n`;
  });
  assert.equal(reads, 1);
  assert.equal(Redacted.value(loaded.apiKey), secret);
  await assert.rejects(
    loadSymmyNegativeProofConfig({ origin: config.origin, keyFile: `/private/${secret}` }, async () => {
      throw new Error(secret);
    }),
    (error: unknown) => symmyNegativeProofFailureLine(error) ===
      'FAIL configuration status=none reason=key_file_unreadable',
  );
});

test('fails closed on redirects and unexpected auth/detail statuses without reading or printing response bodies', async () => {
  for (const statuses of [[302], [200], [401, 403], [401, 401, 200], [401, 401, 404, 503]]) {
    const current = fixture(statuses, { secret });
    await assert.rejects(runSymmyNegativeProof(config, current), (error: unknown) => {
      const line = symmyNegativeProofFailureLine(error);
      assert.equal(line.includes(secret), false);
      assert.match(line, /^FAIL [a-z-]+ status=\d+ reason=(redirect_refused|unexpected_status)$/u);
      return true;
    });
    assert.ok(current.calls.length <= 4);
  }
});

test('requires schema-valid nonempty persisted identifiers, not merely a 200 response', async () => {
  for (const body of [
    {}, { ...page, count: 0, orders: [] },
    { ...page, orders: [{ ...page.orders[0], id: '' }] },
    { ...page, orders: [{ ...page.orders[0], customerId: 'different-party' }] },
    { ...page, limit: 50 }, { ...page, offset: 1 },
  ]) {
    await assert.rejects(runSymmyNegativeProof(config, fixture(undefined, body)), (error: unknown) =>
      /^FAIL orders-list status=200 reason=(response_invalid|orders_empty)$/u.test(symmyNegativeProofFailureLine(error)));
  }
});

test('rejects unrelated 401/404 responses and a missing or foreign challenge without leaking their bodies', async () => {
  for (const [index, response] of [
    [0, Response.json(authProblem, { status: 401, headers: problemHeaders })],
    [1, Response.json(authProblem, { status: 401, headers: { ...problemHeaders, 'www-authenticate': 'Bearer' } })],
    [0, Response.json({ ...authProblem, _tag: 'Other', detail: secret }, {
      status: 401, headers: { ...problemHeaders, 'www-authenticate': challenge },
    })],
    [2, new Response('Not found', { status: 404 })],
    [2, Response.json({ ...missingProblem, _tag: 'Other', detail: secret }, { status: 404, headers: problemHeaders })],
    [2, Response.json({ ...missingProblem, status: 401 }, { status: 404, headers: problemHeaders })],
  ] as const) {
    const current = fixture(undefined, page, { [index]: response });
    const check = ['orders-unauthenticated', 'catalog-revision-unauthenticated', 'missing-order'][index];
    await assert.rejects(runSymmyNegativeProof(config, current), (error: unknown) =>
      symmyNegativeProofFailureLine(error) === `FAIL ${check} status=${response.status} reason=response_invalid`);
    assert.equal(current.calls.length, index + 1);
  }
});

test('sanitizes network errors and refuses an invalid generated selector before sending any requests', async () => {
  const current = fixture();
  await assert.rejects(runSymmyNegativeProof(config, { ...current, newOrderId: () => secret }));
  assert.equal(current.calls.length, 0);
  const fetch: typeof globalThis.fetch = async () => { throw new Error(secret); };
  await assert.rejects(runSymmyNegativeProof(config, { ...current, fetch }), (error: unknown) =>
    symmyNegativeProofFailureLine(error) === 'FAIL orders-unauthenticated status=none reason=network_failed');
  assert.equal(symmyNegativeProofFailureLine(new Error(secret)), 'FAIL configuration status=none reason=unexpected_failure');
});
