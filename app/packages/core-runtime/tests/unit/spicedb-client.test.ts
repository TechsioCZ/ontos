import { expect, it } from 'effect-rstest';

import { SpiceDbConfigError } from '../../src/permissions/config-error.ts';
import { newSpiceDbGrpcClient, spiceDbCaCertificate } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { SPICEDB_TEST_CERTIFICATE } from '../support/spicedb-test-certificate.ts';

it('pins SPICEDB_CA_CERT as the only trusted certificate of the gRPC channel', () => {
  expect(spiceDbCaCertificate({ caCertificate: SPICEDB_TEST_CERTIFICATE }).toString()).toBe(SPICEDB_TEST_CERTIFICATE);
});

it('refuses a gRPC client without SPICEDB_CA_CERT, so there is no plaintext or system-trust channel', () => {
  expect(() => spiceDbCaCertificate({})).toThrow(SpiceDbConfigError);
  expect(() => newSpiceDbGrpcClient({ endpoint: 'spicedb:50051', preSharedKey: 'test-key' })).toThrow(
    SpiceDbConfigError,
  );
});

it('opens a TLS client for the pinned certificate', () => {
  const client = newSpiceDbGrpcClient({
    caCertificate: SPICEDB_TEST_CERTIFICATE,
    endpoint: 'spicedb:50051',
    preSharedKey: 'test-key',
  });
  client.close();
});
