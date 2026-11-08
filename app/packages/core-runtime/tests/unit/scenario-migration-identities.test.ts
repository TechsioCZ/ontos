import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';

import { CORE_MIGRATION_EQUIVALENCES } from '../../src/db/migration-equivalence-data.ts';
import { coreScenarioMigrationStatements } from '../support/access-scenarios/database.ts';

const reviewedSources = Effect.gen(function* readReviewedSources() {
  const fileSystem = yield* FileSystem.FileSystem;
  const sources = new Map<string, string>();
  for (const pair of CORE_MIGRATION_EQUIVALENCES) {
    for (const name of [pair.main, pair.demo]) {
      const url = new URL(`../../drizzle/${name}/migration.sql`, import.meta.url);
      sources.set(name, yield* fileSystem.readFileString(url.pathname));
    }
  }
  return sources;
});

it.layer(NodeServices.layer)('scenario migration identities', (suite) => {
  suite.effect('replays each reviewed Core migration once when both historical identities are present', () =>
    Effect.gen(function* selectReviewedHistory() {
      const sources = yield* reviewedSources;
      const statements = yield* coreScenarioMigrationStatements(sources);
      expect(statements.filter((statement) => statement.includes('CREATE SCHEMA trust;'))).toHaveLength(1);
      expect(statements.length).toBeGreaterThan(0);
    }),
  );

  suite.effect('refuses changed main migration bytes instead of treating their demo counterpart as a fallback', () =>
    Effect.gen(function* refuseChangedMain() {
      const sources = yield* reviewedSources;
      const name = CORE_MIGRATION_EQUIVALENCES[0].main;
      sources.set(name, 'select 0;');
      const failure = yield* Effect.flip(coreScenarioMigrationStatements(sources));
      expect(failure._tag).toBe('ScenarioMigrationIdentityError');
      expect(failure.migration).toBe(name);
    }),
  );

  suite.effect('refuses changed demo migration bytes even though fresh replay selects main identities', () =>
    Effect.gen(function* refuseChangedDemo() {
      const sources = yield* reviewedSources;
      const name = CORE_MIGRATION_EQUIVALENCES[0].demo;
      sources.set(name, 'select 0;');
      const failure = yield* Effect.flip(coreScenarioMigrationStatements(sources));
      expect(failure._tag).toBe('ScenarioMigrationIdentityError');
      expect(failure.migration).toBe(name);
    }),
  );

  suite.effect('requires both immutable identities of every reviewed equivalence', () =>
    Effect.gen(function* refuseMissingHistory() {
      const sources = yield* reviewedSources;
      for (const pair of CORE_MIGRATION_EQUIVALENCES) {
        for (const name of [pair.main, pair.demo]) {
          const incomplete = new Map(sources);
          incomplete.delete(name);
          const failure = yield* Effect.flip(coreScenarioMigrationStatements(incomplete));
          expect(failure._tag).toBe('ScenarioMigrationIdentityError');
          expect(failure.migration).toBe(name);
        }
      }
    }),
  );

  suite.effect('does not deduplicate identical SQL outside the explicit reviewed identities', () =>
    Effect.gen(function* preserveDistinctMigrations() {
      const sources = yield* reviewedSources;
      sources.set('20990101000000_first', 'select 42;');
      sources.set('20990101000001_second', 'select 42;');
      const statements = yield* coreScenarioMigrationStatements(sources);
      expect(statements.filter((statement) => statement === 'select 42;')).toHaveLength(2);
    }),
  );

  suite.effect('preserves committed migration order and splits only nonempty breakpoint statements', () =>
    Effect.gen(function* preserveStatementOrder() {
      const sources = yield* reviewedSources;
      sources.set('20990101000002_last', '--> statement-breakpoint\nselect 43;\n--> statement-breakpoint\n');
      sources.set('20990101000001_first', 'select 42;');
      const statements = yield* coreScenarioMigrationStatements(sources);
      expect(statements.slice(-2)).toEqual(['select 42;', '\nselect 43;\n']);
    }),
  );
});
