// @effect-diagnostics nodeBuiltinImport:off -- Migration contract reads checked-in Catalog SQL; expires: 2027-03-31.
import { expect, it } from 'effect-rstest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Order } from 'effect';
import { readdirSync, readFileSync } from 'node:fs';

import {
  CATALOG_SCHEMA_NAME,
  CATALOG_TABLE_INVENTORY,
  CATALOG_TABLES,
  attributeDefinitionRevisions,
  attributeDefinitions,
  attributeValueItems,
  attributeValueRevisions,
  attributeValueSets,
  brandRevisions,
  brands,
  catalogAcceptedSourceAssertions,
  catalogLocalOverrideHeads,
  catalogLocalOverrideRevisions,
  commercialGtinAssignmentRevisions,
  commercialGtinAssignments,
  commercialSkuAssignmentRevisions,
  commercialSkuReservations,
  catalogMediaAssignmentRevisions,
  catalogMediaAssignmentSetRevisions,
  catalogMediaAssignmentSets,
  catalogMediaAssignments,
  catalogResultSnapshots,
  controlledAttributeValueRevisions,
  controlledAttributeValues,
  productConfigurationChoiceOptions,
  productConfigurationChoices,
  productConfigurationCompatibilityRules,
  productConfigurationContinuityDecisions,
  productConfigurationDefinitionRevisions,
  productConfigurationDefinitions,
  productConfigurationMeasuredRules,
  productConfigurationOptionAllowances,
  productConfigurationRevisionActivations,
  manufacturerRelationRevisions,
  manufacturerRelations,
  packageContentRevisions,
  packageDefinitions,
  packageOptionRoleRevisions,
  packageUnitDivisibility,
  packageUnitDivisibilityRevisions,
  productBrandAssignmentRevisions,
  productBrandAssignments,
  productAttributeApplicability,
  productAttributeApplicabilityRevisions,
  productCategories,
  productCategoryAssignments,
  productCategoryEvents,
  productCategoryHierarchyRevisions,
  productLifecycleEvents,
  productLocalizedFactRevisions,
  productLocalizedFacts,
  productRelationshipRevisions,
  productRelationships,
  productRevisions,
  productSizeUsageItems,
  productSizeUsageRevisionItems,
  productSizeUsageRevisions,
  productSizeUsageSets,
  productTypeAssignmentEvents,
  productTypeAssignments,
  productTypeRevisionAttributes,
  productTypeRevisions,
  productTypes,
  productUnits,
  sizeEquivalenceAssertions,
  productUnitRuleRevisions,
  variantUnitDivisibility,
  variantUnitDivisibilityRevisions,
  productVariants,
  productVariantAxes,
  productVariantAxisAllowanceEvents,
  productVariantAxisAllowedValues,
  productVariantAxisEvents,
  productVariantRevisions,
  products,
  setCompositionComponents,
  setCompositionRevisions,
  setCompositions,
  variantLocalizedFactRevisions,
  variantLocalizedFacts,
} from '../../src/database/schema.ts';

it('owns eighty tenant-scoped Catalog tables with RLS and immutable history', () => {
  const qualifiedNames = EffectArray.sort(
    CATALOG_TABLES.map((table) => {
      const config = getTableConfig(table);
      return `${config.schema}.${config.name}`;
    }),
    Order.String,
  );

  expect(CATALOG_SCHEMA_NAME).toBe('catalog');
  expect(CATALOG_TABLE_INVENTORY).toEqual([
    'attribute_definition_revisions',
    'attribute_definitions',
    'attribute_value_items',
    'attribute_value_revisions',
    'attribute_value_sets',
    'brand_revisions',
    'brands',
    'catalog_accepted_source_assertions',
    'catalog_local_override_heads',
    'catalog_local_override_revisions',
    'catalog_media_assignment_revisions',
    'catalog_media_assignment_set_revisions',
    'catalog_media_assignment_sets',
    'catalog_media_assignments',
    'catalog_result_snapshots',
    'commercial_gtin_assignment_revisions',
    'commercial_gtin_assignments',
    'commercial_sku_assignment_revisions',
    'commercial_sku_reservations',
    'configuration_unit_revisions',
    'configuration_units',
    'controlled_attribute_value_revisions',
    'controlled_attribute_values',
    'manufacturer_relation_revisions',
    'manufacturer_relations',
    'package_content_revisions',
    'package_definitions',
    'package_option_role_revisions',
    'package_unit_divisibility',
    'package_unit_divisibility_revisions',
    'product_attribute_applicability',
    'product_attribute_applicability_revisions',
    'product_brand_assignment_revisions',
    'product_brand_assignments',
    'product_categories',
    'product_category_assignments',
    'product_category_events',
    'product_category_hierarchy_revisions',
    'product_configuration_choice_options',
    'product_configuration_choices',
    'product_configuration_compatibility_rules',
    'product_configuration_continuity_decisions',
    'product_configuration_definition_revisions',
    'product_configuration_definitions',
    'product_configuration_measured_rules',
    'product_configuration_option_allowances',
    'product_configuration_revision_activations',
    'product_lifecycle_events',
    'product_localized_fact_revisions',
    'product_localized_facts',
    'product_relationship_revisions',
    'product_relationships',
    'product_revisions',
    'product_size_usage_items',
    'product_size_usage_revision_items',
    'product_size_usage_revisions',
    'product_size_usage_sets',
    'product_type_assignment_events',
    'product_type_assignments',
    'product_type_revision_attributes',
    'product_type_revisions',
    'product_type_untyped_decisions',
    'product_types',
    'product_unit_rule_revisions',
    'product_units',
    'product_variant_axes',
    'product_variant_axis_allowance_events',
    'product_variant_axis_allowed_values',
    'product_variant_axis_events',
    'product_variant_revisions',
    'product_variants',
    'products',
    'set_composition_components',
    'set_composition_revisions',
    'set_compositions',
    'size_equivalence_assertions',
    'variant_localized_fact_revisions',
    'variant_localized_facts',
    'variant_unit_divisibility',
    'variant_unit_divisibility_revisions',
  ]);
  expect(qualifiedNames).toEqual(CATALOG_TABLE_INVENTORY.map((name) => `catalog.${name}`));
  for (const table of CATALOG_TABLES) {
    const config = getTableConfig(table);
    expect(config.enableRLS, `${config.name} must enable RLS`).toBe(true);
    expect(config.columns.some((column) => column.name === 'tenant_id' && column.notNull)).toBe(true);
    expect(config.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(config.policies.every((policy) => policy.to === 'ontos_runtime')).toBe(true);
  }
});

it('retains source assertions and override revisions as immutable evidence behind one CAS head', () => {
  const accepted = getTableConfig(catalogAcceptedSourceAssertions);
  const heads = getTableConfig(catalogLocalOverrideHeads);
  const revisions = getTableConfig(catalogLocalOverrideRevisions);
  expect(accepted.primaryKeys.map((key) => key.getName())).toContain('catalog_source_assertions_pk');
  expect(accepted.uniqueConstraints.map((key) => key.name)).toEqual(
    expect.arrayContaining(['catalog_source_assertions_source_revision_uk', 'catalog_source_assertions_invocation_uk']),
  );
  expect(accepted.columns.map((column) => column.name)).toEqual(
    expect.arrayContaining([
      'source_issuer_kind',
      'source_record_namespace',
      'correlation_capture_status',
      'authority_issuer_system_id',
      'accepted_at',
      'recorded_at',
    ]),
  );
  expect(revisions.primaryKeys.map((key) => key.getName())).toContain('catalog_local_override_revisions_pk');
  expect(revisions.columns.map((column) => column.name)).toEqual(
    expect.arrayContaining(['decided_at', 'recorded_at', 'evidence_ref', 'action_invocation_id']),
  );
  expect(heads.primaryKeys.map((key) => key.getName())).toContain('catalog_local_override_heads_pk');
  expect(heads.indexes.map((index) => index.config.name)).toContain('catalog_local_override_heads_one_active_uk');

  const migration = readFileSync(
    new URL('../../drizzle/20260918185931_flawless_tarantula/migration.sql', import.meta.url),
    'utf-8',
  );
  expect(migration.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(3);
  expect(migration).toContain('catalog_accepted_source_assertions_append_only');
  expect(migration).toContain('catalog_local_override_revisions_append_only');
  expect(migration).toContain('catalog_local_override_heads_identity_immutable');
  expect(migration).not.toContain('catalog_local_override_revisions_one_active');
});

it('keeps Product-local Attribute applicability distinct from Type permission and values', () => {
  const current = getTableConfig(productAttributeApplicability);
  const revisions = getTableConfig(productAttributeApplicabilityRevisions);
  expect(current.primaryKeys.map((key) => key.getName())).toContain('catalog_product_attribute_applicability_pk');
  expect(current.columns.map((column) => column.name)).toEqual(
    expect.arrayContaining(['product_level', 'variant_level', 'current_revision']),
  );
  expect(revisions.primaryKeys.map((key) => key.getName())).toContain(
    'catalog_product_attribute_applicability_revisions_pk',
  );
  expect(revisions.uniqueConstraints.map((key) => key.name)).toContain(
    'catalog_product_attribute_applicability_revisions_invocation_uk',
  );
});

it('retains one bounded original result per tenant and Action invocation', () => {
  const snapshot = getTableConfig(catalogResultSnapshots);
  expect(snapshot.primaryKeys.map((key) => key.getName())).toContain('catalog_result_snapshots_pk');
  expect(snapshot.columns.map((column) => column.name)).toEqual([
    'tenant_id',
    'action_invocation_id',
    'acting_principal_id',
    'action_key',
    'schema_version',
    'encoded_result',
    'recorded_at',
  ]);
  expect(snapshot.checks.map((rule) => rule.name)).toEqual([
    'catalog_result_snapshots_action_key_ck',
    'catalog_result_snapshots_schema_version_ck',
    'catalog_result_snapshots_result_size_ck',
  ]);
  const migration = readFileSync(
    new URL('../../drizzle/20260917102416_lonely_flatman/migration.sql', import.meta.url),
    'utf-8',
  );
  expect(migration).toContain('PRIMARY KEY("tenant_id","action_invocation_id")');
  expect(migration).toContain('FORCE ROW LEVEL SECURITY');
  expect(migration).toContain('catalog_result_snapshots_append_only');
  expect(migration).toContain('reject_ledger_mutation');
});

it('reserves SKU across exact target kinds and keeps assignment provenance separate from GTIN', () => {
  const sku = getTableConfig(commercialSkuReservations);
  expect(sku.primaryKeys.map((key) => key.getName())).toContain('catalog_sku_reservations_pk');
  expect(sku.indexes.map((item) => item.config.name)).toEqual(
    expect.arrayContaining([
      'catalog_sku_reservations_binary_code_uk',
      'catalog_sku_reservations_current_variant_uk',
      'catalog_sku_reservations_current_package_uk',
    ]),
  );
  expect(sku.foreignKeys.map((key) => key.getName())).toEqual(
    expect.arrayContaining(['catalog_sku_reservations_variant_fk', 'catalog_sku_reservations_package_fk']),
  );
  expect(getTableConfig(commercialSkuAssignmentRevisions).foreignKeys.map((key) => key.getName())).toContain(
    'catalog_sku_assignment_revisions_reservation_fk',
  );
  expect(
    getTableConfig(commercialSkuAssignmentRevisions)
      .uniqueConstraints.find((key) => key.name === 'catalog_sku_assignment_revisions_invocation_uk')
      ?.columns.map((column) => column.name),
  ).toEqual(['tenant_id', 'normalized_code', 'action_invocation_id']);
  expect(getTableConfig(commercialGtinAssignments).checks.map((item) => item.name)).toContain(
    'catalog_gtin_assignments_digits_ck',
  );
  expect(getTableConfig(commercialGtinAssignmentRevisions).columns.map((column) => column.name)).toContain(
    'attribution_evidence_ref',
  );
  const migration = readFileSync(
    new URL('../../drizzle/20260917100849_elite_moondragon/migration.sql', import.meta.url),
    'utf-8',
  );
  expect(migration).toContain('UNIQUE INDEX "catalog_sku_reservations_binary_code_uk"');
  expect(migration).toContain('"normalized_code" COLLATE "C"');
  expect(migration).not.toContain('upper(btrim("display_code"))');
});

it('keeps Product Configuration definitions and exact rules revision-scoped', () => {
  const continuity = getTableConfig(productConfigurationContinuityDecisions);
  expect(continuity.foreignKeys.map((key) => key.getName())).toEqual(
    expect.arrayContaining([
      'catalog_configuration_continuity_definition_fk',
      'catalog_configuration_continuity_left_fk',
      'catalog_configuration_continuity_right_fk',
      'catalog_configuration_continuity_variant_fk',
      'catalog_configuration_continuity_package_fk',
    ]),
  );
  expect(continuity.checks.map((rule) => rule.name)).toEqual(
    expect.arrayContaining([
      'catalog_configuration_continuity_revisions_ck',
      'catalog_configuration_continuity_evidence_ck',
    ]),
  );
  expect(getTableConfig(productConfigurationDefinitions).foreignKeys.map((key) => key.getName())).toContain(
    'catalog_configuration_definitions_product_fk',
  );
  expect(getTableConfig(productConfigurationDefinitionRevisions).primaryKeys.map((key) => key.getName())).toContain(
    'catalog_configuration_definition_revisions_pk',
  );
  expect(getTableConfig(productConfigurationChoices).checks.map((rule) => rule.name)).toContain(
    'catalog_configuration_choices_kind_ck',
  );
  expect(getTableConfig(productConfigurationChoiceOptions).primaryKeys.map((key) => key.getName())).toContain(
    'catalog_configuration_choice_options_pk',
  );
  expect(getTableConfig(productConfigurationMeasuredRules).checks.map((rule) => rule.name)).toEqual(
    expect.arrayContaining([
      'catalog_configuration_measured_rules_bounds_ck',
      'catalog_configuration_measured_rules_step_ck',
    ]),
  );
  expect(getTableConfig(productConfigurationCompatibilityRules).checks.map((rule) => rule.name)).toContain(
    'catalog_configuration_compatibility_rules_kind_ck',
  );
  expect(getTableConfig(productConfigurationOptionAllowances).indexes.map((index) => index.config.name)).toEqual([
    'catalog_configuration_allowances_product_uk',
    'catalog_configuration_allowances_variant_uk',
    'catalog_configuration_allowances_package_uk',
  ]);
  expect(getTableConfig(productConfigurationRevisionActivations).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_configuration_revision_activations_revision_fk',
    'catalog_configuration_revision_activations_predecessor_fk',
  ]);
  expect(getTableConfig(productConfigurationRevisionActivations).uniqueConstraints.map((key) => key.name)).toContain(
    'catalog_configuration_revision_activations_time_uk',
  );
});

it('persists Product-local Size order and only evidenced, scoped equivalence', () => {
  const current = getTableConfig(productSizeUsageItems);
  const history = getTableConfig(productSizeUsageRevisionItems);
  const equivalence = getTableConfig(sizeEquivalenceAssertions);
  expect(getTableConfig(productSizeUsageSets).foreignKeys.map((key) => key.getName())).toContain(
    'catalog_product_size_usage_sets_product_fk',
  );
  expect(getTableConfig(productSizeUsageRevisions).primaryKeys.map((key) => key.getName())).toContain(
    'catalog_product_size_usage_revisions_pk',
  );
  expect(current.primaryKeys.map((key) => key.getName())).toContain('catalog_product_size_usage_items_pk');
  expect(current.uniqueConstraints.map((key) => key.name)).toContain('catalog_product_size_usage_items_value_uk');
  expect(current.foreignKeys.map((key) => key.getName())).toContain('catalog_product_size_usage_items_size_fk');
  expect(history.foreignKeys.map((key) => key.getName())).toContain(
    'catalog_product_size_usage_revision_items_size_fk',
  );
  expect(getTableConfig(controlledAttributeValues).uniqueConstraints.map((key) => key.name)).toContain(
    'catalog_controlled_values_size_kind_uk',
  );
  expect(equivalence.foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_size_equivalence_assertions_left_fk',
    'catalog_size_equivalence_assertions_right_fk',
  ]);
  expect(equivalence.checks.map((key) => key.name)).toEqual(
    expect.arrayContaining([
      'catalog_size_equivalence_assertions_kind_ck',
      'catalog_size_equivalence_assertions_distinct_ck',
      'catalog_size_equivalence_assertions_scope_ck',
      'catalog_size_equivalence_assertions_evidence_ck',
      'catalog_size_equivalence_assertions_period_ck',
    ]),
  );
  expect(equivalence.columns.map((column) => column.name)).not.toContain('size_system_id');
});

it('keeps Brand, Product claim, and manufacturer facts tenant-qualified with append-only revisions', () => {
  expect(getTableConfig(brands).uniqueConstraints.map((key) => key.name)).toContain('catalog_brands_scope_id_uk');
  expect(getTableConfig(brands).uniqueConstraints.map((key) => key.name)).not.toContain('catalog_brands_name_uk');
  expect(getTableConfig(brandRevisions).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_brand_revisions_brand_fk',
  ]);
  expect(getTableConfig(productBrandAssignments).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_product_brand_assignments_product_fk',
    'catalog_product_brand_assignments_brand_fk',
  ]);
  expect(getTableConfig(productBrandAssignmentRevisions).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_product_brand_assignment_revisions_assignment_fk',
    'catalog_product_brand_assignment_revisions_brand_fk',
  ]);
  expect(getTableConfig(manufacturerRelations).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_manufacturer_relations_product_fk',
    'catalog_manufacturer_relations_variant_fk',
  ]);
  expect(getTableConfig(manufacturerRelationRevisions).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_manufacturer_relation_revisions_relation_fk',
    'catalog_manufacturer_relation_revisions_product_fk',
    'catalog_manufacturer_relation_revisions_variant_fk',
  ]);
  expect(getTableConfig(manufacturerRelations).columns.map((column) => column.name)).not.toContain('target_name');
  for (const table of [manufacturerRelations, manufacturerRelationRevisions]) {
    const config = getTableConfig(table);
    expect(config.columns.find((column) => column.name === 'target_id')?.getSQLType()).toBe('text');
    expect(config.checks.map((constraint) => constraint.name)).toContain(`catalog_${config.name}_target_id_ck`);
  }
  expect(getTableConfig(productVariants).columns.map((column) => column.name)).not.toContain('brand_id');
});

it('constrains directed Product relationships and their immutable revision snapshots', () => {
  const current = getTableConfig(productRelationships);
  const history = getTableConfig(productRelationshipRevisions);
  expect(current.foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_product_relationships_source_product_fk',
    'catalog_product_relationships_source_variant_fk',
    'catalog_product_relationships_target_product_fk',
    'catalog_product_relationships_target_variant_fk',
  ]);
  expect(
    current.uniqueConstraints.find((key) => key.name === 'catalog_product_relationships_exact_uk')?.nullsNotDistinct,
  ).toBe(true);
  expect(current.checks.map((key) => key.name)).toEqual(
    expect.arrayContaining([
      'catalog_product_relationships_source_ck',
      'catalog_product_relationships_target_ck',
      'catalog_product_relationships_period_ck',
      'catalog_product_relationships_self_ck',
    ]),
  );
  expect(history.primaryKeys.map((key) => key.getName())).toContain('catalog_product_relationship_revisions_pk');
  expect(history.foreignKeys).toHaveLength(5);
  expect(history.checks.map((key) => key.name)).toContain('catalog_product_relationship_revisions_evidence_ck');
});

it('pins homogeneous Package content to one Variant and an exact lower revision', () => {
  expect(getTableConfig(packageDefinitions).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_package_definitions_variant_fk',
  ]);
  expect(getTableConfig(packageContentRevisions).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_package_content_revisions_definition_fk',
    'catalog_package_content_revisions_unit_fk',
    'catalog_package_content_revisions_lower_form_fk',
    'catalog_package_content_revisions_lower_revision_fk',
    'catalog_package_content_revisions_set_revision_fk',
  ]);
  expect(getTableConfig(packageContentRevisions).checks.map((key) => key.name)).toEqual(
    expect.arrayContaining([
      'catalog_package_content_revisions_amount_ck',
      'catalog_package_content_revisions_lower_ck',
      'catalog_package_content_revisions_set_ck',
      'catalog_package_content_revisions_unit_ck',
    ]),
  );
  expect(getTableConfig(packageDefinitions).columns.map((column) => column.name)).toContain('option_state');
  expect(getTableConfig(packageDefinitions).columns.map((column) => column.name)).toContain('current_option_revision');
  expect(getTableConfig(packageOptionRoleRevisions).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_package_option_role_revisions_definition_fk',
    'catalog_package_option_role_revisions_content_fk',
  ]);
  expect(getTableConfig(packageOptionRoleRevisions).checks.map((key) => key.name)).toEqual(
    expect.arrayContaining([
      'catalog_package_option_role_revisions_active_ck',
      'catalog_package_option_role_revisions_reason_ck',
      'catalog_package_option_role_revisions_evidence_ck',
    ]),
  );
});

it('pins each Set Composition Resource and immutable component need to exact same-tenant identities', () => {
  expect(getTableConfig(setCompositions).uniqueConstraints.map((key) => key.name)).toContain(
    'catalog_set_compositions_variant_uk',
  );
  expect(getTableConfig(setCompositions).foreignKeys.map((key) => key.getName())).toContain(
    'catalog_set_compositions_variant_fk',
  );
  expect(getTableConfig(setCompositionRevisions).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_set_composition_revisions_composition_fk',
    'catalog_set_composition_revisions_predecessor_fk',
  ]);
  expect(getTableConfig(setCompositionComponents).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_set_composition_components_revision_fk',
    'catalog_set_composition_components_variant_fk',
    'catalog_set_composition_components_package_fk',
    'catalog_set_composition_components_package_revision_fk',
    'catalog_set_composition_components_unit_fk',
  ]);
  expect(getTableConfig(setCompositionComponents).checks.map((key) => key.name)).toContain(
    'catalog_set_composition_components_quantity_ck',
  );
});

it('anchors Unit rules and target divisibility in tenant-owned immutable revision history', () => {
  expect(getTableConfig(productUnits).uniqueConstraints.map((key) => key.name)).toContain(
    'catalog_product_units_code_uk',
  );
  expect(getTableConfig(productUnitRuleRevisions).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_product_unit_rule_revisions_unit_fk',
  ]);
  expect(getTableConfig(variantUnitDivisibility).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_variant_unit_divisibility_variant_fk',
    'catalog_variant_unit_divisibility_unit_fk',
  ]);
  expect(getTableConfig(variantUnitDivisibilityRevisions).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_variant_unit_divisibility_revisions_target_fk',
    'catalog_variant_unit_divisibility_revisions_unit_fk',
  ]);
  expect(getTableConfig(packageUnitDivisibility).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_package_unit_divisibility_package_fk',
    'catalog_package_unit_divisibility_unit_fk',
  ]);
  expect(getTableConfig(packageUnitDivisibilityRevisions).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_package_unit_divisibility_revisions_target_fk',
    'catalog_package_unit_divisibility_revisions_unit_fk',
  ]);
});

it('constrains Product Type revisions, rule levels, and a single current assignment', () => {
  expect(getTableConfig(productTypes).uniqueConstraints.map((constraint) => constraint.name)).toContain(
    'catalog_product_types_scope_id_uk',
  );
  expect(getTableConfig(productTypeRevisions).uniqueConstraints.map((constraint) => constraint.name)).toContain(
    'catalog_product_type_revisions_number_uk',
  );
  expect(getTableConfig(productTypeRevisionAttributes).primaryKeys.map((key) => key.getName())).toContain(
    'catalog_product_type_revision_attributes_pk',
  );
  expect(getTableConfig(productTypeRevisionAttributes).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_product_type_revision_attributes_revision_fk',
    'catalog_product_type_revision_attributes_definition_fk',
  ]);
  expect(getTableConfig(productTypeAssignments).primaryKeys.map((key) => key.getName())).toContain(
    'catalog_product_type_assignments_pk',
  );
  expect(getTableConfig(productTypeAssignments).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_product_type_assignments_product_fk',
    'catalog_product_type_assignments_type_fk',
  ]);
  expect(getTableConfig(productTypeAssignmentEvents).uniqueConstraints.map((constraint) => constraint.name)).toContain(
    'catalog_product_type_assignment_events_number_uk',
  );
});

it('constrains shared Attribute identity, revision history, and controlled-value ownership', () => {
  expect(getTableConfig(attributeDefinitions).uniqueConstraints.map((key) => key.name)).toContain(
    'catalog_attribute_definitions_scope_id_uk',
  );
  expect(getTableConfig(attributeDefinitionRevisions).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_attribute_definition_revisions_definition_fk',
  ]);
  expect(getTableConfig(controlledAttributeValues).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_controlled_values_definition_fk',
  ]);
  expect(getTableConfig(controlledAttributeValueRevisions).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_controlled_value_revisions_value_fk',
  ]);
  expect(getTableConfig(controlledAttributeValueRevisions).uniqueConstraints.map((key) => key.name)).toContain(
    'catalog_controlled_value_revisions_number_uk',
  );
});

it('constrains tenant-qualified Category hierarchy, direct links, and revision lock', () => {
  expect(getTableConfig(productCategories).foreignKeys.map((key) => key.getName())).toContain(
    'catalog_product_categories_parent_fk',
  );
  expect(getTableConfig(productCategoryAssignments).primaryKeys.map((key) => key.getName())).toContain(
    'catalog_product_category_assignments_pk',
  );
  expect(getTableConfig(productCategoryAssignments).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_product_category_assignments_product_fk',
    'catalog_product_category_assignments_category_fk',
  ]);
  expect(getTableConfig(productCategoryHierarchyRevisions).columns.map((column) => column.name)).toContain(
    'assignment_revision',
  );
  expect(getTableConfig(productCategoryEvents).uniqueConstraints.map((constraint) => constraint.name)).toContain(
    'catalog_product_category_events_invocation_uk',
  );
  expect(getTableConfig(productCategoryEvents).indexes.map((index) => index.config.name)).toContain(
    'catalog_product_category_events_category_revision_uk',
  );
  expect(getTableConfig(productCategoryEvents).checks.map((constraint) => constraint.name)).toContain(
    'catalog_product_category_events_snapshot_ck',
  );
  expect(getTableConfig(productCategoryEvents).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_product_category_events_category_fk',
    'catalog_product_category_events_product_fk',
    'catalog_product_category_events_previous_parent_fk',
    'catalog_product_category_events_next_parent_fk',
  ]);
  for (const name of [
    'previous_name',
    'next_name',
    'previous_lifecycle_state',
    'next_lifecycle_state',
    'category_revision',
  ]) {
    expect(getTableConfig(productCategoryEvents).columns.map((column) => column.name)).toContain(name);
  }
});

it('keeps Product identity, Variant ownership, and historical revision keys constrained', () => {
  expect(getTableConfig(products).uniqueConstraints.map((constraint) => constraint.name)).toContain(
    'catalog_products_scope_id_uk',
  );
  expect(getTableConfig(productVariants).foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
    'catalog_product_variants_product_fk',
  );
  expect(getTableConfig(productVariants).indexes.map((index) => index.config.name)).toContain(
    'catalog_product_variants_active_combination_uk',
  );
  expect(getTableConfig(productVariantRevisions).foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
    'catalog_product_variant_revisions_variant_fk',
  );
  expect(getTableConfig(productVariants).foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
    'catalog_product_variants_axis_revision_fk',
  );
  expect(getTableConfig(productVariantRevisions).foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual([
    'catalog_product_variant_revisions_variant_fk',
    'catalog_product_variant_revisions_product_fk',
    'catalog_product_variant_revisions_axis_revision_fk',
  ]);
  expect(getTableConfig(productVariantAxes).foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual([
    'catalog_product_variant_axes_product_fk',
    'catalog_product_variant_axes_definition_fk',
  ]);
  expect(getTableConfig(productVariantAxisEvents).primaryKeys.map((key) => key.getName())).toContain(
    'catalog_product_variant_axis_events_pk',
  );
  expect(getTableConfig(productVariantAxisEvents).checks.map((check) => check.name)).toContain(
    'catalog_product_variant_axis_events_null_free_ck',
  );
  expect(getTableConfig(productRevisions).uniqueConstraints.map((constraint) => constraint.name)).toContain(
    'catalog_product_revisions_number_uk',
  );
  expect(getTableConfig(productLifecycleEvents).uniqueConstraints.map((constraint) => constraint.name)).toContain(
    'catalog_product_lifecycle_invocation_uk',
  );
});

it('pins Variant axis allowance history to exact axis and Definition revisions', () => {
  const allowance = getTableConfig(productVariantAxisAllowanceEvents);
  const allowedValues = getTableConfig(productVariantAxisAllowedValues);
  expect(allowance.primaryKeys.map((key) => key.getName())).toContain(
    'catalog_product_variant_axis_allowance_events_pk',
  );
  expect(allowance.uniqueConstraints.map((key) => key.name)).toEqual(
    expect.arrayContaining([
      'catalog_product_variant_axis_allowance_invocation_uk',
      'catalog_product_variant_axis_allowance_axis_uk',
    ]),
  );
  expect(allowance.foreignKeys.map((key) => key.getName())).toEqual(
    expect.arrayContaining([
      'catalog_product_variant_axis_allowance_axis_fk',
      'catalog_product_variant_axis_allowance_definition_revision_fk',
    ]),
  );
  const definitionRevisionFk = allowance.foreignKeys.find(
    (key) => key.getName() === 'catalog_product_variant_axis_allowance_definition_revision_fk',
  );
  expect(definitionRevisionFk?.reference().columns.map((column) => column.name)).toEqual([
    'tenant_id',
    'attribute_definition_id',
    'definition_revision',
  ]);
  expect(definitionRevisionFk?.reference().foreignColumns.map((column) => column.name)).toEqual([
    'tenant_id',
    'attribute_definition_id',
    'revision',
  ]);
  expect(allowedValues.columns.map((column) => column.name)).toContain('axis_revision');
  const eventFk = allowedValues.foreignKeys.find(
    (key) => key.getName() === 'catalog_product_variant_axis_allowed_values_event_fk',
  );
  expect(eventFk?.reference().columns.map((column) => column.name)).toEqual([
    'tenant_id',
    'product_id',
    'attribute_definition_id',
    'allowance_revision',
    'axis_revision',
  ]);
  expect(allowedValues.checks.map((key) => key.name)).toContain('catalog_product_variant_axis_allowed_values_key_ck');
});

it('keeps exact-locale facts and opaque attachment references tenant-qualified', () => {
  expect(getTableConfig(productLocalizedFacts).primaryKeys.map((key) => key.getName())).toContain(
    'catalog_product_localized_facts_pk',
  );
  expect(getTableConfig(variantLocalizedFacts).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_variant_localized_facts_variant_fk',
  ]);
  expect(getTableConfig(productLocalizedFactRevisions).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_product_localized_fact_revisions_fact_fk',
  ]);
  expect(getTableConfig(variantLocalizedFactRevisions).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_variant_localized_fact_revisions_fact_fk',
  ]);
  expect(getTableConfig(catalogMediaAssignmentSets).indexes.map((index) => index.config.name)).toEqual([
    'catalog_media_assignment_sets_product_uk',
    'catalog_media_assignment_sets_variant_uk',
  ]);
  expect(getTableConfig(catalogMediaAssignments).indexes.map((index) => index.config.name)).toContain(
    'catalog_media_assignments_active_position_uk',
  );
  expect(getTableConfig(catalogMediaAssignmentSetRevisions).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_media_assignment_set_revisions_set_fk',
  ]);
  expect(getTableConfig(catalogMediaAssignmentRevisions).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_media_assignment_revisions_assignment_fk',
    'catalog_media_assignment_revisions_set_fk',
  ]);
  for (const table of [catalogMediaAssignments, catalogMediaAssignmentRevisions]) {
    const names = getTableConfig(table).columns.map((column) => column.name);
    expect(names).toEqual(expect.arrayContaining(['owner_module_id', 'owner_resource_type', 'owner_resource_id']));
    expect(names).not.toContain('owner_version');
    expect(names).not.toContain('storage_key');
  }
});

it('separates Product and Variant value sets with controlled-value ownership and immutable revisions', () => {
  expect(getTableConfig(attributeValueSets).indexes.map((index) => index.config.name)).toEqual([
    'catalog_attribute_value_sets_product_uk',
    'catalog_attribute_value_sets_variant_uk',
  ]);
  expect(getTableConfig(attributeValueItems).foreignKeys.map((key) => key.getName())).toEqual([
    'catalog_attribute_value_items_set_fk',
    'catalog_attribute_value_items_controlled_fk',
  ]);
  expect(getTableConfig(attributeValueRevisions).primaryKeys.map((key) => key.getName())).toContain(
    'catalog_attribute_value_revisions_pk',
  );
});

it('checks migration hardening for force-RLS, append-only history, and stable identity', () => {
  const migrationRoot = new URL('../../drizzle/', import.meta.url);
  const combined = EffectArray.sort(readdirSync(migrationRoot), Order.String)
    .map((folder) => readFileSync(new URL(`${folder}/migration.sql`, migrationRoot), 'utf-8'))
    .join('\n');

  for (const table of CATALOG_TABLE_INVENTORY) {
    expect(combined).toContain(`ALTER TABLE "catalog"."${table}" FORCE ROW LEVEL SECURITY`);
  }
  expect(combined).toContain('catalog_product_revisions_append_only');
  expect(combined).toContain('catalog_result_snapshots_append_only');
  expect(combined).toContain('catalog_sku_assignment_revisions_append_only');
  expect(combined).toContain('catalog_gtin_assignment_revisions_append_only');
  expect(combined).toContain('catalog_configuration_definition_revisions_append_only');
  expect(combined).toContain('catalog_configuration_choices_append_only');
  expect(combined).toContain('catalog_configuration_unit_revisions_append_only');
  expect(combined).toContain('catalog_configuration_units_identity_immutable');
  expect(combined).toContain('catalog_configuration_option_allowances_append_only');
  expect(combined).toContain('catalog_configuration_revision_activations_append_only');
  expect(combined).toContain('catalog_configuration_definitions_identity_immutable');
  expect(combined).toContain('catalog_product_lifecycle_events_append_only');
  expect(combined).toContain('catalog_products_identity_immutable');
  expect(combined).toContain('catalog_product_variants_identity_immutable');
  expect(combined).toContain('catalog_product_type_revisions_append_only');
  expect(combined).toContain('catalog_product_type_revision_attributes_append_only');
  expect(combined).toContain('catalog_product_type_assignment_events_append_only');
  expect(combined).toContain('catalog_product_category_events_append_only');
  expect(combined).toContain('catalog_product_types_identity_immutable');
  expect(combined).toContain('catalog_product_categories_identity_immutable');
  expect(combined).toContain('catalog_category_revision_counters_monotonic');
  expect(combined).toContain('catalog_attribute_definition_revisions_append_only');
  expect(combined).toContain('catalog_controlled_value_revisions_append_only');
  expect(combined).toContain('catalog_attribute_definitions_identity_immutable');
  expect(combined).toContain('catalog_controlled_values_identity_immutable');
  expect(combined).toContain('catalog_controlled_values_definition_kind');
  expect(combined).toContain('catalog_attribute_value_revisions_append_only');
  expect(combined).toContain('catalog_product_attribute_applicability_revisions_append_only');
  expect(combined).toContain('catalog_product_variant_axis_events_append_only');
  expect(combined).toContain('catalog_product_variant_axis_allowance_events_append_only');
  expect(combined).toContain('catalog_product_variant_axis_allowed_values_append_only');
  expect(combined).toContain('catalog_product_variant_revisions_append_only');
  expect(combined).toContain('catalog_product_type_assignment_current_pointer');
  expect(combined).toContain('catalog_product_type_assignment_event_pointer');
  expect(combined).toContain('VALIDATE CONSTRAINT "catalog_product_variants_combination_ck"');
  expect(combined).toContain('catalog_product_variants_axis_current');
  expect(combined).toContain('catalog_product_variant_axes_current');
  expect(combined).toContain('catalog_product_variant_axis_events_distinct');
  expect(combined).toContain('catalog_package_content_revisions_append_only');
  expect(combined).toContain('catalog_package_option_role_revisions_append_only');
  expect(combined).toContain('catalog_package_definitions_identity_immutable');
  expect(combined).toContain('catalog_product_unit_rule_revisions_append_only');
  expect(combined).toContain('catalog_variant_unit_divisibility_revisions_append_only');
  expect(combined).toContain('catalog_package_unit_divisibility_revisions_append_only');
  expect(combined).toContain('catalog_product_units_identity_immutable');
  expect(combined).toContain('catalog_variant_unit_divisibility_identity_immutable');
  expect(combined).toContain('catalog_package_unit_divisibility_identity_immutable');
  expect(combined).toContain('catalog_package_content_revisions_unit_fk');
  expect(combined).toContain('catalog_product_relationship_revisions_append_only');
  expect(combined).toContain('catalog_product_relationships_identity_immutable');
  expect(combined).toContain('catalog_product_relationships_exact_uk" UNIQUE NULLS NOT DISTINCT');
  expect(combined).toContain('catalog_set_composition_revisions_append_only');
  expect(combined).toContain('catalog_set_composition_components_append_only');
  expect(combined).toContain('catalog_set_compositions_identity_immutable');
  expect(combined).toContain('catalog_set_compositions_current_revision_valid');
  expect(combined).toContain('catalog_set_composition_components_no_nested_set');
  expect(combined).toContain('catalog_set_compositions_no_nested_set');
  expect(combined).toContain('ALTER COLUMN "target_id" SET DATA TYPE text USING "target_id"::text');
  for (const trigger of [
    'catalog_product_localized_fact_revisions_append_only',
    'catalog_variant_localized_fact_revisions_append_only',
    'catalog_media_assignment_set_revisions_append_only',
    'catalog_media_assignment_revisions_append_only',
    'catalog_product_localized_facts_identity_immutable',
    'catalog_variant_localized_facts_identity_immutable',
    'catalog_media_assignment_sets_identity_immutable',
    'catalog_media_assignments_identity_immutable',
  ]) {
    expect(combined).toContain(trigger);
  }
  for (const trigger of [
    'catalog_brand_revisions_append_only',
    'catalog_product_brand_assignment_revisions_append_only',
    'catalog_manufacturer_relation_revisions_append_only',
    'catalog_brands_identity_immutable',
    'catalog_product_brand_assignments_identity_immutable',
    'catalog_manufacturer_relations_identity_immutable',
  ]) {
    expect(combined).toContain(trigger);
  }
  expect(combined).toContain("'commerce.catalog.product-unit') NOT VALID");
});
