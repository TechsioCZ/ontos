import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { createRequire } from 'node:module';
import { SHARED_RUNTIME_IDENTITY } from '@app/core-runtime/db/database-identity-manifest';
import { expect, it } from 'effect-rstest';

const require = createRequire(import.meta.url);

it.layer(NodeServices.layer)('Core package exports', (suite) => {
  suite.effect('keeps the retained demo entrypoints public alongside the incoming Core Media entrypoints', () =>
    Effect.gen(function* checkEntrypoints() {
      const fileSystem = yield* FileSystem.FileSystem;
      for (const subpath of [
        'auth/assignable-principals',
        'auth/external-identity-provider',
        'db/database-identity-manifest',
        'db/agent-history-page',
        'demo-company-profiles',
        'live/change-notification',
        'media/edge',
        'media/image-contract',
        'modules/legal-entity-navigation-exclusions',
        'outbox/core-modules-tenant-module-state-changed-v1',
        'outbox/core-system-worker',
        'outbox/core-identity-people-search-rebuild-requested-v1',
        'resources/scoped-resource-id',
        'resources/person',
        'resources/media-asset',
        'runtime/boot-warm-up-imports',
        'people/search',
        'people/search-rebuild',
      ]) {
        expect(yield* fileSystem.exists(require.resolve(`@app/core-runtime/${subpath}`)), subpath).toBe(true);
      }
      expect(SHARED_RUNTIME_IDENTITY.id).toBe('shared_runtime');
    }),
  );
});
