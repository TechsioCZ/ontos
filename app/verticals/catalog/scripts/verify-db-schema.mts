// @effect-diagnostics globalConsole:off nodeBuiltinImport:off -- Operator-only database verification adapts the PostgreSQL driver at the infrastructure edge; expires: 2027-03-31.
import { fileURLToPath } from 'node:url';
import { NodeFileSystem } from '@effect/platform-node';
import { FileSystem } from 'effect/FileSystem';

import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { PgClient } from '@effect/sql-pg';
import { Array as EffectArray, Console, Effect, Exit, Order, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';

import { compareCatalogTables } from '../src/database/catalog.ts';
import { CATALOG_SCHEMA_NAME, CATALOG_TABLES } from '../src/database/schema.ts';

class CatalogSchemaVerificationError extends Schema.TaggedError<CatalogSchemaVerificationError>()(
  'CatalogSchemaVerificationError',
  { reason: Schema.String },
) {}

const expectedColumns = EffectArray.sort(
  CATALOG_TABLES.flatMap((table) => {
    const config = getTableConfig(table);
    return config.columns.map((column) => `${config.name}.${column.name}`);
  }),
  Order.String,
);

const pointersAreCurrent = (pointers: {
  assignment_mismatch: number;
  attribute_definition_mismatch: number;
  attribute_value_mismatch: number;
  axis_mismatch: number;
  brand_mismatch: number;
  category_mismatch: number;
  commercial_gtin_mismatch: number;
  commercial_sku_mismatch: number;
  configuration_activation_mismatch: number;
  configuration_definition_mismatch: number;
  controlled_value_mismatch: number;
  counter_mismatch: number;
  manufacturer_mismatch: number;
  media_assignment_mismatch: number;
  media_set_mismatch: number;
  package_mismatch: number;
  package_option_mismatch: number;
  package_unit_mismatch: number;
  package_unit_reference_mismatch: number;
  product_brand_mismatch: number;
  product_locale_mismatch: number;
  product_size_usage_mismatch: number;
  relationship_mismatch: number;
  set_composition_mismatch: number;
  source_override_mismatch: number;
  type_mismatch: number;
  unit_rule_mismatch: number;
  variant_axis_integrity_mismatch: number;
  variant_locale_mismatch: number;
  variant_mismatch: number;
  variant_unit_mismatch: number;
}) => Object.values(pointers).every((count) => count === 0);

interface InfrastructureRow {
  readonly forced_rls: number;
  readonly foreign_key_count: number;
  readonly journal_count: number;
  readonly policy_count: number;
  readonly result_snapshot_guard_count: number;
  readonly trigger_count: number;
  readonly validated_combination_count: number;
}
const infrastructureCounts = (row: InfrastructureRow | undefined) =>
  row === undefined
    ? undefined
    : [
        row.forced_rls,
        row.journal_count,
        row.policy_count,
        row.result_snapshot_guard_count,
        row.trigger_count,
        row.validated_combination_count,
        row.foreign_key_count,
      ];
const sameInventory = (actual: readonly number[] | undefined, expected: readonly number[]) =>
  actual !== undefined && actual.every((value, index) => value === expected[index]);

const verification = Effect.gen(function* verifyCatalogDatabase() {
  const configuration = yield* loadDatabaseConnectionPair();
  const client = yield* PgClient.makeClient({ url: Redacted.make(configuration.admin.connectionString) }).pipe(
    Effect.mapError(() => new CatalogSchemaVerificationError({ reason: 'Unable to connect to the Catalog database' })),
  );
  const inspect = <Row extends object>(reason: string, statement: string) =>
    client.unsafe<Row>(statement).pipe(Effect.mapError(() => new CatalogSchemaVerificationError({ reason })));
  // Typed Drizzle definitions define the complete inventory; catalog queries verify deployment metadata only.
  for (const table of CATALOG_TABLES) {
    const config = getTableConfig(table);
    yield* inspect(`Catalog table ${config.name} is unavailable`, `select * from "catalog"."${config.name}" limit 0`);
  }
  const tables = yield* inspect<{ table_name: string }>(
    'Unable to inspect Catalog tables',
    "select table_name from information_schema.tables where table_schema = 'catalog' and table_type = 'BASE TABLE' order by table_name",
  );
  const difference = compareCatalogTables(tables.map((row) => `${CATALOG_SCHEMA_NAME}.${row.table_name}`));
  if (difference.missing.length > 0 || difference.unexpected.length > 0) {
    yield* new CatalogSchemaVerificationError({
      reason: `Catalog table mismatch; missing=[${difference.missing.join(', ')}], unexpected=[${difference.unexpected.join(', ')}]`,
    });
  }
  const columns = yield* inspect<{ column_name: string; table_name: string }>(
    'Unable to inspect Catalog columns',
    "select table_name, column_name from information_schema.columns where table_schema = 'catalog' order by table_name, column_name",
  );
  const actualColumns = EffectArray.sort(
    columns.map((row) => `${row.table_name}.${row.column_name}`),
    Order.String,
  );
  if (
    actualColumns.length !== expectedColumns.length ||
    actualColumns.some((column, index) => column !== expectedColumns[index])
  ) {
    yield* new CatalogSchemaVerificationError({
      reason: 'Catalog column inventory does not match the typed schema',
    });
  }
  const [gateway] = yield* client.unsafe<{ readonly valid: boolean }>(`select (
  (select count(*) = 1 from pg_catalog.pg_class relation join pg_catalog.pg_namespace ns on ns.oid=relation.relnamespace
    where ns.nspname='catalog' and relation.relname='gateway_assertion_redemptions' and relation.relkind='r'
      and not relation.relrowsecurity and not relation.relforcerowsecurity)
  and (select count(*) = 5 from information_schema.columns where table_schema='catalog' and table_name='gateway_assertion_redemptions'
    and is_nullable='NO' and ((column_name in ('issuer','audience') and data_type='text')
      or (column_name='jti' and data_type='uuid')
      or (column_name in ('expires_at','redeemed_at') and data_type='timestamp with time zone')))
  and (select count(*) = 1 from pg_catalog.pg_constraint c join pg_catalog.pg_class t on t.oid=c.conrelid
    join pg_catalog.pg_namespace ns on ns.oid=t.relnamespace where ns.nspname='catalog' and t.relname='gateway_assertion_redemptions'
      and c.contype='u' and pg_catalog.pg_get_constraintdef(c.oid)='UNIQUE (issuer, audience, jti)')
  and (select count(*) = 1 from pg_catalog.pg_indexes where schemaname='catalog' and tablename='gateway_assertion_redemptions'
    and indexdef like '% USING btree (expires_at)')
  and has_table_privilege('ontos_runtime','catalog.gateway_assertion_redemptions','SELECT')
  and has_table_privilege('ontos_runtime','catalog.gateway_assertion_redemptions','INSERT')
  and has_table_privilege('ontos_runtime','catalog.gateway_assertion_redemptions','DELETE')
  and not has_table_privilege('ontos_runtime','catalog.gateway_assertion_redemptions','UPDATE')
  and not has_table_privilege('ontos_runtime','catalog.gateway_assertion_redemptions','REFERENCES')
  and not has_table_privilege('ontos_runtime','catalog.gateway_assertion_redemptions','TRUNCATE')
  and not has_table_privilege('ontos_runtime','catalog.gateway_assertion_redemptions','TRIGGER')
  and not exists(select 1 from pg_catalog.pg_class t join pg_catalog.pg_namespace ns on ns.oid=t.relnamespace,
    lateral pg_catalog.aclexplode(coalesce(t.relacl,pg_catalog.acldefault('r',t.relowner))) acl
    where ns.nspname='catalog' and t.relname='gateway_assertion_redemptions' and acl.grantee=0)
  and not exists(select 1 from pg_catalog.pg_roles where rolname='ontos_runtime' and (rolsuper or rolbypassrls))
) as valid`);
  if (!gateway?.valid) {
    yield* new CatalogSchemaVerificationError({
      reason: 'Gateway assertion redemption shape, replay identity, expiry index or exact privileges mismatch',
    });
  }
  const infrastructure = yield* inspect<{
    forced_rls: number;
    foreign_key_count: number;
    journal_count: number;
    policy_count: number;
    result_snapshot_guard_count: number;
    trigger_count: number;
    validated_combination_count: number;
  }>(
    'Unable to inspect Catalog security metadata',
    `select
      (select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='catalog' and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity) forced_rls,
      (select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='drizzle' and c.relname='__drizzle_migrations_catalog') journal_count,
      (select count(*)::integer from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='catalog') policy_count,
      (select count(*)::integer from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='catalog' and not t.tgisinternal) trigger_count,
      (select count(*)::integer from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='catalog' and c.relname='catalog_result_snapshots'
          and t.tgname='catalog_result_snapshots_append_only' and t.tgenabled='O'
          and (t.tgtype & 16) = 16 and (t.tgtype & 8) = 8) result_snapshot_guard_count,
      (select count(*)::integer from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='catalog' and k.contype='f') foreign_key_count,
      (select count(*)::integer from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='catalog' and c.relname='product_variants' and k.conname='catalog_product_variants_combination_ck' and k.convalidated) validated_combination_count`,
  );
  const [row] = infrastructure;
  const expectedPolicyCount = CATALOG_TABLES.reduce((count, table) => count + getTableConfig(table).policies.length, 0);
  const expectedForeignKeyCount = CATALOG_TABLES.reduce(
    (count, table) => count + getTableConfig(table).foreignKeys.length,
    0,
  );
  // 78 existing triggers plus accepted-source and override-ledger guards and the mutable-head identity guard.
  const expectedTriggerCount = 81;
  const expectedInfrastructure = [
    CATALOG_TABLES.filter((table) => getTableConfig(table).name !== 'gateway_assertion_redemptions').length,
    1,
    expectedPolicyCount,
    1,
    expectedTriggerCount,
    1,
    expectedForeignKeyCount,
  ];
  if (!sameInventory(infrastructureCounts(row), expectedInfrastructure)) {
    yield* new CatalogSchemaVerificationError({
      reason: 'Catalog RLS, journal, trigger, or foreign-key inventory differs from its migration',
    });
  }
  const mediaPositionGuards = yield* inspect<{ valid: boolean }>(
    'Unable to inspect Catalog media commit-time position uniqueness',
    `select (
      k.contype = 'u' and k.condeferrable and k.condeferred and k.convalidated
      and i.indisunique and i.indisvalid and i.indisready and not i.indnullsnotdistinct
      and i.indpred is null
      and (select array_agg(a.attname::text order by key.ordinality)
        from unnest(k.conkey) with ordinality as key(attnum, ordinality)
        join pg_attribute a on a.attrelid=k.conrelid and a.attnum=key.attnum)
        = array['tenant_id','assignment_set_id','resource_kind','active_position']::text[]
      and exists (select 1 from pg_attribute a join pg_attrdef d
        on d.adrelid=a.attrelid and d.adnum=a.attnum
        where a.attrelid=k.conrelid and a.attname='active_position'
          and a.attgenerated='s' and not a.attnotnull and a.atttypid='integer'::regtype
          and translate(regexp_replace(pg_get_expr(d.adbin,d.adrelid), '[[:space:]]', '', 'g'), '()"', '')
            = 'CASEWHENstate=''ACTIVE''::textTHENpositionELSENULL::integerEND')
      and not exists (select 1 from pg_class old_index join pg_namespace old_ns
        on old_ns.oid=old_index.relnamespace
        where old_ns.nspname='catalog' and old_index.relname='catalog_media_assignments_active_position_uk')
    ) valid
    from pg_constraint k join pg_class c on c.oid=k.conrelid
      join pg_namespace n on n.oid=c.relnamespace join pg_index i on i.indexrelid=k.conindid
    where n.nspname='catalog' and c.relname='catalog_media_assignments'
      and k.conname='catalog_media_assignments_active_position_commit_uk'`,
  );
  if (mediaPositionGuards.length !== 1 || !mediaPositionGuards[0]?.valid) {
    yield* new CatalogSchemaVerificationError({
      reason: 'Catalog media final-position uniqueness is not the expected deferred generated-key constraint',
    });
  }
  yield* Effect.gen(function* verifySetPublishedHeadGuard() {
    const fs = yield* FileSystem;
    const setHeadSql = yield* fs
      .readFileString(
        fileURLToPath(
          new URL('../drizzle/20261020103114_set_successor_publication_head/migration.sql', import.meta.url),
        ),
      )
      .pipe(
        Effect.mapError(
          () => new CatalogSchemaVerificationError({ reason: 'Catalog Set head migration is unreadable' }),
        ),
      );
    const expectedSetHeadBody = setHeadSql.split('AS $$')[1]?.split('$$;')[0];
    const setHeadGuards = yield* inspect<{ body: string; retained_trigger: boolean }>(
      'Unable to inspect the Catalog Set published-head guard',
      `select p.prosrc as body,
        (t.tgdeferrable and t.tginitdeferred and t.tgenabled='O' and t.tgtype=21
          and t.tgconstraint<>0 and not t.tgisinternal and not p.prosecdef
          and p.proconfig is null and p.prorettype='trigger'::regtype
          and p.pronargs=0 and l.lanname='plpgsql') as retained_trigger
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        join pg_language l on l.oid=p.prolang
        join pg_trigger t on t.tgfoid=p.oid
        join pg_class c on c.oid=t.tgrelid
        join pg_namespace tn on tn.oid=c.relnamespace
        where n.nspname='catalog' and p.proname='validate_set_composition_current'
          and tn.nspname='catalog' and c.relname='set_compositions'
          and t.tgname='catalog_set_compositions_current_revision_valid'`,
    );
    const [setHeadGuard] = setHeadGuards;
    if (
      expectedSetHeadBody === undefined ||
      setHeadGuards.length !== 1 ||
      setHeadGuard === undefined ||
      !setHeadGuard.retained_trigger ||
      setHeadGuard.body.trim() !== expectedSetHeadBody.trim()
    ) {
      yield* new CatalogSchemaVerificationError({
        reason: 'Catalog Set published-head function or deferred trigger differs',
      });
    }
  });
  const creationReasons = yield* inspect<{ definition: string; is_nullable: string; table_name: string }>(
    'Unable to inspect Catalog creation reason guards',
    `select col.table_name,col.is_nullable,pg_get_constraintdef(k.oid,true) as definition
       from information_schema.columns col
       join pg_namespace n on n.nspname=col.table_schema
       join pg_class c on c.relnamespace=n.oid and c.relname=col.table_name
       join pg_constraint k on k.conrelid=c.oid and k.conname='catalog_'||col.table_name||'_reason_ck'
       where col.table_schema='catalog' and col.table_name in ('product_revisions','product_variant_revisions')
         and col.column_name='reason'`,
  );
  if (
    creationReasons.length !== 2 ||
    creationReasons.some(
      (reasonGuard) =>
        reasonGuard.is_nullable !== 'YES' ||
        !reasonGuard.definition.includes("'CREATED'") ||
        !reasonGuard.definition.includes('reason IS NOT NULL') ||
        !reasonGuard.definition.includes('reason IS NULL'),
    )
  ) {
    yield* new CatalogSchemaVerificationError({ reason: 'Catalog CREATED-only nullable reason guards are absent' });
  }
  const skuIndex = yield* inspect<{ index_definition: string }>(
    'Unable to inspect Catalog SKU uniqueness',
    `select pg_get_indexdef(i.indexrelid) index_definition
        from pg_index i join pg_class c on c.oid=i.indexrelid
        join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='catalog' and c.relname='catalog_sku_reservations_binary_code_uk' and i.indisunique and i.indisvalid`,
  );
  if (skuIndex.length !== 1 || !skuIndex[0]?.index_definition.includes('(tenant_id, normalized_code COLLATE "C")')) {
    yield* new CatalogSchemaVerificationError({ reason: 'Catalog SKU tenant-wide binary uniqueness is absent' });
  }
  const skuCodes = yield* inspect<{ display_code: string; normalized_code: string }>(
    'Unable to inspect Catalog SKU normalization',
    `select display_code, normalized_code
        from catalog.commercial_sku_reservations
        union all
        select display_code, normalized_code from catalog.commercial_sku_assignment_revisions`,
  );
  if (skuCodes.some(({ display_code, normalized_code }) => display_code.trim().toUpperCase() !== normalized_code)) {
    yield* new CatalogSchemaVerificationError({
      reason: 'Catalog SKU normalization differs from the application rule',
    });
  }
  const currentPointers = yield* inspect<{
    assignment_mismatch: number;
    attribute_definition_mismatch: number;
    attribute_value_mismatch: number;
    axis_mismatch: number;
    brand_mismatch: number;
    category_mismatch: number;
    commercial_gtin_mismatch: number;
    commercial_sku_mismatch: number;
    configuration_activation_mismatch: number;
    configuration_definition_mismatch: number;
    controlled_value_mismatch: number;
    counter_mismatch: number;
    manufacturer_mismatch: number;
    media_assignment_mismatch: number;
    media_set_mismatch: number;
    package_mismatch: number;
    package_option_mismatch: number;
    package_unit_mismatch: number;
    package_unit_reference_mismatch: number;
    product_brand_mismatch: number;
    product_locale_mismatch: number;
    product_size_usage_mismatch: number;
    relationship_mismatch: number;
    set_composition_mismatch: number;
    source_override_mismatch: number;
    type_mismatch: number;
    unit_rule_mismatch: number;
    variant_axis_integrity_mismatch: number;
    variant_locale_mismatch: number;
    variant_mismatch: number;
    variant_unit_mismatch: number;
  }>(
    'Unable to inspect Catalog revision pointers',
    `select
      (select count(*)::integer from catalog.commercial_sku_reservations s where not exists
        (select 1 from catalog.commercial_sku_assignment_revisions r
          where r.tenant_id=s.tenant_id and r.normalized_code=s.normalized_code
            and r.revision=s.current_revision and r.display_code=s.display_code
            and r.product_id=s.product_id and r.variant_id=s.variant_id
            and r.package_definition_id is not distinct from s.package_definition_id and r.state=s.state)
        or s.current_revision <> (select max(r.revision) from catalog.commercial_sku_assignment_revisions r
          where r.tenant_id=s.tenant_id and r.normalized_code=s.normalized_code)) commercial_sku_mismatch,
      (select count(*)::integer from catalog.commercial_gtin_assignments g where not exists
        (select 1 from catalog.commercial_gtin_assignment_revisions r
          where r.tenant_id=g.tenant_id and r.gtin=g.gtin and r.revision=g.current_revision
            and r.product_id=g.product_id and r.variant_id=g.variant_id
            and r.package_definition_id is not distinct from g.package_definition_id and r.state=g.state)
        or g.current_revision <> (select max(r.revision) from catalog.commercial_gtin_assignment_revisions r
          where r.tenant_id=g.tenant_id and r.gtin=g.gtin)) commercial_gtin_mismatch,
      (select count(*)::integer from catalog.brands b where not exists
        (select 1 from catalog.brand_revisions r where r.tenant_id=b.tenant_id and r.brand_id=b.brand_id
          and r.revision=b.current_revision and r.name=b.name and r.lifecycle_state=b.lifecycle_state)
        or b.current_revision <> (select max(r.revision) from catalog.brand_revisions r
          where r.tenant_id=b.tenant_id and r.brand_id=b.brand_id)) brand_mismatch,
      (select count(*)::integer from catalog.product_configuration_definitions d where not exists
        (select 1 from catalog.product_configuration_definition_revisions r
          where r.tenant_id=d.tenant_id and r.definition_id=d.definition_id
            and r.product_id=d.product_id and r.revision=d.current_revision)
        or d.current_revision <> (select max(r.revision) from catalog.product_configuration_definition_revisions r
          where r.tenant_id=d.tenant_id and r.definition_id=d.definition_id)) configuration_definition_mismatch,
      (select count(*)::integer from (
        select a.tenant_id, a.definition_id, a.revision, a.superseded_revision, a.effective_at,
          lag(a.revision) over (partition by a.tenant_id, a.definition_id order by a.effective_at) expected_predecessor
        from catalog.product_configuration_revision_activations a
      ) timeline
        join catalog.product_configuration_definition_revisions r
          on r.tenant_id=timeline.tenant_id and r.definition_id=timeline.definition_id
          and r.revision=timeline.revision
        where timeline.superseded_revision is distinct from timeline.expected_predecessor
          or timeline.effective_at <> r.effective_from)
      + (select count(*)::integer from catalog.product_configuration_definition_revisions r
        where not exists (select 1 from catalog.product_configuration_revision_activations a
          where a.tenant_id=r.tenant_id and a.definition_id=r.definition_id
            and a.revision=r.revision)) configuration_activation_mismatch,
      (select count(*)::integer from catalog.product_brand_assignments a where not exists
        (select 1 from catalog.product_brand_assignment_revisions r where r.tenant_id=a.tenant_id
          and r.product_id=a.product_id and r.revision=a.current_revision and r.claim_kind=a.claim_kind
          and r.brand_id is not distinct from a.brand_id and r.evidence_ref is not distinct from a.evidence_ref)
        or a.current_revision <> (select max(r.revision) from catalog.product_brand_assignment_revisions r
          where r.tenant_id=a.tenant_id and r.product_id=a.product_id)) product_brand_mismatch,
      (select count(*)::integer from catalog.manufacturer_relations m where not exists
        (select 1 from catalog.manufacturer_relation_revisions r where r.tenant_id=m.tenant_id
          and r.relation_id=m.relation_id and r.revision=m.current_revision
          and r.product_id is not distinct from m.product_id and r.variant_id is not distinct from m.variant_id
          and r.target_kind=m.target_kind and r.target_id=m.target_id and r.disposition=m.disposition
          and r.effective_from is not distinct from m.effective_from and r.effective_to is not distinct from m.effective_to
          and r.reason=m.reason and r.evidence_refs=m.evidence_refs)
        or m.current_revision <> (select max(r.revision) from catalog.manufacturer_relation_revisions r
          where r.tenant_id=m.tenant_id and r.relation_id=m.relation_id)) manufacturer_mismatch,
      (select count(*)::integer from catalog.product_type_assignments a
        where not exists (select 1 from catalog.product_type_assignment_events e
          where e.tenant_id=a.tenant_id and e.product_id=a.product_id
            and e.assignment_revision=a.assignment_revision
            and e.next_product_type_id=a.product_type_id
            and not exists (select 1 from catalog.product_type_assignment_events newer
              where newer.tenant_id=e.tenant_id and newer.product_id=e.product_id
                and newer.assignment_revision > e.assignment_revision)))
      + (select count(*)::integer from catalog.product_type_assignment_events e
        where e.next_product_type_id is not null
          and not exists (select 1 from catalog.product_type_assignment_events newer
            where newer.tenant_id=e.tenant_id and newer.product_id=e.product_id
              and newer.assignment_revision > e.assignment_revision)
          and not exists (select 1 from catalog.product_type_assignments a
            where a.tenant_id=e.tenant_id and a.product_id=e.product_id
              and a.assignment_revision=e.assignment_revision and a.product_type_id=e.next_product_type_id)) assignment_mismatch,
      (select count(*)::integer from catalog.product_types t
        where not exists (select 1 from catalog.product_type_revisions r
          where r.tenant_id=t.tenant_id and r.product_type_id=t.product_type_id and r.revision=t.current_revision)
          or t.current_revision <> (select max(r.revision) from catalog.product_type_revisions r
            where r.tenant_id=t.tenant_id and r.product_type_id=t.product_type_id)) type_mismatch,
      (select count(*)::integer from catalog.attribute_definitions d
        where not exists (select 1 from catalog.attribute_definition_revisions r
          where r.tenant_id=d.tenant_id and r.attribute_definition_id=d.attribute_definition_id
            and r.revision=d.current_revision and r.name=d.name and r.value_kind=d.value_kind
            and r.meaning=d.meaning and r.controlled_value_kind is not distinct from d.controlled_value_kind
            and r.multiplicity=d.multiplicity and r.applicable_levels=d.applicable_levels
            and r.measured_quantity is not distinct from d.measured_quantity
            and r.canonical_unit is not distinct from d.canonical_unit
            and r.minimum_value is not distinct from d.minimum_value
            and r.maximum_value is not distinct from d.maximum_value
            and r.decimal_places is not distinct from d.decimal_places
            and r.allows_unknown=d.allows_unknown and r.allows_not_applicable=d.allows_not_applicable
            and r.allows_none=d.allows_none)) attribute_definition_mismatch,
      (select count(*)::integer from catalog.controlled_attribute_values v
        where not exists (select 1 from catalog.controlled_attribute_value_revisions r
          where r.tenant_id=v.tenant_id and r.controlled_attribute_value_id=v.controlled_attribute_value_id
            and r.attribute_definition_id=v.attribute_definition_id and r.revision=v.current_revision
            and r.name=v.name and r.meaning=v.meaning and r.specialization=v.specialization
            and r.lifecycle_state=v.lifecycle_state
            and r.color_group is not distinct from v.color_group
            and r.swatch_system is not distinct from v.swatch_system
            and r.swatch_code is not distinct from v.swatch_code
            and r.preview_hex is not distinct from v.preview_hex
            and r.preview_evidence_ref is not distinct from v.preview_evidence_ref)) controlled_value_mismatch,
      (select count(*)::integer from catalog.attribute_value_sets s
        where not exists (select 1 from catalog.attribute_value_revisions r
          where r.tenant_id=s.tenant_id and r.attribute_value_set_id=s.attribute_value_set_id
            and r.revision=s.current_revision and r.change_kind=s.current_state)
          or s.current_revision <> (select max(r.revision) from catalog.attribute_value_revisions r
            where r.tenant_id=s.tenant_id and r.attribute_value_set_id=s.attribute_value_set_id)
          or (s.current_state='REMOVED' and exists (select 1 from catalog.attribute_value_items i
            where i.tenant_id=s.tenant_id and i.attribute_value_set_id=s.attribute_value_set_id))) attribute_value_mismatch,
      (select count(*)::integer from catalog.product_relationships p
        where not exists (select 1 from catalog.product_relationship_revisions r
          where r.tenant_id=p.tenant_id and r.relationship_id=p.relationship_id
            and r.revision=p.current_revision and r.relationship_type=p.relationship_type
            and r.source_product_id is not distinct from p.source_product_id
            and r.source_variant_id is not distinct from p.source_variant_id
            and r.target_product_id is not distinct from p.target_product_id
            and r.target_variant_id is not distinct from p.target_variant_id
            and r.effective_from is not distinct from p.effective_from
            and r.effective_to is not distinct from p.effective_to)
          or p.current_revision <> (select max(r.revision) from catalog.product_relationship_revisions r
            where r.tenant_id=p.tenant_id and r.relationship_id=p.relationship_id)) relationship_mismatch,
      (select count(*)::integer from catalog.set_compositions s
        where not exists (select 1 from catalog.set_composition_revisions r
          where r.tenant_id=s.tenant_id and r.composition_id=s.composition_id
            and r.product_id=s.product_id and r.variant_id=s.variant_id
            and r.revision=s.current_revision
            and (s.current_revision > 1 or (r.effective_from <= now()
              and (r.effective_to is null or r.effective_to > now()))))
          or exists (select 1 from catalog.set_composition_revisions r
            where r.tenant_id=s.tenant_id and r.composition_id=s.composition_id
              and r.revision=s.current_revision and r.lifecycle_state='ACTIVE'
              and (select count(*) from catalog.set_composition_components c
                where c.tenant_id=r.tenant_id and c.composition_id=r.composition_id
                  and c.revision=r.revision) < 2)) set_composition_mismatch,
      (select count(*)::integer from catalog.product_variants v
        where not exists (select 1 from catalog.product_variant_revisions r
          where r.tenant_id=v.tenant_id and r.variant_id=v.variant_id and r.revision=v.current_revision
            and r.product_id=v.product_id and r.lifecycle_state=v.lifecycle_state
            and r.combination_key is not distinct from v.combination_key
            and r.combination_axis_revision is not distinct from v.combination_axis_revision)
          or v.current_revision <> (select max(r.revision) from catalog.product_variant_revisions r
            where r.tenant_id=v.tenant_id and r.variant_id=v.variant_id)) variant_mismatch,
      (select count(*)::integer from catalog.product_variant_axes a
        where not exists (select 1 from catalog.product_variant_axis_events e
          where e.tenant_id=a.tenant_id and e.product_id=a.product_id and e.axis_revision=a.axis_revision
            and e.attribute_definition_ids[a.ordinal + 1] = a.attribute_definition_id)
          or a.axis_revision <> (select max(e.axis_revision) from catalog.product_variant_axis_events e
            where e.tenant_id=a.tenant_id and e.product_id=a.product_id)) axis_mismatch,
      (select count(*)::integer from catalog.product_variants v
        where v.lifecycle_state='ACTIVE' and (v.combination_key is null
          or v.combination_axis_revision is null or length(v.combination_key) <> 64
          or v.combination_key !~ '^[0-9a-f]{64}$'
          or v.combination_axis_revision is distinct from (
            select max(e.axis_revision) from catalog.product_variant_axis_events e
            where e.tenant_id=v.tenant_id and e.product_id=v.product_id)))
      + (select count(*)::integer from catalog.product_variant_axis_events e
        where array_position(e.attribute_definition_ids, null) is not null
          or cardinality(e.attribute_definition_ids) <> (
            select count(distinct x.id) from unnest(e.attribute_definition_ids) as x(id))
          or (e.axis_revision = (select max(later.axis_revision) from catalog.product_variant_axis_events later
            where later.tenant_id=e.tenant_id and later.product_id=e.product_id)
            and e.attribute_definition_ids is distinct from coalesce((
              select array_agg(a.attribute_definition_id order by a.ordinal)
              from catalog.product_variant_axes a
              where a.tenant_id=e.tenant_id and a.product_id=e.product_id), array[]::uuid[])))
      + (select count(*)::integer from catalog.product_variant_axes a
        where not exists (select 1 from catalog.product_variant_axis_events e
          where e.tenant_id=a.tenant_id and e.product_id=a.product_id
            and e.axis_revision=a.axis_revision)) variant_axis_integrity_mismatch,
      (select count(*)::integer from catalog.product_categories c
        where not exists (select 1 from catalog.product_category_events e
          where e.tenant_id=c.tenant_id and e.category_id=c.category_id
            and e.category_revision=c.current_revision
            and e.next_name=c.name and e.next_lifecycle_state=c.lifecycle_state
            and e.next_parent_category_id is not distinct from c.parent_category_id
            and e.change_kind in ('CREATED','RENAMED','MOVED','RETIRED'))
          or c.current_revision <> (select max(e.category_revision) from catalog.product_category_events e
            where e.tenant_id=c.tenant_id and e.category_id=c.category_id
              and e.change_kind in ('CREATED','RENAMED','MOVED','RETIRED'))) category_mismatch,
      (select count(*)::integer from catalog.package_definitions d
        where not exists (select 1 from catalog.package_content_revisions r
          where r.tenant_id=d.tenant_id and r.package_definition_id=d.package_definition_id
            and r.revision=d.current_revision and r.product_id=d.product_id and r.variant_id=d.variant_id
            and r.lifecycle_state=d.lifecycle_state)
          or d.current_revision <> (select max(r.revision) from catalog.package_content_revisions r
            where r.tenant_id=d.tenant_id and r.package_definition_id=d.package_definition_id)) package_mismatch,
      (select count(*)::integer from catalog.package_definitions d
        where (d.current_option_revision=0 and d.option_state<>'NOT_SELECTABLE')
          or (d.current_option_revision>0 and (
            not exists (select 1 from catalog.package_option_role_revisions r
              where r.tenant_id=d.tenant_id and r.package_definition_id=d.package_definition_id
                and r.revision=d.current_option_revision and r.state=d.option_state
                and r.product_id=d.product_id and r.variant_id=d.variant_id)
            or d.current_option_revision <> (select max(r.revision) from catalog.package_option_role_revisions r
              where r.tenant_id=d.tenant_id and r.package_definition_id=d.package_definition_id)))
          or (d.current_option_revision=0 and exists (select 1 from catalog.package_option_role_revisions r
            where r.tenant_id=d.tenant_id and r.package_definition_id=d.package_definition_id))) package_option_mismatch,
      (select count(*)::integer from catalog.product_units u
        where not exists (select 1 from catalog.product_unit_rule_revisions r
          where r.tenant_id=u.tenant_id and r.unit_id=u.unit_id and r.revision=u.current_rule_revision
            and r.lifecycle_state=u.lifecycle_state)
          or u.current_rule_revision <> (select max(r.revision) from catalog.product_unit_rule_revisions r
            where r.tenant_id=u.tenant_id and r.unit_id=u.unit_id)) unit_rule_mismatch,
      (select count(*)::integer from catalog.variant_unit_divisibility d
        where not exists (select 1 from catalog.variant_unit_divisibility_revisions r
          where r.tenant_id=d.tenant_id and r.variant_id=d.variant_id and r.revision=d.current_revision
            and r.unit_id=d.unit_id and r.divisible=d.divisible)
          or d.current_revision <> (select max(r.revision) from catalog.variant_unit_divisibility_revisions r
            where r.tenant_id=d.tenant_id and r.variant_id=d.variant_id)) variant_unit_mismatch,
      (select count(*)::integer from catalog.catalog_local_override_heads h
        where not exists (select 1 from catalog.catalog_local_override_revisions r
          where r.tenant_id=h.tenant_id and r.target_kind=h.target_kind and r.target_id=h.target_id
            and r.fact_key=h.fact_key and r.revision=h.latest_revision and r.lifecycle=h.lifecycle)
          or h.latest_revision <> (select max(r.revision) from catalog.catalog_local_override_revisions r
            where r.tenant_id=h.tenant_id and r.target_kind=h.target_kind and r.target_id=h.target_id
              and r.fact_key=h.fact_key)
          or (h.lifecycle='ACTIVE' and h.active_revision is distinct from h.latest_revision)
          or (h.lifecycle='RELEASED' and h.active_revision is not null))
      + (select count(*)::integer from catalog.catalog_local_override_revisions r
        where not exists (select 1 from catalog.catalog_local_override_heads h
          where h.tenant_id=r.tenant_id and h.target_kind=r.target_kind and h.target_id=r.target_id
            and h.fact_key=r.fact_key)) source_override_mismatch,
      (select count(*)::integer from catalog.package_unit_divisibility d
        where not exists (select 1 from catalog.package_unit_divisibility_revisions r
          where r.tenant_id=d.tenant_id and r.package_definition_id=d.package_definition_id
            and r.revision=d.current_revision and r.unit_id=d.unit_id and r.divisible=d.divisible)
          or d.current_revision <> (select max(r.revision) from catalog.package_unit_divisibility_revisions r
            where r.tenant_id=d.tenant_id and r.package_definition_id=d.package_definition_id)) package_unit_mismatch,
      (select count(*)::integer from catalog.package_content_revisions c
        where c.unit_resource_type <> 'commerce.catalog.product-unit'
          or not exists (select 1 from catalog.product_units u
            where u.tenant_id=c.tenant_id and u.unit_id=c.unit_resource_id)) package_unit_reference_mismatch,
      (select count(*)::integer from catalog.product_localized_facts f
        where not exists (select 1 from catalog.product_localized_fact_revisions r
          where r.tenant_id=f.tenant_id and r.product_id=f.product_id and r.locale=f.locale
            and r.revision=f.current_revision and r.state=f.state
            and r.name is not distinct from f.name and r.description is not distinct from f.description)
          or f.current_revision <> (select max(r.revision) from catalog.product_localized_fact_revisions r
            where r.tenant_id=f.tenant_id and r.product_id=f.product_id and r.locale=f.locale)) product_locale_mismatch,
      (select count(*)::integer from catalog.variant_localized_facts f
        where not exists (select 1 from catalog.variant_localized_fact_revisions r
          where r.tenant_id=f.tenant_id and r.product_id=f.product_id and r.variant_id=f.variant_id
            and r.locale=f.locale and r.revision=f.current_revision and r.state=f.state
            and r.name is not distinct from f.name and r.description is not distinct from f.description)
          or f.current_revision <> (select max(r.revision) from catalog.variant_localized_fact_revisions r
            where r.tenant_id=f.tenant_id and r.product_id=f.product_id and r.variant_id=f.variant_id
              and r.locale=f.locale)) variant_locale_mismatch,
      (select count(*)::integer from catalog.catalog_media_assignment_sets s
        where not exists (select 1 from catalog.catalog_media_assignment_set_revisions r
          where r.tenant_id=s.tenant_id and r.assignment_set_id=s.assignment_set_id
            and r.revision=s.current_revision)
          or s.current_revision <> (select max(r.revision) from catalog.catalog_media_assignment_set_revisions r
            where r.tenant_id=s.tenant_id and r.assignment_set_id=s.assignment_set_id)) media_set_mismatch,
      (select count(*)::integer from catalog.catalog_media_assignments a
        where not exists (select 1 from catalog.catalog_media_assignment_revisions r
          where r.tenant_id=a.tenant_id and r.assignment_id=a.assignment_id
            and r.assignment_set_id=a.assignment_set_id and r.revision=a.current_revision
            and r.resource_kind=a.resource_kind and r.owner_module_id=a.owner_module_id
            and r.owner_resource_type=a.owner_resource_type and r.owner_resource_id=a.owner_resource_id
            and r.owner_tenant_id=a.owner_tenant_id and r.purpose=a.purpose
            and r.position=a.position and r.state=a.state)
          or a.current_revision <> (select max(r.revision) from catalog.catalog_media_assignment_revisions r
            where r.tenant_id=a.tenant_id and r.assignment_id=a.assignment_id)) media_assignment_mismatch,
      (select count(*)::integer from catalog.product_size_usage_sets s
        where s.current_revision <> (select max(r.revision) from catalog.product_size_usage_revisions r
          where r.tenant_id=s.tenant_id and r.product_id=s.product_id)
          or exists (
            (select i.position, i.size_value_id from catalog.product_size_usage_items i
              where i.tenant_id=s.tenant_id and i.product_id=s.product_id
             except
             select ri.position, ri.size_value_id from catalog.product_size_usage_revision_items ri
              where ri.tenant_id=s.tenant_id and ri.product_id=s.product_id and ri.revision=s.current_revision)
            union all
            (select ri.position, ri.size_value_id from catalog.product_size_usage_revision_items ri
              where ri.tenant_id=s.tenant_id and ri.product_id=s.product_id and ri.revision=s.current_revision
             except
             select i.position, i.size_value_id from catalog.product_size_usage_items i
              where i.tenant_id=s.tenant_id and i.product_id=s.product_id)
          )) product_size_usage_mismatch,
      (select count(*)::integer from catalog.product_category_hierarchy_revisions h
        where h.hierarchy_revision <> coalesce((select max(e.hierarchy_revision)
          from catalog.product_category_events e where e.tenant_id=h.tenant_id
          and e.change_kind in ('CREATED','RENAMED','MOVED','RETIRED')), 0)
        or h.assignment_revision <> coalesce((select max(e.assignment_revision)
          from catalog.product_category_events e where e.tenant_id=h.tenant_id
          and e.change_kind in ('ASSIGNED','UNASSIGNED')), 0)) counter_mismatch`,
  );
  const [pointers] = currentPointers;
  if (pointers === undefined || !pointersAreCurrent(pointers)) {
    yield* new CatalogSchemaVerificationError({
      reason: 'Catalog Current revision pointers or category counters differ from durable events',
    });
  }
  yield* Console.log('Verified Catalog database schema, columns, and security metadata');
}).pipe(
  Effect.scoped,
  Effect.provide(Reactivity.layer),
  Effect.provide(NodeFileSystem.layer),
  Effect.tapError(Console.error),
);

const exit = await Effect.runPromiseExit(verification);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
