/// <reference types="node" />

import { createHash } from 'node:crypto';

import { PgClient } from '@effect/sql-pg';
import { Effect, FileSystem, Option, Redacted, Schema } from 'effect';

import { ApplicationReleaseIntentSchema } from './application-release-intent.mts';
import type { DatabaseConfigValue } from '../packages/core-runtime/src/db/config.ts';
import { configureDatabasePool } from '../packages/core-runtime/src/db/pool-configuration.ts';
import { loadAdministrativeDatabaseConnection } from '../packages/core-runtime/src/db/config.ts';
import {
  ApplicationMigrationRequirementsSchema,
  ApplicationMigrationObservationSchema,
  resolveApplicationMigrationRequirements,
  selectApplicationMigrationPlan,
} from './application-migration-plan.mts';
import type {
  ApplicationMigrationObservation,
  ApplicationMigrationPlan,
  ApplicationMigrationRequirements,
} from './application-migration-plan.mts';
import {
  applicationMigrationOwnerInventory,
  loadApplicationMigrationInventory,
} from './application-migration-inventory.mts';
import type { ApplicationMigrationStream } from './application-migration-inventory.mts';

export class ApplicationMigrationRuntimeError extends Schema.TaggedError<ApplicationMigrationRuntimeError>()(
  'ApplicationMigrationRuntimeError',
  { reason: Schema.String },
) {}
const invalid = (reason: string) => new ApplicationMigrationRuntimeError({ reason });
const portalOwner = 'commerce-customer-context-portal-auth';
const requirementsDocument = Schema.fromJsonString(
  Schema.Union([ApplicationMigrationRequirementsSchema, ApplicationReleaseIntentSchema]),
);
const optionalPortalConfiguration = Effect.fn('ApplicationMigrationRuntime.portalConfiguration')(
  function* optionalPortalConfigurationEffect() {
    const owner = yield* Effect.tryPromise({
      catch: () => invalid('Unable to load the selected portal-auth configuration gateway'),
      try: async () => await import('../verticals/commerce-customer-context/scripts/portal-auth-database-config.mts'),
    });
    return yield* owner
      .loadOptionalCommercePortalAuthDatabaseConfig()
      .pipe(Effect.mapError(() => invalid('Selected portal-auth database configuration is unavailable')));
  },
);
/** CI/publication validates release-intent identity; deployed runtime consumes only its finite migrationRequirements. */
export const readApplicationMigrationRequirements = Effect.fn('ApplicationMigrationRuntime.readRequirements')(
  function* readApplicationMigrationRequirementsEffect(file?: string) {
    let requirements: ApplicationMigrationRequirements = { mode: 'all', owners: [] };
    if (file !== undefined) {
      const fs = yield* FileSystem.FileSystem;
      const decoded = yield* Schema.decodeEffect(requirementsDocument, { onExcessProperty: 'error' })(
        yield* fs.readFileString(file),
      ).pipe(Effect.mapError(() => invalid('Invalid reviewed migration requirements document')));
      requirements = Schema.is(ApplicationMigrationRequirementsSchema)(decoded)
        ? decoded
        : (decoded.migrationRequirements ?? { mode: 'all', owners: [] });
    }
    if (requirements.mode !== 'all') {
      return requirements;
    }
    const portal = yield* optionalPortalConfiguration();
    if (Option.isNone(portal) || requirements.owners.some((owner) => owner.ownerId === portalOwner)) {
      return requirements;
    }
    return { ...requirements, owners: [...requirements.owners, { migrate: true, ownerId: portalOwner, verify: true }] };
  },
);

export interface NativeMigrationTarget {
  readonly database: string;
  readonly databaseKind: ApplicationMigrationStream['database'];
  readonly databaseOid: string;
  readonly host: string;
  readonly port: number;
  readonly systemIdentifier: string;
  readonly user: string;
}
const NativeMigrationTargetSchema = Schema.Struct({
  database: Schema.NonEmptyString,
  databaseKind: Schema.Literals(['primary', 'portal-auth']),
  databaseOid: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u)).pipe(Schema.brand('MigrationDatabaseOid')),
  host: Schema.NonEmptyString,
  port: Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1 })),
  systemIdentifier: Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u)).pipe(
    Schema.brand('MigrationSystemIdentifier'),
  ),
  user: Schema.NonEmptyString,
});
export const assertSameApplicationMigrationTargets = Effect.fn('ApplicationMigrationRuntime.assertSameTargets')(
  function* assertSameApplicationMigrationTargetsEffect(
    expected: readonly NativeMigrationTarget[],
    observed: readonly NativeMigrationTarget[],
  ) {
    if (
      !Schema.is(Schema.Array(NativeMigrationTargetSchema))(expected) ||
      !Schema.is(Schema.Array(NativeMigrationTargetSchema))(observed) ||
      expected.length !== observed.length ||
      new Set(expected.map((target) => target.databaseKind)).size !== expected.length ||
      new Set(observed.map((target) => target.databaseKind)).size !== observed.length
    ) {
      return yield* invalid('Native migration database bindings are invalid, duplicated or incomplete');
    }
    for (const target of expected) {
      const current = observed.find((candidate) => candidate.databaseKind === target.databaseKind);
      if (
        current === undefined ||
        current.database !== target.database ||
        current.databaseOid !== target.databaseOid ||
        current.systemIdentifier !== target.systemIdentifier ||
        current.user !== target.user
      ) {
        return yield* invalid('Native migration evidence belongs to a different physical database identity');
      }
    }
    return yield* Effect.void;
  },
);
const coherentObservation = (observation: ApplicationMigrationObservation): boolean =>
  Schema.is(ApplicationMigrationObservationSchema)(observation) &&
  new Set(observation.entries.map((entry) => entry.name)).size === observation.entries.length &&
  new Set(observation.schemasPresent).size === observation.schemasPresent.length &&
  observation.schemaEvidence !== 'inconsistent' &&
  (observation.schemaEvidence === 'absent'
    ? observation.entries.length === 0 && observation.schemasPresent.length === 0
    : observation.journalExists && observation.entries.length > 0 && observation.schemasPresent.length > 0);
const journalMatches = (
  actual: ApplicationMigrationObservation['entries'],
  expected: ApplicationMigrationObservation['entries'],
): boolean =>
  actual.length === expected.length &&
  actual.every((entry) => expected.some((candidate) => candidate.name === entry.name && candidate.hash === entry.hash));
/** No new completion record: native committed SQL and its exact independent journal are the recovery anchor. */
export const reconcileApplicationMigrationOwner = Effect.fn('ApplicationMigrationRuntime.reconcileOwner')(
  function* reconcileApplicationMigrationOwnerEffect<E, R>(
    before: ApplicationMigrationPlan['owners'][number],
    after: ApplicationMigrationObservation,
    verifyCommitted: Effect.Effect<void, E, R>,
  ) {
    const original = before.before;
    if (
      !coherentObservation(original) ||
      !coherentObservation(after) ||
      before.ownerId !== original.ownerId ||
      after.ownerId !== before.ownerId ||
      after.journalName !== original.journalName
    ) {
      return yield* invalid('Migration recovery observation does not match its owner and independent journal');
    }
    const sameSchemas =
      after.schemasPresent.length === original.schemasPresent.length &&
      after.schemasPresent.every((schema) => original.schemasPresent.includes(schema));
    if (journalMatches(after.entries, original.entries)) {
      if (
        !sameSchemas ||
        after.catalogFingerprint !== original.catalogFingerprint ||
        (original.journalExists && !after.journalExists)
      ) {
        return yield* invalid('Migration journal is unchanged but actual schema evidence differs');
      }
      return 'uncommitted' as const;
    }
    const expected = [...original.entries, ...before.pendingMigrations];
    if (
      before.pendingMigrations.length === 0 ||
      new Set(expected.map((entry) => entry.name)).size !== expected.length ||
      !after.journalExists ||
      !journalMatches(after.entries, expected) ||
      original.schemasPresent.some((schema) => !after.schemasPresent.includes(schema)) ||
      after.schemasPresent.length === 0
    ) {
      return yield* invalid('Migration recovery is partial, inconsistent or differs from the planned SQL hashes');
    }
    yield* verifyCommitted;
    return 'committed' as const;
  },
);

const CatalogSchema = Schema.Array(Schema.Struct({ objects: Schema.String, schema_name: Schema.String }));
interface CatalogNamespace {
  readonly objects: string;
  readonly schema_name: string;
}
interface JournalRecord {
  readonly hash: string;
  readonly name: string | null;
}
interface DatabaseIdentity {
  readonly database: string;
  readonly databaseOid: string;
  readonly systemIdentifier: string;
  readonly user: string;
}
const catalogQuery = `
 select n.nspname as schema_name,
 coalesce(jsonb_agg(jsonb_build_object(
   'name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
   'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,
   'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'required',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
   'constraints',(select jsonb_agg(pg_get_constraintdef(k.oid) order by k.conname) from pg_constraint k where k.conrelid=c.oid),
   'indexes',(select jsonb_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid::regclass::text) from pg_index i where i.indrelid=c.oid),
   'triggers',(select jsonb_agg(pg_get_triggerdef(t.oid) order by t.tgname) from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal)
 ) order by c.relname) filter(where c.oid is not null),'[]'::jsonb)::text as objects
 from pg_namespace n left join pg_class c on c.relnamespace=n.oid and c.relkind in('r','p','v','m','S','f')
 where n.nspname <> 'information_schema' and n.nspname not like 'pg\\_%' and n.nspname not in('public','drizzle')
 group by n.nspname order by n.nspname`;
export const observeApplicationMigrationState = Effect.fn('ApplicationMigrationRuntime.observeNative')(
  function* readNativeStateEffect(streams: readonly ApplicationMigrationStream[]) {
    const observations: ApplicationMigrationObservation[] = [];
    const nativeTargets: NativeMigrationTarget[] = [];
    for (const databaseKind of ['primary', 'portal-auth'] as const) {
      const selected = streams.filter((stream) => stream.database === databaseKind);
      if (selected.length === 0) {
        continue;
      }
      let connection: DatabaseConfigValue;
      if (databaseKind === 'primary') {
        connection = yield* loadAdministrativeDatabaseConnection();
      } else {
        const configured = yield* optionalPortalConfiguration();
        if (Option.isNone(configured)) {
          return yield* invalid('The selected portal-auth migration requires its configured database');
        }
        connection = {
          ...configured.value.admin,
          connectionString: Redacted.value(configured.value.admin.connectionString),
          expectedRole: configured.value.admin.user,
        };
      }
      const observed = yield* Effect.gen(function* observeDatabase() {
        const pool = yield* configureDatabasePool(Redacted.make(connection.connectionString));
        const client = yield* PgClient.makeClient(pool);
        const [identity] = yield* client.unsafe<DatabaseIdentity>(
          'select current_database() as database,current_user as "user",d.oid::text as "databaseOid",(pg_control_system()).system_identifier::text as "systemIdentifier" from pg_database d where d.datname=current_database()',
        );
        if (identity === undefined || identity.database !== connection.database || identity.user !== connection.user) {
          return yield* invalid('Native migration observation reached a different database identity');
        }
        const catalog = yield* client.unsafe<CatalogNamespace>(catalogQuery);
        const catalogJson = yield* Schema.encodeEffect(Schema.fromJsonString(CatalogSchema))(catalog);
        const catalogFingerprint = createHash('sha256').update(catalogJson).digest('hex');
        const journals = yield* client.unsafe<{ readonly table_name: string }>(
          "select c.relname as table_name from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='drizzle' and c.relkind='r' order by c.relname",
        );
        const owners: ApplicationMigrationObservation[] = [];
        for (const stream of selected) {
          if (!/^__drizzle_migrations_[a-z0-9_]+$/u.test(stream.journalName)) {
            return yield* invalid('Invalid independent migration journal name');
          }
          const journalExists = journals.some((row) => row.table_name === stream.journalName);
          const rows = journalExists
            ? yield* client.unsafe<JournalRecord>(
                `select to_jsonb(journal)->>'name' as name, journal.hash from drizzle."${stream.journalName}" as journal order by journal.hash`,
              )
            : [];
          const entries = rows.map((row) => ({
            hash: row.hash,
            name:
              row.name ??
              (stream.migrations.filter((source) => source.hash === row.hash).length === 1
                ? (stream.migrations.find((source) => source.hash === row.hash)?.name ?? '')
                : ''),
          }));
          const schemasPresent = stream.schemas.filter((schema) => catalog.some((row) => row.schema_name === schema));
          let schemaEvidence: ApplicationMigrationObservation['schemaEvidence'] = 'inconsistent';
          if (schemasPresent.length === 0 && entries.length === 0) {
            schemaEvidence = 'absent';
          } else if (journalExists && entries.length > 0 && schemasPresent.length > 0) {
            schemaEvidence = 'observed-journal';
          }
          owners.push({
            catalogFingerprint,
            entries,
            journalExists,
            journalName: stream.journalName,
            ownerId: stream.ownerId,
            schemaEvidence,
            schemasPresent,
          });
        }
        return {
          observations: owners,
          target: {
            database: identity.database,
            databaseKind,
            databaseOid: identity.databaseOid,
            host: connection.host,
            port: connection.port,
            systemIdentifier: identity.systemIdentifier,
            user: identity.user,
          },
        };
      }).pipe(
        Effect.scoped,
        Effect.mapError(() => invalid(`Unable to observe the selected ${databaseKind} migration catalog and journals`)),
      );
      observations.push(...observed.observations);
      nativeTargets.push(observed.target);
    }
    return { nativeTargets, observations };
  },
);
/** Publication's verifier-only path cannot cross into bootstrap or DDL after a changed observation. */
export const assertMigrationVerificationOnly = Effect.fn('ApplicationMigrationRuntime.assertVerificationOnly')(
  function* assertMigrationVerificationOnlyEffect(plan: ApplicationMigrationPlan) {
    if (plan.owners.some((owner) => owner.pendingMigrations.length > 0)) {
      return yield* invalid('Verification-only execution refuses pending migration or bootstrap work');
    }
    return yield* Effect.void;
  },
);

/** Native Drizzle migrates its complete folder; never execute SQL beyond a reviewed upper bound. */
export const assertNativeMigrationBounds = Effect.fn('ApplicationMigrationRuntime.assertNativeBounds')(
  function* assertNativeMigrationBoundsEffect(
    plan: ApplicationMigrationPlan,
    streams: readonly ApplicationMigrationStream[],
  ) {
    for (const owner of plan.owners) {
      if (owner.pendingMigrations.length === 0) {
        continue;
      }
      const stream = streams.find((candidate) => candidate.ownerId === owner.ownerId);
      if (stream === undefined) {
        return yield* invalid('The selected native migration owner is absent from source inventory');
      }
      const applied = new Set(owner.before.entries.map((entry) => entry.name));
      const reviewed = new Set(owner.pendingMigrations.map((entry) => entry.name));
      if (stream.migrations.some((entry) => !applied.has(entry.name) && !reviewed.has(entry.name))) {
        return yield* invalid(`Native whole-owner migration would exceed the reviewed target for ${owner.ownerId}`);
      }
    }
    return yield* Effect.void;
  },
);

/** Read-only preparation is reusable by the publication boundary before any role/bootstrap/DDL effects. */
export const prepareApplicationMigrationPlan = Effect.fn('ApplicationMigrationRuntime.prepare')(
  function* prepareApplicationMigrationPlanEffect(requirements: ApplicationMigrationRequirements) {
    if (requirements.mode === 'none') {
      const plan = yield* selectApplicationMigrationPlan(requirements, [], []);
      const nativeTargets: NativeMigrationTarget[] = [];
      const streams: ApplicationMigrationStream[] = [];
      return { nativeTargets, plan, streams };
    }
    const inventory = yield* loadApplicationMigrationInventory();
    const owners = applicationMigrationOwnerInventory(inventory);
    const closure = yield* resolveApplicationMigrationRequirements(requirements, owners);
    const streams = closure.flatMap((requirement) =>
      inventory.filter((stream) => stream.ownerId === requirement.ownerId),
    );
    const { nativeTargets, observations } = yield* observeApplicationMigrationState(streams);
    const plan = yield* selectApplicationMigrationPlan(requirements, owners, observations);
    yield* assertNativeMigrationBounds(plan, streams);
    return { nativeTargets, plan, streams };
  },
);
