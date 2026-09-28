import { v1 } from '@authzed/authzed-node';
import { expect, it } from 'effect-rstest';

import { spiceDbClientSecurity } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { SpiceDbConfigError } from '../../src/permissions/config-error.ts';
import { allowsInsecureSpiceDbTransport } from '../../src/permissions/config.ts';

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

it('allows plaintext only to the stage-private SpiceDB gRPC and HTTP gateway ports', () => {
  for (const endpoint of ['spicedb:50051', 'spicedb:8443']) {
    expect(allowsInsecureSpiceDbTransport({ deploymentEnvironment: 'stage', endpoint, insecureLocal: true })).toBe(
      true,
    );
  }
  for (const endpoint of ['spicedb:9999', 'spicedb', 'spicedb.example:8443']) {
    expect(allowsInsecureSpiceDbTransport({ deploymentEnvironment: 'stage', endpoint, insecureLocal: true })).toBe(
      false,
    );
  }
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
