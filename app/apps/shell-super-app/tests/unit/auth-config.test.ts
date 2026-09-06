import { expect, test } from '@rstest/core';
import { Effect } from 'effect';
import { loadAuthConfig, parseAuthConfig } from '../../api/auth/config.ts';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';

const validEnvironment = {
  BETTER_AUTH_SECRET: 'a-secure-test-secret-with-more-than-32-characters',
  BETTER_AUTH_TRUSTED_ORIGINS: 'http://localhost:3020,https://preview.example.test',
  BETTER_AUTH_URL: 'http://localhost:3020',
  DATABASE_URL: 'postgresql://ontos:ontos@localhost:5433/ontos',
};

test('parses trusted origins and derives local cookie security', async () =>
  await Effect.runPromise(parseAuthConfig(validEnvironment)).then((configuration) => {
    expect(configuration.secureCookies).toBe(false);
    expect(configuration.trustedOrigins).toEqual([
      'http://localhost:3020',
      'https://preview.example.test',
    ]);
  }));

test('requires a strong secret and PostgreSQL URL in the typed error channel', async () =>
  await Promise.all([
    Effect.runPromise(
      Effect.flip(
        parseAuthConfig({
          ...validEnvironment,
          BETTER_AUTH_SECRET: 'short',
        }),
      ),
    ),
    Effect.runPromise(
      Effect.flip(
        parseAuthConfig({
          ...validEnvironment,
          DATABASE_URL: 'https://example.test/not-postgres',
        }),
      ),
    ),
  ]).then(([secretError, databaseError]) => {
    expect(secretError._tag).toBe('AuthConfigError');
    expect(databaseError._tag).toBe('AuthConfigError');
  }));

test('keeps malformed configuration and loader failures typed', async () => {
  const [baseUrlError, trustedOriginError] = await Promise.all([
    Effect.runPromise(
      Effect.flip(
        parseAuthConfig({
          ...validEnvironment,
          BETTER_AUTH_URL: 'ftp://shell.example.test',
        }),
      ),
    ),
    Effect.runPromise(
      Effect.flip(
        parseAuthConfig({
          ...validEnvironment,
          BETTER_AUTH_TRUSTED_ORIGINS: 'not a URL',
        }),
      ),
    ),
  ]);

  expect(baseUrlError._tag).toBe('AuthConfigError');
  expect(trustedOriginError._tag).toBe('AuthConfigError');

  const loaderError = await Effect.runPromise(
    Effect.flip(
      loadAuthConfig({
        environment: validEnvironment,
        envPath: String.fromCodePoint(0),
      }),
    ),
  );

  expect(loaderError._tag).toBe('AuthConfigError');
  expect(loaderError.reason).toBe('configuration file could not be read');
});

test('keeps unreadable dotenv configuration files in the typed error channel', async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      loadAuthConfig({
        environment: validEnvironment,
        envPath: process.cwd(),
      }),
    ),
  );

  expect(error._tag).toBe('AuthConfigError');
  expect(error.reason).toBe('configuration file could not be read');
});

test('keeps gateway signing configuration independent from Better Auth configuration', async () => {
  const authentication = await Effect.runPromise(parseAuthConfig(validEnvironment));
  const gatewayError = await Effect.runPromise(
    Effect.flip(parseGatewayIssuerConfig(validEnvironment)),
  );

  expect(authentication.baseUrl).toBe('http://localhost:3020');
  expect(gatewayError._tag).toBe('GatewayIssuerConfigError');
});
