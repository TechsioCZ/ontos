import assert from 'node:assert/strict';
import test from 'node:test';
import { createSecretStore } from './secret-store.mjs';

test('secret values travel only inside sensitive JSON requests, with process completion checked', async () => {
  const requests = [];
  const store = createSecretStore({
    token: 'private-token',
    pollMs: 0,
    fetchImpl: async (url, options) => {
      requests.push({ url, ...options });
      if (options.method === 'POST') return Response.json({ id: 'operation', status: 'RUNNING' });
      if (url.includes('/process/')) return Response.json({ id: 'operation', status: 'FINISHED' });
      if (options.method === 'DELETE') return Response.json({ id: 'operation', status: 'FINISHED' });
      return Response.json({ list: [{ id: 'entry', key: 'SMTP_PASSWORD', content: 'private-value' }], total: 1 });
    },
  });
  assert.equal((await store.list('service'))[0].content, 'private-value');
  await store.create('service', 'SMTP_PASSWORD', 'private-value');
  await store.remove('entry');
  const create = requests.find(({ method }) => method === 'POST');
  assert.deepEqual(JSON.parse(create.body), { key: 'SMTP_PASSWORD', content: 'private-value', sensitive: true });
  assert.equal(create.headers.authorization, 'Bearer private-token');
  assert.ok(requests.every(({ url }) => !url.includes('private-value') && !url.includes('private-token')));
  assert.ok(requests.some(({ url }) => url.endsWith('/process/operation')));
});

test('an API error body cannot leak secret values into the exception', async () => {
  const store = createSecretStore({
    token: 'private-token',
    fetchImpl: async () => Response.json({ content: 'private-value' }, { status: 400 }),
  });
  await assert.rejects(store.create('service', 'SMTP_PASSWORD', 'private-value'),
    (error) => /HTTP 400/u.test(error.message) && !/private-/u.test(error.message));
});
