import { Config, Effect } from 'effect';
import { afterEach, expect, it, rs } from 'effect-rstest';

import { loadConfigurationProvider } from '../../../api/auth/configuration-provider.workerd.ts';
import { env } from '../../fixtures/worker-environment.ts';

rs.mock('../../../api/auth/environment-file-provider.ts', () => ({
  loadEnvironmentFileProvider: rs.fn(() => {
    throw new Error('Worker must not read dotenv files');
  }),
}));

afterEach(() => {
  rs.unstubAllEnvs();
  delete env['BETTER_AUTH_URL'];
});

it.effect('Worker bindings are the only ambient configuration source, not Modern process.env or dotenv', () =>
  Effect.gen(function* workerConfigurationTest() {
    rs.stubEnv('BETTER_AUTH_URL', 'https://node.example.test');
    env['BETTER_AUTH_URL'] = 'https://worker.example.test';
    const provider = yield* loadConfigurationProvider({}, () => 'unreadable');
    expect(yield* Config.String('BETTER_AUTH_URL').parse(provider)).toBe('https://worker.example.test');
    delete env['BETTER_AUTH_URL'];
    const missing = yield* loadConfigurationProvider({}, () => 'unreadable');
    expect(yield* Config.String('BETTER_AUTH_URL').parse(missing).pipe(Effect.isFailure)).toBe(true);
  }),
);

it.effect('an explicit empty Worker environment cannot fall through to ambient Worker bindings', () =>
  Effect.gen(function* workerConfigurationTest() {
    env['BETTER_AUTH_URL'] = 'https://worker.example.test';
    const provider = yield* loadConfigurationProvider(
      { environment: {}, envPath: '/must-not-read' },
      () => 'unreadable',
    );
    expect(yield* Config.String('BETTER_AUTH_URL').parse(provider).pipe(Effect.isFailure)).toBe(true);
  }),
);
