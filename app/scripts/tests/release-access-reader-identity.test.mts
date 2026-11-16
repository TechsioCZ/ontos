import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { SHARED_RUNTIME_IDENTITY } from '../../packages/core-runtime/src/db/database-identity-manifest.ts';
import { loadReleaseAccessDatabaseConfiguration } from '../zerops/release-access-verification.mts';

const runtimeUrl = 'postgresql://ontos_runtime:fixture-runtime@127.0.0.1:5432/fixture';
const adminUrl = 'postgresql://postgres:fixture-admin@127.0.0.1:5432/fixture';

it.effect('loads the enrolled runtime identity even when the publication administrator is configured', () =>
  Effect.gen(function* runtimeReaderIdentity() {
    const configuration = yield* loadReleaseAccessDatabaseConfiguration(
      ConfigProvider.fromUnknown({ DATABASE_ADMIN_URL: adminUrl, DATABASE_URL: runtimeUrl }),
    );
    expect(configuration.expectedRole).toBe(SHARED_RUNTIME_IDENTITY.role);
    expect(configuration.connectionString).toBe(runtimeUrl);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('does not require administrative credentials for the scoped intent reader', () =>
  Effect.gen(function* independentRuntimeReader() {
    const configuration = yield* loadReleaseAccessDatabaseConfiguration(
      ConfigProvider.fromUnknown({ DATABASE_URL: runtimeUrl }),
    );
    expect(configuration.expectedRole).toBe(SHARED_RUNTIME_IDENTITY.role);
    expect(configuration.connectionString).toBe(runtimeUrl);
  }).pipe(Effect.provide(NodeServices.layer)),
);

for (const environment of [{ DATABASE_ADMIN_URL: adminUrl }, { DATABASE_URL: adminUrl }]) {
  it.effect(
    `refuses ${'DATABASE_URL' in environment ? 'an administrator in the runtime slot' : 'an admin-only configuration'}`,
    () =>
      Effect.gen(function* refusesAdministrativeReader() {
        const failure = yield* loadReleaseAccessDatabaseConfiguration(ConfigProvider.fromUnknown(environment)).pipe(
          Effect.flip,
        );
        expect(Predicate.isTagged(failure, 'ReleaseAccessVerificationError')).toBe(true);
        expect(failure.reason).toBe(
          'Release access verification requires the configured shared runtime database identity',
        );
        expect(failure.reason).not.toContain('fixture-admin');
      }).pipe(Effect.provide(NodeServices.layer)),
  );
}
