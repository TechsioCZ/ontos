import { expect, it } from '@app/effect-rstest';
import { v1 } from '@authzed/authzed-node';
import { spiceDbClientSecurity } from '../../src/permissions/client.ts';
import { SpiceDbConfigError } from '../../src/permissions/config-error.ts';

it('uses authenticated plaintext credentials for an explicitly insecure transport', () => {
  expect(
    spiceDbClientSecurity({
      endpoint: 'localhost:50051',
      insecureLocal: true,
    }),
  ).toBe(v1.ClientSecurity.INSECURE_PLAINTEXT_CREDENTIALS);
  expect(
    spiceDbClientSecurity({
      deploymentEnvironment: 'stage',
      endpoint: 'spicedb:50051',
      insecureLocal: true,
    }),
  ).toBe(v1.ClientSecurity.INSECURE_PLAINTEXT_CREDENTIALS);
});

it('uses TLS credentials for a secure transport', () => {
  expect(
    spiceDbClientSecurity({
      endpoint: 'spicedb.internal.example:443',
      insecureLocal: false,
    }),
  ).toBe(v1.ClientSecurity.SECURE);
});

it('rejects plaintext credentials for an arbitrary or non-stage endpoint', () => {
  for (const configuration of [
    { endpoint: 'spicedb.internal.example:50051', insecureLocal: true },
    { endpoint: 'spicedb:50051', insecureLocal: true },
    {
      deploymentEnvironment: 'production',
      endpoint: 'spicedb:50051',
      insecureLocal: true,
    },
  ] as const) {
    expect(() => spiceDbClientSecurity(configuration)).toThrow(SpiceDbConfigError);
  }
});
