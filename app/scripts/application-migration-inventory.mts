/// <reference types="node" />

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Array as EffectArray, Effect, FileSystem, Order, Schema } from 'effect';
import { parse } from 'libpg-query';
import type { AlterDefaultPrivilegesStmt, Node } from 'libpg-query';

import { DATABASE_IDENTITIES } from '../packages/core-runtime/src/db/database-identities.ts';

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
const migrationName = /^\d{14}_[\w-]+$/u;
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
      ['core', 'trust'],
      ['packages/core-runtime/scripts/verify-db-schema.mts'],
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
      ['symmy-integration', 'symmy_integration'],
      ['tax', 'tax'],
    ] as const
  ).map(([ownerId, schema]) =>
    primary(ownerId, `verticals/${ownerId}`, [schema], [`verticals/${ownerId}/scripts/verify-db-schema.mts`]),
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

const roleNames = (roles: readonly Node[] = []) =>
  roles.map((role) => ('RoleSpec' in role ? role.RoleSpec.rolename : undefined));

const defaultGrantRoles = ({ action, options = [] }: AlterDefaultPrivilegesStmt) => {
  if (action?.is_grant !== true) {
    return [];
  }
  const owners = options.flatMap((option) => {
    if (!('DefElem' in option) || option.DefElem.defname !== 'roles') {
      return [];
    }
    const { arg } = option.DefElem;
    return arg !== undefined && 'List' in arg ? roleNames(arg.List.items) : [];
  });
  return [...owners, ...roleNames(action.grantees)];
};

/** Only executable role operands, never identifiers from table names or privilege lists. */
const statementRoleNames = (node: Node): readonly (string | undefined)[] => {
  if ('GrantStmt' in node && node.GrantStmt.is_grant === true) {
    return [...roleNames(node.GrantStmt.grantees), node.GrantStmt.grantor?.rolename];
  }
  if ('AlterDefaultPrivilegesStmt' in node) {
    return defaultGrantRoles(node.AlterDefaultPrivilegesStmt);
  }
  if ('GrantRoleStmt' in node && node.GrantRoleStmt.is_grant === true) {
    const { granted_roles, grantee_roles, grantor } = node.GrantRoleStmt;
    return [
      ...(granted_roles ?? []).map((role) => ('AccessPriv' in role ? role.AccessPriv.priv_name : undefined)),
      ...roleNames(grantee_roles),
      grantor?.rolename,
    ];
  }
  if ('CreatePolicyStmt' in node) {
    return roleNames(node.CreatePolicyStmt.roles);
  }
  if ('AlterPolicyStmt' in node) {
    return roleNames(node.AlterPolicyStmt.roles);
  }
  if ('AlterOwnerStmt' in node) {
    return [node.AlterOwnerStmt.newowner?.rolename];
  }
  if ('AlterTableStmt' in node) {
    return (node.AlterTableStmt.cmds ?? []).map((cmd) =>
      'AlterTableCmd' in cmd ? cmd.AlterTableCmd.newowner?.rolename : undefined,
    );
  }
  if ('VariableSetStmt' in node && node.VariableSetStmt.name === 'role') {
    return (node.VariableSetStmt.args ?? []).map((arg) => ('A_Const' in arg ? arg.A_Const.sval?.sval : undefined));
  }
  return [];
};

/** PostgreSQL 18 resolves quoting, comments and statement boundaries before we inspect role-bearing clauses. */
export const migrationRuntimeIdentityIds = Effect.fn('ApplicationMigrationInventory.runtimeIdentities')(
  function* migrationRuntimeIdentityIdsEffect(sql: string, source: string) {
    const parsed = yield* Effect.tryPromise({
      catch: () => invalid(`Cannot parse migration SQL: ${source}`),
      try: async () => await parse(sql),
    });
    const roles = new Set(
      (parsed.stmts ?? []).flatMap(({ stmt }) => (stmt === undefined ? [] : statementRoleNames(stmt))),
    );
    return DATABASE_IDENTITIES.flatMap((identity) => (roles.has(identity.role) ? [identity.id] : []));
  },
);

const readStream = Effect.fn('ApplicationMigrationInventory.readStream')(function* readStreamEffect(
  source: OwnerStreamSource,
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path.join(root, source.directory, source.configFile));
  const journalName = /table:\s*'(?<journal>__drizzle_migrations_[a-z0-9_]+)'/u.exec(text)?.groups?.['journal'];
  const output = /out:\s*'\.\/(?<output>[a-z0-9-]+)'/u.exec(text)?.groups?.['output'];
  if (journalName === undefined || output === undefined) {
    return yield* invalid(`Invalid source migration metadata for ${source.ownerId}`);
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
        Effect.flatMap((sql) =>
          migrationRuntimeIdentityIds(sql, path.join(migrationDirectory, name)).pipe(
            Effect.map((runtimeIdentityIds) => ({
              hash: createHash('sha256').update(sql).digest('hex'),
              name,
              runtimeIdentityIds,
            })),
          ),
        ),
      ),
    { concurrency: 4 },
  );
  const migrations = sourceMigrations.map(({ hash, name }) => ({ hash, name }));
  const migrationRuntimeIdentityRequirements = sourceMigrations.flatMap((migration) => {
    const { name, runtimeIdentityIds } = migration;
    return migration.runtimeIdentityIds.length > 0 ? [{ identityIds: runtimeIdentityIds, migrationName: name }] : [];
  });
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
    const declared = new Set(
      orderedSources.flatMap((source) => (source.configFile === defaultDrizzleConfig ? [source.directory] : [])),
    );
    const generated: OwnerStreamSource[] = [];
    for (const owner of topology.verticals) {
      if (declared.has(owner.path) || !(yield* fs.exists(path.join(root, owner.path, 'drizzle.config.ts')))) {
        continue;
      }
      if (!/^verticals\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(owner.path) || owner.path !== `verticals/${owner.id}`) {
        return yield* invalid('Invalid topology migration owner');
      }
      const schema = owner.id.replaceAll('-', '_');
      generated.push(
        primary(
          owner.id,
          owner.path,
          [schema],
          [`${owner.path}/scripts/${owner.id === 'commerce-order' ? 'verify-database' : 'verify-db-schema'}.mts`],
        ),
      );
    }
    return yield* Effect.forEach([...orderedSources, ...generated, portal], (source) => readStream(source, root), {
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
      ...(stream.migrationRuntimeIdentityRequirements ?? []).flatMap((requirement) =>
        pendingNames.has(requirement.migrationName) ? requirement.identityIds : [],
      ),
    ]),
  ];
};
