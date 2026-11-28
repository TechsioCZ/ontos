import { NodeServices } from '@effect/platform-node';
import { Reactivity } from 'effect/reactivity';
import { Array as EffectArray, ConfigProvider, Effect, FileSystem, Order } from 'effect';
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

import { PARTY_REGISTRY_WORKER_DATABASE_GRANTS } from '../../verticals/party-registry/src/db/database-grants.ts';

const statementBreakpoint = '--> statement-breakpoint';
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

it.effect('only pending migrations bootstrap roles named by executable PostgreSQL clauses', () =>
  Effect.gen(function* nativeRoleBootstrap() {
    const ids = yield* migrationRuntimeIdentityIds(
      [
        'CREATE TABLE "audit TO !" (id integer)',
        statementBreakpoint,
        'GRANT SELECT ON TABLE "audit TO !" TO party_registry_worker;',
        'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO party_registry_runtime;',
        'GRANT shell_gateway_issuer TO analyst;',
      ].join('\n'),
      first.name,
    );
    const withRequirement = {
      ...stream,
      migrationRuntimeIdentityRequirements: [{ identityIds: ids, migrationName: first.name }],
    };
    expect(pendingMigrationRuntimeIdentityIds(withRequirement, [first])).toEqual([
      'shared_runtime',
      'shell_gateway_issuer',
      'party_registry_request',
      'party_registry_worker',
    ]);
    expect(pendingMigrationRuntimeIdentityIds(withRequirement, [second])).toEqual(['shared_runtime']);
    const failure = yield* migrationRuntimeIdentityIds('GRANT SELECT ON', first.name).pipe(Effect.flip);
    expect(failure.reason).toContain(first.name);
  }),
);

it.effect('ignores empty and comment-only fragments including a trailing Drizzle breakpoint', () =>
  Effect.gen(function* emptyBreakpointFragments() {
    const sql = [' \n', '-- comment\n/* outer /* nested */ end */', 'GRANT analyst TO party_registry_worker;', ''].join(
      statementBreakpoint,
    );
    expect(yield* migrationRuntimeIdentityIds(sql, first.name)).toEqual(['party_registry_worker']);
    const failure = yield* migrationRuntimeIdentityIds(`${sql}/* unclosed`, first.name).pipe(Effect.flip);
    expect(failure.reason).toContain('(fragment 4)');
  }),
);

// Assert each clause independently: a valid GRANT must not conceal a missed OWNER or SET ROLE.
for (const [sql, expected] of [
  [
    'CREATE POLICY "p TO shell_gateway_issuer" ON t /* outer /* TO shell_gateway_issuer */ still a comment */ TO "party_registry_runtime", PUBLIC;',
    ['party_registry_request'],
  ],
  ['ALTER POLICY "p TO !" ON t TO party_registry_worker;', ['party_registry_worker']],
  [
    'SELECT $body$; GRANT SELECT ON t TO shell_gateway_issuer;$body$; -- GRANT SELECT ON t TO shell_gateway_issuer;',
    [],
  ],
  ['ALTER TABLE "OWNER TO shell_gateway_issuer" OWNER TO party_registry_worker;', ['party_registry_worker']],
  ['ALTER SCHEMA test OWNER TO "party_registry_runtime";', ['party_registry_request']],
  ['GRANT another_role TO party_registry_worker;', ['party_registry_worker']],
  [
    'ALTER DEFAULT PRIVILEGES FOR ROLE party_registry_worker IN SCHEMA shell_gateway_issuer GRANT SELECT ON TABLES TO party_registry_runtime;',
    ['party_registry_request', 'party_registry_worker'],
  ],
  [
    'GRANT party_registry_worker TO party_registry_runtime GRANTED BY shell_gateway_issuer;',
    ['shell_gateway_issuer', 'party_registry_request', 'party_registry_worker'],
  ],
  ['SET LOCAL ROLE party_registry_worker;', ['party_registry_worker']],
  ['ALTER POLICY p ON t RENAME TO shell_gateway_issuer;', []],
  ['REVOKE SELECT ON t FROM party_registry_worker;', []],
  ['SELECT 1; GRANT SELECT ON t TO party_registry_worker;', ['party_registry_worker']],
] as const) {
  it.effect(`inventories role operands of ${sql}`, () =>
    Effect.gen(function* nativeRoleOperands() {
      expect(yield* migrationRuntimeIdentityIds(sql, first.name)).toEqual(expected);
    }),
  );
}

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
        'symmy-integration',
        'tax',
        'projects',
        'commerce-cart',
        'commerce-order',
        'payment',
        'promotion',
        'communications',
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
        'communications',
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
        'promotion',
        'storefront_registry',
        'symmy_integration',
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
          journalName: '__drizzle_migrations_promotion',
          ownerId: 'promotion',
          runtimeIdentityIds: ['shared_runtime'],
          schemas: ['promotion'],
          verifierPaths: ['verticals/promotion/scripts/verify-db-schema.mts'],
        },
        {
          journalName: '__drizzle_migrations_storefront_registry',
          ownerId: 'storefront-registry',
          runtimeIdentityIds: ['shared_runtime'],
          schemas: ['storefront_registry'],
          verifierPaths: ['verticals/storefront-registry/scripts/verify-db-schema.mts'],
        },
        {
          journalName: '__drizzle_migrations_symmy_integration',
          ownerId: 'symmy-integration',
          runtimeIdentityIds: ['shared_runtime'],
          schemas: ['symmy_integration'],
          verifierPaths: ['verticals/symmy-integration/scripts/verify-db-schema.mts'],
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
      // The saved-reply column must not reach the worker through a table-wide SELECT an older bootstrap
      // granted: naming the worker makes the migrator refresh its manifest grants around this migration.
      expect(
        inventory
          .find((owner) => owner.ownerId === coreOwner)
          ?.migrationRuntimeIdentityRequirements?.find(
            (requirement) => requirement.migrationName === '20261118203150_action-committed-reply',
          )?.identityIds,
      ).toEqual(['party_registry_worker']);
      expect(inventory.find((owner) => owner.ownerId === 'promotion')?.prerequisites).toEqual([
        { migrate: true, ownerId: coreOwner, verify: true },
      ]);
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

it.effect(
  'replaces the worker table-wide Action invocation read with the manifest columns when the saved reply is added',
  () =>
    Effect.gen(function* savedReplyWorkerGrant() {
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* fs.readFileString(
        new URL(
          '../../packages/core-runtime/drizzle/20261118203150_action-committed-reply/migration.sql',
          import.meta.url,
        ).pathname,
      );
      const statements = sql.split(statementBreakpoint).map((statement) => statement.trim());
      const addColumn = statements.findIndex((statement) => statement.includes('ADD COLUMN "committed_reply_json"'));
      const revoke = statements.indexOf(
        'REVOKE SELECT ON TABLE "core"."action_invocations" FROM "party_registry_worker";',
      );
      const grant = statements.findIndex(
        (statement) =>
          statement.startsWith('GRANT SELECT (') &&
          statement.endsWith('ON TABLE "core"."action_invocations" TO "party_registry_worker";'),
      );
      expect(addColumn).toBeGreaterThanOrEqual(0);
      expect(revoke).toBeGreaterThan(addColumn);
      expect(grant).toBe(revoke + 1);
      const granted = [...(statements[grant] ?? '').matchAll(/"(?<column>[a-z_]+)"/gu)]
        .map((match) => match.groups?.['column'])
        .filter((column) => !['core', 'action_invocations', 'party_registry_worker'].includes(column ?? ''));
      const manifest = PARTY_REGISTRY_WORKER_DATABASE_GRANTS.tables.find(
        ({ table }) => table === 'core.action_invocations',
      );
      expect(granted).toEqual(manifest?.columns?.select);
      expect(granted).not.toContain('committed_reply_json');
    }).pipe(Effect.provide(NodeServices.layer)),
);
