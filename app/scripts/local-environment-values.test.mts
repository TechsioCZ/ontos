import { Config, ConfigProvider, Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  localDatabaseIdentityValues,
  localPublicClientValues,
  localSpiceDbValues,
} from './local-environment-values.mts';

const spiceDbGrpcPort = '50052';
const spiceDbHttpPort = '8444';
const spiceDbEndpoint = `localhost:${spiceDbGrpcPort}`;
const certificate = '-----BEGIN CERTIFICATE-----\r\nMIIB\r\nAAAA\r\n-----END CERTIFICATE-----\n';

it('preserves canonical SpiceDB values and pins the current local certificate', () => {
  const values = localSpiceDbValues(
    [
      `SPICEDB_ENDPOINT=${spiceDbEndpoint}`,
      `SPICEDB_GRPC_PORT=${spiceDbGrpcPort}`,
      `SPICEDB_HTTP_PORT=${spiceDbHttpPort}`,
      'SPICEDB_CA_CERT="stale"',
      'SPICEDB_PRESHARED_KEY=existing-key',
    ],
    {},
    certificate,
  );

  expect(values).toEqual({
    SPICEDB_CA_CERT: String.raw`"-----BEGIN CERTIFICATE-----\nMIIB\nAAAA\n-----END CERTIFICATE-----"`,
    SPICEDB_ENDPOINT: spiceDbEndpoint,
    SPICEDB_GRPC_PORT: spiceDbGrpcPort,
    SPICEDB_HTTP_PORT: spiceDbHttpPort,
    SPICEDB_PRESHARED_KEY: 'existing-key',
  });
});

it('applies explicit local port overrides as one consistent endpoint', () => {
  const values = localSpiceDbValues(
    ['SPICEDB_ENDPOINT=localhost:50051', 'SPICEDB_GRPC_PORT=50051'],
    { grpcPort: spiceDbGrpcPort, httpPort: spiceDbHttpPort },
    certificate,
  );

  expect(values.SPICEDB_ENDPOINT).toBe(spiceDbEndpoint);
  expect(values.SPICEDB_GRPC_PORT).toBe(spiceDbGrpcPort);
  expect(values.SPICEDB_HTTP_PORT).toBe(spiceDbHttpPort);
});

it('derives local public-client URLs from configured Shell identity/port and owner API URLs', () => {
  expect(
    localPublicClientValues([], {
      partyRegistryApiBaseUrl: 'http://localhost:4199/party-api',
      priceGroupCatalogApiBaseUrl: 'http://localhost:4200/price-group-catalog-api',
      shellId: 'staff-shell',
      shellPort: 3099,
    }),
  ).toEqual({
    ONTOS_PARTY_REGISTRY_API_BASE_URL: 'http://localhost:4199/party-api',
    ONTOS_PRICE_GROUP_CATALOG_BASE_URL: 'http://localhost:4200/price-group-catalog-api',
    ONTOS_SHELL_GATEWAY_BASE_URL: 'http://localhost:3099/staff-shell-api',
  });
});

it('preserves explicitly configured public-client URLs', () => {
  expect(
    localPublicClientValues(
      [
        'ONTOS_SHELL_GATEWAY_BASE_URL=https://gateway.example.test/shell-super-app-api',
        'ONTOS_PARTY_REGISTRY_API_BASE_URL=https://party.example.test/party-registry-api',
        'ONTOS_PRICE_GROUP_CATALOG_BASE_URL=https://pricing.example.test/price-group-catalog-api',
      ],
      {
        partyRegistryApiBaseUrl: 'http://localhost:4102/party-registry-api',
        priceGroupCatalogApiBaseUrl: 'http://localhost:4108/price-group-catalog-api',
        shellId: 'shell-super-app',
        shellPort: 3020,
      },
    ),
  ).toEqual({
    ONTOS_PARTY_REGISTRY_API_BASE_URL: 'https://party.example.test/party-registry-api',
    ONTOS_PRICE_GROUP_CATALOG_BASE_URL: 'https://pricing.example.test/price-group-catalog-api',
    ONTOS_SHELL_GATEWAY_BASE_URL: 'https://gateway.example.test/shell-super-app-api',
  });
});

it.effect('writes SPICEDB_CA_CERT so the dotenv loader reads back the PEM line by line', () =>
  Effect.gen(function* readsBackThePem() {
    const { SPICEDB_CA_CERT } = localSpiceDbValues([], {}, certificate);
    const provider = ConfigProvider.fromDotEnvContents(`SPICEDB_CA_CERT=${SPICEDB_CA_CERT}\n`);
    expect(yield* Config.String('SPICEDB_CA_CERT').parse(provider)).toBe(
      '-----BEGIN CERTIFICATE-----\nMIIB\nAAAA\n-----END CERTIFICATE-----',
    );
  }),
);

it.effect('derives each missing dedicated identity URL from a loopback runtime URL without overwriting', () =>
  Effect.gen(function* derivesLocalIdentityUrls() {
    const existingParty = 'PARTY_REGISTRY_DATABASE_URL=postgresql://custom:custom@localhost:6543/other';

    expect(
      yield* localDatabaseIdentityValues([
        'DATABASE_URL=postgresql://ontos_runtime:ontos_runtime@127.0.0.1:5544/ontos_l6',
        existingParty,
      ]),
    ).toStrictEqual({
      PARTY_REGISTRY_WORKER_DATABASE_URL:
        'postgresql://party_registry_worker:party_registry_worker@127.0.0.1:5544/ontos_l6',
      SHELL_GATEWAY_ISSUER_DATABASE_URL:
        'postgresql://shell_gateway_issuer:shell_gateway_issuer@127.0.0.1:5544/ontos_l6',
    });
    expect(
      yield* localDatabaseIdentityValues([
        'DATABASE_URL=postgresql://ontos_runtime:ontos_runtime@localhost:5433/ontos',
      ]),
    ).toStrictEqual({
      PARTY_REGISTRY_DATABASE_URL: 'postgresql://party_registry_runtime:party_registry_runtime@localhost:5433/ontos',
      PARTY_REGISTRY_WORKER_DATABASE_URL:
        'postgresql://party_registry_worker:party_registry_worker@localhost:5433/ontos',
      SHELL_GATEWAY_ISSUER_DATABASE_URL: 'postgresql://shell_gateway_issuer:shell_gateway_issuer@localhost:5433/ontos',
    });
  }),
);

for (const assignment of [
  'DATABASE_URL="postgresql://ontos_runtime:ontos_runtime@localhost:5544/ontos_fixture"',
  "DATABASE_URL='postgresql://ontos_runtime:ontos_runtime@localhost:5544/ontos_fixture'",
  'DATABASE_URL=postgresql://ontos_runtime:ontos_runtime@localhost:5544/ontos_fixture # local database',
  'export DATABASE_URL = "postgresql://ontos_runtime:ontos_runtime@localhost:5544/ontos_fixture" # local database',
]) {
  it.effect(`decodes dotenv syntax before deriving identity URLs: ${assignment}`, () =>
    Effect.gen(function* parsesDotenvDatabaseUrl() {
      expect(yield* localDatabaseIdentityValues([assignment])).toStrictEqual({
        PARTY_REGISTRY_DATABASE_URL:
          'postgresql://party_registry_runtime:party_registry_runtime@localhost:5544/ontos_fixture',
        PARTY_REGISTRY_WORKER_DATABASE_URL:
          'postgresql://party_registry_worker:party_registry_worker@localhost:5544/ontos_fixture',
        SHELL_GATEWAY_ISSUER_DATABASE_URL:
          'postgresql://shell_gateway_issuer:shell_gateway_issuer@localhost:5544/ontos_fixture',
      });
    }),
  );
}

it.effect('preserves explicit dotenv identity assignments, including empty values', () =>
  Effect.gen(function* preservesExplicitDotenvIdentityUrls() {
    expect(
      yield* localDatabaseIdentityValues([
        'DATABASE_URL="postgresql://ontos_runtime:ontos_runtime@localhost:5544/ontos_fixture"',
        ' export PARTY_REGISTRY_DATABASE_URL = "postgresql://custom:custom@localhost:6543/other" # custom',
        "PARTY_REGISTRY_WORKER_DATABASE_URL=''",
        'SHELL_GATEWAY_ISSUER_DATABASE_URL= # intentionally empty',
      ]),
    ).toStrictEqual({});
  }),
);

it.effect('derives no identity URL from a remote, malformed or missing runtime URL', () =>
  Effect.gen(function* rejectsNonLocalDatabaseUrls() {
    expect(
      yield* localDatabaseIdentityValues(['DATABASE_URL=postgresql://ontos_runtime:secret@db.example.com:5432/ontos']),
    ).toStrictEqual({});
    expect(yield* localDatabaseIdentityValues(['DATABASE_URL=not a url'])).toStrictEqual({});
    expect(yield* localDatabaseIdentityValues([])).toStrictEqual({});
  }),
);
