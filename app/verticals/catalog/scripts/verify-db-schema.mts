// @effect-diagnostics asyncFunction:off globalConsole:off nodeBuiltinImport:off -- Operator-only database verification adapts the PostgreSQL driver at the infrastructure edge; expires: 2027-03-31.
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Console, Effect, Exit, Order, Schema } from 'effect';
import { Client } from 'pg';

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

const verification = Effect.gen(function* verifyCatalogDatabase() {
  const configuration = yield* loadDatabaseConnectionPair();
  const client = yield* Effect.acquireRelease(
    Effect.tryPromise({
      catch: () => new CatalogSchemaVerificationError({ reason: 'Unable to connect to the Catalog database' }),
      try: async () => {
        const connection = new Client({ connectionString: configuration.admin.connectionString });
        await connection.connect();
        return connection;
      },
    }),
    (connection) => Effect.promise(async () => await connection.end()),
  );
  // Typed Drizzle definitions define the complete inventory; catalog queries verify deployment metadata only.
  for (const table of CATALOG_TABLES) {
    const config = getTableConfig(table);
    yield* Effect.tryPromise({
      catch: () => new CatalogSchemaVerificationError({ reason: `Catalog table ${config.name} is unavailable` }),
      try: async () => await client.query(`select * from "catalog"."${config.name}" limit 0`),
    });
  }
  const tables = yield* Effect.tryPromise({
    catch: () => new CatalogSchemaVerificationError({ reason: 'Unable to inspect Catalog tables' }),
    try: async () =>
      await client.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'catalog' and table_type = 'BASE TABLE' order by table_name",
      ),
  });
  const difference = compareCatalogTables(tables.rows.map((row) => `${CATALOG_SCHEMA_NAME}.${row.table_name}`));
  if (difference.missing.length > 0 || difference.unexpected.length > 0) {
    yield* new CatalogSchemaVerificationError({
      reason: `Catalog table mismatch; missing=[${difference.missing.join(', ')}], unexpected=[${difference.unexpected.join(', ')}]`,
    });
  }
  const columns = yield* Effect.tryPromise({
    catch: () => new CatalogSchemaVerificationError({ reason: 'Unable to inspect Catalog columns' }),
    try: async () =>
      await client.query<{ column_name: string; table_name: string }>(
        "select table_name, column_name from information_schema.columns where table_schema = 'catalog' order by table_name, column_name",
      ),
  });
  const actualColumns = EffectArray.sort(
    columns.rows.map((row) => `${row.table_name}.${row.column_name}`),
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
  const infrastructure = yield* Effect.tryPromise({
    catch: () => new CatalogSchemaVerificationError({ reason: 'Unable to inspect Catalog security metadata' }),
    try: async () =>
      await client.query<{
        forced_rls: number;
        foreign_key_count: number;
        journal_count: number;
        policy_count: number;
        result_snapshot_guard_count: number;
        trigger_count: number;
        validated_combination_count: number;
      }>(`select
      (select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='catalog' and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity) forced_rls,
      (select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='drizzle' and c.relname='__drizzle_migrations_catalog') journal_count,
      (select count(*)::integer from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='catalog') policy_count,
      (select count(*)::integer from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='catalog' and not t.tgisinternal) trigger_count,
      (select count(*)::integer from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='catalog' and c.relname='catalog_result_snapshots'
          and t.tgname='catalog_result_snapshots_append_only' and t.tgenabled='O'
          and (t.tgtype & 16) = 16 and (t.tgtype & 8) = 8) result_snapshot_guard_count,
      (select count(*)::integer from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='catalog' and k.contype='f') foreign_key_count,
      (select count(*)::integer from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='catalog' and c.relname='product_variants' and k.conname='catalog_product_variants_combination_ck' and k.convalidated) validated_combination_count`),
  });
  const [row] = infrastructure.rows;
  const expectedPolicyCount = CATALOG_TABLES.reduce((count, table) => count + getTableConfig(table).policies.length, 0);
  const expectedForeignKeyCount = CATALOG_TABLES.reduce(
    (count, table) => count + getTableConfig(table).foreignKeys.length,
    0,
  );
  // 78 existing triggers plus accepted-source and override-ledger guards and the mutable-head identity guard.
  const expectedTriggerCount = 81;
  const expectedInfrastructure = [
    CATALOG_TABLES.length,
    1,
    expectedPolicyCount,
    1,
    expectedTriggerCount,
    1,
    expectedForeignKeyCount,
  ];
  const actualInfrastructure =
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
  if (
    actualInfrastructure === undefined ||
    actualInfrastructure.some((value, index) => value !== expectedInfrastructure[index])
  ) {
    yield* new CatalogSchemaVerificationError({
      reason: 'Catalog RLS, journal, trigger, or foreign-key inventory differs from its migration',
    });
  }
  const skuIndex = yield* Effect.tryPromise({
    catch: () => new CatalogSchemaVerificationError({ reason: 'Unable to inspect Catalog SKU uniqueness' }),
    try: async () =>
      await client.query<{ index_definition: string }>(`select pg_get_indexdef(i.indexrelid) index_definition
        from pg_index i join pg_class c on c.oid=i.indexrelid
        join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='catalog' and c.relname='catalog_sku_reservations_binary_code_uk' and i.indisunique and i.indisvalid`),
  });
  if (
    skuIndex.rows.length !== 1 ||
    !skuIndex.rows[0]?.index_definition.includes('(tenant_id, normalized_code COLLATE "C")')
  ) {
    yield* new CatalogSchemaVerificationError({ reason: 'Catalog SKU tenant-wide binary uniqueness is absent' });
  }
  const skuCodes = yield* Effect.tryPromise({
    catch: () => new CatalogSchemaVerificationError({ reason: 'Unable to inspect Catalog SKU normalization' }),
    try: async () =>
      await client.query<{ display_code: string; normalized_code: string }>(`select display_code, normalized_code
        from catalog.commercial_sku_reservations
        union all
        select display_code, normalized_code from catalog.commercial_sku_assignment_revisions`),
  });
  if (
    skuCodes.rows.some(({ display_code, normalized_code }) => display_code.trim().toUpperCase() !== normalized_code)
  ) {
    yield* new CatalogSchemaVerificationError({
      reason: 'Catalog SKU normalization differs from the application rule',
    });
  }
  const currentPointers = yield* Effect.tryPromise({
    catch: () => new CatalogSchemaVerificationError({ reason: 'Unable to inspect Catalog revision pointers' }),
    try: async () =>
      await client.query<{
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
      }>(`select
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
            and r.revision=s.current_revision and r.effective_from <= now()
            and (r.effective_to is null or r.effective_to > now()))
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
          and e.change_kind in ('ASSIGNED','UNASSIGNED')), 0)) counter_mismatch`),
  });
  const [pointers] = currentPointers.rows;
  if (pointers === undefined || !pointersAreCurrent(pointers)) {
    yield* new CatalogSchemaVerificationError({
      reason: 'Catalog Current revision pointers or category counters differ from durable events',
    });
  }
  yield* Console.log('Verified Catalog database schema, columns, and security metadata');
}).pipe(Effect.scoped, Effect.tapError(Console.error));

const exit = await Effect.runPromiseExit(verification);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
