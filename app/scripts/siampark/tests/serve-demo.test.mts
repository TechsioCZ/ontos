import { ConfigProvider, Effect, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { DemoServeError, makeDemoServeCommand, parseDemoServeConfiguration } from '../serve-demo.mts';

const environment = {
  BETTER_AUTH_SECRET: 'authentication-test-secret-at-least-32-characters',
  BETTER_AUTH_URL: 'http://localhost:3020',
  DATABASE_ADMIN_URL: 'postgresql://ontos_admin:admin-secret@127.0.0.1:5432/siampark_demo',
  DATABASE_URL: 'postgresql://ontos_runtime:runtime-secret@127.0.0.1:5432/siampark_demo',
  ONTOS_GATEWAY_ISSUER: 'http://localhost:3020',
  ONTOS_GATEWAY_PUBLIC_JWKS:
    '{"keys":[{"alg":"EdDSA","crv":"Ed25519","kid":"development","kty":"OKP","use":"sig","x":"development-public-coordinate"}]}',
  SPICEDB_CA_CERT: '-----BEGIN CERTIFICATE-----\nMIIB\nAAAA\n-----END CERTIFICATE-----',
  SPICEDB_ENDPOINT: 'localhost:50051',
  SPICEDB_PRESHARED_KEY: 'spicedb-test-secret',
  ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'development',
};

it.effect('passes identical public verification configuration and native required environment to every child', () =>
  Effect.gen(function* buildsGuardedNativeCommand() {
    const configuration = yield* parseDemoServeConfiguration(
      ConfigProvider.fromUnknown({
        ...environment,
        ONTOS_GATEWAY_PRIVATE_JWK: 'signer-private-material-must-not-be-projected',
      }),
    );
    expect(Redacted.isRedacted(configuration.DATABASE_URL)).toBe(true);
    expect(Redacted.isRedacted(configuration.BETTER_AUTH_SECRET)).toBe(true);
    const command = makeDemoServeCommand(configuration);
    expect(command.command).toBe('pnpm');
    expect(command.args).toEqual([
      '-r',
      '--parallel',
      '--filter',
      './verticals/*',
      '--filter',
      './apps/shell-super-app',
      'exec',
      'modern',
      'serve',
    ]);
    expect(command.options.extendEnv).toBe(true);
    expect(command.options.env?.ONTOS_GATEWAY_ISSUER).toBe(environment.ONTOS_GATEWAY_ISSUER);
    expect(command.options.env?.ONTOS_GATEWAY_PUBLIC_JWKS).toBe(environment.ONTOS_GATEWAY_PUBLIC_JWKS);
    expect(command.options.env?.SPICEDB_CA_CERT).toBe(environment.SPICEDB_CA_CERT);
    expect(command.options.env?.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL).toBe('http://127.0.0.1:3031/active');
    expect(command.options.env?.ONTOS_GATEWAY_PRIVATE_JWK).toBeUndefined();
  }),
);

it.effect('requires issuer and public keys before starting recipients', () =>
  Effect.gen(function* refusesMissingVerifierConfiguration() {
    for (const input of [
      Object.fromEntries(Object.entries(environment).filter(([key]) => key !== 'ONTOS_GATEWAY_ISSUER')),
      Object.fromEntries(Object.entries(environment).filter(([key]) => key !== 'ONTOS_GATEWAY_PUBLIC_JWKS')),
      { ...environment, ONTOS_GATEWAY_PUBLIC_JWKS: '  ' },
    ]) {
      const failure = yield* parseDemoServeConfiguration(ConfigProvider.fromUnknown(input)).pipe(Effect.flip);
      expect(Schema.is(DemoServeError)(failure)).toBe(true);
      expect(failure.reason).toBe('Required server configuration is missing or invalid');
    }
  }),
);

it.effect('refuses production, original database and remote authorization without revealing secrets', () =>
  Effect.gen(function* preservesDevelopmentSafetyGuard() {
    for (const input of [
      { ...environment, ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' },
      { ...environment, DATABASE_URL: environment.DATABASE_URL.replace('siampark_demo', 'ontos') },
      { ...environment, SPICEDB_ENDPOINT: 'example.com:50051' },
    ]) {
      const failure = yield* parseDemoServeConfiguration(ConfigProvider.fromUnknown(input)).pipe(Effect.flip);
      expect(Schema.is(DemoServeError)(failure)).toBe(true);
      expect(failure.reason).not.toContain('admin-secret');
      expect(failure.reason).not.toContain('runtime-secret');
      expect(failure.reason).not.toContain('spicedb-test-secret');
    }
  }),
);

it.effect('environment overrides take precedence over the root file provider for both issuer and keys', () =>
  Effect.gen(function* usesOneConsistentProviderPrecedence() {
    const file = ConfigProvider.fromUnknown(environment);
    const provider = ConfigProvider.orElse(
      ConfigProvider.fromUnknown({
        ONTOS_GATEWAY_ISSUER: 'http://localhost:3020/overridden-issuer',
        ONTOS_GATEWAY_PUBLIC_JWKS: '{"keys":[]}',
      }),
      file,
    );
    const configuration = yield* parseDemoServeConfiguration(provider);
    expect(configuration.ONTOS_GATEWAY_ISSUER).toBe('http://localhost:3020/overridden-issuer');
    expect(configuration.ONTOS_GATEWAY_PUBLIC_JWKS).toBe('{"keys":[]}');
  }),
);
