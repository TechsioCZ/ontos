import { expect, it } from '@app/effect-rstest';
import { localPublicClientValues, localSpiceDbValues } from './local-environment-values.mts';

const spiceDbGrpcPort = '50052';
const spiceDbHttpPort = '8444';
const spiceDbEndpoint = `localhost:${spiceDbGrpcPort}`;

it('preserves canonical SpiceDB values when no local override is supplied', () => {
  const values = localSpiceDbValues(
    [
      `SPICEDB_ENDPOINT=${spiceDbEndpoint}`,
      `SPICEDB_GRPC_PORT=${spiceDbGrpcPort}`,
      `SPICEDB_HTTP_PORT=${spiceDbHttpPort}`,
      'SPICEDB_INSECURE=true',
      'SPICEDB_PRESHARED_KEY=existing-key',
    ],
    {},
  );

  expect(values).toEqual({
    SPICEDB_ENDPOINT: spiceDbEndpoint,
    SPICEDB_GRPC_PORT: spiceDbGrpcPort,
    SPICEDB_HTTP_PORT: spiceDbHttpPort,
    SPICEDB_INSECURE: 'true',
    SPICEDB_PRESHARED_KEY: 'existing-key',
  });
});

it('applies explicit local port overrides as one consistent endpoint', () => {
  const values = localSpiceDbValues(
    ['SPICEDB_ENDPOINT=localhost:50051', 'SPICEDB_GRPC_PORT=50051'],
    { grpcPort: spiceDbGrpcPort, httpPort: spiceDbHttpPort },
  );

  expect(values.SPICEDB_ENDPOINT).toBe(spiceDbEndpoint);
  expect(values.SPICEDB_GRPC_PORT).toBe(spiceDbGrpcPort);
  expect(values.SPICEDB_HTTP_PORT).toBe(spiceDbHttpPort);
});

it('derives local public-client URLs from configured Shell identity/port and Party API URL', () => {
  expect(
    localPublicClientValues([], {
      partyRegistryApiBaseUrl: 'http://localhost:4199/party-api',
      shellId: 'staff-shell',
      shellPort: 3099,
    }),
  ).toEqual({
    ONTOS_PARTY_REGISTRY_API_BASE_URL: 'http://localhost:4199/party-api',
    ONTOS_SHELL_GATEWAY_BASE_URL: 'http://localhost:3099/staff-shell-api',
  });
});

it('preserves explicitly configured public-client URLs', () => {
  expect(
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
  ).toEqual({
    ONTOS_PARTY_REGISTRY_API_BASE_URL: 'https://party.example.test/party-registry-api',
    ONTOS_SHELL_GATEWAY_BASE_URL: 'https://gateway.example.test/shell-super-app-api',
  });
});
