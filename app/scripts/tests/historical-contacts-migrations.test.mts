import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { historicalContactsMigrationFolder } from '../../verticals/party-registry/tests/fixtures/historical-contacts-migrations.ts';
import { planEquivalentMigrations } from '../migration-equivalence.mts';

it.layer(NodeServices.layer)('historical Contacts replay', (suite) => {
  suite.effect('replays the reviewed fresh lineage once, preserving every selected SQL statement', () =>
    Effect.gen(function* reviewedContactsReplay() {
      const source = fileURLToPath(new URL('../../verticals/party-registry/drizzle-contacts/', import.meta.url));
      const original = yield* Effect.sync(() => readMigrationFiles({ migrationsFolder: source }));
      const planned = yield* planEquivalentMigrations('contacts', original, []);
      const folder = yield* historicalContactsMigrationFolder();
      const selected = yield* Effect.sync(() => readMigrationFiles({ migrationsFolder: folder }));
      expect(planned.lineage).toBe('main');
      expect(selected.map(({ name, sql }) => ({ name, sql }))).toEqual(
        planned.migrations.map(({ name, sql }) => ({ name, sql })),
      );
      expect(selected).toHaveLength(7);
      expect(selected.map(({ name }) => name)).not.toContain('20261024090301_contacts-gateway-scope-rls');
      const routineCreations = selected
        .flatMap(({ sql }) => sql)
        .filter((statement) =>
          /create\s+function\s+"contacts"\."prune_expired_gateway_assertion_redemptions"/iu.test(statement),
        );
      expect(routineCreations).toHaveLength(1);
    }),
  );
});
