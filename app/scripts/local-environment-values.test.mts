import assert from 'node:assert/strict';
import test from 'node:test';
import { localPublicClientValues, localSpiceDbValues } from './local-environment-values.mts';

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

test('derives local public-client URLs from configured Shell identity/port and Party API URL', () => {
  assert.deepEqual(
    localPublicClientValues([], {
      partyRegistryApiBaseUrl: 'http://localhost:4199/party-api',
      shellId: 'staff-shell',
      shellPort: 3099,
    }),
    {
      ONTOS_PARTY_REGISTRY_API_BASE_URL: 'http://localhost:4199/party-api',
      ONTOS_SHELL_GATEWAY_BASE_URL: 'http://localhost:3099/staff-shell-api',
    },
  );
});

test('preserves explicitly configured public-client URLs', () => {
  assert.deepEqual(
    localPublicClientValues(
      [
        'ONTOS_SHELL_GATEWAY_BASE_URL=https://gateway.example.test/shell-super-app-api',
        'ONTOS_PARTY_REGISTRY_API_BASE_URL=https://party.example.test/party-registry-api',
      ],
      {
        partyRegistryApiBaseUrl: 'http://localhost:4102/party-registry-api',
        shellId: 'shell-super-app',
        shellPort: 3020,
      },
    ),
    {
      ONTOS_PARTY_REGISTRY_API_BASE_URL: 'https://party.example.test/party-registry-api',
      ONTOS_SHELL_GATEWAY_BASE_URL: 'https://gateway.example.test/shell-super-app-api',
    },
  );
});
