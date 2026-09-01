import assert from 'node:assert/strict';
import test from 'node:test';
import { localSpiceDbValues } from './local-environment-values.mts';

test('preserves canonical SpiceDB values when no local override is supplied', () => {
  const values = localSpiceDbValues(
    [
      'SPICEDB_ENDPOINT=localhost:50052',
      'SPICEDB_GRPC_PORT=50052',
      'SPICEDB_HTTP_PORT=8444',
      'SPICEDB_INSECURE=true',
      'SPICEDB_PRESHARED_KEY=existing-key',
    ],
    {},
  );

  assert.deepEqual(values, {
    SPICEDB_ENDPOINT: 'localhost:50052',
    SPICEDB_GRPC_PORT: '50052',
    SPICEDB_HTTP_PORT: '8444',
    SPICEDB_INSECURE: 'true',
    SPICEDB_PRESHARED_KEY: 'existing-key',
  });
});

test('applies explicit local port overrides as one consistent endpoint', () => {
  const values = localSpiceDbValues(
    ['SPICEDB_ENDPOINT=localhost:50051', 'SPICEDB_GRPC_PORT=50051'],
    { grpcPort: '50052', httpPort: '8444' },
  );

  assert.equal(values['SPICEDB_ENDPOINT'], 'localhost:50052');
  assert.equal(values['SPICEDB_GRPC_PORT'], '50052');
  assert.equal(values['SPICEDB_HTTP_PORT'], '8444');
});
