import { ConfigProvider, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ApplicationCompositionAuthorityError } from '../../packages/core-runtime/src/modules/application-composition-authority.ts';
import { ApplicationCompositionAuthorityAdminDatabaseLive } from '../application-composition-authority-publication.mts';

const runtimeUrl = 'postgresql://ontos_runtime:runtime-test-secret@127.0.0.1:5432/publication';
const adminUrl = 'postgresql://ontos_admin:admin-test-secret@127.0.0.1:5432/publication';

it.effect('requires explicit distinct valid runtime and admin identities without leaking credentials', () =>
  Effect.gen(function* requiresNativeAdminConfiguration() {
    for (const environment of [
      {},
      { DATABASE_URL: runtimeUrl },
      { DATABASE_ADMIN_URL: adminUrl },
      { DATABASE_ADMIN_URL: runtimeUrl, DATABASE_URL: runtimeUrl },
      { DATABASE_ADMIN_URL: adminUrl, DATABASE_URL: adminUrl },
      {
        DATABASE_ADMIN_URL: adminUrl,
        DATABASE_URL: 'https://ontos_runtime:runtime-test-secret@example.test/publication',
      },
      { DATABASE_ADMIN_URL: 'not-a-url-admin-test-secret', DATABASE_URL: runtimeUrl },
    ]) {
      const failure = yield* Layer.build(ApplicationCompositionAuthorityAdminDatabaseLive).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
        Effect.scoped,
        Effect.flip,
      );
      expect(Schema.is(ApplicationCompositionAuthorityError)(failure)).toBe(true);
      expect(failure.reason).toMatch(/database (?:configuration|identities)/u);
      expect(failure.reason).not.toContain('admin-test-secret');
      expect(failure.reason).not.toContain('runtime-test-secret');
      expect(failure.cause).toBeUndefined();
    }
  }),
);
