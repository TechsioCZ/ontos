import { expect, it } from 'effect-rstest';
import { Effect, Predicate, Schema } from 'effect';
import { parseAuthConfig } from '../../api/auth/config.ts';
import {
  GatewayIssuerConfigError,
  parseGatewayIssuerConfig,
} from '../../api/auth/gateway-issuer-config.ts';

const validEnvironment = {
  BETTER_AUTH_SECRET: 'a-secure-test-secret-with-more-than-32-characters',
  BETTER_AUTH_TRUSTED_ORIGINS: 'http://localhost:3020,https://preview.example.test',
  BETTER_AUTH_URL: 'http://localhost:3020',
  DATABASE_URL: 'postgresql://ontos:ontos@localhost:5433/ontos',
};

it.effect('parses trusted origins and derives local cookie security', () =>
  Effect.gen(function* parsesOrigins() {
    const configuration = yield* parseAuthConfig(validEnvironment);
    expect(configuration.secureCookies).toBe(false);
    expect(configuration.trustedOrigins).toEqual([
      'http://localhost:3020',
      'https://preview.example.test',
    ]);
  }),
);
it.effect('requires a strong secret and PostgreSQL URL in the typed error channel', () =>
  Effect.gen(function* validatesCredentials() {
    const [secretError, databaseError] = yield* Effect.all(
      [
        Effect.flip(parseAuthConfig({ ...validEnvironment, BETTER_AUTH_SECRET: 'short' })),
        Effect.flip(
          parseAuthConfig({
            ...validEnvironment,
            DATABASE_URL: 'https://example.test/not-postgres',
          }),
        ),
      ],
      { concurrency: 'unbounded' },
    );
    expect(Predicate.isTagged(secretError, 'AuthConfigError')).toBe(true);
    expect(Predicate.isTagged(databaseError, 'AuthConfigError')).toBe(true);
  }),
);
it.effect('keeps gateway signing configuration independent from Better Auth configuration', () =>
  Effect.gen(function* independentSigning() {
    const authentication = yield* parseAuthConfig(validEnvironment);
    const gatewayError = yield* Effect.flip(parseGatewayIssuerConfig({}));
    expect(authentication.baseUrl).toBe('http://localhost:3020');
    expect(Schema.is(GatewayIssuerConfigError)(gatewayError)).toBe(true);
  }),
);
