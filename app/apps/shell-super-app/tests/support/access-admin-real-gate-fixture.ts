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
import type {
  AccessDeclaration,
  ActiveApplicationCompositionSnapshot,
  DatabaseConnectionPair,
  TrustedPrincipalContext,
} from '@app/core-runtime';
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

import type { AuthenticationService, AuthenticationServiceContract } from '../../api/auth/service.ts';
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

/**
 * The fixed template the full-catalog authority suites still clone by name (`templateDatabaseLayer`).
 * Every process that builds it first drops it, so two sessions running those suites against one
 * PostgreSQL server can still destroy each other's template.
 */
const SHARED_TEMPLATE_DATABASE = 'p14_access_admin_template';
/**
 * This process's own template (`accessAdminTemplateLayer`): no other session can drop it while a case
 * clones it, and the layer drops it when the suite ends.
 */
export const ACCESS_ADMIN_TEMPLATE_DATABASE = `${SHARED_TEMPLATE_DATABASE}_${process.pid}_${globalThis.crypto.randomUUID().slice(0, 8)}`;
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
  /** An active human of the company directory in companies A and B with no access membership: admissible. */
  'directoryMember',
  /** A person whose company-A directory row is 'departed': never admissible. */
  'departed',
  /**
   * A person whose tenant `member` row expired (still `active`) while the company-B row and a B
   * assignment stay active: a fresh tenant row would revive that B authority (skeptic S1).
   */
  'lapsed',
  /**
   * A delegated manager of company A and nothing more: the owner's delegation names the tasks role,
   * the plain member and the Lidé keys, including admit-member and end-membership. It also holds the
   * tasks role itself and a place in company A's team, so ending them has something to close.
   */
  'manager',
] as const;
export type Persona = (typeof PERSONAS)[number];

/** The one capability the seeded tasks roles grant: a routine page read, decided by role cells. */
export const TASKS_CAPABILITY_KEY = 'work.tasks.page-work-tasks-home.read';

/** The Lidé keys of the seeded manager's delegation (the release publishes none of them). */
const MANAGER_DELEGATED_PEOPLE_KEYS = [
  'shell-super-app.access-people.list',
  'shell-super-app.access-people.options',
  'shell-super-app.access-people.assign',
  'shell-super-app.access-people.revoke-assignment',
  'shell-super-app.access-people.admit-member',
  'shell-super-app.access-people.end-membership',
] as const;

export interface AccessAdminIdentifiers {
  readonly authBindingId: string;
  readonly principalId: string;
}

/** One seeded role: its id and the single revision it carries. */
export interface SeededRole {
  readonly roleId: string;
  readonly roleRevisionId: string;
}

/** The intent rows the people-write scenarios act on, by their identities. */
export interface SeededPeopleIntent {
  /** The company-A administrator role (every published admin capability) held by companyAdmin. */
  readonly adminRole: SeededRole;
  /** The delegation of the manager persona (granted by the owner, written by fixture SQL). */
  readonly managerDelegationId: string;
  /** The manager's own, non-delegated tasks assignment in company A. */
  readonly managerTasksAssignmentId: string;
  /** A company-A role whose one cell is `TASKS_CAPABILITY_KEY`. */
  readonly tasksRoleA: SeededRole;
  /** The same cell as a company-B role; the lapsed person holds it in B. */
  readonly tasksRoleB: SeededRole;
  /** Company A's team; the manager holds a place in it. */
  readonly teamId: string;
}

/**
 * One gate question, asked the way a Shell entrypoint asks it: the declaration the entrypoint ships,
 * its declared scope and the trusted request scope (O66).
 */
export interface DeclarationQuestion {
  /**
   * A declaration the release does not publish but a Shell entrypoint ships (the Lidé keys): the gate
   * decides it exactly as that entrypoint asks it. Without it, `declarationKey` names a published one.
   */
  readonly declaration?: AccessDeclaration;
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
  /** The foreign tenant's own principals (its owner and its directory member among them). */
  /** The foreign tenant's own companies. */
  readonly foreignCompanies: readonly string[];
  readonly foreignIds: ReadonlyMap<Persona, AccessAdminIdentifiers>;
  readonly foreignTenantId: string;
  /** The real gate itself, for code under test that asks the gate through its own service (O62). */
  readonly gate: AccessDecisionService;
  readonly ids: ReadonlyMap<Persona, AccessAdminIdentifiers>;
  /** The trusted request scope of one persona (O66), for intent a scenario writes itself. */
  readonly scopeFor: (persona: Persona, legalEntityId?: string) => Effect.Effect<OperationalScope>;
  /** The scope id of one company, or of the tenant context when omitted. */
  readonly scopeIdOf: (legalEntityId?: string) => Effect.Effect<string>;
  readonly seeded: SeededPeopleIntent;
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
  admin.unsafe(`create database "${database}" template "${ACCESS_ADMIN_TEMPLATE_DATABASE}"`).pipe(Effect.orDie);

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

const prepareTemplateDatabase = (name: string) =>
  Effect.gen(function* prepareTemplate() {
    const adminUrl = yield* serverAdminUrl;
    const admin = yield* makeClient(adminUrl, 1);
    yield* dropDatabase(admin, name);
    yield* admin.unsafe(`create database "${name}"`).pipe(Effect.orDie);
    const template = yield* makeClient(replacedDatabase(adminUrl, name), 1);
    yield* buildTemplateDatabase(template);
  }).pipe(
    Effect.scoped,
    Effect.tapCause((cause) => Effect.logError('P14 template database failed', cause)),
    Effect.provide(NodeServices.layer),
    Effect.orDie,
  );

const dropTemplateDatabase = (name: string) =>
  Effect.gen(function* dropTemplate() {
    yield* dropDatabase(yield* makeClient(yield* serverAdminUrl, 1), name);
  }).pipe(Effect.scoped);

/** The shared, fixed-name template of the full-catalog authority suites, which clone it by that name. */
export const templateDatabaseLayer = Layer.effectDiscard(prepareTemplateDatabase(SHARED_TEMPLATE_DATABASE));

/** Whether this process's own template exists: `withAccessAdminCase` clones nothing else. */
let accessAdminTemplateReady = false;

/**
 * The suite-scoped template every `withAccessAdminCase` clones: built once before the cases, on the
 * suite's deadline, and dropped when the suite ends so no template outlives its process.
 */
export const accessAdminTemplateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    prepareTemplateDatabase(ACCESS_ADMIN_TEMPLATE_DATABASE).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          accessAdminTemplateReady = true;
        }),
      ),
    ),
    () =>
      Effect.sync(() => {
        accessAdminTemplateReady = false;
      }).pipe(Effect.andThen(dropTemplateDatabase(ACCESS_ADMIN_TEMPLATE_DATABASE))),
  ),
);

const requireTemplate = Effect.suspend(() =>
  accessAdminTemplateReady
    ? Effect.void
    : Effect.die(new Error('A suite that runs withAccessAdminCase provides accessAdminTemplateLayer')),
);

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

/** One row of the company directory (`core.principal_company_memberships`), which admission reads. */
const insertDirectoryMember = (
  admin: PgClient.PgClient,
  input: {
    readonly legalEntityId: string;
    readonly principalId: string;
    readonly status: 'active' | 'departed';
    readonly tenantId: string;
  },
) =>
  admin
    .unsafe(
      `insert into core.principal_company_memberships (tenant_id, legal_entity_id, principal_id, affiliation, status)
       values ('${input.tenantId}', '${input.legalEntityId}', '${input.principalId}', 'employee', '${input.status}')`,
    )
    .pipe(Effect.orDie);

const insertTeam = (
  admin: PgClient.PgClient,
  input: {
    readonly createdBy: string;
    readonly memberId: string;
    readonly principalId: string;
    readonly scopeId: string;
    readonly teamId: string;
    readonly tenantId: string;
  },
) =>
  Effect.gen(function* insertTeamRows() {
    yield* admin
      .unsafe(
        `insert into core.access_teams (team_id, tenant_id, scope_id, name, created_by)
         values ('${input.teamId}', '${input.tenantId}', '${input.scopeId}', 'P14 team', '${input.createdBy}')`,
      )
      .pipe(Effect.orDie);
    yield* admin
      .unsafe(
        `insert into core.access_team_members (team_member_id, tenant_id, team_id, principal_id, added_at, added_by)
         values ('${input.memberId}', '${input.tenantId}', '${input.teamId}', '${input.principalId}', now(),
                 '${input.createdBy}')`,
      )
      .pipe(Effect.orDie);
  });

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
    /** The company the role lives in (O7); without it the role is the tenant context's. */
    readonly legalEntityId?: string;
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
    const legalEntityId = input.legalEntityId === undefined ? 'null' : `'${input.legalEntityId}'`;
    yield* admin
      .unsafe(
        `insert into core.access_roles (role_id, tenant_id, created_by, name, legal_entity_id)
         values ('${input.roleId}', '${input.tenantId}', '${input.createdBy}', '${input.name}', ${legalEntityId})`,
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
    const declaration = input.declaration ?? context.declarations.get(input.declarationKey);
    if (declaration === undefined || declaration.key !== input.declarationKey) {
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

const identifiersOf = (seeds: PersonaSeeds): ReadonlyMap<Persona, AccessAdminIdentifiers> =>
  new Map(PERSONAS.map((persona) => [persona, { ...(seeds.get(persona) ?? { authBindingId: '', principalId: '' }) }]));

/** The personas holding live `member` rows in the tenant context and company A (the suspended one's tenant row aside). */
const SEEDED_MEMBERS: ReadonlySet<Persona> = new Set<Persona>([
  'agent',
  'companyAdmin',
  'delegate',
  'expiredAssignment',
  'manager',
  'member',
  'suspended',
]);

/**
 * What admission and ending act on, beside the gate personas: the company directory (`core.principal_company_memberships`,
 * which nothing else here seeds), the lapsed person, a tasks role in each company, company A's team, and
 * the manager's delegation.
 *
 * The manager's delegation names `admit-member` and `end-membership`. No command can write that:
 * `grantDelegation` refuses a key the release does not publish (`delegation_unknown_capability`), and
 * no release publishes the Lidé keys. It is written here by SQL, because it is the only way to prove
 * that Core's own permanent-basis check refuses a delegate the gate may admit.
 */
const seedPeopleIntent = (
  admin: PgClient.PgClient,
  input: {
    readonly adminRole: SeededRole;
    readonly catalogSnapshotId: string;
    readonly companyA: string;
    readonly companyB: string;
    readonly companyScopeId: string;
    readonly foreignCompany: string;
    readonly foreignHolderOf: (persona: Persona) => string;
    readonly foreignTenantId: string;
    readonly holderOf: (persona: Persona) => string;
    readonly ownerPrincipal: string;
    readonly secondCompanyScopeId: string;
    readonly tenantContextScopeId: string;
    readonly tenantId: string;
  },
) =>
  Effect.gen(function* seedPeopleIntentRows() {
    const crypto = yield* Crypto.Crypto;
    const { companyA, companyB, holderOf, tenantId } = input;
    const directory: readonly (readonly [Persona, string, 'active' | 'departed'])[] = [
      ['owner', companyA, 'active'],
      ['owner', companyB, 'active'],
      ['companyAdmin', companyA, 'active'],
      ['delegate', companyA, 'active'],
      ['member', companyA, 'active'],
      ['member', companyB, 'active'],
      ['suspended', companyA, 'active'],
      ['expiredAssignment', companyA, 'active'],
      ['manager', companyA, 'active'],
      ['directoryMember', companyA, 'active'],
      ['directoryMember', companyB, 'active'],
      ['departed', companyA, 'departed'],
      ['lapsed', companyA, 'active'],
      ['lapsed', companyB, 'active'],
    ];
    for (const [persona, legalEntityId, status] of directory) {
      yield* insertDirectoryMember(admin, { legalEntityId, principalId: holderOf(persona), status, tenantId });
    }
    yield* insertDirectoryMember(admin, {
      legalEntityId: input.foreignCompany,
      principalId: input.foreignHolderOf('directoryMember'),
      status: 'active',
      tenantId: input.foreignTenantId,
    });

    // The lapsed person: the tenant row ended an hour ago but still reads `active`; company B is live.
    yield* insertMembership(admin, {
      holderColumn: 'principal_id',
      kind: 'member',
      principalId: holderOf('lapsed'),
      recordedBy: input.ownerPrincipal,
      scopeId: input.tenantContextScopeId,
      status: 'active',
      tenantId,
      validUntil: "now() - interval '1 hour'",
    });
    yield* insertMembership(admin, {
      holderColumn: 'principal_id',
      kind: 'member',
      principalId: holderOf('lapsed'),
      recordedBy: input.ownerPrincipal,
      scopeId: input.secondCompanyScopeId,
      status: 'active',
      tenantId,
    });

    const tasksRole = (legalEntityId: string, scopeId: string, name: string) =>
      Effect.gen(function* insertTasksRole() {
        const role: SeededRole = {
          roleId: yield* crypto.randomUUIDv4(),
          roleRevisionId: yield* crypto.randomUUIDv4(),
        };
        yield* insertRole(admin, {
          capabilityKeys: [TASKS_CAPABILITY_KEY],
          catalogSnapshotId: input.catalogSnapshotId,
          createdBy: input.ownerPrincipal,
          legalEntityId,
          mode: 'run',
          name,
          ...role,
          scopeId,
          tenantId,
        });
        return role;
      });
    const tasksRoleA = yield* tasksRole(companyA, input.companyScopeId, 'P14 tasks A');
    const tasksRoleB = yield* tasksRole(companyB, input.secondCompanyScopeId, 'P14 tasks B');

    const managerTasksAssignmentId = yield* crypto.randomUUIDv4();
    yield* insertAssignment(admin, {
      assignedBy: input.ownerPrincipal,
      holderColumn: 'principal_id',
      incarnationId: managerTasksAssignmentId,
      principalId: holderOf('manager'),
      roleId: tasksRoleA.roleId,
      roleRevisionId: tasksRoleA.roleRevisionId,
      scopeId: input.companyScopeId,
      tenantId,
    });
    yield* insertAssignment(admin, {
      assignedBy: input.ownerPrincipal,
      holderColumn: 'principal_id',
      incarnationId: yield* crypto.randomUUIDv4(),
      principalId: holderOf('lapsed'),
      roleId: tasksRoleB.roleId,
      roleRevisionId: tasksRoleB.roleRevisionId,
      scopeId: input.secondCompanyScopeId,
      tenantId,
    });

    const teamId = yield* crypto.randomUUIDv4();
    yield* insertTeam(admin, {
      createdBy: input.ownerPrincipal,
      memberId: yield* crypto.randomUUIDv4(),
      principalId: holderOf('manager'),
      scopeId: input.companyScopeId,
      teamId,
      tenantId,
    });

    const managerDelegationId = yield* crypto.randomUUIDv4();
    yield* insertDelegation(admin, {
      capabilityKeys: [TASKS_CAPABILITY_KEY, ...MANAGER_DELEGATED_PEOPLE_KEYS],
      delegationId: managerDelegationId,
      grantedBy: input.ownerPrincipal,
      managerId: holderOf('manager'),
      people: [holderOf('member')],
      roleIds: [tasksRoleA.roleId],
      scopeId: input.companyScopeId,
      tenantId,
      until: DELEGATION_UNTIL,
    });

    return {
      adminRole: input.adminRole,
      managerDelegationId,
      managerTasksAssignmentId,
      tasksRoleA,
      tasksRoleB,
      teamId,
    } satisfies SeededPeopleIntent;
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
      yield* requireTemplate;
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

      // Scoped intent is persisted as the enrolled runtime identity; the CI admin login only seeds rows.
      const graph = yield* buildAccessGraph({ adminUrl: databases.runtime.connectionString, configuration });
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
        if (!SEEDED_MEMBERS.has(persona)) {
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

      const seeded = yield* labelled(
        'seed-people-intent',
        seedPeopleIntent(admin, {
          adminRole: { roleId: adminRoleId, roleRevisionId: adminRoleRevisionId },
          catalogSnapshotId: ownerBootstrap.catalogSnapshotId,
          companyA: companyA ?? '',
          companyB: companyB ?? '',
          companyScopeId,
          foreignCompany: foreignCompanies[0] ?? '',
          foreignHolderOf: (persona) => foreignPersonas.get(persona)?.principalId ?? '',
          foreignTenantId,
          holderOf,
          ownerPrincipal,
          secondCompanyScopeId,
          tenantContextScopeId,
          tenantId,
        }),
      );

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

      return yield* run({
        admin,
        catalog,
        companies,
        databases,
        decide: askWith(live, questionContext),
        decideUnavailable: askWith(dead, questionContext),
        declarations,
        foreignCompanies,
        foreignIds: identifiersOf(foreignPersonas),
        foreignTenantId,
        gate: live,
        ids: identifiersOf(personas),
        scopeFor,
        scopeIdOf: companyScopeIdFor,
        seeded,
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

// ---------------------------------------------------------------------------------------------
// The production Shell API over one case
// ---------------------------------------------------------------------------------------------

/** One answer of the Shell API: the HTTP status and the body as sent. */
export interface ShellHttpAnswer {
  readonly status: number;
  readonly text: string;
}

export interface ShellHttpRequest {
  /** The `idempotency-key` header every access write carries. */
  readonly idempotencyKey?: string;
  /**
   * The company the persona's session has selected, as the Shell's company switcher records it; without
   * it the session stays in the tenant context.
   */
  readonly legalEntityId?: string;
  readonly path: string;
  readonly payload: unknown;
  /** The signed-in persona; a request without one has no session at all. */
  readonly persona?: Persona;
  /** A request the Shell's own page sends (`sec-fetch-site: same-origin`), as its origin-checked writes require. */
  readonly sameOrigin?: boolean;
}

export interface ShellHttp {
  /** A GET of the Shell API: the payload is ignored. */
  readonly get: (request: Omit<ShellHttpRequest, 'payload'>) => Effect.Effect<ShellHttpAnswer>;
  readonly post: (request: ShellHttpRequest) => Effect.Effect<ShellHttpAnswer>;
}

const PERSONA_HEADER = 'x-p14-persona';
const LEGAL_ENTITY_HEADER = 'x-p14-legal-entity';

/** The session one persona holds, in the tenant context or with one company selected. */
const sessionKey = (persona: string, legalEntityId: string | null | undefined) =>
  legalEntityId === undefined || legalEntityId === null || legalEntityId === ''
    ? persona
    : `${persona}@${legalEntityId}`;

/** Every persona that signs in; the workload is never a Shell session. */
const SIGNED_IN: readonly Persona[] = PERSONAS.filter((persona) => persona !== 'workload');

const unsupportedSession = (operation: string) =>
  Effect.die(new Error(`${operation} is not part of the access administration suites`));

/** Signs in whichever seeded persona the request header names; every other session method is unused. */
const personaAuthentication = (
  authenticationService: typeof AuthenticationService,
  principals: ReadonlyMap<string, TrustedPrincipalContext>,
) => {
  const service: AuthenticationServiceContract = {
    availableTenants: () => unsupportedSession('availableTenants'),
    createFixtureUser: () => unsupportedSession('createFixtureUser'),
    currentSession: () => unsupportedSession('currentSession'),
    resolveDocumentContext: () => unsupportedSession('resolveDocumentContext'),
    // The same persona as `resolveTenantContext`, as the Shell surfaces that resolve a full shell session read it: with
    // a company selected the session is `authenticated` in that company, otherwise it stays in the tenant context.
    resolveShellContext: (headers) => {
      const principal = principals.get(sessionKey(headers.get(PERSONA_HEADER) ?? '', headers.get(LEGAL_ENTITY_HEADER)));
      if (principal === undefined) {
        return Effect.succeed({ setCookieHeaders: [], state: 'anonymous' as const });
      }
      const identity = {
        displayName: 'P14 person',
        email: 'p14@example.test',
        principalId: principal.principalId,
        tenantId: principal.tenantId,
      };
      const { legalEntityId } = principal;
      return Effect.succeed(
        legalEntityId === undefined
          ? {
              availableLegalEntities: [],
              identity,
              principal,
              setCookieHeaders: [],
              state: 'tenant_authenticated' as const,
            }
          : {
              availableLegalEntities: [{ legalEntityId, legalName: 'P14 company' }],
              identity: { ...identity, legalEntityId, legalName: 'P14 company' },
              principal,
              setCookieHeaders: [],
              state: 'authenticated' as const,
            },
      );
    },
    resolveTenantContext: (headers) => {
      const principal = principals.get(sessionKey(headers.get(PERSONA_HEADER) ?? '', headers.get(LEGAL_ENTITY_HEADER)));
      return Effect.succeed(
        principal === undefined
          ? { setCookieHeaders: [], state: 'anonymous' as const }
          : {
              identity: {
                displayName: 'P14 person',
                email: 'p14@example.test',
                principalId: principal.principalId,
                tenantId: principal.tenantId,
              },
              principal,
              setCookieHeaders: [],
              state: 'authenticated' as const,
            },
      );
    },
    signIn: () => unsupportedSession('signIn'),
    signOut: () => unsupportedSession('signOut'),
    switchLegalEntity: () => unsupportedSession('switchLegalEntity'),
    switchTenant: () => unsupportedSession('switchTenant'),
    switchToTenantContext: () => unsupportedSession('switchToTenantContext'),
  };
  return Layer.succeed(authenticationService, service);
};

/**
 * The Shell API runtime `api/index.ts` builds for production, over this case's database and the
 * integration SpiceDB, mounted as the browser reaches it. Nothing here chooses a gate: the access
 * decision layer, the Lidé and Novinky ship gates and every store are the composition's own, so a
 * suite driving writes through it goes red the moment the composition ships them closed.
 *
 * The signed-in person is the one thing it supplies itself: `resolveTenantContext` answers the
 * persona a request header names with that persona's seeded principal, in the tenant context or with
 * the company a second header names selected, because authentication is not what these suites test.
 *
 * `api/index.ts` is loaded on first use, so the suites that only need the gate never load the Shell.
 */
export const shellHttpFor = Effect.fn('AccessAdminFixture.shellHttp')(function* shellHttp(
  accessCase: AccessAdminCase,
  /** The installed release a surface reads its module catalog from (a deployed Shell loads it from the composition). */
  installed?: ActiveApplicationCompositionSnapshot,
  /**
   * `frame`: also pin the Shell's own read authority to that release, so the Shell's governed reads (composition, module
   * target) are admitted end to end; the suite then writes the release's active authority row itself.
   */
  serves?: 'frame',
) {
  const [shell, authentication, api, bff, catalog] = yield* Effect.promise(
    async () =>
      await Promise.all([
        import('../../api/index.ts'),
        import('../../api/auth/service.ts'),
        import('../../shared/api.ts'),
        import('@modern-js/bff-effect/effect-edge'),
        import('../../api/modules/installed-module-catalog.ts'),
      ]),
  );
  const principals = new Map<string, TrustedPrincipalContext>();
  for (const persona of SIGNED_IN) {
    for (const legalEntityId of [undefined, ...accessCase.companies]) {
      const scope = yield* accessCase.scopeFor(persona, legalEntityId);
      principals.set(
        sessionKey(persona, legalEntityId),
        yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(scope).pipe(Effect.orDie),
      );
    }
  }
  const [, issuer, moduleStates] = shell.shellProductionRuntimeArguments;
  const runtime = shell.makeShellAuthenticationApiRuntime(
    personaAuthentication(authentication.AuthenticationService, principals),
    issuer,
    moduleStates,
    installed === undefined ? undefined : catalog.makeInstalledModuleCatalogLoader(Effect.succeed(installed)),
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    serves === 'frame' && installed !== undefined ? { load: Effect.succeed(installed) } : undefined,
    accessCase.databases,
  );
  const { apiPrefix } = api.shellAuthenticationApiContract;
  const handler = yield* Effect.acquireRelease(
    Effect.promise(
      async () => await bff.createEffectBffTestHandler({ module: { default: runtime }, prefix: apiPrefix }),
    ),
    (created) => Effect.promise(created.dispose.bind(created)),
  );
  const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
  const send = (request: ShellHttpRequest, method: 'GET' | 'POST') =>
    Effect.gen(function* sendRequest() {
      const headers = new Headers(method === 'POST' ? { 'content-type': 'application/json' } : {});
      if (request.persona !== undefined) {
        headers.set(PERSONA_HEADER, request.persona);
      }
      if (request.legalEntityId !== undefined) {
        headers.set(LEGAL_ENTITY_HEADER, request.legalEntityId);
      }
      if (request.idempotencyKey !== undefined) {
        headers.set('idempotency-key', request.idempotencyKey);
      }
      if (request.sameOrigin === true) {
        headers.set('sec-fetch-site', 'same-origin');
      }
      const url = `http://shell.test${apiPrefix}${request.path}`;
      const init: RequestInit =
        method === 'POST'
          ? { body: yield* encodeJson(request.payload).pipe(Effect.orDie), headers, method }
          : { headers };
      const response = yield* Effect.promise(async () => await handler.handler(new Request(url, init)));
      const text = yield* Effect.promise(async () => await response.text());
      return { status: response.status, text } satisfies ShellHttpAnswer;
    });
  const post = (request: ShellHttpRequest) => send(request, 'POST');
  const get = (request: Omit<ShellHttpRequest, 'payload'>) => send({ ...request, payload: null }, 'GET');
  return { get, post } satisfies ShellHttp;
});
