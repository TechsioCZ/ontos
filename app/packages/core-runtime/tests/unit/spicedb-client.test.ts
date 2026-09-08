import assert from 'node:assert/strict';
import test from 'node:test';
import { v1 } from '@authzed/authzed-node';
import { spiceDbClientSecurity } from '../../src/permissions/client.ts';
import { SpiceDbConfigError } from '../../src/permissions/config-error.ts';

void test('uses authenticated plaintext credentials for an explicitly insecure transport', () => {
  assert.equal(
    spiceDbClientSecurity({
      endpoint: 'localhost:50051',
      insecureLocal: true,
    }),
    v1.ClientSecurity.INSECURE_PLAINTEXT_CREDENTIALS,
  );
  assert.equal(
    spiceDbClientSecurity({
      deploymentEnvironment: 'stage',
      endpoint: 'spicedb:50051',
      insecureLocal: true,
    }),
    v1.ClientSecurity.INSECURE_PLAINTEXT_CREDENTIALS,
  );
});

void test('uses TLS credentials for a secure transport', () => {
  assert.equal(
    spiceDbClientSecurity({
      endpoint: 'spicedb.internal.example:443',
      insecureLocal: false,
    }),
    v1.ClientSecurity.SECURE,
  );
});

void test('rejects plaintext credentials for an arbitrary or non-stage endpoint', () => {
  for (const configuration of [
    { endpoint: 'spicedb.internal.example:50051', insecureLocal: true },
    { endpoint: 'spicedb:50051', insecureLocal: true },
    {
      deploymentEnvironment: 'production',
      endpoint: 'spicedb:50051',
      insecureLocal: true,
    },
  ] as const) {
    assert.throws(() => spiceDbClientSecurity(configuration), SpiceDbConfigError);
  }
});
