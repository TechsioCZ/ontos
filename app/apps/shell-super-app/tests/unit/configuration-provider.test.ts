import { Config, ConfigProvider, Effect } from 'effect';
import { afterAll, expect, it, rs } from 'effect-rstest';

import { loadAuthConfig } from '../../api/auth/config.ts';
import { loadConfigurationProvider } from '../../api/auth/configuration-provider.ts';
import { loadEnvironmentFileProvider } from '../../api/auth/environment-file-provider.ts';
import { loadGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';

rs.mock('../../api/auth/environment-file-provider.ts', () => ({
  loadEnvironmentFileProvider: rs.fn(() => Effect.succeed(ConfigProvider.fromEnvRecord({}))),
}));

it.effect('explicit environment overrides file values and absent keys fall back to the file', () =>
  Effect.gen(function* explicitEnvironment() {
    rs.mocked(loadEnvironmentFileProvider).mockReturnValue(
      Effect.succeed(
        ConfigProvider.fromEnvRecord({
          SECRET: 'file-secret',
          URL: 'file-url',
        }),
      ),
    );
    const result = yield* loadConfigurationProvider(
      { environment: { URL: 'explicit-url' }, envPath: 'fixture-path' },
      () => 'unreadable',
    ).pipe(
      Effect.flatMap((provider) =>
        Config.all({
          secret: Config.String('SECRET'),
          url: Config.String('URL'),
        }).parse(provider),
      ),
    );
    expect(result).toEqual({ secret: 'file-secret', url: 'explicit-url' });
    expect(loadEnvironmentFileProvider).toHaveBeenCalledWith('fixture-path', expect.any(Function));
  }),
);

const read = (
  options: {
    readonly environment?: Readonly<Partial<Record<'ONTOS_PROVIDER_TEST', string>>>;
  } = {},
) =>
  loadConfigurationProvider(options, () => 'unreadable').pipe(
    Effect.flatMap((provider) => Config.String('ONTOS_PROVIDER_TEST').parse(provider)),
  );

it.effect('an explicit empty environment does not fall through to process values', () =>
  Effect.gen(function* emptyEnvironment() {
    yield* Effect.acquireRelease(
      Effect.sync(() => rs.stubEnv('ONTOS_PROVIDER_TEST', 'process-value')),
      () => Effect.sync(() => rs.unstubAllEnvs()),
    );
    rs.mocked(loadEnvironmentFileProvider).mockReturnValue(
      Effect.succeed(ConfigProvider.fromEnvRecord({ ONTOS_PROVIDER_TEST: 'file-value' })),
    );
    expect(yield* read()).toBe('process-value');
    expect(yield* read({ environment: {} })).toBe('file-value');
  }),
);

it.effect('file loading failures retain the parser-specific typed error and safe reason', () =>
  Effect.gen(function* fileFailure() {
    rs.mocked(loadEnvironmentFileProvider).mockImplementation((_path, failure) => Effect.fail(failure()));
    const authFailure = yield* Effect.flip(loadAuthConfig({ environment: {} }));
    const gatewayFailure = yield* Effect.flip(loadGatewayIssuerConfig({ environment: {} }));
    expect(authFailure.reason).toBe('Unable to load the root authentication environment');
    expect(gatewayFailure.reason).toBe('Unable to load the Shell gateway signing environment');
  }),
);

// With `isolate: false` one module registry is shared by every file a worker runs, so these
// replacements outlive this file and would leak into whatever runs next. Remove them and drop the
// modules they replaced, so the next file evaluates the real implementations.
afterAll(() => {
  rs.doUnmock('../../api/auth/environment-file-provider.ts');
  rs.resetModules();
});
