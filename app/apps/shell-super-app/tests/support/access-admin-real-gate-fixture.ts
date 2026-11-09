import { NodeCrypto, NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { PgClient as PgClientService } from '@effect/sql-pg';
import { v1 } from '@authzed/authzed-node';
import {
  AccessDeclarationSchema,
  DatabaseConfig,
  loadDatabaseConnectionPair,
  makeDatabaseIdentityEnrollmentLive,
  parseDatabaseConfig,
  parseDatabaseConnectionPair,
} from '@app/core-runtime';
import type { AccessDeclaration, DatabaseConnectionPair } from '@app/core-runtime';
import { AccessCatalogModulesSchema } from '@app/core-runtime/access/catalog';
import { TenantIntentLoaderLive } from '@app/core-runtime/access/intent/tenant-intent-loader';
import { CoreDatabase, CoreDatabaseLive } from '@app/core-runtime/db/client';
import {
  AccessDecisionLive,
  AccessDecisionLogLive,
  AccessIntentLive,
  AccessPrincipalKindSourceLive,
  AccessWorkloadBindingSourceLive,
  LegalEntityCandidatesLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import type { AccessDecisionService } from '@app/core-runtime/access/enforcement';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '@app/core-runtime/access/compiler/spice-db-compiler';
import { AccessCatalogSnapshotWriterLive } from '@app/core-runtime/access/intent/catalog-snapshot-writer';
import { AccessMembershipStore, AccessMembershipStoreLive } from '@app/core-runtime/access/intent/memberships';
import { AccessChangesStoreLive } from '@app/core-runtime/access/changes/persistence/drizzle-store';
import { AccessProjectionCompiler } from '@app/core-runtime/access/intent/projection-compiler';
import { AccessProjectionWriter, AccessProjectionWriterLive } from '@app/core-runtime/access/intent/projection-writer';
import { TenantAccessBootstrap, TenantAccessBootstrapLive } from '@app/core-runtime/access/bootstrap';
import { AccessWriteJournalStoreLive } from '@app/core-runtime/access/lifecycle/persistence/journal-store';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import type { OperationalScope } from '@app/core-runtime/operations/context';
import { recordObjectId, scopeObjectId } from '../../../../packages/core-runtime/src/access/compiler/object-id.ts';
import type { AccessCatalogModule } from '../../../../packages/core-runtime/src/authorization/access-declaration.ts';
import { CORE_MIGRATION_EQUIVALENCES } from '../../../../packages/core-runtime/src/db/migration-equivalence-data.ts';
import type { CoreDatabaseExecutor } from '../../../../packages/core-runtime/src/db/types.ts';
import { Cause, Context, Crypto, DateTime, Effect, FileSystem, Layer, Path, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';

import { SHELL_DATABASE_IDENTITY_ENROLLMENT } from '../../api/database-identity-enrollment.ts';
import { shellLegalEntityScope } from '../../api/modules/shell-access-decisions';
import { bindLiveActionAccessGate } from '../../../../packages/core-runtime/src/operations/access-gate.ts';
import { loadSpiceDbConfig } from '@app/core-runtime/access/spicedb-config';
import type { SpiceDbConfigValue } from '@app/core-runtime/access/spicedb-config';
import { newSpiceDbGrpcClient } from '../../../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { spiceDbTransport } from '../../../../packages/core-runtime/src/permissions/spicedb-transport.node.ts';
import { SPICEDB_CHECK_TIMEOUT_MS } from '../../../../packages/core-runtime/src/permissions/client.ts';
import { DecisionCheck } from '../../../../packages/core-runtime/src/access/decision/engine.ts';
import { enginePortOf } from '../../../../packages/core-runtime/src/access/enforcement/enforcement-live.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../../../packages/core-runtime/src/permissions/schema.ts';

/*
 * The P14 cross-lane security fixture (#1343): the *real* Core access gate, intent, bootstrap and
 * projection writer over a disposable database cloned per case and the integration SpiceDB, plus the
 * real Shell BFF handler that asks them.
 *
 * There is deliberately no scripted gate here. Every access answer comes from `AccessDecisionLive`
 * over `AccessEnforcementPortsLive` and `TenantIntentLoaderLive` — the composition
 * `apps/shell-super-app/api/index.ts` builds for production — pointed at this case's own database and
 * at this lane's own engine. A test may therefore only assert what the engine actually decided.
 *
 * The PostgreSQL server and SpiceDB come from the integration environment (`DATABASE_ADMIN_URL`,
 * `SPICEDB_*`), as for every other integration suite. The signed-in person is the one thing the
 * fixture supplies itself: `resolveShellContext` answers from an explicit request header and the
 * seeded principal row, because authentication is not what this suite tests. The *authorization*
 * answer is never faked: the session it hands the BFF names a real principal, and the gate then
 * decides that principal's real intent.
 */

/** A port nothing listens on, so "the engine is unavailable" is a real transport failure. */
const UNREACHABLE_SPICEDB_ENDPOINT = '127.0.0.1:1';

const TEMPLATE_DATABASE = 'p14_access_admin_template';
const CASE_DATABASE_PREFIX = 'p14_access_admin_';
const LOGIN_ROLES = ['ontos_runtime', 'party_registry_runtime', 'party_registry_worker'] as const;

const coreMigrationDirectory = new URL('../../../../packages/core-runtime/drizzle/', import.meta.url);
const authMigrationDirectory = new URL('../../drizzle-auth/', import.meta.url);
const catalogArtifactPath = new URL('../../../../topology/authorization-catalog.json', import.meta.url);

/*
 * The app-host migrator (`scripts/migration-convergence-cli.mts`) applies exactly one lineage of each reviewed
 * equivalent migration pair, and a database without a journal starts on the `main` lineage. This template is
 * built from raw committed SQL with no journal, so it must make the same choice: applying both lineages re-runs
 * the demo history's byte-identical copies, and the second `CREATE SCHEMA trust` fails the template build.
 */
const retiredCoreMigrationDirectories: ReadonlySet<string> = new Set(
  CORE_MIGRATION_EQUIVALENCES.map((pair) => pair.demo),
);

export class AccessAdminFixtureError extends Schema.TaggedError<AccessAdminFixtureError>()('AccessAdminFixtureError', {
  reason: Schema.String,
}) {}

const fixtureFailure = (reason: string) => new AccessAdminFixtureError({ reason });

// ---------------------------------------------------------------------------------------------
// The scenario surface
// ---------------------------------------------------------------------------------------------

/**
 * The people a security scenario needs. Each one is a real `core.principals` row of the case tenant
 * with its own intent; nothing about a persona is implied by the test's name.
 */
export const PERSONAS = [
  /** The tenant's bootstrapped owner: "Plný přístup" in the tenant context and in every company. */
  'owner',
  /** A company administrator: an explicit, scope-local role in one company. */
  'companyAdmin',
  /** A time-bounded delegate of that administrator, bounded to the same company and cells (D10b). */
  'delegate',
  /** A plain member of both companies with no role at all. */
  'member',
  /** A holder suspended in the tenant while its company membership and assignment stay active. */
  'suspended',
  /** A holder whose assignment ended yesterday; the row is still `active`. */
  'expiredAssignment',
  /** An agent principal with an assigned role: agents are refused this surface (O67-Q5). */
  'agent',
  /** A trusted workload principal: classified by the capability owner, never a human administrator. */
  'workload',
  /** The owner of a *different* tenant: the same declaration over another tenant's authority. */
  'foreignOwner',
] as const;
export type Persona = (typeof PERSONAS)[number];

export interface AccessAdminIdentifiers {
  readonly authBindingId: string;
  readonly principalId: string;
}

/**
 * One gate question, asked the way a Shell entrypoint asks it: the declaration the entrypoint ships,
 * its declared scope and the trusted request scope (O66).
 */
export interface DeclarationQuestion {
  readonly declarationKey: string;
  readonly legalEntityId?: string | undefined;
  readonly persona: Persona;
  /** `tenant` keeps the request in the tenant context — no company selected (O28/P3). */
  readonly scope?: 'legal-entity' | 'tenant';
}

export interface GateAnswer {
  readonly outcome: 'ALLOWED' | 'DENIED' | 'NEEDS_APPROVAL' | 'UNAVAILABLE';
  readonly reasonCodes: readonly string[];
}

/** The Shell BFF a test drives: one real handler, one fixture-owned session source, one real gate. */

export interface AccessAdminCase {
  /** The case's own admin connection, for reading back what a write persisted. */
  readonly admin: PgClient.PgClient;
  /** The published catalog this case bootstrapped: exactly the declarations the gate can decide. */
  readonly catalog: readonly AccessCatalogModule[];
  readonly companies: readonly string[];
  /** The case database as the Shell's own runtime and admin identities reach it, for a real composition. */
  readonly databases: DatabaseConnectionPair;
  /** The real gate: one question, one engine answer. */
  readonly decide: (question: DeclarationQuestion) => Effect.Effect<GateAnswer>;
  /** The same question with the engine unreachable: UNAVAILABLE, never DENIED (O48). */
  readonly decideUnavailable: (question: DeclarationQuestion) => Effect.Effect<GateAnswer>;
  /** Every declaration the published catalog carries, keyed the way the gate asks for it. */
  readonly declarations: ReadonlyMap<string, PublishedDeclaration>;
  readonly ids: ReadonlyMap<Persona, AccessAdminIdentifiers>;
  /** The trusted request scope of one persona (O66), for intent a scenario writes itself. */
  readonly scopeFor: (persona: Persona, legalEntityId?: string) => Effect.Effect<OperationalScope>;
  /** The scope id of one company, or of the tenant context when omitted. */
  readonly scopeIdOf: (legalEntityId?: string) => Effect.Effect<string>;
  /** Every `admin` declaration of the published catalog under `core.shell.*` (P1 publishes them). */
  readonly shellAdminDeclarations: readonly PublishedDeclaration[];
  readonly tenantId: string;
  /** Projects one protected record, so a record-targeted decision has something to prove. */
  readonly writeRecord: (input: {
    readonly moduleKey: string;
    readonly persona: Persona;
    readonly recordKey: string;
  }) => Effect.Effect<void>;
}

/** Every question the suite asks is asked at one fixed instant; Core mints its own transaction time. */
export const DECISION_AT = DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00.000Z'));

// ---------------------------------------------------------------------------------------------
// PostgreSQL: one template, one clone per case
// ---------------------------------------------------------------------------------------------

const migrationStatements = (directory: URL, retired: ReadonlySet<string> = new Set<string>()) =>
  Effect.gen(function* readMigrations() {
    const fileSystem = yield* FileSystem.FileSystem;
    const directories = yield* fileSystem.readDirectory(directory.pathname);
    const statements: string[] = [];
    for (const name of directories.filter((directoryName) => !retired.has(directoryName)).toSorted()) {
      const path = `${directory.pathname}${name}/migration.sql`;
      if (!(yield* fileSystem.exists(path))) {
        continue;
      }
      const contents = yield* fileSystem.readFileString(path);
      for (const statement of contents.split('--> statement-breakpoint')) {
        if (statement.trim().length > 0) {
          statements.push(statement);
        }
      }
    }
    return statements;
  }).pipe(Effect.orDie);

const runStatements = (client: PgClient.PgClient, statements: readonly string[]) =>
  Effect.forEach(statements, (statement) => client.unsafe(statement).pipe(Effect.orDie), {
    concurrency: 1,
    discard: true,
  });

export const replacedDatabase = (connectionString: string, database: string): string => {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.href;
};

const dropDatabase = (admin: PgClient.PgClient, database: string) =>
  admin.unsafe(`drop database if exists "${database}" with (force)`).pipe(Effect.orDie);

const cloneDatabase = (admin: PgClient.PgClient, database: string) =>
  admin.unsafe(`create database "${database}" template "${TEMPLATE_DATABASE}"`).pipe(Effect.orDie);

/** A pool the caller's own scope owns and closes; never a client whose scope already ended. */
const makeClient = (connectionString: string, maxConnections: number) =>
  Effect.gen(function* openClient() {
    const reactivity = yield* Reactivity.make;
    return yield* PgClientService.make({ maxConnections, url: Redacted.make(connectionString) }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
    );
  }).pipe(Effect.orDie);

/** The suite's template: the committed core and staff-auth schemas plus the runtime login roles. */
const buildTemplateDatabase = (admin: PgClient.PgClient) =>
  Effect.gen(function* buildTemplate() {
    yield* Effect.forEach(
      LOGIN_ROLES,
      (role) =>
        admin
          .unsafe(
            `do $$ begin
               if not exists (select 1 from pg_roles where rolname = '${role}') then
                 create role ${role} login password '${role}';
               end if;
             end $$`,
          )
          .pipe(Effect.orDie),
      { concurrency: 1, discard: true },
    );
    yield* runStatements(admin, yield* migrationStatements(coreMigrationDirectory, retiredCoreMigrationDirectories));
    yield* runStatements(admin, yield* migrationStatements(authMigrationDirectory));
    yield* runStatements(admin, [
      'grant usage on schema core to ontos_runtime',
      'grant select, insert, update, delete on all tables in schema core to ontos_runtime',
      'grant usage, select on all sequences in schema core to ontos_runtime',
      'grant execute on all functions in schema core to ontos_runtime',
      'grant usage on schema auth to ontos_runtime',
      'grant select, insert, update, delete on all tables in schema auth to ontos_runtime',
      'grant usage, select on all sequences in schema auth to ontos_runtime',
    ]);
  });

/** The one template every case clones: built once for the suite. */
const labelled = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.tapCause((cause) => Effect.logError(`P14 step failed: ${name}\n${Cause.pretty(cause)}`)));

/** The integration server's connections; every database this suite makes lives beside them. */
const serverConnections = loadDatabaseConnectionPair().pipe(Effect.orDie);
const serverAdminUrl = serverConnections.pipe(Effect.map((connections) => connections.admin.connectionString));

const prepareTemplateDatabase = Effect.gen(function* prepareTemplate() {
  const adminUrl = yield* serverAdminUrl;
  const admin = yield* makeClient(adminUrl, 1);
  yield* dropDatabase(admin, TEMPLATE_DATABASE);
  yield* admin.unsafe(`create database "${TEMPLATE_DATABASE}"`).pipe(Effect.orDie);
  const template = yield* makeClient(replacedDatabase(adminUrl, TEMPLATE_DATABASE), 1);
  yield* buildTemplateDatabase(template);
}).pipe(
  Effect.scoped,
  Effect.tapCause((cause) => Effect.logError('P14 template database failed', cause)),
  Effect.provide(NodeServices.layer),
  Effect.orDie,
);

/**
 * The template is built once per process, on the first case's own budget: a suite hook has a shorter
 * deadline than a case, and applying the committed migrations is the cost this fixture pays once.
 */
let templatePrepared = false;

/** The suite-scoped template: built once, before the cases, on a deadline migrations can meet. */
export const templateDatabaseLayer = Layer.effectDiscard(
  prepareTemplateDatabase.pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        templatePrepared = true;
      }),
    ),
  ),
);

const ensureTemplate = Effect.suspend((): Effect.Effect<void> => {
  if (templatePrepared) {
    return Effect.void;
  }
  return prepareTemplateDatabase.pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        templatePrepared = true;
      }),
    ),
  );
});

// ---------------------------------------------------------------------------------------------
// The engine's schema
// ---------------------------------------------------------------------------------------------

const writeEngineSchema = (configuration: SpiceDbConfigValue) =>
  Effect.acquireUseRelease(
    Effect.sync(() => newSpiceDbGrpcClient(configuration)),
    (client) =>
      Effect.tryPromise(
        async () => await client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
      ).pipe(Effect.orDie),
    (client) => Effect.sync(() => client.close()),
  );

// ---------------------------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------------------------

interface SeedPerson {
  readonly authBindingId: string;
  readonly principalId: string;
}
type PersonaSeeds = ReadonlyMap<Persona, SeedPerson>;

const jsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const principalKindOf = (persona: Persona) => {
  if (persona === 'agent') {
    return 'agent';
  }
  if (persona === 'workload') {
    return 'integration';
  }
  return 'human';
};

/** Core holds an agent in its own `agent_id` column: a principal column only ever names a person. */
const holderColumnOf = (persona: Persona) => (persona === 'agent' ? 'agent_id' : 'principal_id');

const seedTenant = (
  admin: PgClient.PgClient,
  input: {
    readonly companies: readonly string[];
    readonly moduleKeys: readonly string[];
    readonly personas: PersonaSeeds;
    readonly slug: string;
    readonly tenantId: string;
  },
) =>
  Effect.gen(function* seedTenantRows() {
    yield* admin
      .unsafe(
        `insert into core.tenants (tenant_id, slug, name, status, default_locale)
         values ('${input.tenantId}', '${input.slug}', 'P14 tenant', 'active', 'cs')`,
      )
      .pipe(Effect.orDie);
    for (const companyId of input.companies) {
      yield* admin
        .unsafe(
          `insert into core.legal_entities
             (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status)
           values ('${companyId}', '${input.tenantId}', 'P14 company', 'CZ', '${companyId.slice(-8)}', 'active')`,
        )
        .pipe(Effect.orDie);
    }
    for (const persona of PERSONAS) {
      const person =
        input.personas.get(persona) ?? (yield* Effect.die(new Error(`The P14 fixture has no seeded ${persona}`)));
      const kind = principalKindOf(persona);
      yield* admin
        .unsafe(
          `insert into core.principals (principal_id, tenant_id, kind, display_name, status)
           values ('${person.principalId}', '${input.tenantId}', '${kind}', 'P14 ${persona}', 'active')`,
        )
        .pipe(Effect.orDie);
      yield* admin
        .unsafe(
          `insert into core.principal_auth_bindings
             (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider,
              subject_type, provider_subject_id, status)
           values ('${person.authBindingId}', '${input.tenantId}', '${person.principalId}',
                   '${STAFF_AUTHENTICATION_NAMESPACE_ID}', 'fixture', 'user', 'seed-${persona}-${person.principalId}', 'active')`,
        )
        .pipe(Effect.orDie);
    }
    for (const moduleKey of input.moduleKeys) {
      yield* admin
        .unsafe(
          `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state)
           values (gen_random_uuid(), '${input.tenantId}', '${moduleKey}', 'active')`,
        )
        .pipe(Effect.orDie);
    }
  });

const insertMembership = (
  admin: PgClient.PgClient,
  input: {
    readonly holderColumn: 'agent_id' | 'principal_id';
    readonly kind: 'access_admin' | 'member' | 'owner';
    readonly principalId: string;
    readonly recordedBy: string;
    readonly scopeId: string;
    readonly status: 'active' | 'suspended';
    readonly tenantId: string;
    readonly validUntil?: string;
  },
) =>
  admin
    .unsafe(
      `insert into core.access_memberships
         (membership_id, tenant_id, scope_id, ${input.holderColumn}, kind, status, valid_from, valid_until, recorded_by)
       values (gen_random_uuid(), '${input.tenantId}', '${input.scopeId}', '${input.principalId}',
               '${input.kind}', '${input.status}', now() - interval '1 day',
               ${input.validUntil ?? 'null'}, '${input.recordedBy}')`,
    )
    .pipe(Effect.orDie);

const insertAssignment = (
  admin: PgClient.PgClient,
  input: {
    readonly assignedBy: string;
    readonly delegatedBy?: string;
    readonly delegationEnvelopeJson?: string;
    readonly holderColumn: 'agent_id' | 'principal_id';
    readonly incarnationId: string;
    readonly principalId: string;
    readonly roleId: string;
    readonly roleRevisionId: string;
    readonly scopeId: string;
    readonly tenantId: string;
    readonly validUntil?: string;
  },
) => {
  const delegatedBy = input.delegatedBy === undefined ? 'null' : `'${input.delegatedBy}'`;
  const envelope = input.delegationEnvelopeJson === undefined ? 'null' : `'${input.delegationEnvelopeJson}'::jsonb`;
  return admin
    .unsafe(
      `insert into core.access_assignments
         (incarnation_id, tenant_id, scope_id, ${input.holderColumn}, role_id, role_revision_id, status, assigned_by,
          valid_from, valid_until, delegated_by, delegation_envelope_json)
       values ('${input.incarnationId}', '${input.tenantId}', '${input.scopeId}', '${input.principalId}',
               '${input.roleId}', '${input.roleRevisionId}', 'active', '${input.assignedBy}',
               now() - interval '1 day', ${input.validUntil ?? 'null'}, ${delegatedBy}, ${envelope})`,
    )
    .pipe(Effect.orDie);
};

/** When the delegate's envelope, and so its assignment, ends. */
const DELEGATION_UNTIL = '2031-01-01T00:00:00.000Z';

/** One delegation of a scope: who granted it, who may use it, and the roles, people and cells it bounds. */
const insertDelegation = (
  admin: PgClient.PgClient,
  input: {
    readonly capabilityKeys: readonly string[];
    readonly delegationId: string;
    readonly grantedBy: string;
    readonly managerId: string;
    readonly people: readonly string[];
    readonly roleIds: readonly string[];
    readonly scopeId: string;
    readonly tenantId: string;
    readonly until: string;
  },
) =>
  admin
    .unsafe(
      `insert into core.access_delegations
         (delegation_id, tenant_id, scope_id, granted_by, manager_id, people, role_ids, capability_keys,
          can_redelegate, status, valid_from, until)
       values ('${input.delegationId}', '${input.tenantId}', '${input.scopeId}', '${input.grantedBy}',
               '${input.managerId}', '{${input.people.join(',')}}'::uuid[], '{${input.roleIds.join(',')}}'::uuid[],
               '{${input.capabilityKeys.join(',')}}'::text[], false, 'active', now() - interval '1 day',
               '${input.until}')`,
    )
    .pipe(Effect.orDie);

interface SeededRole {
  readonly roleId: string;
  readonly roleRevisionId: string;
}

/**
 * The company assignments the personas hold: the administrator role for the people, a propose-only
 * role for the agent, an ended one for `expiredAssignment`, and the delegate's, made by the company
 * administrator under the owner's delegation and ending with its envelope (D10b).
 */
const seedAssignments = (
  admin: PgClient.PgClient,
  input: {
    readonly adminKeys: readonly string[];
    readonly adminRole: SeededRole;
    readonly agentRole: SeededRole;
    readonly companyScopeId: string;
    readonly holderOf: (persona: Persona) => string;
    readonly ownerPrincipal: string;
    readonly tenantId: string;
  },
) =>
  Effect.gen(function* seedPersonaAssignments() {
    const crypto = yield* Crypto.Crypto;
    const assign = (persona: Persona, role: SeededRole, extra: Partial<Parameters<typeof insertAssignment>[1]>) =>
      Effect.gen(function* assignPersona() {
        yield* labelled(
          `assignment-${persona}`,
          insertAssignment(admin, {
            assignedBy: input.ownerPrincipal,
            holderColumn: holderColumnOf(persona),
            incarnationId: yield* crypto.randomUUIDv4(),
            principalId: input.holderOf(persona),
            roleId: role.roleId,
            roleRevisionId: role.roleRevisionId,
            scopeId: input.companyScopeId,
            tenantId: input.tenantId,
            ...extra,
          }),
        );
      });
    yield* assign('companyAdmin', input.adminRole, {});
    yield* assign('suspended', input.adminRole, {});
    yield* assign('expiredAssignment', input.adminRole, { validUntil: "now() - interval '1 hour'" });
    yield* assign('agent', input.agentRole, {});

    const delegationId = yield* crypto.randomUUIDv4();
    yield* labelled(
      'delegation',
      insertDelegation(admin, {
        capabilityKeys: input.adminKeys,
        delegationId,
        grantedBy: input.ownerPrincipal,
        managerId: input.holderOf('companyAdmin'),
        people: [input.holderOf('delegate')],
        roleIds: [input.adminRole.roleId],
        scopeId: input.companyScopeId,
        tenantId: input.tenantId,
        until: DELEGATION_UNTIL,
      }),
    );
    yield* assign('delegate', input.adminRole, {
      assignedBy: input.holderOf('companyAdmin'),
      delegatedBy: delegationId,
      delegationEnvelopeJson: jsonText({ capabilityKeys: input.adminKeys, delegationId, until: DELEGATION_UNTIL }),
      // A delegated assignment ends with its envelope (`access_assignments_envelope_ck`).
      validUntil: `'${DELEGATION_UNTIL}'`,
    });
  });

/** One role whose single revision carries exactly the named capabilities as `all` cells of one mode. */
const insertRole = (
  admin: PgClient.PgClient,
  input: {
    readonly capabilityKeys: readonly string[];
    readonly catalogSnapshotId: string;
    readonly createdBy: string;
    readonly mode: 'propose' | 'run';
    readonly name: string;
    readonly roleId: string;
    readonly roleRevisionId: string;
    readonly scopeId: string;
    readonly tenantId: string;
  },
) =>
  Effect.gen(function* insertRoleRows() {
    const cells = input.capabilityKeys.map((capabilityKey) => ({
      capabilityKey,
      mode: input.mode,
      selector: { _tag: 'all' as const },
    }));
    yield* admin
      .unsafe(
        `insert into core.access_roles (role_id, tenant_id, created_by, name)
         values ('${input.roleId}', '${input.tenantId}', '${input.createdBy}', '${input.name}')`,
      )
      .pipe(Effect.orDie);
    yield* admin
      .unsafe(
        `insert into core.access_role_revisions
           (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by, provenance)
         values ('${input.roleRevisionId}', '${input.tenantId}', '${input.roleId}', 1,
                 '${input.catalogSnapshotId}', '${jsonText(cells)}'::jsonb, '${input.createdBy}', 'manual')`,
      )
      .pipe(Effect.orDie);
    for (const cell of cells) {
      yield* admin
        .unsafe(
          `insert into core.access_grant_incarnations
             (grant_incarnation_id, tenant_id, scope_id, role_id, capability_key, mode, slot, cell_json, status)
           values (gen_random_uuid(), '${input.tenantId}', '${input.scopeId}', '${input.roleId}',
                   '${cell.capabilityKey}', '${cell.mode}', 'all', '${jsonText(cell)}'::jsonb, 'active')`,
        )
        .pipe(Effect.orDie);
    }
  });

// ---------------------------------------------------------------------------------------------
// Trusted scopes and the record projection
// ---------------------------------------------------------------------------------------------

const scopeIdOf = (admin: PgClient.PgClient, tenantId: string, legalEntityId?: string) =>
  admin
    .unsafe<{ readonly scope_id: string }>(
      legalEntityId === undefined
        ? `select scope_id from core.access_scopes
           where tenant_id = '${tenantId}' and tenant_context_id is not null`
        : `select scope_id from core.access_scopes
           where tenant_id = '${tenantId}' and legal_entity_id = '${legalEntityId}'`,
    )
    .pipe(
      Effect.map((rows) => rows[0]?.scope_id ?? ''),
      Effect.orDie,
    );

/** One trusted request scope: the acting principal, the tenant and, when given, the selected company. */
const scopeOf = (input: {
  readonly authBindingId: string;
  readonly legalEntityId?: string | undefined;
  readonly principalId: string;
  readonly tenantId: string;
}): Effect.Effect<OperationalScope> => {
  const session = {
    authBindingId: input.authBindingId,
    authContextRef: `session:p14:${input.principalId}`,
    // The staff namespace the Shell registers, so a real Shell composition admits this session.
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'session' as const,
    principalId: input.principalId,
    tenantId: input.tenantId,
  };
  return Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(
    input.legalEntityId === undefined ? session : { ...session, legalEntityId: input.legalEntityId },
  ).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-admin-real-gate' }) satisfies OperationalScope),
    Effect.orDie,
  );
};

const projectRecord = (
  client: v1.ZedClientInterface,
  input: {
    readonly moduleKey: string;
    readonly principalId: string;
    readonly recordKey: string;
    readonly scopeId: string;
    readonly tenantId: string;
  },
) =>
  Effect.gen(function* projectRecordRows() {
    const record = v1.ObjectReference.create({
      objectId: recordObjectId(input.tenantId, input.scopeId, input.moduleKey, input.recordKey),
      objectType: 'access_record',
    });
    const human = v1.ObjectReference.create({ objectId: input.principalId, objectType: 'access_human' });
    const scope = v1.ObjectReference.create({
      objectId: scopeObjectId(input.tenantId, input.scopeId),
      objectType: 'access_scope',
    });
    const touch = (relation: string, subject: v1.ObjectReference) =>
      v1.RelationshipUpdate.create({
        operation: v1.RelationshipUpdate_Operation.TOUCH,
        relationship: v1.Relationship.create({
          relation,
          resource: record,
          subject: v1.SubjectReference.create({ object: subject }),
        }),
      });
    yield* Effect.tryPromise(
      async () =>
        await client.promises.writeRelationships(
          v1.WriteRelationshipsRequest.create({ updates: [touch('assigned', human), touch('scope', scope)] }),
        ),
    ).pipe(Effect.orDie);
  });

// ---------------------------------------------------------------------------------------------
// The real access graph
// ---------------------------------------------------------------------------------------------

interface AccessGraph {
  readonly bootstrap: (typeof TenantAccessBootstrap)['Service'];
  readonly executor: CoreDatabaseExecutor;
  readonly memberships: (typeof AccessMembershipStore)['Service'];
  readonly project: (input: {
    readonly moduleKey: string;
    readonly principalId: string;
    readonly recordKey: string;
    readonly scopeId: string;
    readonly tenantId: string;
  }) => Effect.Effect<void>;
  readonly writer: (typeof AccessProjectionWriter)['Service'];
}

/**
 * The privileged graph a tenant bootstrap needs (`scripts/bootstrap-stage-accounts.mts` composes the
 * same one): one admin pool, one engine transport and the access writers behind `runAccessWrite`.
 */
export const buildAccessGraph = (input: { readonly adminUrl: string; readonly configuration: SpiceDbConfigValue }) =>
  Effect.gen(function* buildGraph() {
    const databaseConfiguration = yield* parseDatabaseConfig({ DATABASE_URL: input.adminUrl }).pipe(Effect.orDie);
    const database = CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, databaseConfiguration)));
    const engine = Layer.effect(
      AccessProjectionCompiler,
      Effect.acquireRelease(
        Effect.sync(() => makeAccessProjectionTransport(input.configuration)),
        (transport) => Effect.sync(() => transport.close()),
      ).pipe(Effect.map((transport) => makeAccessProjectionCompiler(transport))),
    );
    const platform = Layer.mergeAll(
      database,
      engine,
      makeDatabaseIdentityEnrollmentLive(SHELL_DATABASE_IDENTITY_ENROLLMENT),
    );
    const stores = Layer.mergeAll(
      TenantIntentLoaderLive,
      AccessWriteJournalStoreLive,
      AccessMembershipStoreLive,
      AccessChangesStoreLive,
    ).pipe(Layer.provide(platform));
    const catalog = AccessCatalogSnapshotWriterLive.pipe(Layer.provide(stores));
    const writer = AccessProjectionWriterLive.pipe(Layer.provide(Layer.mergeAll(stores, platform)));
    const bootstrap = TenantAccessBootstrapLive.pipe(Layer.provide(Layer.mergeAll(stores, platform, catalog, writer)));
    const context = yield* Layer.build(Layer.mergeAll(stores, platform, catalog, writer, bootstrap));
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => newSpiceDbGrpcClient(input.configuration)),
      (opened) => Effect.sync(() => opened.close()),
    );
    return {
      bootstrap: Context.get(context, TenantAccessBootstrap),
      executor: Context.get(context, CoreDatabase).executor,
      memberships: Context.get(context, AccessMembershipStore),
      project: (projection) => projectRecord(client, projection),
      writer: Context.get(context, AccessProjectionWriter),
    } satisfies AccessGraph;
  });

/**
 * The real gate over one case's intent and engine. `endpoint` decides which engine it can reach, so
 * "the engine is unavailable" is a real transport failure rather than a scripted answer (O48).
 */
const buildGateContext = (input: {
  readonly configuration: SpiceDbConfigValue;
  readonly executor: CoreDatabaseExecutor;
}) =>
  Effect.gen(function* buildGateService() {
    const transport = yield* Effect.acquireRelease(
      Effect.sync(() => makeAccessProjectionTransport(input.configuration)),
      (opened) => Effect.sync(() => opened.close()),
    );
    const compiler = makeAccessProjectionCompiler(transport);
    const base = Layer.mergeAll(
      Layer.succeed(CoreDatabase, { executor: input.executor }),
      makeDatabaseIdentityEnrollmentLive(SHELL_DATABASE_IDENTITY_ENROLLMENT),
      Layer.succeed(AccessProjectionCompiler, compiler),
      NodeServices.layer,
    );
    const intent = TenantIntentLoaderLive.pipe(Layer.provide(base));
    const stores = Layer.mergeAll(base, intent);
    // `AccessEnforcementPortsLive` with its engine port bound to this case's endpoint instead of the environment's.
    const check = Layer.effect(
      DecisionCheck,
      Effect.acquireRelease(
        Effect.sync(() => spiceDbTransport.open(input.configuration, SPICEDB_CHECK_TIMEOUT_MS)),
        (rpc) => Effect.sync(() => rpc.close()),
      ).pipe(Effect.map(enginePortOf)),
    );
    const ports = Layer.mergeAll(
      AccessIntentLive,
      AccessDecisionLogLive,
      AccessPrincipalKindSourceLive,
      LegalEntityCandidatesLive,
      check,
      AccessWorkloadBindingSourceLive,
    );
    const enforcement = AccessDecisionLive.pipe(Layer.provideMerge(ports), Layer.provide(stores));
    return yield* Layer.build(Layer.mergeAll(stores, enforcement));
  });

export const buildGate = (input: Parameters<typeof buildGateContext>[0]) =>
  buildGateContext(input).pipe(Effect.map((context) => Context.get(context, AccessDecisionGate)));

/** Action execution prepares remote evidence before entering its transaction, then joins that transaction. */
export const buildActionGate = (input: Parameters<typeof buildGateContext>[0]) =>
  buildGateContext(input).pipe(
    Effect.flatMap((context) => bindLiveActionAccessGate.pipe(Effect.provideContext(context))),
  );

const loadCatalog = Effect.gen(function* loadPublishedCatalog() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const artifactPath = yield* path.fromFileUrl(catalogArtifactPath);
  const source = yield* fileSystem.readFileString(artifactPath);
  const artifact = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ modules: AccessCatalogModulesSchema, schemaVersion: Schema.Number })),
  )(source);
  return artifact.modules;
}).pipe(Effect.mapError(() => fixtureFailure('The published authorization catalog artifact could not be read')));

/** Every declaration of the published release, keyed the way the gate asks for it. */
export type PublishedDeclaration = AccessDeclaration;

/** Decodes every published declaration into the branded form the gate carries (the artifact holds the encoded form). */
const declarationsOf = (catalog: readonly AccessCatalogModule[]) =>
  Effect.gen(function* decodeDeclarations() {
    const declarations = new Map<string, PublishedDeclaration>();
    for (const module of catalog) {
      for (const descriptor of module.descriptors) {
        const input = descriptor.accessDeclaration;
        if (input !== undefined) {
          const declaration = yield* Schema.decodeUnknownEffect(AccessDeclarationSchema)(input).pipe(Effect.orDie);
          declarations.set(declaration.key, declaration);
        }
      }
    }
    return declarations;
  });

const legalEntityScopeOf = (declaration: PublishedDeclaration) => shellLegalEntityScope(declaration);

interface QuestionContext {
  readonly companyA: string | undefined;
  readonly declarations: ReadonlyMap<string, PublishedDeclaration>;
  readonly scopeFor: (persona: Persona, legalEntityId?: string) => Effect.Effect<OperationalScope>;
}

/** Asks the real gate one declaration question, the way the Shell entrypoint asks it. */
const askWith = (gate: AccessDecisionService, context: QuestionContext) => (input: DeclarationQuestion) =>
  Effect.gen(function* askQuestion() {
    const declaration = context.declarations.get(input.declarationKey);
    if (declaration === undefined) {
      return yield* Effect.die(new Error(`The published catalog does not declare ${input.declarationKey}`));
    }
    const tenantContext = input.scope !== 'legal-entity';
    const legalEntityId = tenantContext ? undefined : (input.legalEntityId ?? context.companyA);
    const decision = yield* gate.decide({
      carrier: { accessDeclaration: declaration },
      // A company question is a company operation: its entrypoint requires the company it names.
      legalEntityScope: tenantContext ? legalEntityScopeOf(declaration) : 'required',
      now: DECISION_AT,
      scope: yield* context.scopeFor(input.persona, legalEntityId),
    });
    return {
      outcome: decision.outcome,
      reasonCodes: decision.reasons.map((reason) => reason.code),
    } satisfies GateAnswer;
  });

const adminCapabilityKeysOf = (declarations: ReadonlyMap<string, PublishedDeclaration>) =>
  [...declarations.values()]
    .filter((declaration) => declaration.kind === 'admin')
    .map((declaration) => declaration.key);

const seedsOf = Effect.gen(function* makePersonaSeeds() {
  const crypto = yield* Crypto.Crypto;
  const seeds = new Map<Persona, SeedPerson>();
  for (const persona of PERSONAS) {
    seeds.set(persona, {
      authBindingId: yield* crypto.randomUUIDv4(),
      principalId: yield* crypto.randomUUIDv4(),
    });
  }
  return seeds;
});

/**
 * One case: its own cloned database, its own tenant, the real bootstrap, the seeded personas and the
 * real gate — asked here, and by nothing in this fixture, with a scripted answer.
 */
export const withAccessAdminCase = <Value, Failure>(
  run: (accessCase: AccessAdminCase) => Effect.Effect<Value, Failure>,
) =>
  Effect.scoped(
    Effect.gen(function* accessAdminCase() {
      const crypto = yield* Crypto.Crypto;
      const catalog = yield* loadCatalog;
      const declarations = yield* declarationsOf(catalog);
      const seedSuffix = (yield* crypto.randomUUIDv4()).replaceAll('-', '');
      const tenantId = yield* crypto.randomUUIDv4();
      const foreignTenantId = yield* crypto.randomUUIDv4();
      const companies = [yield* crypto.randomUUIDv4(), yield* crypto.randomUUIDv4()];
      const foreignCompanies = [yield* crypto.randomUUIDv4()];
      const personas = yield* seedsOf;
      const foreignPersonas = yield* seedsOf;
      const [companyA, companyB] = companies;

      const caseDatabase = `${CASE_DATABASE_PREFIX}${seedSuffix}`;
      const adminUrl = yield* serverAdminUrl;
      yield* ensureTemplate;
      const server = yield* makeClient(adminUrl, 1);
      yield* cloneDatabase(server, caseDatabase);
      yield* Effect.addFinalizer(() => dropDatabase(server, caseDatabase));
      const caseAdminUrl = replacedDatabase(adminUrl, caseDatabase);
      const admin = yield* makeClient(caseAdminUrl, 2);
      const databases = yield* parseDatabaseConnectionPair({
        DATABASE_ADMIN_URL: caseAdminUrl,
        DATABASE_URL: replacedDatabase((yield* serverConnections).runtime.connectionString, caseDatabase),
      }).pipe(Effect.orDie);

      const configuration = yield* loadSpiceDbConfig().pipe(
        Effect.mapError(() => fixtureFailure('The integration SpiceDB configuration is unavailable')),
      );
      yield* writeEngineSchema(configuration);

      const graph = yield* buildAccessGraph({ adminUrl: caseAdminUrl, configuration });
      const moduleKeys = catalog.map((module) => module.moduleId);
      yield* labelled(
        'seed-tenant',
        seedTenant(admin, { companies, moduleKeys, personas, slug: `p14-${seedSuffix}`, tenantId }),
      );
      yield* labelled(
        'seed-foreign-tenant',
        seedTenant(admin, {
          companies: foreignCompanies,
          moduleKeys,
          personas: foreignPersonas,
          slug: `p14-foreign-${seedSuffix}`,
          tenantId: foreignTenantId,
        }),
      );

      const scopeFor = (persona: Persona, legalEntityId?: string) =>
        scopeOf({
          authBindingId: (persona === 'foreignOwner' ? foreignPersonas : personas).get(persona)?.authBindingId ?? '',
          legalEntityId,
          principalId: (persona === 'foreignOwner' ? foreignPersonas : personas).get(persona)?.principalId ?? '',
          tenantId: persona === 'foreignOwner' ? foreignTenantId : tenantId,
        });
      const companyScopeIdFor = (legalEntityId?: string) => scopeIdOf(admin, tenantId, legalEntityId);

      const ownerBootstrap = yield* labelled(
        'bootstrap-owner',
        graph.bootstrap.bootstrapTenantAccess({
          legalEntityIds: companies.map((company) => LegalEntityIdSchema.make(company)),
          modules: catalog,
          scope: yield* scopeFor('owner'),
        }),
      );
      yield* labelled(
        'bootstrap-foreign-owner',
        graph.bootstrap.bootstrapTenantAccess({
          legalEntityIds: foreignCompanies.map((company) => LegalEntityIdSchema.make(company)),
          modules: catalog,
          scope: yield* scopeFor('foreignOwner'),
        }),
      );

      const companyScopeId = yield* companyScopeIdFor(companyA);
      const secondCompanyScopeId = yield* companyScopeIdFor(companyB);
      const tenantContextScopeId = yield* companyScopeIdFor();
      const adminKeys = adminCapabilityKeysOf(declarations);
      const ownerPrincipal = personas.get('owner')?.principalId ?? '';
      const holderOf = (persona: Persona) => personas.get(persona)?.principalId ?? '';

      const adminRoleId = yield* crypto.randomUUIDv4();
      const adminRoleRevisionId = yield* crypto.randomUUIDv4();
      yield* labelled(
        'insert-role',
        insertRole(admin, {
          capabilityKeys: adminKeys,
          catalogSnapshotId: ownerBootstrap.catalogSnapshotId,
          createdBy: ownerPrincipal,
          mode: 'run',
          name: 'P14 company administrator',
          roleId: adminRoleId,
          roleRevisionId: adminRoleRevisionId,
          scopeId: companyScopeId,
          tenantId,
        }),
      );
      // An agent may only ever propose a sensitive capability (O48a), and every admin one is sensitive.
      const agentRoleId = yield* crypto.randomUUIDv4();
      const agentRoleRevisionId = yield* crypto.randomUUIDv4();
      yield* labelled(
        'insert-agent-role',
        insertRole(admin, {
          capabilityKeys: adminKeys.filter((key) => declarations.get(key)?.modes.includes('propose') === true),
          catalogSnapshotId: ownerBootstrap.catalogSnapshotId,
          createdBy: ownerPrincipal,
          mode: 'propose',
          name: 'P14 agent proposer',
          roleId: agentRoleId,
          roleRevisionId: agentRoleRevisionId,
          scopeId: companyScopeId,
          tenantId,
        }),
      );

      for (const persona of PERSONAS) {
        if (persona === 'owner' || persona === 'foreignOwner' || persona === 'workload') {
          continue;
        }
        // A company decision rests on live `member` rows in the tenant and in the company (D6, M2); a
        // suspension is the tenant's, and it outranks every company membership and assignment.
        for (const scopeId of [tenantContextScopeId, companyScopeId]) {
          yield* labelled(
            `membership-${persona}`,
            insertMembership(admin, {
              holderColumn: holderColumnOf(persona),
              kind: 'member',
              principalId: holderOf(persona),
              recordedBy: ownerPrincipal,
              scopeId,
              status: persona === 'suspended' && scopeId === tenantContextScopeId ? 'suspended' : 'active',
              tenantId,
            }),
          );
        }
        // Only the company administrator manages the company; every other holder's power is its assignment.
        if (persona === 'companyAdmin') {
          yield* labelled(
            `access-admin-membership-${persona}`,
            insertMembership(admin, {
              holderColumn: 'principal_id',
              kind: 'access_admin',
              principalId: holderOf(persona),
              recordedBy: ownerPrincipal,
              scopeId: companyScopeId,
              status: 'active',
              tenantId,
            }),
          );
        }
        if (persona === 'member') {
          yield* labelled(
            'membership-member-second-company',
            insertMembership(admin, {
              holderColumn: 'principal_id',
              kind: 'member',
              principalId: holderOf(persona),
              recordedBy: ownerPrincipal,
              scopeId: secondCompanyScopeId,
              status: 'active',
              tenantId,
            }),
          );
        }
      }

      yield* seedAssignments(admin, {
        adminKeys,
        adminRole: { roleId: adminRoleId, roleRevisionId: adminRoleRevisionId },
        agentRole: { roleId: agentRoleId, roleRevisionId: agentRoleRevisionId },
        companyScopeId,
        holderOf,
        ownerPrincipal,
        tenantId,
      });

      // One reconcile of the tenant through the single Core writer, exactly as a command would.
      yield* labelled('reconcile', graph.writer.reconcileTenant({ scope: yield* scopeFor('owner') }));

      const live = yield* labelled('gate', buildGate({ configuration, executor: graph.executor }));
      const dead = yield* labelled(
        'gate-unavailable',
        buildGate({
          configuration: { ...configuration, endpoint: UNREACHABLE_SPICEDB_ENDPOINT },
          executor: graph.executor,
        }),
      );

      const questionContext: QuestionContext = { companyA, declarations, scopeFor };

      const identifiers = new Map<Persona, AccessAdminIdentifiers>();
      for (const persona of PERSONAS) {
        identifiers.set(persona, {
          authBindingId: personas.get(persona)?.authBindingId ?? '',
          principalId: holderOf(persona),
        });
      }

      return yield* run({
        admin,
        catalog,
        companies,
        databases,
        decide: askWith(live, questionContext),
        decideUnavailable: askWith(dead, questionContext),
        declarations,
        ids: identifiers,
        scopeFor,
        scopeIdOf: companyScopeIdFor,
        shellAdminDeclarations: [...declarations.values()].filter(
          (declaration) => declaration.kind === 'admin' && declaration.key.startsWith('core.shell.'),
        ),
        tenantId,
        writeRecord: (projection) =>
          companyScopeIdFor(companyA).pipe(
            Effect.flatMap((scopeId) =>
              graph.project({
                moduleKey: projection.moduleKey,
                principalId: holderOf(projection.persona),
                recordKey: projection.recordKey,
                scopeId,
                tenantId,
              }),
            ),
          ),
      });
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
