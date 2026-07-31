import { expect, test } from '@rstest/core';
import { Effect } from 'effect';
import { parseAuthConfig } from '../../api/auth/config.ts';

const validEnvironment = {
  BETTER_AUTH_SECRET: 'a-secure-test-secret-with-more-than-32-characters',
  BETTER_AUTH_TRUSTED_ORIGINS: 'http://localhost:3020,https://preview.example.test',
  BETTER_AUTH_URL: 'http://localhost:3020',
  DATABASE_URL: 'postgresql://ontos:ontos@localhost:5433/ontos',
};

test('parses trusted origins and derives local cookie security', () =>
  Effect.runPromise(parseAuthConfig(validEnvironment)).then((configuration) => {
    expect(configuration.secureCookies).toBe(false);
    expect(configuration.trustedOrigins).toEqual([
      'http://localhost:3020',
      'https://preview.example.test',
    ]);
  }));

test('requires a strong secret and PostgreSQL URL in the typed error channel', () =>
  Promise.all([
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
