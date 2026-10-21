import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { parseAuthConfig } from '../../api/auth/config.ts';
import { GatewayIssuerConfigError, parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';

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
    expect(configuration.trustedOrigins).toEqual(['http://localhost:3020', 'https://preview.example.test']);
  }),
);
it.effect('requires a strong secret and PostgreSQL URL in the typed error channel', () =>
  Effect.gen(function* validatesCredentials() {
    const [secretError, databaseError] = yield* Effect.all(
      [
        Effect.flip(
          parseAuthConfig({
            ...validEnvironment,
            BETTER_AUTH_SECRET: 'short',
          }),
        ),
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

it.effect('defaults the MCP resource to the local resource server', () =>
  Effect.gen(function* defaultsMcpResource() {
    const configuration = yield* parseAuthConfig(validEnvironment);
    expect(configuration.mcpResourceUrl).toBe('http://localhost:3090/mcp');
  }),
);

it.effect('accepts an https or loopback MCP resource', () =>
  Effect.gen(function* acceptsMcpResource() {
    const [httpsConfiguration, loopbackConfiguration] = yield* Effect.all([
      parseAuthConfig({ ...validEnvironment, ONTOS_MCP_RESOURCE_URL: 'https://mcp.example.test/mcp' }),
      parseAuthConfig({ ...validEnvironment, ONTOS_MCP_RESOURCE_URL: 'http://127.0.0.1:3090/mcp' }),
    ]);
    expect(httpsConfiguration.mcpResourceUrl).toBe('https://mcp.example.test/mcp');
    expect(loopbackConfiguration.mcpResourceUrl).toBe('http://127.0.0.1:3090/mcp');
  }),
);

it.effect('rejects a malformed MCP resource', () =>
  Effect.gen(function* rejectsMcpResource() {
    const errors = yield* Effect.all(
      [
        'http://mcp.example.test/mcp',
        'http://localhost:3090/mcp/',
        'https://mcp.example.test/mcp?x=1',
        'not a url',
      ].map((ONTOS_MCP_RESOURCE_URL) =>
        Effect.flip(parseAuthConfig({ ...validEnvironment, ONTOS_MCP_RESOURCE_URL })),
      ),
      { concurrency: 'unbounded' },
    );
    for (const error of errors) {
      expect(Predicate.isTagged(error, 'AuthConfigError')).toBe(true);
    }
  }),
);
