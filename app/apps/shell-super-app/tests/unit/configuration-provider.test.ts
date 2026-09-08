import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { expect, rs, test } from '@rstest/core';
import { Config, ConfigProvider, Effect } from 'effect';
import { loadAuthConfig } from '../../api/auth/config.ts';
import { loadGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import { loadConfigurationProvider } from '../../api/auth/configuration-provider.ts';
import { loadEnvironmentFileProvider } from '../../api/auth/environment-file-provider.ts';

rs.mock('../../api/auth/environment-file-provider.ts', () => ({
  loadEnvironmentFileProvider: rs.fn(() => Effect.succeed(ConfigProvider.fromEnvRecord({}))),
}));

test('explicit environment overrides file values and absent keys fall back to the file', async () => {
  rs.mocked(loadEnvironmentFileProvider).mockReturnValue(
    Effect.succeed(ConfigProvider.fromEnvRecord({ SECRET: 'file-secret', URL: 'file-url' })),
  );
  const result = await runEffectTestPromise(
    loadConfigurationProvider(
      { environment: { URL: 'explicit-url' }, envPath: 'fixture-path' },
      () => 'unreadable',
    ).pipe(
      Effect.flatMap((provider) =>
        Config.all({ secret: Config.string('SECRET'), url: Config.string('URL') }).parse(provider),
      ),
    ),
  );
  expect(result).toEqual({ secret: 'file-secret', url: 'explicit-url' });
  expect(loadEnvironmentFileProvider).toHaveBeenCalledWith('fixture-path', expect.any(Function));
});

const read = (
  options: { readonly environment?: Readonly<Partial<Record<'ONTOS_PROVIDER_TEST', string>>> } = {},
) =>
  loadConfigurationProvider(options, () => 'unreadable').pipe(
    Effect.flatMap((provider) => Config.string('ONTOS_PROVIDER_TEST').parse(provider)),
  );

test('an explicit empty environment does not fall through to process values', async () => {
  rs.stubEnv('ONTOS_PROVIDER_TEST', 'process-value');
  rs.mocked(loadEnvironmentFileProvider).mockReturnValue(
    Effect.succeed(ConfigProvider.fromEnvRecord({ ONTOS_PROVIDER_TEST: 'file-value' })),
  );
  try {
    expect(await runEffectTestPromise(read())).toBe('process-value');
    expect(await runEffectTestPromise(read({ environment: {} }))).toBe('file-value');
  } finally {
    rs.unstubAllEnvs();
  }
});

test('file loading failures retain the parser-specific typed error and safe reason', async () => {
  rs.mocked(loadEnvironmentFileProvider).mockImplementation((_path, failure) =>
    Effect.fail(failure()),
  );
  const authFailure = await runEffectTestPromise(Effect.flip(loadAuthConfig({ environment: {} })));
  const gatewayFailure = await runEffectTestPromise(
    Effect.flip(loadGatewayIssuerConfig({ environment: {} })),
  );
  expect(authFailure.reason).toBe('Unable to load the root authentication environment');
  expect(gatewayFailure.reason).toBe('Unable to load the Shell gateway signing environment');
});
