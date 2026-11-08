/// <reference types="node" />

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Array as EffectArray, Effect, FileSystem, Order, Schema } from 'effect';

import { DATABASE_IDENTITIES } from '../database/identity-enrollment.ts';

import type { ApplicationMigrationOwnerInventory } from './application-migration-plan.mts';

/** Existing ordered runner streams and owner verifier gateways, consolidated without loading owner configuration. */
export interface ApplicationMigrationStream extends ApplicationMigrationOwnerInventory {
  readonly configFile: string;
  readonly database: 'primary' | 'portal-auth';
  readonly directory: string;
  readonly migrationDirectory: string;
  readonly migrationRuntimeIdentityRequirements?: readonly {
    readonly identityIds: readonly string[];
    readonly migrationName: string;
  }[];
  readonly preparationScripts: readonly string[];
  readonly runtimeIdentityIds: readonly string[];
  readonly verifierPaths: readonly string[];
}
interface OwnerStreamSource {
  readonly configFile: string;
  readonly database: 'primary' | 'portal-auth';
  readonly directory: string;
  readonly optional: boolean;
  readonly ownerId: string;
  readonly preparationScripts: readonly string[];
  readonly prerequisiteIds: readonly string[];
  readonly runtimeIdentityIds: readonly string[];
  readonly schemas: readonly string[];
  readonly verifierPaths: readonly string[];
}
export class ApplicationMigrationInventoryError extends Schema.TaggedError<ApplicationMigrationInventoryError>()(
  'ApplicationMigrationInventoryError',
  { reason: Schema.String },
) {}
const invalid = (reason: string) => new ApplicationMigrationInventoryError({ reason });
const coreOwner = 'core-runtime';
const defaultDrizzleConfig = 'drizzle.config.ts';
const applicationDirectory = fileURLToPath(new URL('../', import.meta.url));
const TopologySchema = Schema.fromJsonString(
  Schema.Struct({ verticals: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String })) }),
);
const migrationName = /^[0-9]{14}_[a-zA-Z0-9_-]+$/u;
const primary = (
  ownerId: string,
  directory: string,
  schemas: readonly string[],
  verifierPaths: readonly string[],
  prerequisiteIds: readonly string[] = [coreOwner],
): OwnerStreamSource => ({
  configFile: defaultDrizzleConfig,
  database: 'primary',
  directory,
  optional: false,
  ownerId,
  preparationScripts: [],
  prerequisiteIds,
  runtimeIdentityIds: ['shared_runtime'],
  schemas,
  verifierPaths,
});
// Preserve the actual Core/Auth/Contacts -> Party order of the existing runner.
const orderedSources: readonly OwnerStreamSource[] = [
  {
    ...primary(
      'core-runtime',
      'packages/core-runtime',
      ['core', 'trust', 'demo_email'],
      ['scripts/verify-core-db-schema.mts'],
      [],
    ),
    // Core's own verifier checks the registrar's exclusive executor before Shell migrations run.
    runtimeIdentityIds: ['shared_runtime', 'shell_gateway_issuer'],
  },
  {
    ...primary(
      'shell-super-app',
      'apps/shell-super-app',
      ['auth'],
      ['apps/shell-super-app/scripts/verify-auth-db-schema.mts'],
    ),
    configFile: 'drizzle.auth.config.ts',
    runtimeIdentityIds: ['shared_runtime', 'shell_gateway_issuer'],
  },
  {
    ...primary(
      'party-registry-contacts',
      'verticals/party-registry',
      ['contacts'],
      ['verticals/party-registry/scripts/verify-engagement-db-schema.mts'],
    ),
    configFile: 'drizzle.contacts.config.ts',
    preparationScripts: ['verticals/party-registry/scripts/prepare-contacts-migration.mts'],
    runtimeIdentityIds: ['shared_runtime', 'party_registry_request', 'party_registry_worker'],
  },
  {
    ...primary(
      'party-registry',
      'verticals/party-registry',
      ['party'],
      ['verticals/party-registry/scripts/verify-db-schema.mts'],
      [coreOwner, 'party-registry-contacts'],
    ),
    runtimeIdentityIds: ['shared_runtime', 'party_registry_request', 'party_registry_worker'],
  },
  ...(
    [
      ['payment-term-catalog', 'payment_term_catalog'],
      ['price-group-catalog', 'price_group_catalog'],
      ['assortment', 'assortment'],
      ['commerce-customer-context', 'commerce_customer_context'],
      ['commerce-market-catalog', 'commerce_market_catalog'],
      ['catalog', 'catalog'],
      ['inventory', 'inventory'],
      ['pricing', 'pricing'],
      ['privacy', 'privacy'],
      ['storefront-registry', 'storefront_registry'],
      ['tax', 'tax'],
    ] as const
  ).map(([ownerId, schema]) =>
    primary(ownerId, `verticals/${ownerId}`, [schema], [`verticals/${ownerId}/scripts/verify-db-schema.mts`]),
  ),
  // These names come from the owners' actual schema declarations and Drizzle configurations.
  ...(
    [
      ['property-portfolio', 'property_portfolio'],
      ['property-leasing', 'property_leasing'],
      ['legal-agreements', 'legal_agreements'],
      ['work-tasks', 'work_tasks'],
      ['workforce', 'demo_workforce'],
      ['tagging', 'demo_tagging'],
      ['crm', 'demo_crm'],
      ['sales-pipeline', 'demo_sales_pipeline'],
      ['merchandise', 'demo_merchandise'],
      ['facility-operations', 'facility_operations'],
      ['sales-insights', 'demo_sales_insights'],
      ['finance-billing', 'finance_billing'],
      ['crm-activities', 'crm_activities'],
      ['projects', 'projects'],
      ['commerce-cart', 'commerce_cart'],
    ] as const
  ).map(([ownerId, schema]) =>
    primary(ownerId, `verticals/${ownerId}`, [schema], [`verticals/${ownerId}/scripts/verify-db-schema.mts`]),
  ),
  primary(
    'commerce-order',
    'verticals/commerce-order',
    ['commerce_order'],
    ['verticals/commerce-order/scripts/verify-database.mts'],
  ),
];
const portal: OwnerStreamSource = {
  configFile: 'drizzle.portal-auth.config.ts',
  database: 'portal-auth',
  directory: 'verticals/commerce-customer-context',
  optional: true,
  ownerId: 'commerce-customer-context-portal-auth',
  preparationScripts: [],
  prerequisiteIds: [],
  runtimeIdentityIds: [],
  schemas: ['commerce_auth'],
  verifierPaths: ['verticals/commerce-customer-context/scripts/verify-portal-auth-db-schema.mts'],
};

/** Existing native DDL statements can require an already-defined physical role before policy creation. */
export const migrationRuntimeIdentityIds = (sql: string): readonly string[] => {
  const requiredRoles = new Set<string>();
  for (const part of sql.split('--> statement-breakpoint')) {
    const statement = part
      .replaceAll(/\/\*[\s\S]*?\*\//gu, ' ')
      .replaceAll(/^\s*--[^\n]*$/gmu, '')
      .trim();
    const roles =
      /^(?:(?:create|alter)\s+policy\b[^;]*?\bto\s+|grant\b[^;]*?\bto\s+|alter\b[^;]*?\bowner\s+to\s+|set\s+(?:local\s+)?role\s+)(?<roles>(?:"[a-z0-9_]+"|[a-z0-9_]+)(?:\s*,\s*(?:"[a-z0-9_]+"|[a-z0-9_]+))*)/iu.exec(
        statement,
      )?.groups?.roles;
    if (roles === undefined) {
      continue;
    }
    for (const match of roles.matchAll(/"(?<quoted>[a-z0-9_]+)"|(?<plain>[a-z0-9_]+)/giu)) {
      const role = match.groups?.quoted ?? match.groups?.plain?.toLowerCase();
      if (role !== undefined) {
        requiredRoles.add(role);
      }
    }
  }
  return DATABASE_IDENTITIES.filter((identity) => requiredRoles.has(identity.role)).map((identity) => identity.id);
};

const readStream = Effect.fn('ApplicationMigrationInventory.readStream')(function* readStreamEffect(
  source: OwnerStreamSource,
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path.join(root, source.directory, source.configFile));
  const journalName = /table:\s*'(?<journal>__drizzle_migrations_[a-z0-9_]+)'/u.exec(text)?.groups?.journal;
  const output = /out:\s*'\.\/(?<output>[a-z0-9-]+)'/u.exec(text)?.groups?.output;
  if (journalName === undefined || output === undefined) {
    return yield* invalid(`Invalid source migration metadata for ${source.ownerId}`);
  }
  for (const verifier of source.verifierPaths) {
    if (!(yield* fs.exists(path.join(root, verifier)))) {
      return yield* invalid(`Missing source verifier gateway for ${source.ownerId}`);
    }
  }
  const migrationDirectory = path.join(source.directory, output);
  const names = EffectArray.sort(
    (yield* fs.readDirectory(path.join(root, migrationDirectory))).filter((name) => migrationName.test(name)),
    Order.String,
  );
  const sourceMigrations = yield* Effect.forEach(
    names,
    (name) =>
      fs.readFileString(path.join(root, migrationDirectory, name, 'migration.sql')).pipe(
        Effect.map((sql) => ({
          hash: createHash('sha256').update(sql).digest('hex'),
          name,
          runtimeIdentityIds: migrationRuntimeIdentityIds(sql),
        })),
      ),
    { concurrency: 4 },
  );
  const migrations = sourceMigrations.map(({ hash, name }) => ({ hash, name }));
  const migrationRuntimeIdentityRequirements = sourceMigrations
    .filter((migration) => migration.runtimeIdentityIds.length > 0)
    .map(({ name, runtimeIdentityIds }) => ({ identityIds: runtimeIdentityIds, migrationName: name }));
  const { prerequisiteIds, ...metadata } = source;
  return {
    ...metadata,
    journalName,
    migrationDirectory,
    migrationRuntimeIdentityRequirements,
    migrations,
    prerequisites: prerequisiteIds.map((ownerId) => ({ migrate: true, ownerId, verify: true })),
  } satisfies ApplicationMigrationStream;
});

/** SQL name/hash discovery reads files only; importing a Drizzle config would initialize unrelated credentials. */
export const loadApplicationMigrationInventory = Effect.fn('ApplicationMigrationInventory.load')(
  function* loadApplicationMigrationInventoryEffect(root: string = applicationDirectory) {
    const fs = yield* FileSystem.FileSystem;
    const topology = yield* Schema.decodeEffect(TopologySchema)(
      yield* fs.readFileString(path.join(root, 'topology/reference-topology.json')),
    );
    if (
      new Set(topology.verticals.map((owner) => owner.id)).size !== topology.verticals.length ||
      new Set(topology.verticals.map((owner) => owner.path)).size !== topology.verticals.length
    ) {
      return yield* invalid('Duplicate topology migration owner');
    }
    const declared = new Set(
      orderedSources.filter((source) => source.configFile === defaultDrizzleConfig).map((source) => source.directory),
    );
    for (const owner of topology.verticals) {
      if (declared.has(owner.path) || !(yield* fs.exists(path.join(root, owner.path, 'drizzle.config.ts')))) {
        continue;
      }
      if (!/^verticals\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(owner.path) || owner.path !== `verticals/${owner.id}`) {
        return yield* invalid('Invalid topology migration owner');
      }
      return yield* invalid(`Missing reviewed source migration metadata for ${owner.id}`);
    }
    return yield* Effect.forEach([...orderedSources, portal], (source) => readStream(source, root), {
      concurrency: 4,
    });
  },
);

/** Project only the reviewed planner contract, retaining executable gateway metadata separately. */
export const applicationMigrationOwnerInventory = (
  streams: readonly ApplicationMigrationStream[],
): readonly ApplicationMigrationOwnerInventory[] =>
  streams.map(({ journalName, migrations, optional, ownerId, prerequisites, schemas }) => ({
    journalName,
    migrations,
    optional,
    ownerId,
    prerequisites,
    schemas,
  }));

/** Journaled role-dependent SQL is not a reason to read unrelated runtime passwords again. */
export const pendingMigrationRuntimeIdentityIds = (
  stream: ApplicationMigrationStream,
  pendingMigrations: ApplicationMigrationOwnerInventory['migrations'],
): readonly string[] => {
  if (pendingMigrations.length === 0) {
    return [];
  }
  const pendingNames = new Set(pendingMigrations.map((migration) => migration.name));
  return [
    ...new Set([
      ...stream.runtimeIdentityIds,
      ...(stream.migrationRuntimeIdentityRequirements ?? [])
        .filter((requirement) => pendingNames.has(requirement.migrationName))
        .flatMap((requirement) => requirement.identityIds),
    ]),
  ];
};
