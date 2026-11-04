import { readFileSync } from 'node:fs';

import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  applicationMigrationOwnerInventory,
  loadApplicationMigrationInventory,
} from '../application-migration-inventory.mts';
import { selectApplicationMigrationPlan } from '../application-migration-plan.mts';
import type { ApplicationMigrationObservation } from '../application-migration-plan.mts';

const deployment = readFileSync(new URL('../../zerops.yaml', import.meta.url), 'utf-8');
const [migratorDeployment] = deployment.split("  - setup: 'spicedb'");

for (const owner of [
  'price-group-catalog',
  'assortment',
  'commerce-market-catalog',
  'pricing',
  'privacy',
  'projects',
  'storefront-registry',
]) {
  it.effect(`D1 includes ${owner} migration and verification in the source plan and shipped artifact`, () =>
    Effect.gen(function* ownerMigrationCoverage() {
      const streams = yield* loadApplicationMigrationInventory();
      const inventory = applicationMigrationOwnerInventory(streams);
      const observations = inventory.map<ApplicationMigrationObservation>((stream) => ({
        catalogFingerprint: 'a'.repeat(64),
        entries: [],
        journalExists: false,
        journalName: stream.journalName,
        ownerId: stream.ownerId,
        schemaEvidence: 'absent',
        schemasPresent: [],
      }));
      const plan = yield* selectApplicationMigrationPlan({ mode: 'all', owners: [] }, inventory, observations);
      const selected = plan.owners.find((candidate) => candidate.ownerId === owner);
      expect(selected?.migrate).toBe(true);
      expect(selected?.verify).toBe(true);
      expect(selected?.pendingMigrations.length).toBeGreaterThan(0);
      expect(plan.initializationOwners.indexOf('core-runtime')).toBeLessThan(plan.initializationOwners.indexOf(owner));
      expect(migratorDeployment).toContain(`- 'app/verticals/${owner}'`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}
