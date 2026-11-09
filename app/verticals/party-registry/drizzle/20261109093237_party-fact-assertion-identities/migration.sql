create table if not exists "party"."party_fact_assertion_identities" (
	"assertion_id" uuid primary key,
	"tenant_id" uuid not null,
	"party_id" uuid not null,
	constraint "party_fact_assertion_identities_tenant_assertion_uk" unique ("tenant_id", "assertion_id"),
	constraint "party_fact_assertion_identities_tenant_party_fk" foreign key ("tenant_id", "party_id")
		references "party"."parties" ("tenant_id", "party_id") on delete restrict
);--> statement-breakpoint
create table if not exists "party"."party_historical_name_assertions" (
	"assertion_id" uuid primary key,
	"tenant_id" uuid not null,
	"party_id" uuid not null,
	"original_assertion" jsonb not null,
	"archived_at" timestamp with time zone default now() not null,
	constraint "party_historical_name_assertions_tenant_assertion_fk" foreign key ("tenant_id", "assertion_id")
		references "party"."party_fact_assertion_identities" ("tenant_id", "assertion_id") on delete restrict
);--> statement-breakpoint
do $block$
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
$block$;--> statement-breakpoint
do $block$
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
$block$;--> statement-breakpoint
create or replace function "party"."register_party_fact_assertion_identity"()
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
$routine$;--> statement-breakpoint
create or replace function "party"."guard_party_historical_name_assertion"()
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
$routine$;--> statement-breakpoint
create or replace function "party"."reject_party_historical_name_assertion_collision"()
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
$routine$;--> statement-breakpoint
drop trigger if exists "party_fact_assertions_identity_registration" on "party"."party_fact_assertions";--> statement-breakpoint
create trigger "party_fact_assertions_identity_registration"
before insert or update of assertion_id, tenant_id, party_id on "party"."party_fact_assertions"
for each row execute function "party"."register_party_fact_assertion_identity"();--> statement-breakpoint
drop trigger if exists "party_historical_name_assertions_guard" on "party"."party_historical_name_assertions";--> statement-breakpoint
create trigger "party_historical_name_assertions_guard"
before insert or update or delete on "party"."party_historical_name_assertions"
for each row execute function "party"."guard_party_historical_name_assertion"();--> statement-breakpoint
drop trigger if exists "party_historical_name_assertions_collision" on "party"."party_historical_name_assertions";--> statement-breakpoint
create constraint trigger "party_historical_name_assertions_collision"
after insert on "party"."party_historical_name_assertions"
deferrable initially deferred
for each row execute function "party"."reject_party_historical_name_assertion_collision"();--> statement-breakpoint
revoke execute on function
	"party"."register_party_fact_assertion_identity"(),
	"party"."guard_party_historical_name_assertion"(),
	"party"."reject_party_historical_name_assertion_collision"()
from public;--> statement-breakpoint
insert into "party"."party_fact_assertion_identities" ("assertion_id", "tenant_id", "party_id")
select assertion.assertion_id, assertion.tenant_id, assertion.party_id
from "party"."party_fact_assertions" as assertion
where not exists (
	select 1 from "party"."party_fact_assertion_identities" as identity
	where identity.assertion_id = assertion.assertion_id
);--> statement-breakpoint
alter table "party"."party_fact_assertions"
	drop constraint if exists "party_fact_assertions_tenant_supersedes_fk",
	add constraint "party_fact_assertions_tenant_supersedes_fk"
		foreign key ("tenant_id", "supersedes_assertion_id")
		references "party"."party_fact_assertion_identities" ("tenant_id", "assertion_id") on delete restrict;--> statement-breakpoint
alter table "party"."party_fact_assertions"
	drop constraint if exists "party_fact_assertions_tenant_retracts_fk",
	add constraint "party_fact_assertions_tenant_retracts_fk"
		foreign key ("tenant_id", "retracts_assertion_id")
		references "party"."party_fact_assertion_identities" ("tenant_id", "assertion_id") on delete restrict;--> statement-breakpoint
alter table "party"."party_corrections"
	drop constraint if exists "party_corrections_tenant_fact_fk",
	add constraint "party_corrections_tenant_fact_fk"
		foreign key ("tenant_id", "party_fact_assertion_id")
		references "party"."party_fact_assertion_identities" ("tenant_id", "assertion_id") on delete restrict;--> statement-breakpoint
alter table "party"."party_corrections"
	drop constraint if exists "party_corrections_tenant_replacement_fact_fk",
	add constraint "party_corrections_tenant_replacement_fact_fk"
		foreign key ("tenant_id", "replacement_party_fact_assertion_id")
		references "party"."party_fact_assertion_identities" ("tenant_id", "assertion_id") on delete restrict;
