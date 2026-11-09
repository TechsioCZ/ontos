import { NodeServices } from '@effect/platform-node';
import { Reactivity } from 'effect/reactivity';
import { Array as EffectArray, ConfigProvider, Effect, Order } from 'effect';
import { expect, it } from 'effect-rstest';

import { selectApplicationMigrationPlan } from '../application-migration-plan.mts';
import {
  applicationMigrationOwnerInventory,
  migrationRuntimeIdentityIds,
  pendingMigrationRuntimeIdentityIds,
  loadApplicationMigrationInventory,
} from '../application-migration-inventory.mts';
import type { ApplicationMigrationPlan } from '../application-migration-plan.mts';
import type { ApplicationMigrationStream } from '../application-migration-inventory.mts';
import {
  assertMigrationVerificationOnly,
  assertNativeMigrationBounds,
  prepareApplicationMigrationPlan,
} from '../application-migration-runtime.mts';

const coreOwner = 'core-runtime';
const first = { hash: 'a'.repeat(64), name: '20260101000000_first' };
const second = { hash: 'b'.repeat(64), name: '20260102000000_second' };
const stream: ApplicationMigrationStream = {
  configFile: 'drizzle.config.ts',
  database: 'primary',
  directory: 'verticals/example',
  journalName: '__drizzle_migrations_example',
  migrationDirectory: 'verticals/example/drizzle',
  migrations: [first, second],
  optional: false,
  ownerId: 'example',
  preparationScripts: [],
  prerequisites: [],
  runtimeIdentityIds: ['shared_runtime'],
  schemas: ['example'],
  verifierPaths: ['verticals/example/scripts/verify-db-schema.mts'],
};
const plan: ApplicationMigrationPlan = {
  initializationOwners: ['example'],
  mode: 'selected',
  owners: [
    {
      before: {
        catalogFingerprint: 'c'.repeat(64),
        entries: [],
        journalExists: false,
        journalName: stream.journalName,
        ownerId: stream.ownerId,
        schemaEvidence: 'absent',
        schemasPresent: [],
      },
      migrate: true,
      ownerId: stream.ownerId,
      pendingMigrations: [first],
      throughMigration: first.name,
      verification: 'pending',
      verify: true,
    },
  ],
  schemaVersion: 1,
};
it.effect('rejects a native whole-folder migration beyond the reviewed bound before execution', () =>
  Effect.gen(function* rejectsBound() {
    const failure = yield* assertNativeMigrationBounds(plan, [stream]).pipe(Effect.flip);
    expect(failure.reason).toBe('Native whole-owner migration would exceed the reviewed target for example');
  }),
);
it.effect('allows native latest-head pending SQL and performs no migration for an already-complete bound', () =>
  Effect.gen(function* acceptsNativeModes() {
    const [owner] = plan.owners;
    if (owner === undefined) {
      return yield* Effect.die('Missing fixture migration owner');
    }
    yield* assertNativeMigrationBounds(
      { ...plan, owners: [{ ...owner, pendingMigrations: [first, second], throughMigration: second.name }] },
      [stream],
    );
    return yield* assertNativeMigrationBounds({ ...plan, owners: [{ ...owner, pendingMigrations: [] }] }, [stream]);
  }),
);
it.effect('prepares none without any database credentials or optional owner configuration', () =>
  Effect.gen(function* noneNeedsNoConfiguration() {
    const result = yield* prepareApplicationMigrationPlan({ mode: 'none', owners: [] }).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      Effect.provide(NodeServices.layer),
      Effect.provide(Reactivity.layer),
    );
    expect(result).toEqual({
      nativeTargets: [],
      plan: { initializationOwners: [], mode: 'none', owners: [], schemaVersion: 1 },
      streams: [],
    });
  }),
);

it('derives only existing physical identities required by executable native DDL', () => {
  expect(
    migrationRuntimeIdentityIds(
      '-- CREATE POLICY ignored ON t TO "shell_gateway_issuer";\nCREATE POLICY genuine ON t TO "party_registry_runtime" USING (tenant_id = \'shell_gateway_issuer\');--> statement-breakpoint\nGRANT SELECT ON t TO "party_registry_worker";',
    ),
  ).toEqual(['party_registry_request', 'party_registry_worker']);
  expect(
    migrationRuntimeIdentityIds(
      'INSERT INTO t VALUES (\'party_registry_worker CREATE POLICY fake ON t TO "party_registry_worker"\');--> statement-breakpoint\n/* CREATE POLICY ignored ON t TO "shell_gateway_issuer"; */ SELECT 1;',
    ),
  ).toEqual([]);
});

it.effect('refuses a changed pending plan on verification-only execution', () =>
  Effect.gen(function* rejectsVerificationWrites() {
    const failure = yield* assertMigrationVerificationOnly(plan).pipe(Effect.flip);
    expect(failure.reason).toBe('Verification-only execution refuses pending migration or bootstrap work');
  }),
);
it.effect('keeps behind-target verifier-only work pending verification without requesting future SQL', () =>
  Effect.gen(function* verifyRetainedOwner() {
    const [owner] = plan.owners;
    if (owner === undefined) {
      return yield* Effect.die('Missing fixture migration owner');
    }
    const observed = {
      ...owner.before,
      entries: [first],
      journalExists: true,
      schemaEvidence: 'observed-journal' as const,
      schemasPresent: ['example'],
    };
    const selected = yield* selectApplicationMigrationPlan(
      { mode: 'selected', owners: [{ migrate: false, ownerId: 'example', verify: true }] },
      applicationMigrationOwnerInventory([stream]),
      [observed],
    );
    expect(selected.owners[0]?.pendingMigrations).toEqual([]);
    expect(selected.owners[0]?.verification).toBe('pending');
    expect(selected.owners[0]?.before.schemaEvidence).toBe('observed-journal');
    yield* assertMigrationVerificationOnly(selected);
    return yield* assertNativeMigrationBounds(selected, [stream]);
  }),
);

it('does not initialize credentials for role-dependent migrations already journaled', () => {
  const withRoleRequirement = {
    ...stream,
    migrationRuntimeIdentityRequirements: [
      { identityIds: ['party_registry_request', 'party_registry_worker'], migrationName: first.name },
    ],
  };
  expect(pendingMigrationRuntimeIdentityIds(withRoleRequirement, [second])).toEqual(['shared_runtime']);
  expect(pendingMigrationRuntimeIdentityIds(withRoleRequirement, [])).toEqual([]);
  expect(pendingMigrationRuntimeIdentityIds(withRoleRequirement, [first, second])).toEqual([
    'shared_runtime',
    'party_registry_request',
    'party_registry_worker',
  ]);
});

it.effect(
  'reads the existing ordered independent journals and exact pending Core role prerequisites without owner configuration imports',
  () =>
    Effect.gen(function* actualSourceInventory() {
      const inventory = yield* loadApplicationMigrationInventory();
      expect(inventory.filter((owner) => !owner.optional).map((owner) => owner.ownerId)).toEqual([
        coreOwner,
        'shell-super-app',
        'party-registry-contacts',
        'party-registry',
        'payment-term-catalog',
        'price-group-catalog',
        'assortment',
        'commerce-customer-context',
        'commerce-market-catalog',
        'catalog',
        'inventory',
        'pricing',
        'privacy',
        'storefront-registry',
        'tax',
        'projects',
        'commerce-cart',
        'commerce-order',
        'payment',
      ]);
      // Controller metadata is asserted at its actual source inventory, rather than its former inline location.
      expect(
        EffectArray.sort(
          [...new Set(inventory.filter(({ database }) => database === 'primary').flatMap(({ schemas }) => schemas))],
          Order.String,
        ),
      ).toEqual([
        'assortment',
        'auth',
        'catalog',
        'commerce_cart',
        'commerce_customer_context',
        'commerce_market_catalog',
        'commerce_order',
        'contacts',
        'core',
        'inventory',
        'party',
        'payment',
        'payment_term_catalog',
        'price_group_catalog',
        'pricing',
        'privacy',
        'projects',
        'storefront_registry',
        'tax',
        'trust',
      ]);
      for (const expected of [
        {
          journalName: '__drizzle_migrations_assortment',
          ownerId: 'assortment',
          runtimeIdentityIds: ['shared_runtime'],
          schemas: ['assortment'],
          verifierPaths: ['verticals/assortment/scripts/verify-db-schema.mts'],
        },
        {
          journalName: '__drizzle_migrations_catalog',
          ownerId: 'catalog',
          runtimeIdentityIds: ['shared_runtime'],
          schemas: ['catalog'],
          verifierPaths: ['verticals/catalog/scripts/verify-db-schema.mts'],
        },
        {
          journalName: '__drizzle_migrations_inventory',
          ownerId: 'inventory',
          runtimeIdentityIds: ['shared_runtime'],
          schemas: ['inventory'],
          verifierPaths: ['verticals/inventory/scripts/verify-db-schema.mts'],
        },
        {
          journalName: '__drizzle_migrations_party',
          ownerId: 'party-registry',
          runtimeIdentityIds: ['shared_runtime', 'party_registry_request', 'party_registry_worker'],
          schemas: ['party'],
          verifierPaths: ['verticals/party-registry/scripts/verify-db-schema.mts'],
        },
        {
          journalName: '__drizzle_migrations_price_group_catalog',
          ownerId: 'price-group-catalog',
          runtimeIdentityIds: ['shared_runtime'],
          schemas: ['price_group_catalog'],
          verifierPaths: ['verticals/price-group-catalog/scripts/verify-db-schema.mts'],
        },
        {
          journalName: '__drizzle_migrations_pricing',
          ownerId: 'pricing',
          runtimeIdentityIds: ['shared_runtime'],
          schemas: ['pricing'],
          verifierPaths: ['verticals/pricing/scripts/verify-db-schema.mts'],
        },
        {
          journalName: '__drizzle_migrations_storefront_registry',
          ownerId: 'storefront-registry',
          runtimeIdentityIds: ['shared_runtime'],
          schemas: ['storefront_registry'],
          verifierPaths: ['verticals/storefront-registry/scripts/verify-db-schema.mts'],
        },
      ]) {
        const matching = inventory.filter(({ ownerId }) => ownerId === expected.ownerId);
        expect(matching).toHaveLength(1);
        for (const { journalName, ownerId, runtimeIdentityIds, schemas, verifierPaths } of matching) {
          expect({ journalName, ownerId, runtimeIdentityIds, schemas, verifierPaths }).toEqual(expected);
        }
      }
      expect(inventory.find((owner) => owner.ownerId === 'commerce-customer-context-portal-auth')?.optional).toBe(true);
      expect(
        inventory
          .find((owner) => owner.ownerId === coreOwner)
          ?.migrationRuntimeIdentityRequirements?.find(
            (requirement) => requirement.migrationName === '20261020063004_dedicated-identity-core-policies',
          )?.identityIds,
      ).toEqual(['shared_runtime', 'party_registry_request', 'party_registry_worker']);
      const coreStreams = inventory.filter((owner) => owner.ownerId === coreOwner);
      expect(coreStreams).toHaveLength(1);
      for (const core of coreStreams) {
        expect(core.runtimeIdentityIds).toEqual(['shared_runtime', 'shell_gateway_issuer']);
        expect(pendingMigrationRuntimeIdentityIds(core, core.migrations)).toEqual([
          'shared_runtime',
          'shell_gateway_issuer',
          'party_registry_request',
          'party_registry_worker',
        ]);
        expect(pendingMigrationRuntimeIdentityIds(core, [])).toEqual([]);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);
