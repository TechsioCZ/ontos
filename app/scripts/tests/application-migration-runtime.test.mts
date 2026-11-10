import { tmpdir } from 'node:os';

import { NodeServices } from '@effect/platform-node';
import { Reactivity } from 'effect/reactivity';
import { Array as EffectArray, Config, ConfigProvider, Effect, FileSystem, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { selectApplicationMigrationPlan } from '../application-migration-plan.mts';
import {
  applicationMigrationOwnerInventory,
  migrationRuntimeIdentityIds,
  pendingMigrationRuntimeIdentityIds,
  loadApplicationMigrationInventory,
  ApplicationMigrationInventoryError,
} from '../application-migration-inventory.mts';
import type { ApplicationMigrationPlan } from '../application-migration-plan.mts';
import type { ApplicationMigrationStream } from '../application-migration-inventory.mts';
import {
  assertMigrationVerificationOnly,
  assertNativeMigrationBounds,
  prepareApplicationMigrationPlan,
  readApplicationMigrationRequirements,
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
const readRequirementsDocument = (document: Schema.Json) =>
  readApplicationMigrationRequirements('reviewed-requirements.json').pipe(
    Effect.provide(FileSystem.layerNoop({ readFileString: () => Effect.succeed(JSON.stringify(document)) })),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  );

it.effect('preserves exact bounded and none requirements from both supported document shapes', () =>
  Effect.gen(function* preservesRequirementsDocuments() {
    for (const requirements of [
      { mode: 'none', owners: [] },
      {
        mode: 'selected',
        owners: [{ migrate: true, ownerId: 'example', throughMigration: first.name, verify: true }],
      },
    ]) {
      expect(yield* readRequirementsDocument(requirements)).toEqual(requirements);
      expect(yield* readRequirementsDocument({ migrationRequirements: requirements, modules: [] })).toEqual(
        requirements,
      );
    }
  }),
);

it.effect('rejects ambiguous or misspelled migration instructions before configuration or native execution', () =>
  Effect.gen(function* rejectsUnknownRequirementsFields() {
    const boundedTypo = {
      mode: 'selected',
      owners: [{ migrate: true, ownerId: 'example', throughMigraton: first.name, verify: true }],
    };
    const documents: readonly Schema.Json[] = [
      { mode: 'none', modules: [], owners: [] },
      boundedTypo,
      { migrationRequirement: { mode: 'none', owners: [] }, modules: [] },
      { migrationRequirements: boundedTypo, modules: [] },
    ];
    for (const document of documents) {
      const failure = yield* readRequirementsDocument(document).pipe(Effect.flip);
      expect(failure.reason).toBe('Invalid reviewed migration requirements document');
    }
  }),
);

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
        'property-portfolio',
        'property-leasing',
        'legal-agreements',
        'work-tasks',
        'workforce',
        'tagging',
        'crm',
        'sales-pipeline',
        'merchandise',
        'facility-operations',
        'sales-insights',
        'finance-billing',
        'crm-activities',
        'projects',
        'commerce-cart',
        'commerce-order',
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
        'crm_activities',
        'demo_crm',
        'demo_email',
        'demo_merchandise',
        'demo_sales_insights',
        'demo_sales_pipeline',
        'demo_tagging',
        'demo_workforce',
        'facility_operations',
        'finance_billing',
        'inventory',
        'legal_agreements',
        'party',
        'payment_term_catalog',
        'price_group_catalog',
        'pricing',
        'privacy',
        'projects',
        'property_leasing',
        'property_portfolio',
        'storefront_registry',
        'tax',
        'trust',
        'work_tasks',
      ]);
      for (const expected of [
        {
          journalName: '__drizzle_migrations_core',
          ownerId: coreOwner,
          runtimeIdentityIds: ['shared_runtime', 'shell_gateway_issuer'],
          schemas: ['core', 'trust', 'demo_email'],
          verifierPaths: ['scripts/verify-core-db-schema.mts'],
        },
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
        ...[
          ['workforce', 'demo_workforce'],
          ['tagging', 'demo_tagging'],
          ['crm', 'demo_crm'],
          ['sales-pipeline', 'demo_sales_pipeline'],
          ['merchandise', 'demo_merchandise'],
          ['sales-insights', 'demo_sales_insights'],
        ].map(([ownerId, schema]) => ({
          journalName: `__drizzle_migrations_${schema}`,
          ownerId,
          runtimeIdentityIds: ['shared_runtime'],
          schemas: [schema],
          verifierPaths: [`verticals/${ownerId}/scripts/verify-db-schema.mts`],
        })),
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

it.effect('refuses an unreviewed topology migration owner instead of guessing its schema or verifier', () =>
  Effect.gen(function* unreviewedMigrationOwner() {
    const fs = yield* FileSystem.FileSystem;
    // The CI shard provisions no OWNED_TEMP_DIR; that directory only narrows where this disposable
    // fixture lives, so an absent value falls back to the system temp root like the sibling tests.
    const owned = yield* Config.String('OWNED_TEMP_DIR').pipe(Config.withDefault(tmpdir()));
    const root = yield* fs.makeTempDirectoryScoped({ directory: owned });
    yield* fs.makeDirectory(`${root}/topology`, { recursive: true });
    yield* fs.makeDirectory(`${root}/verticals/unreviewed`, { recursive: true });
    yield* fs.writeFileString(
      `${root}/topology/reference-topology.json`,
      '{"verticals":[{"id":"unreviewed","path":"verticals/unreviewed"}]}',
    );
    yield* fs.writeFileString(`${root}/verticals/unreviewed/drizzle.config.ts`, '// must not be imported or guessed');
    const failure = yield* loadApplicationMigrationInventory(root).pipe(Effect.flip);
    if (Schema.is(ApplicationMigrationInventoryError)(failure)) {
      expect(failure.reason).toBe('Missing reviewed source migration metadata for unreviewed');
    } else {
      yield* Effect.die(failure);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
