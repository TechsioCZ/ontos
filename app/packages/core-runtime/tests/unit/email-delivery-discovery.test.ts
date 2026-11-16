import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path } from 'effect';
import { expect, it } from 'effect-rstest';

// demo_email.pending_deliveries() bypasses row security, so each "already in the ledger" check must name the candidate's
// company itself. A check on the key alone lets one company's row hide another company's e-mail forever.
const ledgerLookup = /NOT EXISTS \(SELECT 1 FROM demo_email\.deliveries d\s+WHERE /gu;
const companyLookup =
  /NOT EXISTS \(SELECT 1 FROM demo_email\.deliveries d\s+WHERE d\.tenant_id = (?<alias>\w+)\.tenant_id AND d\.legal_entity_id = \k<alias>\.legal_entity_id\s+AND d\.dedupe_key = /gu;

it.layer(NodeServices.layer)((suite) => {
  suite.effect('matches every pending e-mail only against ledger rows of its own company', () =>
    Effect.gen(function* currentDiscovery() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const drizzle = yield* path.fromFileUrl(new URL('../../drizzle/', import.meta.url));
      const folders = (yield* fileSystem.readDirectory(drizzle)).toSorted();
      const definitions = yield* Effect.forEach(
        folders,
        (folder) =>
          fileSystem
            .readFileString(path.join(drizzle, folder, 'migration.sql'))
            .pipe(Effect.map((sql) => ({ folder, sql }))),
        { concurrency: 1 },
      );
      const current = definitions.findLast(({ sql }) =>
        sql.includes('CREATE OR REPLACE FUNCTION "demo_email"."pending_deliveries"'),
      );
      if (current === undefined) {
        expect.unreachable('No migration defines demo_email.pending_deliveries');
      }
      const lookups = current.sql.match(ledgerLookup) ?? [];
      // Reminders, orders, inquiries, invitations and agenda batches.
      expect(lookups).toHaveLength(5);
      expect(current.sql.match(companyLookup) ?? []).toHaveLength(lookups.length);
    }),
  );
});
