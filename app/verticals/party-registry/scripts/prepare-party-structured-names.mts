import type { PgClient } from '@effect/sql-pg';
import { Effect, Schema } from 'effect';

/**
 * Lossless additive preparation for the Party structured-name and assertion-history convergence.
 *
 * The structured-names migration adds `firstName`/`lastName`/`businessName` to
 * `party.duplicate_candidate_cases.candidate_snapshot` and replaces the old `names`-array CHECK.
 * Rows written by the previous snapshot shape carry `names` and omit the structured keys, so the new
 * CHECK rejects them. This preparation adds ONLY the absent structured keys as JSON null, keeping every
 * existing member byte-for-byte (names, provenance, validFrom, officialIdentifiers and the rest) and
 * never splitting `names` into fabricated facts. Existing structured values always win, and a second
 * preparation updates zero rows.
 *
 * The same convergence narrows `party.party_fact_assertions.fact_kind`, which the deployed demo history
 * still satisfies with legacy `DISPLAY_NAME` assertions. Those rows are not relabelled: the current
 * party type cannot establish what an original fact meant, and a name assertion is not authority for a
 * structured current name. Instead this preparation installs a stable assertion-identity registry plus a
 * separate append-only archive, registers every existing assertion, re-points the supersede/retract and
 * correction references at that registry, and then retires only the byte-conserved `DISPLAY_NAME` copies
 * into the archive. Identity, provenance, acceptance evidence, timestamps, state and the correction graph
 * survive; nothing is inferred, split, rewritten or deleted. Existing structured rows are never touched.
 *
 * `party.duplicate_candidate_cases` carries FORCE ROW LEVEL SECURITY, so this update only reaches rows
 * when DATABASE_ADMIN_URL connects as a superuser or BYPASSRLS role (the same requirement as
 * scripts/demo/migrate-domain-regroup.mts). Otherwise the update silently matches nothing and the
 * following constraint change fails closed. The assertion-history structures, the registry seed, the
 * archive copy and its conservation check are owner statements for the same reason; every one of them
 * runs in the caller's serialized convergence transaction, so a mismatch rolls the whole convergence back.
 */
export const PartyStructuredNamesStateSchema = Schema.Literals(['absent', 'installed', 'prepared', 'unchanged']);
export type PartyStructuredNamesState = typeof PartyStructuredNamesStateSchema.Type;

class PartyStructuredNamesMigrationError extends Schema.TaggedError<PartyStructuredNamesMigrationError>()(
  'PartyStructuredNamesMigrationError',
  { cause: Schema.Unknown, message: Schema.String },
) {}

// Fixed, data-free messages: no SQL text, parameters, credentials or row values escape.
const PROBE_FAILED = 'PostgreSQL candidate snapshot probe failed';
const PREPARATION_FAILED = 'PostgreSQL candidate snapshot preparation failed';
const STRUCTURE_FAILED = 'PostgreSQL Party assertion history installation failed';
const REGISTRATION_FAILED = 'PostgreSQL Party assertion identity registration failed';
const RETARGET_FAILED = 'PostgreSQL Party assertion reference retarget failed';
const ARCHIVE_FAILED = 'PostgreSQL Party historical name archival failed';
const CONSERVATION_FAILED = 'PostgreSQL Party historical name conservation check failed';

const databaseFailure = (message: string, cause: unknown): PartyStructuredNamesMigrationError =>
  new PartyStructuredNamesMigrationError({ cause, message });

export const PARTY_STRUCTURED_NAMES_PROBE_SQL = `select
        to_regclass('party.duplicate_candidate_cases') is not null as present,
        to_regclass('party.party_fact_assertions') is not null as assertions,
        to_regclass('party.party_fact_assertion_identities') is not null as registered`;

/**
 * Add only the absent structured keys, as JSON null, to recognizable legacy snapshots (those that still
 * carry a `names` array). Existing keys and every other member are preserved by construction, and the
 * `?&` guard leaves already-complete rows out of the write set.
 */
export const PARTY_STRUCTURED_NAMES_PREPARATION_SQL = `with prepared_rows as (
        update party.duplicate_candidate_cases
        set candidate_snapshot = candidate_snapshot || jsonb_build_object(
          'firstName', case when candidate_snapshot ? 'firstName' then candidate_snapshot -> 'firstName' else 'null'::jsonb end,
          'lastName', case when candidate_snapshot ? 'lastName' then candidate_snapshot -> 'lastName' else 'null'::jsonb end,
          'businessName', case when candidate_snapshot ? 'businessName' then candidate_snapshot -> 'businessName' else 'null'::jsonb end
        )
        where jsonb_typeof(candidate_snapshot) = 'object'
          and jsonb_typeof(candidate_snapshot -> 'names') = 'array'
          and not candidate_snapshot ?& array['firstName', 'lastName', 'businessName']
        returning 1
      )
      select count(*)::integer as prepared from prepared_rows`;

const query = <Row extends object>(client: PgClient.PgClient, text: string, operation: string) =>
  client.unsafe<Row>(text).pipe(Effect.mapError((cause) => databaseFailure(operation, cause)));

/** A statement with no result rows; every structural statement is idempotent, so a re-run changes nothing. */
const execute = (client: PgClient.PgClient, text: string, operation: string) =>
  client.unsafe<Record<string, never>>(text).pipe(Effect.mapError((cause) => databaseFailure(operation, cause)));

/** A refused invariant is a typed failure with a fixed, data-free message and no SQL text. */
const invariantFailure = (message: string): PartyStructuredNamesMigrationError =>
  new PartyStructuredNamesMigrationError({ cause: null, message });

/**
 * Stable assertion-identity registry plus the separate historical-name archive. The same statement list
 * is what the appended native migration ships, so this preparation installs the final schema before any
 * pending migration narrows the current-store `fact_kind` CHECK and the migration later converges on the
 * already-installed structures. Each statement is idempotent, including the registry seed below.
 */
export const PARTY_ASSERTION_HISTORY_STRUCTURE_SQL: readonly string[] = [
  `create table if not exists "party"."party_fact_assertion_identities" (
	"assertion_id" uuid primary key,
	"tenant_id" uuid not null,
	"party_id" uuid not null,
	constraint "party_fact_assertion_identities_tenant_assertion_uk" unique ("tenant_id", "assertion_id"),
	constraint "party_fact_assertion_identities_tenant_party_fk" foreign key ("tenant_id", "party_id")
		references "party"."parties" ("tenant_id", "party_id") on delete restrict
);`,
  `create table if not exists "party"."party_historical_name_assertions" (
	"assertion_id" uuid primary key,
	"tenant_id" uuid not null,
	"party_id" uuid not null,
	"original_assertion" jsonb not null,
	"archived_at" timestamp with time zone default now() not null,
	constraint "party_historical_name_assertions_tenant_assertion_fk" foreign key ("tenant_id", "assertion_id")
		references "party"."party_fact_assertion_identities" ("tenant_id", "assertion_id") on delete restrict
);`,
  `do $block$
begin
	alter table "party"."party_fact_assertion_identities" enable row level security;
	alter table "party"."party_fact_assertion_identities" force row level security;
	drop policy if exists "party_fact_assertion_identities_tenant_select" on "party"."party_fact_assertion_identities";
	drop policy if exists "party_fact_assertion_identities_tenant_insert" on "party"."party_fact_assertion_identities";
	drop policy if exists "party_fact_assertion_identities_tenant_update" on "party"."party_fact_assertion_identities";
	drop policy if exists "party_fact_assertion_identities_tenant_delete" on "party"."party_fact_assertion_identities";
	create policy "party_fact_assertion_identities_tenant_select" on "party"."party_fact_assertion_identities" as permissive for select to "party_registry_runtime" using ("tenant_id" = (select trust.current_tenant_id()));
	create policy "party_fact_assertion_identities_tenant_insert" on "party"."party_fact_assertion_identities" as permissive for insert to "party_registry_runtime" with check ("tenant_id" = (select trust.current_tenant_id()));
	create policy "party_fact_assertion_identities_tenant_update" on "party"."party_fact_assertion_identities" as permissive for update to "party_registry_runtime" using ("tenant_id" = (select trust.current_tenant_id())) with check ("tenant_id" = (select trust.current_tenant_id()));
	create policy "party_fact_assertion_identities_tenant_delete" on "party"."party_fact_assertion_identities" as permissive for delete to "party_registry_runtime" using ("tenant_id" = (select trust.current_tenant_id()));
end
$block$;`,
  `do $block$
begin
	alter table "party"."party_historical_name_assertions" enable row level security;
	alter table "party"."party_historical_name_assertions" force row level security;
	drop policy if exists "party_historical_name_assertions_tenant_select" on "party"."party_historical_name_assertions";
	drop policy if exists "party_historical_name_assertions_tenant_insert" on "party"."party_historical_name_assertions";
	drop policy if exists "party_historical_name_assertions_tenant_update" on "party"."party_historical_name_assertions";
	drop policy if exists "party_historical_name_assertions_tenant_delete" on "party"."party_historical_name_assertions";
	create policy "party_historical_name_assertions_tenant_select" on "party"."party_historical_name_assertions" as permissive for select to "party_registry_runtime" using ("tenant_id" = (select trust.current_tenant_id()));
	create policy "party_historical_name_assertions_tenant_insert" on "party"."party_historical_name_assertions" as permissive for insert to "party_registry_runtime" with check ("tenant_id" = (select trust.current_tenant_id()));
	create policy "party_historical_name_assertions_tenant_update" on "party"."party_historical_name_assertions" as permissive for update to "party_registry_runtime" using ("tenant_id" = (select trust.current_tenant_id())) with check ("tenant_id" = (select trust.current_tenant_id()));
	create policy "party_historical_name_assertions_tenant_delete" on "party"."party_historical_name_assertions" as permissive for delete to "party_registry_runtime" using ("tenant_id" = (select trust.current_tenant_id()));
end
$block$;`,
  `create or replace function "party"."register_party_fact_assertion_identity"()
returns trigger
language plpgsql
set search_path = pg_catalog, party, pg_temp
as $routine$
begin
	if tg_op = 'UPDATE' and (
		new.assertion_id is distinct from old.assertion_id
		or new.tenant_id is distinct from old.tenant_id
		or new.party_id is distinct from old.party_id
	) then
		raise exception 'A Party fact assertion identity is immutable'
			using errcode = '23514';
	end if;
	if exists (
		select 1 from party.party_historical_name_assertions as archived
		where archived.assertion_id = new.assertion_id
	) then
		raise exception 'A Party fact assertion identity cannot be reused once it is archived'
			using errcode = '23505';
	end if;
	insert into party.party_fact_assertion_identities (assertion_id, tenant_id, party_id)
	values (new.assertion_id, new.tenant_id, new.party_id)
	on conflict (assertion_id) do nothing;
	if not exists (
		select 1 from party.party_fact_assertion_identities as identity
		where identity.assertion_id = new.assertion_id
			and identity.tenant_id = new.tenant_id
			and identity.party_id = new.party_id
	) then
		raise exception 'A Party fact assertion identity belongs to another tenant or party'
			using errcode = '23514';
	end if;
	return new;
end
$routine$;`,
  `create or replace function "party"."guard_party_historical_name_assertion"()
returns trigger
language plpgsql
set search_path = pg_catalog, party, pg_temp
as $routine$
begin
	if tg_op <> 'INSERT' then
		raise exception 'Party historical name assertions are immutable'
			using errcode = '55000';
	end if;
	if new.original_assertion ->> 'fact_kind' is distinct from 'DISPLAY_NAME'
		or new.original_assertion ->> 'assertion_id' is distinct from new.assertion_id::text
		or new.original_assertion ->> 'tenant_id' is distinct from new.tenant_id::text
		or new.original_assertion ->> 'party_id' is distinct from new.party_id::text then
		raise exception 'A Party historical name assertion must preserve its original identity and kind'
			using errcode = '23514';
	end if;
	if not exists (
		select 1 from party.party_fact_assertion_identities as identity
		where identity.assertion_id = new.assertion_id
			and identity.tenant_id = new.tenant_id
			and identity.party_id = new.party_id
	) then
		raise exception 'A Party historical name assertion requires its registered assertion identity'
			using errcode = '23503';
	end if;
	return new;
end
$routine$;`,
  `create or replace function "party"."reject_party_historical_name_assertion_collision"()
returns trigger
language plpgsql
set search_path = pg_catalog, party, pg_temp
as $routine$
begin
	if exists (
		select 1 from party.party_fact_assertions as current_assertion
		where current_assertion.assertion_id = new.assertion_id
	) then
		raise exception 'A Party fact assertion identity cannot be current and archived at once'
			using errcode = '23505';
	end if;
	return null;
end
$routine$;`,
  `drop trigger if exists "party_fact_assertions_identity_registration" on "party"."party_fact_assertions";`,
  `create trigger "party_fact_assertions_identity_registration"
before insert or update of assertion_id, tenant_id, party_id on "party"."party_fact_assertions"
for each row execute function "party"."register_party_fact_assertion_identity"();`,
  `drop trigger if exists "party_historical_name_assertions_guard" on "party"."party_historical_name_assertions";`,
  `create trigger "party_historical_name_assertions_guard"
before insert or update or delete on "party"."party_historical_name_assertions"
for each row execute function "party"."guard_party_historical_name_assertion"();`,
  `drop trigger if exists "party_historical_name_assertions_collision" on "party"."party_historical_name_assertions";`,
  `create constraint trigger "party_historical_name_assertions_collision"
after insert on "party"."party_historical_name_assertions"
deferrable initially deferred
for each row execute function "party"."reject_party_historical_name_assertion_collision"();`,
  `revoke execute on function
	"party"."register_party_fact_assertion_identity"(),
	"party"."guard_party_historical_name_assertion"(),
	"party"."reject_party_historical_name_assertion_collision"()
from public;`,
];

/**
 * Registers every assertion that already exists, so the retarget below can validate the current graph.
 * Existing rows are never rewritten and an already-registered assertion is left alone; a conflicting
 * identity for another tenant or party stays unregistered and is refused by the check that follows.
 */
export const PARTY_ASSERTION_HISTORY_SEED_SQL = `insert into "party"."party_fact_assertion_identities" ("assertion_id", "tenant_id", "party_id")
select assertion.assertion_id, assertion.tenant_id, assertion.party_id
from "party"."party_fact_assertions" as assertion
where not exists (
	select 1 from "party"."party_fact_assertion_identities" as identity
	where identity.assertion_id = assertion.assertion_id
);`;

/** Every current-store assertion must own the registry row it was seeded or registered with. */
export const PARTY_ASSERTION_HISTORY_REGISTRATION_SQL = `select count(*)::integer as unregistered
from "party"."party_fact_assertions" as assertion
where not exists (
	select 1 from "party"."party_fact_assertion_identities" as identity
	where identity.assertion_id = assertion.assertion_id
		and identity.tenant_id = assertion.tenant_id
		and identity.party_id = assertion.party_id
);`;

/**
 * Re-points every fact reference at the stable identity registry. The columns, names and RESTRICT
 * behaviour are unchanged, so no correction row is updated and no integrity is dropped; only the target
 * moves from the current store to the registry that also covers the archive.
 */
export const PARTY_ASSERTION_HISTORY_RETARGET_SQL: readonly string[] = [
  `alter table "party"."party_fact_assertions"
	drop constraint if exists "party_fact_assertions_tenant_supersedes_fk",
	add constraint "party_fact_assertions_tenant_supersedes_fk"
		foreign key ("tenant_id", "supersedes_assertion_id")
		references "party"."party_fact_assertion_identities" ("tenant_id", "assertion_id") on delete restrict;`,
  `alter table "party"."party_fact_assertions"
	drop constraint if exists "party_fact_assertions_tenant_retracts_fk",
	add constraint "party_fact_assertions_tenant_retracts_fk"
		foreign key ("tenant_id", "retracts_assertion_id")
		references "party"."party_fact_assertion_identities" ("tenant_id", "assertion_id") on delete restrict;`,
  `alter table "party"."party_corrections"
	drop constraint if exists "party_corrections_tenant_fact_fk",
	add constraint "party_corrections_tenant_fact_fk"
		foreign key ("tenant_id", "party_fact_assertion_id")
		references "party"."party_fact_assertion_identities" ("tenant_id", "assertion_id") on delete restrict;`,
  `alter table "party"."party_corrections"
	drop constraint if exists "party_corrections_tenant_replacement_fact_fk",
	add constraint "party_corrections_tenant_replacement_fact_fk"
		foreign key ("tenant_id", "replacement_party_fact_assertion_id")
		references "party"."party_fact_assertion_identities" ("tenant_id", "assertion_id") on delete restrict;`,
];

/**
 * The exact statement list the appended native migration ships: structure, then the registry seed, then
 * the retarget. One source, so preparation and migration can never describe different final schemas.
 */
export const PARTY_ASSERTION_HISTORY_MIGRATION_SQL: readonly string[] = [
  ...PARTY_ASSERTION_HISTORY_STRUCTURE_SQL,
  PARTY_ASSERTION_HISTORY_SEED_SQL,
  ...PARTY_ASSERTION_HISTORY_RETARGET_SQL,
];

/**
 * Copies every legacy `DISPLAY_NAME` assertion, whole-row, into the archive. `to_jsonb(row)` keeps the
 * original fact kind, state, currency flags, timestamps, evidence, acceptance and provenance exactly.
 * A collision with an already-archived identity aborts the transaction rather than overwriting evidence.
 */
export const PARTY_ASSERTION_HISTORY_ARCHIVE_SQL = `with archived as (
	insert into "party"."party_historical_name_assertions" ("assertion_id", "tenant_id", "party_id", "original_assertion")
	select assertion.assertion_id, assertion.tenant_id, assertion.party_id, to_jsonb(assertion)
	from "party"."party_fact_assertions" as assertion
	where assertion.fact_kind = 'DISPLAY_NAME'
	returning 1
)
select count(*)::integer as archived from archived;`;

/** Removes a current-store copy only when the archive holds its exact bytes, tenant and party. */
export const PARTY_ASSERTION_HISTORY_REMOVE_SQL = `with removed as (
	delete from "party"."party_fact_assertions" as assertion
	using "party"."party_historical_name_assertions" as archived
	where archived.assertion_id = assertion.assertion_id
		and archived.tenant_id = assertion.tenant_id
		and archived.party_id = assertion.party_id
		and archived.original_assertion = to_jsonb(assertion)
		and assertion.fact_kind = 'DISPLAY_NAME'
	returning 1
)
select count(*)::integer as removed from removed;`;

/** Nothing legacy may survive, no identity may be both current and archived, and no copy may be foreign. */
export const PARTY_ASSERTION_HISTORY_CONSERVATION_SQL = `select
	(select count(*)::integer
		from "party"."party_fact_assertions" as assertion
		where assertion.fact_kind = 'DISPLAY_NAME') as remaining,
	(select count(*)::integer
		from "party"."party_historical_name_assertions" as archived
		inner join "party"."party_fact_assertions" as assertion
			on assertion.assertion_id = archived.assertion_id) as collisions,
	(select count(*)::integer
		from "party"."party_historical_name_assertions" as archived
		where archived.original_assertion ->> 'fact_kind' is distinct from 'DISPLAY_NAME') as "foreignKind";`;

const AssertionHistoryConservationSchema = Schema.Struct({
  collisions: Schema.Literal(0),
  foreignKind: Schema.Literal(0),
  remaining: Schema.Literal(0),
});

/** Drain deferred archive checks before the native migration reinstalls the same table triggers. */
export const PARTY_ASSERTION_HISTORY_VALIDATE_SQL =
  'set constraints "party"."party_historical_name_assertions_collision" immediate';
export const PARTY_ASSERTION_HISTORY_DEFER_SQL =
  'set constraints "party"."party_historical_name_assertions_collision" deferred';

export const preparePartyStructuredNames = Effect.fn('preparePartyStructuredNames')(
  function* preparePartyStructuredNamesEffect(client: PgClient.PgClient) {
    return yield* client
      .withTransaction(
        Effect.gen(function* preparePartyStructuredNamesTransactionEffect() {
          const probe = yield* query<{ assertions: boolean; present: boolean; registered: boolean }>(
            client,
            PARTY_STRUCTURED_NAMES_PROBE_SQL,
            PROBE_FAILED,
          );
          const [probed] = probe;
          if (probed?.present !== true) {
            return 'absent' satisfies PartyStructuredNamesState;
          }
          const prepared = yield* query<{ prepared: number }>(
            client,
            PARTY_STRUCTURED_NAMES_PREPARATION_SQL,
            PREPARATION_FAILED,
          );
          const snapshotPrepared = (prepared[0]?.prepared ?? 0) > 0;
          if (!probed.assertions) {
            return snapshotPrepared
              ? ('prepared' satisfies PartyStructuredNamesState)
              : ('unchanged' satisfies PartyStructuredNamesState);
          }
          yield* Effect.forEach(
            PARTY_ASSERTION_HISTORY_STRUCTURE_SQL,
            (statement) => execute(client, statement, STRUCTURE_FAILED),
            { concurrency: 1, discard: true },
          );
          yield* execute(client, PARTY_ASSERTION_HISTORY_SEED_SQL, REGISTRATION_FAILED);
          const registration = yield* query<{ unregistered: number }>(
            client,
            PARTY_ASSERTION_HISTORY_REGISTRATION_SQL,
            REGISTRATION_FAILED,
          );
          if ((registration[0]?.unregistered ?? 0) > 0) {
            return yield* invariantFailure(REGISTRATION_FAILED);
          }
          yield* Effect.forEach(
            PARTY_ASSERTION_HISTORY_RETARGET_SQL,
            (statement) => execute(client, statement, RETARGET_FAILED),
            { concurrency: 1, discard: true },
          );
          const archived = yield* query<{ archived: number }>(
            client,
            PARTY_ASSERTION_HISTORY_ARCHIVE_SQL,
            ARCHIVE_FAILED,
          );
          const removed = yield* query<{ removed: number }>(client, PARTY_ASSERTION_HISTORY_REMOVE_SQL, ARCHIVE_FAILED);
          const archivedCount = archived[0]?.archived ?? 0;
          const removedCount = removed[0]?.removed ?? 0;
          if (archivedCount !== removedCount) {
            return yield* invariantFailure(ARCHIVE_FAILED);
          }
          const conservation = yield* query<{ collisions: number; foreignKind: number; remaining: number }>(
            client,
            PARTY_ASSERTION_HISTORY_CONSERVATION_SQL,
            CONSERVATION_FAILED,
          );
          const [conserved] = conservation;
          if (!Schema.is(AssertionHistoryConservationSchema)(conserved)) {
            return yield* invariantFailure(CONSERVATION_FAILED);
          }
          yield* execute(client, PARTY_ASSERTION_HISTORY_VALIDATE_SQL, CONSERVATION_FAILED);
          yield* execute(client, PARTY_ASSERTION_HISTORY_DEFER_SQL, CONSERVATION_FAILED);
          if (snapshotPrepared || archivedCount > 0) {
            return 'prepared' satisfies PartyStructuredNamesState;
          }
          return probed.registered
            ? ('unchanged' satisfies PartyStructuredNamesState)
            : ('installed' satisfies PartyStructuredNamesState);
        }),
      )
      .pipe(
        Effect.catchTag('SqlError', (cause) =>
          Effect.fail(databaseFailure('PostgreSQL transaction control failed', cause)),
        ),
      );
  },
);
