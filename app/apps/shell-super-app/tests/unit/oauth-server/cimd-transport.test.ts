// @rstest-environment node
import { afterEach, expect, rs, test } from 'effect-rstest';

import {
  CIMD_FETCH_TIMEOUT_MS,
  CIMD_MAX_RESPONSE_BYTES,
  fetchClientMetadataResource,
} from '../../../api/auth/cimd-transport.workerd.ts';

const CLIENT = 'https://client.example/oauth/client.json';

afterEach(() => {
  rs.unstubAllGlobals();
  rs.useRealTimers();
});

test('workerd CIMD rejects insecure URLs, literal addresses, localhost and credentials before fetching', async () => {
  const fetch = rs.fn();
  rs.stubGlobal('fetch', fetch);
  for (const url of [
    'http://client.example/client.json',
    'https://127.0.0.1/client.json',
    'https://2130706433/client.json',
    'https://0x7f000001/client.json',
    'https://[::1]/client.json',
    'https://[::ffff:127.0.0.1]/client.json',
    'https://localhost/client.json',
    'https://localhost./client.json',
    'https://private.localhost/client.json',
    'https://user:password@client.example/client.json',
    `${CLIENT}#fragment`,
  ]) {
    await expect(fetchClientMetadataResource(url)).rejects.toThrow();
  }
  expect(fetch).not.toHaveBeenCalled();
});

test('workerd CIMD preserves conditional headers, caps the response and forces manual redirects', async () => {
  const fetch = rs.fn(() => Promise.resolve(Response.json({ client_id: CLIENT }, { headers: { etag: 'v1' } })));
  rs.stubGlobal('fetch', fetch);
  const response = await fetchClientMetadataResource(CLIENT, {
    headers: { 'if-none-match': 'v0' },
    redirect: 'follow',
  });
  expect(await response.json()).toEqual({ client_id: CLIENT });
  expect(response.headers.get('etag')).toBe('v1');
  const [request, init] = fetch.mock.calls[0] as unknown as [Request, RequestInit];
  expect(request.headers.get('if-none-match')).toBe('v0');
  expect(init.redirect).toBe('manual');
  expect(init.signal).toBeInstanceOf(AbortSignal);
});

test('workerd CIMD passes a conditional 304 through without requiring a JSON body', async () => {
  rs.stubGlobal(
    'fetch',
    rs.fn(() => Promise.resolve(new Response(null, { headers: { etag: 'v1' }, status: 304 }))),
  );
  const response = await fetchClientMetadataResource(CLIENT, { headers: { 'if-none-match': 'v1' } });
  expect(response.status).toBe(304);
  expect(response.headers.get('etag')).toBe('v1');
});

test('workerd CIMD refuses redirects, non-JSON, malformed JSON and declared oversized bodies', async () => {
  for (const response of [
    new Response(null, { headers: { location: 'https://elsewhere.example/metadata' }, status: 302 }),
    new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    new Response('{}', {
      headers: { 'content-length': String(CIMD_MAX_RESPONSE_BYTES + 1), 'content-type': 'application/json' },
    }),
  ]) {
    const fetch = rs.fn(() => Promise.resolve(response));
    rs.stubGlobal('fetch', fetch);
    await expect(fetchClientMetadataResource(CLIENT)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  }
});

test('workerd CIMD cancels a streamed oversized body even without Content-Length', async () => {
  const cancel = rs.fn();
  const body = new ReadableStream({
    cancel,
    start(controller) {
      controller.enqueue(new Uint8Array(CIMD_MAX_RESPONSE_BYTES + 1));
    },
  });
  rs.stubGlobal(
    'fetch',
    rs.fn(() => Promise.resolve(new Response(body, { headers: { 'content-type': 'application/json' } }))),
  );
  await expect(fetchClientMetadataResource(CLIENT)).rejects.toThrow('too large');
  expect(cancel).toHaveBeenCalledTimes(1);
});

test('workerd CIMD aborts a stalled fetch after five seconds', async () => {
  rs.useFakeTimers();
  rs.stubGlobal(
    'fetch',
    rs.fn(
      (_request: Request, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
    ),
  );
  const result = expect(fetchClientMetadataResource(CLIENT)).rejects.toThrow('timed out');
  await rs.advanceTimersByTimeAsync(CIMD_FETCH_TIMEOUT_MS);
  await result;
});

test('workerd CIMD propagates caller cancellation', async () => {
  const controller = new AbortController();
  rs.stubGlobal(
    'fetch',
    rs.fn(
      (_request: Request, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
    ),
  );
  const result = expect(fetchClientMetadataResource(CLIENT, { signal: controller.signal })).rejects.toThrow(
    'caller cancelled',
  );
  controller.abort(new Error('caller cancelled'));
  await result;
});
