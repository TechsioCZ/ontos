import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import apiRuntime from '../../api/index.ts';
import { classifyResourceProviderReadFailure } from '../../api/auth/resource-provider-server.ts';
import { crmApi } from '../../shared/api.ts';

test('composes readiness and every declared governed resource-provider API', () => {
  assert.strictEqual(apiRuntime.api, crmApi);
  assert.deepEqual(Object.keys(crmApi.groups), [
    'foundation',
    'contactDetail',
    'createCustomerActions',
    'customerDetail',
    'reads',
    'customerTimeline',
    'dealDetail',
    'deleteCustomerActions',
    'editCustomerActions',
  ]);
  const endpoints = Object.values(crmApi.groups).flatMap((group) =>
    Object.values(group.endpoints).map(({ method, path: endpointPath }) => ({
      method,
      path: endpointPath,
    })),
  );
  assert.deepEqual(endpoints, [
    { method: 'GET', path: '/crm/readiness' },
    { method: 'POST', path: '/reads/contact-detail' },
    { method: 'POST', path: '/actions/create-customer' },
    { method: 'POST', path: '/reads/customer-detail' },
    { method: 'POST', path: '/reads/customer-directory' },
    { method: 'POST', path: '/reads/customer-timeline' },
    { method: 'POST', path: '/reads/deal-detail' },
    { method: 'POST', path: '/actions/delete-customer' },
    { method: 'POST', path: '/actions/edit-customer' },
  ]);
  assert.equal(
    endpoints.some(({ path: endpointPath }) => endpointPath === '/crm'),
    false,
  );
});

test('centralizes fail-closed provider error classification and unexpected-failure logging', async () => {
  assert.deepEqual(classifyResourceProviderReadFailure({ _tag: 'ReadHandlerNotFound' } as never), {
    kind: 'not_found',
  });
  assert.deepEqual(classifyResourceProviderReadFailure({ _tag: 'ReadPermissionDenied' } as never), {
    kind: 'forbidden',
  });
  assert.deepEqual(classifyResourceProviderReadFailure({ _tag: 'UnknownFailure' } as never), {
    kind: 'internal',
  });

  const server = await readFile(
    path.resolve(import.meta.dirname, '../../api/contact-detail-read-server.ts'),
    'utf-8',
  );
  assert.match(server, /Unexpected governed resource-provider failure/u);
  assert.match(server, /correlationId/u);
});
