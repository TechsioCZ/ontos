import { fileURLToPath } from 'node:url';

import { NodeFileSystem } from '@effect/platform-node';
import { Array as EffectArray, Effect, FileSystem, Order } from 'effect';
import { expect, it } from 'effect-rstest';

import { comparePriceGroupCatalog } from '../../src/database/catalog.ts';
import { PRICE_GROUP_CATALOG_TABLE_INVENTORY } from '../../src/database/schema.ts';

const readMigration = (folder: string) =>
  FileSystem.FileSystem.use((fileSystem) =>
    fileSystem.readFileString(fileURLToPath(new URL(`../../drizzle/${folder}/migration.sql`, import.meta.url))),
  );

const requireMigrationFolder = (folder: string | undefined, suffix: string) =>
  folder === undefined ? Effect.die(`Expected generated migration folder ending in ${suffix}`) : Effect.succeed(folder);

it.layer(NodeFileSystem.layer)('Price Group Catalog migration security contract', (suite) => {
  suite.effect('ships generated Drizzle v1 history plus explicit invariant hardening', () =>
    Effect.gen(function* migrationContract() {
      const config = yield* FileSystem.FileSystem.use((fileSystem) =>
        fileSystem.readFileString(fileURLToPath(new URL('../../drizzle.config.ts', import.meta.url))),
      );
      expect(config).toMatch(/__drizzle_migrations_price_group_catalog/u);
      expect(config).toMatch(/\.\/src\/database\/schema\.ts/u);

      const migrationDirectory = new URL('../../drizzle/', import.meta.url);
      const entries = yield* FileSystem.FileSystem.use((fileSystem) =>
        fileSystem.readDirectory(fileURLToPath(migrationDirectory)),
      );
      const folders = EffectArray.sort(entries, Order.String);
      const foundationFolder = folders.find((entry) => entry.endsWith('_price-group-catalog-foundation'));
      const hardeningFolder = folders.find((entry) => entry.endsWith('_enforce-price-group-catalog-invariants'));
      const intentTableFolder = folders.find((entry) => entry.startsWith('20260923131410_'));
      const projectionRoutinesFolder = folders.find((entry) =>
        entry.endsWith('_price-group-containment-projection-routines'),
      );
      expect(foundationFolder).toBeTruthy();
      expect(hardeningFolder).toBeTruthy();
      expect(intentTableFolder).toBeTruthy();
      expect(projectionRoutinesFolder).toBeTruthy();
      const foundationName = yield* requireMigrationFolder(foundationFolder, '_price-group-catalog-foundation');
      const hardeningName = yield* requireMigrationFolder(hardeningFolder, '_enforce-price-group-catalog-invariants');
      const intentTableName = yield* requireMigrationFolder(intentTableFolder, '20260923131410_');
      const projectionRoutinesName = yield* requireMigrationFolder(
        projectionRoutinesFolder,
        '_price-group-containment-projection-routines',
      );

      const foundation = yield* readMigration(foundationName);
      const hardening = yield* readMigration(hardeningName);
      const intentTable = yield* readMigration(intentTableName);
      const projectionRoutines = yield* readMigration(projectionRoutinesName);
      const enabledTableCount =
        (foundation.match(/ALTER TABLE "price_group_catalog"\."[^"]+" ENABLE ROW LEVEL SECURITY;/gu)?.length ?? 0) +
        (intentTable.match(/ALTER TABLE "price_group_catalog"\."[^"]+" ENABLE ROW LEVEL SECURITY;/gu)?.length ?? 0);
      const forcedTableCount =
        (hardening.match(/ALTER TABLE "price_group_catalog"\."[^"]+" FORCE ROW LEVEL SECURITY;/gu)?.length ?? 0) +
        (projectionRoutines.match(/ALTER TABLE "price_group_catalog"\."[^"]+" FORCE ROW LEVEL SECURITY;/gu)?.length ??
          0);
      expect(enabledTableCount).toBe(PRICE_GROUP_CATALOG_TABLE_INVENTORY.length);
      expect(forcedTableCount).toBe(PRICE_GROUP_CATALOG_TABLE_INVENTORY.length);
      expect(foundation).not.toMatch(/REFERENCES "(?:core|auth|party|contacts|commerce_customer_context)"\./u);
      expect(hardening).toMatch(/CREATE EXTENSION IF NOT EXISTS btree_gist/iu);
      expect(hardening).toMatch(
        /price_group_catalog_intervals_no_overlap_excl[\s\S]*EXCLUDE USING gist[\s\S]*schedule_catalog_revision[\s\S]*tstzrange[\s\S]*'\[\)'/iu,
      );
      expect(hardening).toMatch(/pg_advisory_xact_lock/iu);
      expect(hardening).toMatch(/price_group_catalog_ledger_fence/iu);
      expect(hardening).toMatch(/price_group_catalog_definitions_append_only/iu);
      expect(hardening).toMatch(/price_group_catalog_intervals_append_only/iu);
      expect(hardening).toMatch(/price_group_retirements_consistency/iu);
      expect(hardening).toMatch(/RETIRED Price Group is terminal/iu);
      expect(hardening).toMatch(/REVOKE ALL ON ALL TABLES[\s\S]*"ontos_runtime"/iu);
      expect(hardening).toMatch(/ALTER DEFAULT PRIVILEGES[\s\S]*REVOKE ALL ON FUNCTIONS/iu);
      expect(projectionRoutines).toMatch(
        /REVOKE ALL ON TABLE "price_group_catalog"\."price_group_containment_projection_intents" FROM "ontos_runtime"/u,
      );
    }),
  );

  suite.effect('registers exact owner schema and journal verification', () =>
    Effect.gen(function* rootVerificationContract() {
      const rootVerifier = yield* FileSystem.FileSystem.use((fileSystem) =>
        fileSystem.readFileString(
          fileURLToPath(new URL('../../../../scripts/verify-application-db-schema.mts', import.meta.url)),
        ),
      );
      expect(rootVerifier).toMatch(/'price_group_catalog'/u);
      expect(rootVerifier).toMatch(/'__drizzle_migrations_price_group_catalog'/u);
      expect(rootVerifier).toMatch(/verticals\/price-group-catalog\/scripts\/verify-db-schema\.mts/u);
    }),
  );

  suite.effect('replaces direct create access with the governed projection routines', () =>
    Effect.gen(function* governedRoutineContract() {
      const migration = yield* readMigration('20260923063344_governed-price-group-routines');
      for (const signature of [
        '"create_price_group"(uuid, jsonb)',
        '"create_definition_revision"(uuid, jsonb)',
        '"retire_price_group"(uuid, jsonb)',
        '"read_current_definition"(uuid, uuid, timestamptz)',
        '"read_definition_revision"(uuid, uuid, uuid, timestamptz)',
        '"validate_compatibility"(uuid, uuid, text, bigint, timestamptz, jsonb)',
      ]) {
        expect(migration).toContain(`GRANT EXECUTE ON FUNCTION "price_group_catalog".${signature} TO "ontos_runtime"`);
      }
      expect(migration).toMatch(/SECURITY DEFINER/gu);
      expect(migration).toMatch(/SET search_path = pg_catalog, pg_temp/gu);
      expect(migration).toMatch(/current_setting\('ontos\.tenant_id'/u);
      expect(migration).not.toMatch(/current_setting\('ontos\.legal_entity_id'/u);
      expect(migration).toMatch(/assert_operation_scope"\(uuid\) FROM PUBLIC, "ontos_runtime"/u);
      expect(migration).toMatch(/definition_json"\(uuid, uuid, uuid, bigint\) FROM PUBLIC, "ontos_runtime"/u);
      const projectionMigration = yield* readMigration('20260923131429_price-group-containment-projection-routines');
      expect(projectionMigration).toContain(
        'REVOKE ALL ON FUNCTION "price_group_catalog"."create_price_group"(uuid, jsonb) FROM "ontos_runtime"',
      );
      for (const signature of [
        '"create_price_group_with_containment_projection"(uuid, jsonb)',
        '"read_price_group_containment_projection_intent"(uuid, uuid)',
        '"complete_price_group_containment_projection"(uuid, uuid, timestamptz)',
      ]) {
        expect(projectionMigration).toContain(
          `GRANT EXECUTE ON FUNCTION "price_group_catalog".${signature} TO "ontos_runtime"`,
        );
        expect(projectionMigration).toContain(`REVOKE ALL ON FUNCTION "price_group_catalog".${signature} FROM PUBLIC`);
      }
      expect(projectionMigration.match(/SECURITY DEFINER/gu)).toHaveLength(3);
      expect(projectionMigration.match(/SET search_path = pg_catalog, pg_temp/gu)).toHaveLength(3);
      const verifier = yield* FileSystem.FileSystem.use((fileSystem) =>
        fileSystem.readFileString(fileURLToPath(new URL('../../scripts/verify-db-schema.mts', import.meta.url))),
      );
      expect(verifier).toMatch(/routine\.prosecdef/u);
      expect(verifier).toMatch(/search_path=pg_catalog, pg_temp/u);
      expect(verifier).toMatch(/governed_runtime_function_count/u);
    }),
  );
});

it('exact catalog comparison rejects missing and unexpected tables', () => {
  const exact = PRICE_GROUP_CATALOG_TABLE_INVENTORY.map((table) => `price_group_catalog.${table}`);
  expect(comparePriceGroupCatalog(exact)).toEqual({ missing: [], unexpected: [] });
  expect(comparePriceGroupCatalog(exact.slice(1))).toEqual({
    missing: ['price_group_catalog.price_group_catalog_ledger'],
    unexpected: [],
  });
  expect(comparePriceGroupCatalog([...exact, 'price_group_catalog.unowned'])).toEqual({
    missing: [],
    unexpected: ['price_group_catalog.unowned'],
  });
});
