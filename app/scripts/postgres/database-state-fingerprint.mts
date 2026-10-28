#!/usr/bin/env node
import { createHash, createHmac } from 'node:crypto';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import {
  Array as EffectArray,
  Config,
  Console,
  Effect,
  FileSystem,
  Option,
  Order,
  Redacted,
  Result,
  Schema,
} from 'effect';
import { Command, Flag } from 'effect/cli';
import { Reactivity } from 'effect/reactivity';

import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../../database/identity-enrollment.ts';
import { loadDatabaseIdentityConnections } from '../../packages/core-runtime/src/db/config.ts';
import type { DatabaseConfigValue } from '../../packages/core-runtime/src/db/config.ts';
import { loadOptionalCommercePortalAuthDatabaseConfig } from '../../verticals/commerce-customer-context/scripts/portal-auth-database-config.mts';
import { quoteIdentifier } from './database-login-roles.mts';

const FINGERPRINT_VERSION = 'ontos-database-state-v1';
const SHA256 = /^[a-f0-9]{64}$/u;
const digestSchema = Schema.String.check(Schema.isPattern(SHA256));
export const DatabasePreparationRecordSchema = Schema.Struct({
  identityFp: digestSchema,
  inputsDigest: digestSchema,
  stateHash: digestSchema,
});
export type DatabasePreparationRecord = typeof DatabasePreparationRecordSchema.Type;
export interface DatabasePreparationObservation {
  readonly authorityPhase: string;
  readonly identityFp: string | null;
  readonly loginsOk: boolean;
  readonly stateHash: string | null;
}
export const DatabasePreparationPlanSchema = Schema.Struct({
  authorityPhase: Schema.String,
  light: Schema.Boolean,
  loginsOk: Schema.Boolean,
  reason: Schema.String,
  stateHash: Schema.OptionFromNullOr(Schema.String),
});
export type DatabasePreparationPlan = typeof DatabasePreparationPlanSchema.Type;
export class DatabaseStateFingerprintError extends Schema.TaggedError<DatabaseStateFingerprintError>()(
  'DatabaseStateFingerprintError',
  { reason: Schema.String },
) {}
const unavailable = () => new DatabaseStateFingerprintError({ reason: 'Database preparation evidence is unavailable' });
const encodeJson = (value: Schema.Json) =>
  Result.getOrThrow(Schema.encodeResult(Schema.fromJsonString(Schema.Json))(value));

/** Sort rows and ACL entries, not SQL argument/column arrays whose order is meaningful. */
export const canonicalDatabaseValue = (value: Schema.Json, key = ''): string => {
  if (Schema.is(Schema.JsonObject)(value)) {
    const entries = EffectArray.sort(
      Object.entries(value),
      (left: [string, Schema.Json], right: [string, Schema.Json]) => Order.String(left[0], right[0]),
    );
    const properties = entries.map(([name, entry]) => `${encodeJson(name)}:${canonicalDatabaseValue(entry, name)}`);
    return `{${properties.join(',')}}`;
  }
  if (Array.isArray(value)) {
    const entries = value.map((entry: Schema.Json) => canonicalDatabaseValue(entry));
    return `[${(key.endsWith('acl') ? EffectArray.sort(entries, Order.String) : entries).join(',')}]`;
  }
  return encodeJson(value);
};
export const hashDatabaseState = (lines: readonly string[]): string =>
  createHash('sha256')
    .update([FINGERPRINT_VERSION, ...EffectArray.sort(lines, Order.String)].join('\n'))
    .digest('hex');

export const parseDatabasePreparationRecord = Schema.decodeUnknownOption(DatabasePreparationRecordSchema);

/** Read-only; callers must still run runtime-role bootstrap, which reconciles mutable trust data. */
export const planDatabasePreparation = (
  observation: DatabasePreparationObservation,
  inputsDigest: string,
  record?: DatabasePreparationRecord,
  forceFull = false,
): DatabasePreparationPlan => {
  let reason = 'matching-preparation';
  if (forceFull) {
    reason = 'force-full';
  } else if (observation.identityFp === null) {
    reason = 'fingerprint-key-unavailable';
  } else if (!SHA256.test(inputsDigest)) {
    reason = 'inputs-unavailable';
  } else if (record === undefined) {
    reason = 'preparation-record-unavailable';
  } else if (record.inputsDigest !== inputsDigest) {
    reason = 'inputs-changed';
  } else if (record.identityFp !== observation.identityFp) {
    reason = 'identity-changed';
  } else if (observation.authorityPhase !== 'active') {
    reason = 'authority-not-active';
  } else if (!observation.loginsOk) {
    reason = 'login-unavailable';
  } else if (observation.stateHash === null) {
    reason = 'state-unavailable';
  } else if (record.stateHash !== observation.stateHash) {
    reason = 'state-changed';
  }
  return {
    authorityPhase: observation.authorityPhase,
    light: reason === 'matching-preparation',
    loginsOk: observation.loginsOk,
    reason,
    stateHash: Option.fromNullOr(observation.stateHash),
  };
};

// Catalog projections deliberately exclude physical storage IDs, statistics, transaction IDs,
// password verifiers, sequence values and application rows (including composition authority).
// Every ACL is included: table/column/schema/routine/type/database/default and role membership.
export const DATABASE_CATALOG_QUERIES = {
  columns: `select n.nspname, c.relname, a.attnum, a.attname, format_type(a.atttypid,a.atttypmod) as type,
    a.attnotnull, a.attidentity, a.attgenerated, a.attisdropped, a.attacl, a.attoptions,
    a.attstorage, a.attcompression, a.attcollation::regcollation::text as collation,
    pg_get_expr(d.adbin,d.adrelid) as default_expression
    from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid=a.attrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    left join pg_catalog.pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
    where a.attnum>0 and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`,
  constraints: `select n.nspname, c.relname, x.conname, x.convalidated, pg_get_constraintdef(x.oid) as definition
    from pg_catalog.pg_constraint x join pg_catalog.pg_namespace n on n.oid=x.connamespace
    left join pg_catalog.pg_class c on c.oid=x.conrelid
    where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`,
  database: `select to_jsonb(d) - 'oid' - 'datfrozenxid' - 'datminmxid' - 'dattablespace' - 'datdba' as attributes,
    pg_get_userbyid(d.datdba) as owner from pg_catalog.pg_database d where datname=current_database()`,
  defaults: `select pg_get_userbyid(d.defaclrole) as owner, n.nspname, d.defaclobjtype, d.defaclacl
    from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid=d.defaclnamespace`,
  enums: `select n.nspname, t.typname, e.enumlabel, e.enumsortorder
    from pg_catalog.pg_enum e join pg_catalog.pg_type t on t.oid=e.enumtypid
    join pg_catalog.pg_namespace n on n.oid=t.typnamespace`,
  extensions: `select extname, extversion, pg_get_userbyid(extowner) as owner, extnamespace::regnamespace::text as namespace
    from pg_catalog.pg_extension`,
  indexes: `select n.nspname, c.relname, pg_get_indexdef(i.indexrelid) as definition,
    i.indisvalid, i.indisready, i.indisreplident, i.indisclustered
    from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid=i.indexrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`,
  memberships: `select to_jsonb(m) - 'oid' - 'roleid' - 'member' - 'grantor' as attributes,
    pg_get_userbyid(m.roleid) as role, pg_get_userbyid(m.member) as member, pg_get_userbyid(m.grantor) as grantor
    from pg_catalog.pg_auth_members m`,
  namespaces: `select nspname, pg_get_userbyid(nspowner) as owner, nspacl
    from pg_catalog.pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema'`,
  policies: `select n.nspname, c.relname, p.polname, p.polcmd, p.polpermissive,
    array(select case when r=0 then 'PUBLIC' else pg_get_userbyid(r) end from unnest(p.polroles) r order by r) as roles,
    pg_get_expr(p.polqual,p.polrelid) as qualification, pg_get_expr(p.polwithcheck,p.polrelid) as with_check
    from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid=p.polrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace`,
  relations: `select n.nspname, c.relname, c.relkind, pg_get_userbyid(c.relowner) as owner,
    c.relpersistence, c.relreplident, c.relrowsecurity, c.relforcerowsecurity,
    c.reloptions, c.relacl, c.relispartition,
    case when c.relkind in ('v','m') then pg_get_viewdef(c.oid) end as view_definition,
    case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end as partition_key,
    pg_get_expr(c.relpartbound, c.oid) as partition_bound
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`,
  roles: `select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication,
    rolconnlimit, rolvaliduntil::text, rolbypassrls, rolconfig from pg_catalog.pg_roles`,
  routines: `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as arguments,
    pg_get_userbyid(p.proowner) as owner, p.proacl,
    case when p.prokind <> 'a' then pg_get_functiondef(p.oid) else to_jsonb(p)::text end as definition
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`,
  rules: `select n.nspname, c.relname, r.rulename, r.ev_enabled, pg_get_ruledef(r.oid) as definition
    from pg_catalog.pg_rewrite r join pg_catalog.pg_class c on c.oid=r.ev_class
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`,
  sequences: `select n.nspname, c.relname, s.seqtypid::regtype::text as type,
    s.seqstart::text, s.seqincrement::text, s.seqmax::text, s.seqmin::text, s.seqcache::text, s.seqcycle
    from pg_catalog.pg_sequence s join pg_catalog.pg_class c on c.oid=s.seqrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace`,
  settings: `select pg_get_userbyid(s.setrole) as role, d.datname, s.setconfig
    from pg_catalog.pg_db_role_setting s left join pg_catalog.pg_database d on d.oid=s.setdatabase
    where s.setdatabase=0 or d.datname=current_database()`,
  triggers: `select n.nspname, c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) as definition
    from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where not t.tgisinternal and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`,
  types: `select n.nspname, t.typname, pg_get_userbyid(t.typowner) as owner, t.typacl,
    t.typtype, t.typcategory, t.typnotnull, t.typdefault, format_type(t.typbasetype,t.typtypmod) as base_type,
    t.typinput::regprocedure::text as input, t.typoutput::regprocedure::text as output
    from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid=t.typnamespace
    where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`,
} satisfies Readonly<Record<string, string>>;

/** One repeatable, read-only snapshot; journal rows are the only non-catalog rows hashed. */
export const readDatabaseStateLines = (client: PgClient.PgClient) =>
  client
    .withTransaction(
      Effect.gen(function* readDatabaseState() {
        yield* client.unsafe('set transaction isolation level repeatable read read only');
        yield* client.unsafe('set local search_path = pg_catalog');
        const lines: string[] = [];
        for (const [name, sql] of Object.entries(DATABASE_CATALOG_QUERIES)) {
          const rows = yield* client.unsafe(`select to_jsonb(evidence) as row from (${sql}) evidence`).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ row: Schema.Json })))),
            Effect.mapError(
              () => new DatabaseStateFingerprintError({ reason: `Catalog fingerprint unavailable: ${name}` }),
            ),
          );
          lines.push(...rows.map(({ row }) => `${name} ${canonicalDatabaseValue(row)}`));
        }
        const journals = yield* client.unsafe<{ name: string }>(`select c.relname as name from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        where n.nspname='drizzle' and c.relkind in ('r','p') order by c.relname`);
        for (const { name } of journals) {
          const rows = yield* client
            .unsafe(`select to_jsonb(j) as row from drizzle.${quoteIdentifier(name)} j`)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ row: Schema.Json })))));
          lines.push(...rows.map(({ row }) => `journal ${name} ${canonicalDatabaseValue(row)}`));
        }
        return lines;
      }),
    )
    .pipe(Effect.mapError((failure) => (Schema.is(DatabaseStateFingerprintError)(failure) ? failure : unavailable())));

interface LoginTarget {
  readonly connectionString: Redacted.Redacted;
  readonly database: string;
  readonly user: string;
}
const loginTarget = (connection: DatabaseConfigValue): LoginTarget => ({
  connectionString: Redacted.make(connection.connectionString),
  database: connection.database,
  user: connection.user,
});
const authenticateLogin = (target: LoginTarget) =>
  Effect.scoped(
    Effect.gen(function* authenticatePreparationLogin() {
      const client = yield* PgClient.makeClient({ connectTimeout: '10 seconds', url: target.connectionString });
      const [row] = yield* client.unsafe<{ database: string; role: string }>(
        'select current_database() as database, session_user as role',
      );
      return row?.database === target.database && row.role === target.user;
    }),
  ).pipe(Effect.orElseSucceed(() => false));

const readDatabaseEvidence = (name: string, target: LoginTarget) =>
  Effect.scoped(
    Effect.gen(function* readPreparationDatabase() {
      const client = yield* PgClient.makeClient({
        connectTimeout: '10 seconds',
        startupParameters: { statement_timeout: '15000' },
        url: target.connectionString,
      });
      const lines = (yield* readDatabaseStateLines(client)).map((line) => `${name} ${line}`);
      let authorityPhase = 'unknown';
      if (name === 'application') {
        const rows = yield* client.unsafe<{ phase: string }>(
          "select phase from core.application_composition_authority where authority_key='active'",
        );
        if (rows.length === 1) {
          authorityPhase = rows[0].phase;
        }
      }
      return { authorityPhase, lines };
    }),
  );

export const observeDatabasePreparation = Effect.gen(function* observePreparation() {
  const connections = yield* loadDatabaseIdentityConnections({ enrollment: APP_DATABASE_IDENTITY_ENROLLMENT });
  const commerce = yield* loadOptionalCommercePortalAuthDatabaseConfig();
  const targets = new Map<string, LoginTarget>([
    ['admin', loginTarget(connections.admin)],
    ...Object.entries(connections.runtime).map(([name, target]): [string, LoginTarget] => [name, loginTarget(target)]),
  ]);
  const admins = new Map<string, LoginTarget>([['application', loginTarget(connections.admin)]]);
  if (Option.isSome(commerce)) {
    const pair = commerce.value;
    targets.set('portalAdmin', pair.admin);
    targets.set('portalRuntime', pair.runtime);
    if (
      pair.admin.database !== connections.admin.database ||
      pair.admin.host !== connections.admin.host ||
      pair.admin.port !== connections.admin.port
    ) {
      admins.set('portal', pair.admin);
    }
  }
  const key = yield* Config.option(Config.Redacted('RELEASE_FINGERPRINT_KEY'));
  const identityFp =
    Option.isSome(key) && Redacted.value(key.value).length > 0
      ? createHmac('sha256', Redacted.value(key.value))
          .update(
            canonicalDatabaseValue(
              Object.fromEntries([...targets].map(([name, target]) => [name, Redacted.value(target.connectionString)])),
            ),
          )
          .digest('hex')
      : null;
  const logins = yield* Effect.forEach([...targets.values()], authenticateLogin, { concurrency: 4 });
  const databases = yield* Effect.forEach([...admins], ([name, target]) => readDatabaseEvidence(name, target));
  return {
    authorityPhase: databases[0].authorityPhase,
    identityFp,
    loginsOk: logins.every(Boolean),
    stateHash: hashDatabaseState(databases.flatMap(({ lines }) => lines)),
  } satisfies DatabasePreparationObservation;
}).pipe(Effect.mapError(unavailable));

export const readDatabasePreparationPlan = (options: {
  readonly forceFull?: boolean;
  readonly inputsDigest: string;
  readonly recordFile?: string;
}) =>
  Effect.gen(function* readPreparationPlan() {
    const fs = yield* FileSystem.FileSystem;
    const observation = yield* observeDatabasePreparation.pipe(
      Effect.orElseSucceed(() => ({ authorityPhase: 'unknown', identityFp: null, loginsOk: false, stateHash: null })),
    );
    const record =
      options.recordFile === undefined || options.recordFile === ''
        ? Option.none<DatabasePreparationRecord>()
        : yield* fs
            .readFileString(options.recordFile)
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(DatabasePreparationRecordSchema))),
              Effect.option,
            );
    return planDatabasePreparation(observation, options.inputsDigest, Option.getOrUndefined(record), options.forceFull);
  });

/** Optional reuse evidence must never block publication of an already prepared database. */
export const recordDatabasePreparation = (
  { inputsDigest, output }: { readonly inputsDigest: string; readonly output: string },
  observe: Effect.Effect<
    DatabasePreparationObservation,
    DatabaseStateFingerprintError,
    Reactivity.Reactivity
  > = observeDatabasePreparation,
) =>
  Effect.gen(function* writePreparationRecord() {
    const fs = yield* FileSystem.FileSystem;
    // A failed retry must not leave a prior record available for the ledger checkpoint.
    yield* fs.remove(output, { force: true });
    if (!SHA256.test(inputsDigest)) {
      return yield* Console.log('Skipped database preparation fingerprint: inputs-unavailable');
    }
    const evidence = yield* observe;
    if (evidence.identityFp === null) {
      return yield* Console.log('Skipped database preparation fingerprint: fingerprint-key-unavailable');
    }
    if (!evidence.loginsOk || evidence.stateHash === null) {
      return yield* Console.log('Skipped database preparation fingerprint: state-or-login-unavailable');
    }
    const record = { identityFp: evidence.identityFp, inputsDigest, stateHash: evidence.stateHash };
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(DatabasePreparationRecordSchema))(record);
    yield* fs.writeFileString(output, `${json}\n`, { mode: 0o600 });
    return yield* Console.log('Recorded database preparation fingerprint');
  }).pipe(
    Effect.mapError(unavailable),
    Effect.catchTag('DatabaseStateFingerprintError', () =>
      Effect.gen(function* discardUnavailableRecord() {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(output, { force: true }).pipe(Effect.ignore);
        // Never include database errors, connection strings or credential material in logs.
        yield* Console.log('Skipped database preparation fingerprint: evidence-unavailable');
      }),
    ),
  );

if (import.meta.main) {
  const command = Command.make(
    'database-state-fingerprint',
    {
      inputsDigest: Flag.String('inputs-digest'),
      output: Flag.String('output'),
    },
    (options) => recordDatabasePreparation(options),
  );
  NodeRuntime.runMain(
    Command.run(command, { version: '1.0.0' }).pipe(Effect.provide([Reactivity.layer, NodeServices.layer])),
  );
}
