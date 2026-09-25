// @effect-diagnostics nodeBuiltinImport:off -- Migration contract reads checked-in Inventory SQL; expires: 2027-03-31.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { Array as EffectArray, Order } from 'effect';
import { expect, it } from 'effect-rstest';

import { compareInventoryCatalog } from '../../src/database/catalog.ts';
import { INVENTORY_SCHEMA_NAME, INVENTORY_TABLE_INVENTORY, INVENTORY_TABLES } from '../../src/database/schema.ts';
import { inventoryBackendConfigurationImmutabilityTriggerContract } from '../../src/persistence/inventory-backend-configuration-table.ts';
import {
  inventoryCatalogToStockBindingCompatibilityTriggerContract,
  inventoryCatalogToStockBindingHistoryImmutabilityContract,
  inventoryCatalogToStockBindingMeaningKeyContract,
} from '../../src/persistence/catalog-to-stock-binding-table.ts';
import {
  inventoryCommitmentProtectionHistoryImmutabilityContract,
  inventoryCommitmentProtectionLifecycleContract,
  inventoryCommitmentProtectionScopeContract,
} from '../../src/persistence/commitment-protection-table.ts';
import {
  inventoryExternalStockCorrelationImmutabilityContract,
  inventoryExternalStockCorrelationNonoverlapContract,
} from '../../src/persistence/external-stock-correlation-table.ts';
import {
  claimInventoryEffectLedgerRoutine,
  readInventoryEffectLedgerForWorkerRoutine,
  transitionInventoryEffectLedgerForWorkerRoutine,
} from '../../src/persistence/inventory-effect-ledger-repository.ts';
import {
  inventoryEffectLedgerExactScopeContract,
  inventoryEffectLedgerHistoryImmutabilityContract,
  inventoryEffectLedgerTransitionContract,
} from '../../src/persistence/inventory-effect-ledger-table.ts';
import {
  inventoryObligationCommitTransitionContract,
  inventoryObligationImmutabilityContract,
  inventoryObligationCoverageTriggerContract,
  inventoryObligationScopeTriggerContract,
} from '../../src/persistence/inventory-obligation-table.ts';
import {
  finalizePhysicalStockEffectForWorkerRoutine,
  readPhysicalStockEffectForWorkerRoutine,
} from '../../src/persistence/physical-stock-effect-repository.ts';
import {
  inventoryPhysicalStockEffectIdentityTriggerContract,
  inventoryPhysicalStockEffectInsertionVerifierContract,
} from '../../src/persistence/physical-stock-effect-table.ts';
import {
  finalizeReservationCreateEffectForWorkerRoutine,
  readReservationCreateEffectForWorkerRoutine,
} from '../../src/persistence/reservation-create-effect-repository.ts';
import {
  inventoryReservationConfirmationHistoryImmutabilityContract,
  inventoryReservationConfirmationLifecycleContract,
  inventoryReservationConfirmationScopeContract,
} from '../../src/persistence/reservation-confirmation-table.ts';
import { inventoryReservationCreateEffectTransitionContract } from '../../src/persistence/reservation-create-effect-table.ts';
import {
  finalizeReservationReleaseEffectForWorkerRoutine,
  readReservationReleaseEffectForWorkerRoutine,
} from '../../src/persistence/reservation-release-effect-repository.ts';
import {
  inventoryReservationReleaseEffectHistoryImmutabilityContract,
  inventoryReservationReleaseEffectTransitionContract,
} from '../../src/persistence/reservation-release-effect-table.ts';
import {
  applyReservationShortageImpactForWorkerRoutine,
  findReservationShortageImpactForWorkerRoutine,
  readReservationShortageImpactContextForWorkerRoutine,
} from '../../src/persistence/reservation-shortage-impact-repository.ts';
import { inventoryReservationShortageImpactContract } from '../../src/persistence/reservation-shortage-impact-table.ts';
import {
  inventorySourceAssertionCoverageCompletenessContract,
  inventorySourceAssertionImmutabilityContract,
  inventorySourceAssertionScopeVerifierContract,
} from '../../src/persistence/inventory-source-assertion-table.ts';
import {
  inventorySourceConflictRevisionContract,
  inventorySourceConflictScopeVerifierContract,
} from '../../src/persistence/inventory-source-conflict-table.ts';
import { inventorySourceImportLedgerVerifierContract } from '../../src/persistence/inventory-source-import-ledger-table.ts';
import {
  inventoryStockCorrectionExactScopeVerifierContract,
  inventoryStockCorrectionImmutabilityContract,
  inventoryStockCorrectionOpenTransitionContract,
} from '../../src/persistence/stock-correction-table.ts';
import {
  inventoryStockCorrectionSourceEvidenceCoverageCompletenessContract,
  inventoryStockCorrectionSourceEvidenceCurrentOrderContract,
  inventoryStockCorrectionSourceEvidenceImmutabilityContract,
  inventoryStockCorrectionSourceEvidenceScopeVerifierContract,
} from '../../src/persistence/stock-correction-source-evidence-table.ts';
import { inventoryStockItemImmutabilityTriggerContract } from '../../src/persistence/stock-item-table.ts';
import {
  inventoryStockPositionImmutabilityTriggerContract,
  inventoryStockPositionOwnerConfigurationTriggerContract,
  inventoryStockPositionUnitMatchTriggerContract,
} from '../../src/persistence/stock-position-table.ts';
import {
  inventoryStockSharingEligibilityHistoryImmutabilityContract,
  inventoryStockSharingEligibilityIdentityImmutabilityContract,
  inventoryStockSharingEligibilityScopeTriggerContract,
} from '../../src/persistence/stock-sharing-eligibility-table.ts';

const readMigration = (folder: string) =>
  readFileSync(fileURLToPath(new URL(`../../drizzle/${folder}/migration.sql`, import.meta.url)), 'utf-8');

const requireMigrationFolder = (folder: string | undefined, suffix: string): string => {
  expect(folder, `Expected generated migration folder ending in ${suffix}`).toBeDefined();
  return folder ?? '';
};

it('owns thirty-four tenant-scoped Inventory tables with row-level security', () => {
  expect(INVENTORY_SCHEMA_NAME).toBe('inventory');
  expect(INVENTORY_TABLE_INVENTORY).toEqual([
    'backend_configurations',
    'catalog_to_stock_binding_history',
    'catalog_to_stock_bindings',
    'commitment_protection_history',
    'commitment_protections',
    'effect_ledger',
    'effect_ledger_history',
    'external_stock_correlations',
    'obligation_allocations',
    'obligation_requirements',
    'obligations',
    'physical_stock_effects',
    'reservation_confirmation_history',
    'reservation_confirmations',
    'reservation_create_effects',
    'reservation_release_effect_history',
    'reservation_release_effects',
    'reservation_shortage_impact_decisions',
    'reservation_shortage_impacts',
    'source_assertion_coverage',
    'source_assertions',
    'source_conflict_revisions',
    'source_import_ledger',
    'stock_correction_open_reconciliations',
    'stock_correction_source_evidence',
    'stock_correction_source_evidence_coverage',
    'stock_correction_source_evidence_current',
    'stock_corrections',
    'stock_items',
    'stock_location_revisions',
    'stock_locations',
    'stock_positions',
    'stock_sharing_eligibilities',
    'stock_sharing_eligibility_history',
  ]);
  expect(
    EffectArray.sort(
      INVENTORY_TABLES.map((table) => {
        const config = getTableConfig(table);
        return `${config.schema}.${config.name}`;
      }),
      Order.String,
    ),
  ).toEqual(INVENTORY_TABLE_INVENTORY.map((name) => `inventory.${name}`));
  for (const table of INVENTORY_TABLES) {
    const config = getTableConfig(table);
    expect(config.enableRLS, `${config.name} must enable RLS`).toBe(true);
    expect(config.columns.some((column) => column.name === 'tenant_id' && column.notNull)).toBe(true);
    expect(config.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(config.policies.every((policy) => policy.to === 'ontos_runtime')).toBe(true);
  }
});

// oxlint-disable-next-line eslint/complexity -- One migration contract keeps the serialized Inventory owner chain auditable in order; expires: 2027-03-31.
it('ships generated owner history and explicit immutable-identity hardening', () => {
  const config = readFileSync(fileURLToPath(new URL('../../drizzle.config.ts', import.meta.url)), 'utf-8');
  expect(config).toMatch(/__drizzle_migrations_inventory/u);
  expect(config).toMatch(/\.\/src\/database\/schema\.ts/u);

  const folders = EffectArray.sort(
    readdirSync(fileURLToPath(new URL('../../drizzle/', import.meta.url))),
    Order.String,
  );
  const foundationFolder = folders.find((entry) => entry.endsWith('_inventory-foundation'));
  const hardeningFolder = folders.find((entry) => entry.endsWith('_enforce-inventory-identities'));
  const backendFolder = folders.find((entry) =>
    readMigration(entry).includes('CREATE TABLE "inventory"."backend_configurations"'),
  );
  const backendHardeningFolder = folders.find((entry) => entry.endsWith('_enforce-backend-configuration-authority'));
  const stockPositionAndBindingFolder = folders.find((entry) =>
    entry.endsWith('_inventory-stock-positions-and-catalog-bindings'),
  );
  const externalStockCorrelationFolder = folders.find((entry) => entry.endsWith('_external-stock-correlations'));
  const effectLedgerFolder = folders.find((entry) => entry.endsWith('_inventory-effect-ledger'));
  const effectLedgerContractFixFolder = folders.find((entry) =>
    entry.endsWith('_inventory-effect-ledger-contract-fix'),
  );
  const commitmentProtectionFolder = folders.find((entry) => entry.endsWith('_inventory-commitment-protections'));
  const stockSharingEligibilityFolder = folders.find((entry) => entry.endsWith('_stock-sharing-eligibility'));
  const physicalStockEffectFolder = folders.find((entry) => entry.endsWith('_physical-stock-effects'));
  const catalogBindingHistoryLifecycleFolder = folders.find((entry) =>
    entry.endsWith('_catalog-binding-history-lifecycle'),
  );
  const sourceAssertionFolder = folders.find((entry) => entry.endsWith('_inventory-source-assertions'));
  const obligationFolder = folders.find((entry) => entry.endsWith('_inventory-obligations'));
  const obligationCommitFolder = folders.find((entry) => entry.endsWith('_inventory-obligation-commit'));
  const obligationAuthorityCapabilitiesFolder = folders.find((entry) =>
    entry.endsWith('_inventory-obligation-authority-capabilities'),
  );
  const sourceImportLedgerFolder = folders.find((entry) => entry.endsWith('_inventory-source-import-ledger'));
  const stockCorrectionFolder = folders.find((entry) => entry.endsWith('_inventory-stock-corrections'));
  const reservationCreateEffectFolder = folders.find((entry) =>
    entry.endsWith('_inventory-reservation-create-effects'),
  );
  const sourceConflictFolder = folders.find((entry) => entry.endsWith('_inventory-source-conflicts'));
  const reservationConfirmationFolder = folders.find((entry) => entry.endsWith('_inventory-reservation-confirmations'));
  const reservationReleaseEffectFolder = folders.find((entry) =>
    entry.endsWith('_inventory-reservation-release-effects'),
  );
  const reservationShortageImpactFolder = folders.find((entry) =>
    entry.endsWith('_inventory-reservation-shortage-impacts'),
  );
  const foundation = readMigration(requireMigrationFolder(foundationFolder, '_inventory-foundation'));
  const hardening = readMigration(requireMigrationFolder(hardeningFolder, '_enforce-inventory-identities'));
  const backend = readMigration(requireMigrationFolder(backendFolder, ' containing backend_configurations'));
  const backendHardening = readMigration(
    requireMigrationFolder(backendHardeningFolder, '_enforce-backend-configuration-authority'),
  );
  const stockPositionAndBinding = readMigration(
    requireMigrationFolder(stockPositionAndBindingFolder, '_inventory-stock-positions-and-catalog-bindings'),
  );
  const externalStockCorrelation = readMigration(
    requireMigrationFolder(externalStockCorrelationFolder, '_external-stock-correlations'),
  );
  const effectLedger = readMigration(requireMigrationFolder(effectLedgerFolder, '_inventory-effect-ledger'));
  const effectLedgerContractFix = readMigration(
    requireMigrationFolder(effectLedgerContractFixFolder, '_inventory-effect-ledger-contract-fix'),
  );
  const commitmentProtection = readMigration(
    requireMigrationFolder(commitmentProtectionFolder, '_inventory-commitment-protections'),
  );
  const stockSharingEligibility = readMigration(
    requireMigrationFolder(stockSharingEligibilityFolder, '_stock-sharing-eligibility'),
  );
  const physicalStockEffect = readMigration(
    requireMigrationFolder(physicalStockEffectFolder, '_physical-stock-effects'),
  );
  const catalogBindingHistoryLifecycle = readMigration(
    requireMigrationFolder(catalogBindingHistoryLifecycleFolder, '_catalog-binding-history-lifecycle'),
  );
  const sourceAssertion = readMigration(requireMigrationFolder(sourceAssertionFolder, '_inventory-source-assertions'));
  const obligation = readMigration(requireMigrationFolder(obligationFolder, '_inventory-obligations'));
  const obligationCommit = readMigration(
    requireMigrationFolder(obligationCommitFolder, '_inventory-obligation-commit'),
  );
  const obligationAuthorityCapabilities = readMigration(
    requireMigrationFolder(obligationAuthorityCapabilitiesFolder, '_inventory-obligation-authority-capabilities'),
  );
  const sourceImportLedger = readMigration(
    requireMigrationFolder(sourceImportLedgerFolder, '_inventory-source-import-ledger'),
  );
  const stockCorrection = readMigration(requireMigrationFolder(stockCorrectionFolder, '_inventory-stock-corrections'));
  const reservationCreateEffect = readMigration(
    requireMigrationFolder(reservationCreateEffectFolder, '_inventory-reservation-create-effects'),
  );
  const sourceConflict = readMigration(requireMigrationFolder(sourceConflictFolder, '_inventory-source-conflicts'));
  const reservationConfirmation = readMigration(
    requireMigrationFolder(reservationConfirmationFolder, '_inventory-reservation-confirmations'),
  );
  const reservationReleaseEffect = readMigration(
    requireMigrationFolder(reservationReleaseEffectFolder, '_inventory-reservation-release-effects'),
  );
  const reservationShortageImpact = readMigration(
    requireMigrationFolder(reservationShortageImpactFolder, '_inventory-reservation-shortage-impacts'),
  );

  expect(foundation.match(/CREATE TABLE "inventory"\./gu)).toHaveLength(3);
  expect(foundation.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(3);
  expect(foundation).not.toMatch(/REFERENCES "(?:core|auth|party|contacts|catalog)"\./u);
  expect(backend.match(/CREATE TABLE "inventory"\."backend_configurations"/gu)).toHaveLength(1);
  expect(backend.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(1);
  expect(backend).not.toMatch(/REFERENCES "(?:core|auth|party|contacts|catalog)"\./u);
  expect(hardening.match(/ALTER TABLE .* FORCE ROW LEVEL SECURITY/gu)).toHaveLength(3);
  expect(backendHardening.match(/ALTER TABLE .* FORCE ROW LEVEL SECURITY/gu)).toHaveLength(1);
  for (const immutableColumn of inventoryStockItemImmutabilityTriggerContract.columns) {
    expect(hardening).toContain(`NEW.${immutableColumn} IS DISTINCT FROM OLD.${immutableColumn}`);
  }
  expect(hardening).toContain(`"${inventoryStockItemImmutabilityTriggerContract.functionName.replace('.', '"."')}"`);
  expect(hardening).toContain(inventoryStockItemImmutabilityTriggerContract.triggerName);
  expect(hardening).toContain('inventory_stock_locations_immutable_identity_trg');
  expect(hardening).toContain('inventory_stock_location_revisions_append_only_trg');
  expect(hardening.match(/REVOKE ALL ON FUNCTION/gu)).toHaveLength(3);
  expect(backendHardening).toContain(
    `"${inventoryBackendConfigurationImmutabilityTriggerContract.functionName.replace('.', '"."')}"`,
  );
  expect(backendHardening).toContain(inventoryBackendConfigurationImmutabilityTriggerContract.triggerName);
  expect(backendHardening).toContain('BEFORE UPDATE OR DELETE');
  expect(backendHardening).toContain('require explicit cutover');
  expect(backendHardening.match(/REVOKE ALL ON FUNCTION/gu)).toHaveLength(1);
  expect(stockPositionAndBinding.match(/CREATE TABLE "inventory"\./gu)).toHaveLength(3);
  expect(stockPositionAndBinding.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(3);
  expect(stockPositionAndBinding.match(/ALTER TABLE .* FORCE ROW LEVEL SECURITY/gu)).toHaveLength(3);
  expect(stockPositionAndBinding).not.toMatch(/REFERENCES "(?:core|auth|party|contacts|catalog)"\./u);
  expect(stockPositionAndBinding).toContain('inventory_stock_positions_current_scope_uk');
  expect(stockPositionAndBinding).toContain(inventoryCatalogToStockBindingMeaningKeyContract.indexName);
  expect(stockPositionAndBinding).not.toContain('inventory_catalog_to_stock_bindings_selection_uk');
  expect(stockPositionAndBinding).toContain('("tenant_id","exact_selection_meaning_id")');
  expect(stockPositionAndBinding).toContain('inventory_stock_positions_item_fk');
  expect(stockPositionAndBinding).toContain('inventory_stock_positions_location_fk');
  expect(stockPositionAndBinding).toContain(inventoryStockPositionOwnerConfigurationTriggerContract.foreignKeyName);
  expect(stockPositionAndBinding).toContain('inventory_stock_positions_historical_on_hand_ck');
  for (const immutableColumn of inventoryStockPositionImmutabilityTriggerContract.columns) {
    expect(stockPositionAndBinding).toContain(`NEW.${immutableColumn} IS DISTINCT FROM OLD.${immutableColumn}`);
  }
  expect(stockPositionAndBinding).toContain(inventoryStockPositionImmutabilityTriggerContract.triggerName);
  expect(stockPositionAndBinding).toContain(inventoryStockPositionUnitMatchTriggerContract.triggerName);
  expect(stockPositionAndBinding).toContain(inventoryStockPositionUnitMatchTriggerContract.constraintName);
  expect(stockPositionAndBinding).toContain(inventoryStockPositionOwnerConfigurationTriggerContract.triggerName);
  expect(stockPositionAndBinding).toContain(inventoryStockPositionOwnerConfigurationTriggerContract.constraintName);
  expect(stockPositionAndBinding).toContain(
    inventoryCatalogToStockBindingHistoryImmutabilityContract.updateTriggerName,
  );
  expect(stockPositionAndBinding).toContain(
    inventoryCatalogToStockBindingHistoryImmutabilityContract.deleteTriggerName,
  );
  expect(stockPositionAndBinding).toContain(
    inventoryCatalogToStockBindingCompatibilityTriggerContract.bindingTriggerName,
  );
  expect(stockPositionAndBinding).toContain(
    inventoryCatalogToStockBindingCompatibilityTriggerContract.stockItemTriggerName,
  );
  for (const constraintName of Object.values(
    inventoryCatalogToStockBindingCompatibilityTriggerContract.failureConstraints,
  )) {
    expect(stockPositionAndBinding).toContain(constraintName);
  }
  expect(stockPositionAndBinding).toContain('FOR UPDATE');
  expect(stockPositionAndBinding.match(/REVOKE ALL ON FUNCTION/gu)).toHaveLength(6);
  expect(externalStockCorrelation.match(/CREATE TABLE "inventory"\./gu)).toHaveLength(1);
  expect(externalStockCorrelation.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(1);
  expect(externalStockCorrelation.match(/ALTER TABLE .* FORCE ROW LEVEL SECURITY/gu)).toHaveLength(1);
  expect(externalStockCorrelation).not.toMatch(/REFERENCES "(?:core|auth|party|contacts|catalog)"\./u);
  expect(externalStockCorrelation).toContain('inventory_external_stock_correlations_current_key_uk');
  expect(externalStockCorrelation).toContain('inventory_external_stock_correlations_item_fk');
  expect(externalStockCorrelation).toContain('inventory_external_stock_correlations_location_fk');
  expect(externalStockCorrelation).toContain('inventory_external_stock_correlations_target_ck');
  expect(externalStockCorrelation).toContain('inventory_external_stock_correlations_lifecycle_ck');
  for (const immutableColumn of inventoryExternalStockCorrelationImmutabilityContract.columns) {
    expect(externalStockCorrelation).toContain(`NEW.${immutableColumn} IS DISTINCT FROM OLD.${immutableColumn}`);
  }
  expect(externalStockCorrelation).toContain(inventoryExternalStockCorrelationImmutabilityContract.updateTriggerName);
  expect(externalStockCorrelation).toContain(inventoryExternalStockCorrelationImmutabilityContract.deleteTriggerName);
  expect(externalStockCorrelation).toContain(inventoryExternalStockCorrelationNonoverlapContract.triggerName);
  expect(externalStockCorrelation).toContain('inventory_external_stock_correlations_effective_period_excl');
  expect(externalStockCorrelation).toContain("ERRCODE = '23P01'");
  expect(externalStockCorrelation.match(/REVOKE ALL ON FUNCTION/gu)).toHaveLength(2);
  expect(stockSharingEligibility.match(/CREATE TABLE "inventory"\./gu)).toHaveLength(2);
  expect(stockSharingEligibility.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(2);
  expect(stockSharingEligibility.match(/ALTER TABLE .* FORCE ROW LEVEL SECURITY/gu)).toHaveLength(2);
  expect(stockSharingEligibility).not.toMatch(/REFERENCES "(?:core|auth|party|contacts|catalog)"\./u);
  expect(stockSharingEligibility).toContain('inventory_stock_sharing_eligibilities_backend_configuration_fk');
  expect(stockSharingEligibility).toContain('inventory_stock_sharing_eligibilities_position_fk');
  expect(stockSharingEligibility).toContain(inventoryStockSharingEligibilityScopeTriggerContract.triggerName);
  for (const constraintName of Object.values(inventoryStockSharingEligibilityScopeTriggerContract.constraintNames)) {
    expect(stockSharingEligibility).toContain(constraintName);
  }
  for (const immutableColumn of inventoryStockSharingEligibilityIdentityImmutabilityContract.columns) {
    expect(stockSharingEligibility).toContain(`NEW.${immutableColumn} IS DISTINCT FROM OLD.${immutableColumn}`);
  }
  expect(stockSharingEligibility).toContain(inventoryStockSharingEligibilityIdentityImmutabilityContract.triggerName);
  expect(stockSharingEligibility).toContain(
    inventoryStockSharingEligibilityHistoryImmutabilityContract.updateTriggerName,
  );
  expect(stockSharingEligibility).toContain(
    inventoryStockSharingEligibilityHistoryImmutabilityContract.deleteTriggerName,
  );
  expect(stockSharingEligibility).toContain('FOR KEY SHARE');
  expect(stockSharingEligibility.match(/REVOKE ALL ON FUNCTION/gu)).toHaveLength(3);
  expect(physicalStockEffect.match(/CREATE TABLE "inventory"\./gu)).toHaveLength(1);
  expect(physicalStockEffect.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(1);
  expect(physicalStockEffect.match(/ALTER TABLE .* FORCE ROW LEVEL SECURITY/gu)).toHaveLength(1);
  expect(physicalStockEffect).toContain('inventory_physical_stock_effects_position_fk');
  expect(physicalStockEffect).toContain('inventory_physical_stock_effects_backend_configuration_fk');
  expect(physicalStockEffect).toContain(inventoryPhysicalStockEffectInsertionVerifierContract.triggerName);
  expect(physicalStockEffect).toContain(inventoryPhysicalStockEffectInsertionVerifierContract.constraintName);
  expect(physicalStockEffect).toContain('BEFORE INSERT ON "inventory"."physical_stock_effects"');
  expect(physicalStockEffect).not.toContain('BEFORE INSERT OR UPDATE ON "inventory"."physical_stock_effects"');
  for (const immutableColumn of inventoryPhysicalStockEffectIdentityTriggerContract.columns) {
    expect(physicalStockEffect).toContain(`NEW.${immutableColumn} IS DISTINCT FROM OLD.${immutableColumn}`);
  }
  expect(physicalStockEffect).toContain(inventoryPhysicalStockEffectIdentityTriggerContract.triggerName);
  expect(physicalStockEffect).toContain(inventoryPhysicalStockEffectIdentityTriggerContract.terminalConstraintName);
  expect(physicalStockEffect).toContain('FOR UPDATE');
  expect(physicalStockEffect.match(/SECURITY DEFINER/gu)).toHaveLength(2);
  expect(physicalStockEffect.match(/SET search_path = pg_catalog, pg_temp/gu)).toHaveLength(2);
  expect(physicalStockEffect).toContain(
    `"inventory"."${readPhysicalStockEffectForWorkerRoutine.name}"(uuid, uuid, uuid)`,
  );
  expect(physicalStockEffect).toContain(
    `"inventory"."${finalizePhysicalStockEffectForWorkerRoutine.name}"(uuid, uuid, uuid, jsonb)`,
  );
  expect(physicalStockEffect.match(/REVOKE ALL ON FUNCTION/gu)).toHaveLength(4);
  expect(physicalStockEffect.match(/GRANT EXECUTE ON FUNCTION/gu)).toHaveLength(2);
  expect(catalogBindingHistoryLifecycle).not.toContain('CREATE TABLE');
  expect(catalogBindingHistoryLifecycle).toContain(
    'DROP CONSTRAINT "inventory_catalog_to_stock_binding_history_binding_fk"',
  );
  expect(catalogBindingHistoryLifecycle).toContain('ADD COLUMN "transition" text NOT NULL');
  expect(catalogBindingHistoryLifecycle).toContain('ADD COLUMN "owner_evidence_ref" text NOT NULL');
  expect(catalogBindingHistoryLifecycle).toContain('inventory_catalog_to_stock_binding_history_transition_ck');
  expect(catalogBindingHistoryLifecycle).toContain("'CORRECTED', 'ENDED', 'SUPERSEDED'");
  expect(catalogBindingHistoryLifecycle).toContain('char_length(btrim("owner_evidence_ref")) between 1 and 300');
  expect(sourceAssertion.match(/CREATE TABLE "inventory"\./gu)).toHaveLength(2);
  expect(sourceAssertion.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(2);
  expect(sourceAssertion.match(/ALTER TABLE .* FORCE ROW LEVEL SECURITY/gu)).toHaveLength(2);
  expect(sourceAssertion).not.toMatch(/REFERENCES "(?:core|auth|party|contacts|catalog)"\./u);
  expect(sourceAssertion).toContain('inventory_source_assertions_tenant_id_uk');
  expect(sourceAssertion).toContain('inventory_source_assertion_coverage_pk');
  for (const foreignKey of [
    'inventory_source_assertions_authority_configuration_fk',
    'inventory_source_assertions_position_fk',
    'inventory_source_assertions_item_fk',
    'inventory_source_assertions_location_fk',
    'inventory_source_assertions_item_correlation_fk',
    'inventory_source_assertions_location_correlation_fk',
    'inventory_source_assertion_coverage_assertion_fk',
    'inventory_source_assertion_coverage_effect_fk',
  ]) {
    expect(sourceAssertion).toContain(foreignKey);
  }
  expect(sourceAssertion).toContain(inventorySourceAssertionScopeVerifierContract.functionName.replace('.', '"."'));
  expect(sourceAssertion).toContain(inventorySourceAssertionScopeVerifierContract.triggerName);
  expect(sourceAssertion).toContain(inventorySourceAssertionScopeVerifierContract.coverageTriggerName);
  expect(sourceAssertion).toContain(inventorySourceAssertionCoverageCompletenessContract.constraintTriggerName);
  expect(sourceAssertion).toContain(
    inventorySourceAssertionCoverageCompletenessContract.functionName.replace('.', '"."'),
  );
  expect(sourceAssertion).toContain(inventorySourceAssertionCoverageCompletenessContract.effectRequiredState);
  expect(sourceAssertion).toContain('inventory_source_assertion_coverage_complete_ck');
  expect(sourceAssertion).toContain('CREATE CONSTRAINT TRIGGER');
  expect(sourceAssertion).toContain('DEFERRABLE INITIALLY DEFERRED');
  expect(sourceAssertion).toContain("pg_catalog.jsonb_array_length(NEW.assertion_json -> 'coverage')");
  expect(sourceAssertion).toContain("stored.effect_id::text = expected.entry ->> 'effectId'");
  for (const constraintName of Object.values(inventorySourceAssertionScopeVerifierContract.constraintNames)) {
    expect(sourceAssertion).toContain(constraintName);
  }
  for (const triggerName of inventorySourceAssertionImmutabilityContract.triggerNames) {
    expect(sourceAssertion).toContain(triggerName);
  }
  expect(sourceAssertion).toContain('correlation.effective_from <= NEW.business_observed_at');
  expect(sourceAssertion).toContain('NEW.business_observed_at < correlation.effective_to');
  expect(sourceAssertion).toContain('NEW.business_observed_at >= authority_configuration.selected_at');
  expect(sourceAssertion).not.toContain(
    "NEW.assertion_json ->> 'businessObservedAt' >= authority_configuration.selected_at",
  );
  expect(sourceAssertion).not.toContain('position.lifecycle_state');
  expect(sourceAssertion).toContain('effect.position_id = assertion.position_id');
  expect(sourceAssertion).toContain("effect.state = 'APPLIED'");
  expect(sourceAssertion).toContain("'{authorityConfiguration,selection,backend}'");
  expect(sourceAssertion).toContain('FOR KEY SHARE');
  expect(sourceAssertion.match(/REVOKE ALL ON FUNCTION/gu)).toHaveLength(3);
  expect(obligation.match(/CREATE TABLE "inventory"\./gu)).toHaveLength(3);
  expect(obligation.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(3);
  expect(obligation.match(/ALTER TABLE .* FORCE ROW LEVEL SECURITY/gu)).toHaveLength(3);
  expect(obligation).not.toMatch(/REFERENCES "(?:core|auth|party|contacts|catalog)"\./u);
  expect(obligation).not.toContain('ON DELETE CASCADE');
  for (const indexName of ['inventory_obligations_attempt_uk', 'inventory_obligations_imported_lineage_uk']) {
    expect(obligation).toContain(indexName);
  }
  expect(obligation).toContain('WHERE "origin_kind" = \'ORDER_COMMITMENT_ATTEMPT\'');
  expect(obligation).toContain('WHERE "origin_kind" = \'IMPORTED_PROVEN_ORDER\'');
  for (const foreignKey of [
    'inventory_obligations_backend_configuration_fk',
    'inventory_obligation_requirements_obligation_fk',
    'inventory_obligation_requirements_item_fk',
    'inventory_obligation_allocations_requirement_fk',
    'inventory_obligation_allocations_position_fk',
    'inventory_obligation_allocations_item_fk',
  ]) {
    expect(obligation).toContain(foreignKey);
  }
  for (const functionName of Object.values(inventoryObligationScopeTriggerContract.functions)) {
    expect(obligation).toContain(functionName.replace('.', '"."'));
  }
  for (const constraintName of Object.values(inventoryObligationScopeTriggerContract.constraintNames)) {
    expect(obligation).toContain(constraintName);
  }
  expect(obligation).toContain(inventoryObligationCoverageTriggerContract.constraintName);
  expect(obligation).toContain(inventoryObligationCoverageTriggerContract.functionName.replace('.', '"."'));
  for (const triggerName of inventoryObligationCoverageTriggerContract.triggerNames) {
    expect(obligation).toContain(triggerName);
  }
  expect(obligation).not.toContain('binding.catalog_selection = NEW.catalog_selection');
  expect(obligation).toContain('binding.exact_selection_meaning_id = NEW.exact_selection_meaning_id');
  expect(obligation).toContain('item.exact_selection_meaning_id = NEW.exact_selection_meaning_id');
  expect(obligation).toContain("item.lifecycle_state = 'CURRENT'");
  expect(obligation).toContain("NEW.stock_item_snapshot #>> '{stockItemRef,resourceId}'");
  expect(obligation).toContain("pg_catalog.jsonb_path_query(NEW.catalog_selection, 'strict $.**.tenantId')");
  expect(obligation).toContain('position.owner_configuration_id = obligation.owner_configuration_id');
  expect(obligation).toContain("position.lifecycle_state = 'CURRENT'");
  expect(obligation.match(/CREATE CONSTRAINT TRIGGER/gu)).toHaveLength(2);
  expect(obligation.match(/DEFERRABLE INITIALLY DEFERRED/gu)).toHaveLength(2);
  expect(obligation).toContain('allocated_total IS DISTINCT FROM required_amount');
  for (const functionName of Object.values(inventoryObligationImmutabilityContract.functions)) {
    expect(obligation).toContain(functionName.replace('.', '"."'));
  }
  for (const immutableColumn of inventoryObligationImmutabilityContract.obligationImmutableColumns) {
    expect(`${obligation}\n${obligationAuthorityCapabilities}`).toContain(
      `NEW.${immutableColumn} IS DISTINCT FROM OLD.${immutableColumn}`,
    );
  }
  for (const immutableColumn of inventoryObligationImmutabilityContract.importedProofImmutableColumns) {
    expect(obligation).toContain(`NEW.${immutableColumn} IS DISTINCT FROM OLD.${immutableColumn}`);
  }
  expect(obligation).toContain(`OLD.origin_kind = '${inventoryObligationImmutabilityContract.importedOriginKind}'`);
  expect(obligation).toContain(`OLD.origin_kind = '${inventoryObligationImmutabilityContract.runtimeOriginKind}'`);
  expect(obligation).toContain(
    `OLD.lifecycle_meaning = '${inventoryObligationImmutabilityContract.runtimeTransition.from}'`,
  );
  expect(obligation).toContain(
    `NEW.lifecycle_meaning = '${inventoryObligationImmutabilityContract.runtimeTransition.to}'`,
  );
  for (const requiredProofColumn of inventoryObligationImmutabilityContract.runtimeTransition.requiredProofColumns) {
    expect(obligation).toContain(`NEW.${requiredProofColumn} IS NOT NULL`);
  }
  expect(obligation).toContain('inventory_obligation_requirements_append_only_trg');
  expect(obligation).toContain('inventory_obligation_allocations_append_only_trg');
  expect(obligation).toContain('inventory_obligations_immutable_origin_trg');
  expect(obligation).toContain('FOR UPDATE');
  expect(obligation.match(/REVOKE ALL ON FUNCTION/gu)).toHaveLength(7);
  expect(obligationAuthorityCapabilities).toContain('authority_exact_reservation_capability');
  expect(obligationAuthorityCapabilities).toContain('authority_stock_correction_capability');
  expect(obligationAuthorityCapabilities).toContain(
    'configuration.exact_reservation_capability = NEW.authority_exact_reservation_capability',
  );
  expect(obligationAuthorityCapabilities).toContain(
    'configuration.stock_correction_capability = NEW.authority_stock_correction_capability',
  );
  expect(obligationAuthorityCapabilities).toContain(
    'SET\n  "authority_exact_reservation_capability" = configuration."exact_reservation_capability"',
  );
  expect(obligationCommit).toContain(`CREATE UNIQUE INDEX "${inventoryObligationCommitTransitionContract.indexName}"`);
  expect(obligationCommit).toContain('("tenant_id","accepted_order_id")');
  expect(obligationCommit).toContain(
    `WHERE "origin_kind" = '${inventoryObligationImmutabilityContract.runtimeOriginKind}' and "lifecycle_meaning" = '${inventoryObligationCommitTransitionContract.transition.to}'`,
  );
  expect(obligationCommit).toContain(inventoryObligationCommitTransitionContract.functionName.replace('.', '"."'));
  expect(obligation).toContain(inventoryObligationCommitTransitionContract.triggerName);
  expect(obligationCommit).toContain(inventoryObligationCommitTransitionContract.constraintName);
  expect(obligationCommit).toContain(`TG_OP = 'DELETE'`);
  expect(obligationCommit).toContain(
    `OLD.lifecycle_meaning = '${inventoryObligationCommitTransitionContract.transition.from}'`,
  );
  expect(obligationCommit).toContain(
    `NEW.lifecycle_meaning = '${inventoryObligationCommitTransitionContract.transition.to}'`,
  );
  for (const column of inventoryObligationCommitTransitionContract.exactMutableColumns) {
    expect(obligationCommit).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`);
  }
  for (const column of inventoryObligationCommitTransitionContract.requiredProofColumns) {
    expect(obligationCommit).toContain(`OLD.${column} IS NULL`);
    expect(obligationCommit).toContain(`NEW.${column} IS NOT NULL`);
  }
  expect(obligationCommit).toContain("OLD.origin_kind <> 'ORDER_COMMITMENT_ATTEMPT'");
  expect(obligationCommit).toContain('NEW.accepted_order_id IS NOT DISTINCT FROM OLD.accepted_order_id');
  expect(obligationCommit).toContain('NEW.order_evidence_ref IS NOT DISTINCT FROM OLD.order_evidence_ref');
  expect(obligationCommit).toContain(
    'NEW.order_evidence_observed_at IS NOT DISTINCT FROM OLD.order_evidence_observed_at',
  );
  expect(obligationCommit).toContain(
    'REVOKE ALL ON FUNCTION "inventory"."reject_obligation_origin_mutation"() FROM PUBLIC, "ontos_runtime"',
  );
  expect(sourceImportLedger.match(/CREATE TABLE "inventory"\./gu)).toHaveLength(1);
  expect(sourceImportLedger.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(1);
  expect(sourceImportLedger.match(/ALTER TABLE .* FORCE ROW LEVEL SECURITY/gu)).toHaveLength(1);
  expect(sourceImportLedger).not.toMatch(/REFERENCES "(?:core|auth|party|contacts|catalog)"\./u);
  expect(sourceImportLedger).toContain('inventory_source_import_ledger_pk');
  expect(sourceImportLedger).toContain('inventory_source_import_ledger_position_fk');
  expect(sourceImportLedger).toContain('inventory_source_import_ledger_stream_idx');
  expect(sourceImportLedger).toContain('inventory_source_import_accepted_assertion_uk');
  expect(sourceImportLedger).toContain('inventory_source_import_accepted_source_identity_uk');
  expect(sourceImportLedger).toContain('inventory_source_import_accepted_revision_uk');
  expect(sourceImportLedger.match(/WHERE "status" = 'ACCEPTED'/gu)).toHaveLength(3);
  expect(sourceImportLedger).toContain(inventorySourceImportLedgerVerifierContract.functionName.replace('.', '"."'));
  expect(sourceImportLedger).toContain(inventorySourceImportLedgerVerifierContract.scopeTriggerName);
  expect(sourceImportLedger).toContain(inventorySourceImportLedgerVerifierContract.immutableTriggerName);
  expect(sourceImportLedger).toContain(inventorySourceImportLedgerVerifierContract.acceptedAssertionForeignKey);
  expect(sourceImportLedger).toContain('BEFORE INSERT ON "inventory"."source_import_ledger"');
  expect(sourceImportLedger).toContain('BEFORE UPDATE OR DELETE ON "inventory"."source_import_ledger"');
  expect(sourceImportLedger).toContain("NEW.proposal_json ->> 'assertionId' IS DISTINCT FROM NEW.assertion_id::text");
  expect(sourceImportLedger).toContain("NEW.outcome_json ->> 'status' IS DISTINCT FROM NEW.status");
  expect(sourceImportLedger).toContain('assertion.tenant_id = NEW.tenant_id');
  expect(sourceImportLedger).toContain('assertion.assertion_id = NEW.assertion_id');
  expect(sourceImportLedger).toContain("IF NEW.status = 'ACCEPTED' THEN");
  expect(sourceImportLedger).toContain("ERRCODE = '23503'");
  expect(sourceImportLedger).toContain('FOR KEY SHARE');
  expect(sourceImportLedger.match(/REVOKE ALL ON FUNCTION/gu)).toHaveLength(2);
  expect(stockCorrection.match(/CREATE TABLE "inventory"\./gu)).toHaveLength(5);
  expect(stockCorrection.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(5);
  expect(stockCorrection.match(/ALTER TABLE .* FORCE ROW LEVEL SECURITY/gu)).toHaveLength(5);
  expect(stockCorrection).not.toMatch(/REFERENCES "(?:core|auth|party|contacts|catalog)"\./u);
  for (const foreignKey of [
    'inventory_stock_corrections_position_fk',
    'inventory_stock_corrections_assertion_fk',
    'inventory_stock_corrections_source_evidence_fk',
    'inventory_stock_corrections_authority_fk',
    'inventory_stock_corrections_reconciles_fk',
    'inventory_stock_correction_open_position_fk',
    'inventory_stock_correction_open_correction_fk',
    'inventory_stock_correction_source_evidence_authority_fk',
    'inventory_stock_correction_source_evidence_position_fk',
    'inventory_stock_correction_source_evidence_item_fk',
    'inventory_stock_correction_source_evidence_location_fk',
    'inventory_stock_correction_source_evidence_coverage_evidence_fk',
    'inventory_stock_correction_source_evidence_coverage_effect_fk',
    'inventory_stock_correction_source_evidence_current_evidence_fk',
  ]) {
    expect(stockCorrection).toContain(foreignKey);
  }
  expect(stockCorrection).toContain(
    inventoryStockCorrectionExactScopeVerifierContract.functionName.replace('.', '"."'),
  );
  expect(stockCorrection).toContain(inventoryStockCorrectionExactScopeVerifierContract.triggerName);
  expect(stockCorrection).toContain(inventoryStockCorrectionExactScopeVerifierContract.constraintName);
  expect(stockCorrection).toContain('BEFORE INSERT ON "inventory"."stock_corrections"');
  expect(stockCorrection).toContain(inventoryStockCorrectionImmutabilityContract.functionName.replace('.', '"."'));
  expect(stockCorrection).toContain(inventoryStockCorrectionImmutabilityContract.triggerName);
  expect(stockCorrection).toContain('BEFORE UPDATE OR DELETE ON "inventory"."stock_corrections"');
  expect(stockCorrection).toContain(inventoryStockCorrectionOpenTransitionContract.functionName.replace('.', '"."'));
  expect(stockCorrection).toContain(inventoryStockCorrectionOpenTransitionContract.triggerName);
  expect(stockCorrection).toContain(inventoryStockCorrectionOpenTransitionContract.constraintName);
  expect(stockCorrection).toContain(
    'BEFORE INSERT OR UPDATE OR DELETE ON "inventory"."stock_correction_open_reconciliations"',
  );
  expect(stockCorrection).toContain("assertion.issuer_authority = 'SELECTED_BACKEND'");
  expect(stockCorrection).toContain("accepted.status = 'ACCEPTED'");
  expect(stockCorrection).toContain("competing.status = 'ACCEPTED'");
  expect(stockCorrection).toContain("authority.stock_correction_capability = 'SUPPORTED'");
  expect(stockCorrection).toContain('NEW.business_observed_at >= authority.selected_at');
  expect(stockCorrection).toContain('length(split_part("quantity_amount", \'.\', 1)) <= 29');
  expect(stockCorrection).toContain('length(split_part("quantity_amount", \'.\', 2)) <= 9');
  expect(stockCorrection).toContain(
    "(NEW.evidence_json #>> '{authorityConfiguration,selectedAt}')::timestamptz = exact_authority.selected_at",
  );
  expect(stockCorrection).toContain(
    "(NEW.evidence_json #>> '{authorityConfiguration,revision}')::integer = exact_authority.revision",
  );
  expect(stockCorrection).toContain("'{authorityConfiguration,selection,exactReservationCapability}'");
  expect(stockCorrection).toContain('current_evidence.evidence_id = evidence.evidence_id');
  expect(stockCorrection).toContain("position.lifecycle_state = 'CURRENT'");
  expect(stockCorrection).toContain('position.revision = NEW.expected_position_revision');
  expect(stockCorrection).toContain("effect.state = 'APPLIED'");
  expect(stockCorrection).toContain("(effect.evidence_json ->> 'appliedAt')::timestamptz >= NEW.business_observed_at");
  expect(stockCorrection).toContain('NEW.evaluated_material_effect_ids_json IS DISTINCT FROM expected_effect_ids');
  expect(stockCorrection).toContain("expected_reason_code := 'MATERIAL_EFFECT_COVERAGE_MISSING'");
  expect(stockCorrection).toContain("expected_reason_code := 'MATERIAL_EFFECT_COVERAGE_UNKNOWN'");
  expect(stockCorrection).toContain("expected_reason_code := 'MATERIAL_EFFECT_EXCLUDED_OR_PREDATED'");
  expect(stockCorrection).toContain(
    "NEW.record_json -> 'materialEffectIds' IS DISTINCT FROM expected_material_effect_ids",
  );
  expect(stockCorrection).toContain("NEW.record_json #>> '{previousOnHand,_tag}'");
  expect(stockCorrection).toContain("replacement.state = 'APPLIED'");
  expect(stockCorrection).toContain('replacement_reconciles IS DISTINCT FROM OLD.correction_id');
  expect(stockCorrection).not.toContain('REFERENCES "inventory"."obligations"');
  expect(stockCorrection).not.toContain('REFERENCES "inventory"."obligation_allocations"');
  expect(stockCorrection).toContain(
    inventoryStockCorrectionSourceEvidenceScopeVerifierContract.functionName.replace('.', '"."'),
  );
  expect(stockCorrection).toContain(inventoryStockCorrectionSourceEvidenceScopeVerifierContract.triggerName);
  expect(stockCorrection).toContain(inventoryStockCorrectionSourceEvidenceScopeVerifierContract.coverageTriggerName);
  for (const constraintName of Object.values(
    inventoryStockCorrectionSourceEvidenceScopeVerifierContract.constraintNames,
  )) {
    expect(stockCorrection).toContain(constraintName);
  }
  expect(stockCorrection).toContain(
    inventoryStockCorrectionSourceEvidenceCoverageCompletenessContract.functionName.replace('.', '"."'),
  );
  expect(stockCorrection).toContain(
    inventoryStockCorrectionSourceEvidenceCoverageCompletenessContract.constraintTriggerName,
  );
  expect(stockCorrection).toContain('DEFERRABLE INITIALLY DEFERRED');
  expect(stockCorrection).toContain(
    inventoryStockCorrectionSourceEvidenceCurrentOrderContract.functionName.replace('.', '"."'),
  );
  expect(stockCorrection).toContain(inventoryStockCorrectionSourceEvidenceCurrentOrderContract.triggerName);
  expect(stockCorrection).toContain(inventoryStockCorrectionSourceEvidenceCurrentOrderContract.constraintName);
  expect(stockCorrection).toContain('NEW.ordering_evidence_value <= OLD.ordering_evidence_value');
  expect(stockCorrection).toContain(
    inventoryStockCorrectionSourceEvidenceImmutabilityContract.functionName.replace('.', '"."'),
  );
  for (const triggerName of inventoryStockCorrectionSourceEvidenceImmutabilityContract.triggerNames) {
    expect(stockCorrection).toContain(triggerName);
  }
  expect(stockCorrection.match(/REVOKE ALL ON FUNCTION/gu)).toHaveLength(7);
  expect(reservationCreateEffect.match(/CREATE TABLE "inventory"\./gu)).toHaveLength(1);
  expect(reservationCreateEffect.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(1);
  expect(reservationCreateEffect.match(/ALTER TABLE .* FORCE ROW LEVEL SECURITY/gu)).toHaveLength(1);
  expect(reservationCreateEffect).toContain(
    'CONSTRAINT "inventory_reservation_create_effects_pkey" PRIMARY KEY("tenant_id","effect_id")',
  );
  expect(reservationCreateEffect).not.toContain('inventory_reservation_create_effects_tenant_id_uk');
  expect(reservationCreateEffect).toContain('inventory_reservation_create_effects_attempt_uk');
  expect(reservationCreateEffect).toContain('inventory_reservation_create_effects_mutation_uk');
  expect(reservationCreateEffect).toContain('inventory_reservation_create_effects_reservation_uk');
  expect(reservationCreateEffect).toContain('inventory_reservation_create_effects_backend_configuration_fk');
  expect(reservationCreateEffect).toContain(
    inventoryReservationCreateEffectTransitionContract.functionName.replace('.', '"."'),
  );
  expect(reservationCreateEffect).toContain(inventoryReservationCreateEffectTransitionContract.triggerName);
  expect(reservationCreateEffect).toContain(inventoryReservationCreateEffectTransitionContract.constraintName);
  for (const immutableColumn of inventoryReservationCreateEffectTransitionContract.immutableColumns) {
    expect(reservationCreateEffect).toContain(`NEW.${immutableColumn} IS DISTINCT FROM OLD.${immutableColumn}`);
  }
  expect(reservationCreateEffect).toContain(
    'BEFORE INSERT OR UPDATE OR DELETE ON "inventory"."reservation_create_effects"',
  );
  expect(reservationCreateEffect).toContain("OLD.state = 'REQUESTED'");
  expect(reservationCreateEffect).toContain("OLD.state IN ('RECONCILIATION_REQUIRED', 'INDETERMINATE')");
  expect(reservationCreateEffect).toContain("OLD.state = 'ESTABLISHED'");
  expect(reservationCreateEffect).toContain("OLD.state = 'RESOLVED_NO_RESERVATION'");
  expect(reservationCreateEffect).toContain("NEW.request_json ->> 'mutationId'");
  expect(reservationCreateEffect).toContain("NEW.request_json ->> 'sourceActionInvocationId'");
  expect(reservationCreateEffect).toContain('NEW.record_json IS DISTINCT FROM OLD.record_json');
  expect(reservationCreateEffect).toContain(
    `"inventory"."${readReservationCreateEffectForWorkerRoutine.name}"(uuid, uuid, text)`,
  );
  expect(reservationCreateEffect).toContain(
    `"inventory"."${finalizeReservationCreateEffectForWorkerRoutine.name}"(uuid, uuid, text, jsonb)`,
  );
  expect(reservationCreateEffect.match(/SECURITY DEFINER/gu)).toHaveLength(2);
  expect(reservationCreateEffect.match(/SET search_path = pg_catalog, pg_temp/gu)).toHaveLength(2);
  expect(reservationCreateEffect).toContain('INSERT INTO "inventory"."obligations"');
  expect(reservationCreateEffect).toContain('INSERT INTO "inventory"."obligation_requirements"');
  expect(reservationCreateEffect).toContain('INSERT INTO "inventory"."obligation_allocations"');
  expect(reservationCreateEffect).toContain('FOR UPDATE');
  expect(reservationCreateEffect.match(/REVOKE ALL ON FUNCTION/gu)).toHaveLength(3);
  expect(reservationCreateEffect.match(/GRANT EXECUTE ON FUNCTION/gu)).toHaveLength(2);
  expect(sourceConflict.match(/CREATE TABLE "inventory"\./gu)).toHaveLength(1);
  expect(sourceConflict.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(1);
  expect(sourceConflict.match(/ALTER TABLE .* FORCE ROW LEVEL SECURITY/gu)).toHaveLength(1);
  expect(sourceConflict).toContain('inventory_source_conflict_revisions_pk');
  expect(sourceConflict).toContain('inventory_source_conflict_revisions_position_fk');
  expect(sourceConflict).toContain(inventorySourceConflictRevisionContract.functionName.replace('.', '"."'));
  expect(sourceConflict).toContain(inventorySourceConflictRevisionContract.immutableTriggerName);
  expect(sourceConflict).toContain(inventorySourceConflictRevisionContract.sequenceTriggerName);
  expect(sourceConflict).toContain(inventorySourceConflictScopeVerifierContract.functionName.replace('.', '"."'));
  expect(sourceConflict).toContain(inventorySourceConflictScopeVerifierContract.triggerName);
  expect(sourceConflict).toContain('BEFORE INSERT ON "inventory"."source_conflict_revisions"');
  expect(sourceConflict).toContain('BEFORE UPDATE OR DELETE ON "inventory"."source_conflict_revisions"');
  expect(sourceConflict).toContain('NEW.resolved_at < NEW.detected_at');
  expect(sourceConflict).toContain("NEW.conflict_json -> 'originalEvidence'");
  expect(sourceConflict).toContain("previous.conflict_json -> 'evidence'");
  expect(sourceConflict).toContain("NEW.conflict_json -> 'authorityConfiguration'");
  expect(sourceConflict).toContain("NEW.conflict_json -> 'scope'");
  expect(sourceConflict).toContain("NEW.conflict_json #>> '{scope,positionRef,resourceId}'");
  expect(sourceConflict).toContain("NEW.conflict_json #>> '{scope,unitRef,resourceId}'");
  expect(sourceConflict).toContain("NEW.conflict_json #>> '{scope,tenantId}'");
  expect(sourceConflict).toContain("NEW.conflict_json #>> '{scope,_tag}' IS DISTINCT FROM 'EXTERNAL_CORRELATION'");
  expect(sourceConflict).toContain("source_evidence -> 'ambiguousExternalKey'");
  expect(sourceConflict).toContain("source_evidence -> 'candidateCorrelationRefs'");
  expect(sourceConflict).toContain('pg_catalog.jsonb_array_length(source_evidence');
  expect(sourceConflict).toContain("ambiguous_key ->> 'tenantId' IS DISTINCT FROM NEW.tenant_id::text");
  expect(sourceConflict).toContain(
    "ambiguous_key ->> 'customerConfigurationId' IS DISTINCT FROM NEW.customer_configuration_id",
  );
  expect(sourceConflict).toContain("proposal -> 'itemExternalKey' IS DISTINCT FROM ambiguous_key");
  expect(sourceConflict).toContain("proposal -> 'locationExternalKey' IS DISTINCT FROM ambiguous_key");
  expect(sourceConflict).toContain('FOR proposal IN');
  expect(sourceConflict).toContain("proposal #>> '{positionRef,resourceId}' IS DISTINCT FROM NEW.position_id::text");
  expect(sourceConflict).toContain("proposal #>> '{quantity,unitRef,resourceId}'");
  expect(sourceConflict).toContain("source_evidence -> 'selectedConfiguration'");
  expect(sourceConflict).toContain("source_evidence #>> '{attemptedSelection,backend}'");
  expect(sourceConflict).toContain("NEW.conflict_json #> '{resolution,configuration}'");
  expect(sourceConflict).toContain("resolution_assertion -> 'authorityConfiguration'");
  expect(sourceConflict).toContain("resolution_assertion #>> '{positionRef,resourceId}'");
  expect(sourceConflict).toContain('"inventory"."source_assertions" AS persisted_assertion');
  expect(sourceConflict).toContain('persisted_assertion.assertion_id');
  expect(sourceConflict).toContain('persisted_assertion.assertion_json IS NOT DISTINCT FROM resolution_assertion');
  expect(sourceConflict).toContain('"inventory"."external_stock_correlations" AS repaired_correlation');
  expect(sourceConflict).toContain('repaired_correlation.correlation_id');
  expect(sourceConflict).toContain('repaired_correlation.effective_from');
  expect(sourceConflict).toContain('repaired_correlation.stock_item_id');
  expect(sourceConflict).toContain('repaired_correlation.stock_location_id');
  expect(sourceConflict).toContain("position.lifecycle_state = 'CURRENT'");
  expect(sourceConflict).toContain("position.on_hand_state = 'CURRENT'");
  expect(sourceConflict).toContain(
    'CREATE OR REPLACE FUNCTION "inventory"."enforce_source_import_ledger_exact_scope"()',
  );
  expect(sourceConflict).toContain("NEW.outcome_json ->> 'reason' = 'INVENTORY_SOURCE_CONFLICT'");
  expect(sourceConflict).toContain("'assertionId', 'conflictRefs', 'reason', 'reconciliationRequired', 'status'");
  expect(sourceConflict).toContain("'assertionId', 'reason', 'reconciliationRequired', 'status'");
  expect(sourceConflict).toContain("pg_catalog.jsonb_array_length(NEW.outcome_json -> 'conflictRefs') < 1");
  expect(sourceConflict).toContain("pg_catalog.count(DISTINCT conflict_ref ->> 'resourceId')");
  expect(sourceConflict).toContain('"inventory"."source_conflict_revisions" AS source_conflict');
  expect(sourceConflict).toContain('source_conflict.revision = 1');
  expect(sourceConflict).toContain("source_conflict.status = 'OPEN'");
  expect(sourceConflict).toContain("source_conflict.conflict_json -> 'conflictRef' IS NOT DISTINCT FROM conflict_ref");
  expect(sourceConflict).toContain(
    "source_conflict.conflict_json #> '{evidence,proposal}'\n                      IS NOT DISTINCT FROM NEW.proposal_json",
  );
  expect(sourceConflict).toContain('conflict_proposal IS NOT DISTINCT FROM NEW.proposal_json');
  expect(sourceConflict.match(/REVOKE ALL ON FUNCTION/gu)).toHaveLength(3);
  expect(reservationConfirmation.match(/CREATE TABLE "inventory"\./gu)).toHaveLength(2);
  expect(reservationConfirmation.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(2);
  expect(reservationConfirmation.match(/ALTER TABLE .* FORCE ROW LEVEL SECURITY/gu)).toHaveLength(2);
  expect(reservationConfirmation).toContain('inventory_reservation_confirmations_reservation_fk');
  expect(reservationConfirmation).toContain('inventory_reservation_confirmations_backend_configuration_fk');
  expect(reservationConfirmation).toContain('inventory_reservation_confirmations_reservation_attempt_uk');
  expect(reservationConfirmation).toContain('inventory_reservation_confirmations_authority_effect_uk');
  expect(reservationConfirmation).toContain(
    inventoryReservationConfirmationScopeContract.functionName.replace('.', '"."'),
  );
  expect(reservationConfirmation).toContain(inventoryReservationConfirmationScopeContract.triggerName);
  for (const constraintName of Object.values(inventoryReservationConfirmationScopeContract.constraintNames)) {
    expect(reservationConfirmation).toContain(constraintName);
  }
  expect(reservationConfirmation).toContain(
    inventoryReservationConfirmationLifecycleContract.functionName.replace('.', '"."'),
  );
  expect(reservationConfirmation).toContain(inventoryReservationConfirmationLifecycleContract.triggerName);
  for (const immutableColumn of inventoryReservationConfirmationLifecycleContract.immutableColumns) {
    expect(reservationConfirmation).toContain(`NEW.${immutableColumn} IS DISTINCT FROM OLD.${immutableColumn}`);
  }
  expect(reservationConfirmation).toContain("OLD.current_health_state IN ('REVOKED', 'EXPIRED')");
  expect(reservationConfirmation).toContain('NEW.current_revision IS DISTINCT FROM OLD.current_revision + 1');
  expect(reservationConfirmation).toContain(
    "(NEW.snapshot #>> '{health,observation,effectiveAt}')::timestamptz\n      < (OLD.snapshot #>> '{health,observation,effectiveAt}')::timestamptz",
  );
  expect(reservationConfirmation).toContain("OLD.current_health_state NOT IN ('AT_RISK', 'UNVERIFIABLE')");
  expect(reservationConfirmation).toContain(
    inventoryReservationConfirmationHistoryImmutabilityContract.functionName.replace('.', '"."'),
  );
  expect(reservationConfirmation).toContain(
    inventoryReservationConfirmationHistoryImmutabilityContract.updateTriggerName,
  );
  expect(reservationConfirmation).toContain(
    inventoryReservationConfirmationHistoryImmutabilityContract.deleteTriggerName,
  );
  expect(reservationConfirmation).toContain('inventory_reservation_confirmation_history_scope_trg');
  expect(reservationConfirmation).toContain('inventory_reservation_confirmation_history_snapshot_ck');
  expect(reservationConfirmation).toContain("reservation.origin_kind = 'ORDER_COMMITMENT_ATTEMPT'");
  expect(reservationConfirmation).toContain("reservation.lifecycle_meaning = 'PROVISIONAL_RESERVATION'");
  expect(reservationConfirmation).toContain("authority.exact_reservation_capability = 'SUPPORTED'");
  expect(reservationConfirmation).toContain("NEW.snapshot #> '{authorityEvidence,evidence,allocations}'");
  expect(reservationConfirmation).toContain("TG_OP = 'INSERT'");
  expect(reservationConfirmation).toContain("'{health,observation,correctionEvidenceRef}'");
  expect(reservationConfirmation).toContain("'{health,observation,ownerEvidenceRef}'");
  expect(reservationConfirmation).toContain("observation_tag <> 'VALIDITY_ELAPSED'");
  expect(reservationConfirmation).toContain('confirmation.snapshot IS NOT DISTINCT FROM NEW.snapshot');
  expect(reservationConfirmation.match(/REVOKE ALL ON FUNCTION/gu)).toHaveLength(4);
  expect(reservationShortageImpact.match(/CREATE TABLE "inventory"\./gu)).toHaveLength(2);
  expect(reservationShortageImpact.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(2);
  expect(reservationShortageImpact.match(/ALTER TABLE .* FORCE ROW LEVEL SECURITY/gu)).toHaveLength(2);
  expect(reservationShortageImpact).toContain('inventory_reservation_shortage_impacts_position_fk');
  expect(reservationShortageImpact).toContain('inventory_reservation_shortage_impacts_effect_fk');
  expect(reservationShortageImpact).toContain('inventory_reservation_shortage_impacts_correction_fk');
  expect(reservationShortageImpact).toContain(
    inventoryReservationShortageImpactContract.source.functionName.replace('.', '"."'),
  );
  expect(reservationShortageImpact).toContain(inventoryReservationShortageImpactContract.source.triggerName);
  expect(reservationShortageImpact).toContain(
    inventoryReservationShortageImpactContract.decisionSet.functionName.replace('.', '"."'),
  );
  expect(reservationShortageImpact).toContain('DEFERRABLE INITIALLY DEFERRED');
  for (const triggerName of inventoryReservationShortageImpactContract.immutability.triggers) {
    expect(reservationShortageImpact).toContain(triggerName);
  }
  expect(reservationShortageImpact).toContain("position.lifecycle_state = 'CURRENT'");
  expect(reservationShortageImpact).toContain("effect.state = 'APPLIED'");
  expect(reservationShortageImpact).toContain("correction.state = 'APPLIED'");
  expect(reservationShortageImpact).toContain(
    "current_position.on_hand_evidence_ref\n                  = effect.evidence_json ->> 'backendEvidenceRef'",
  );
  expect(reservationShortageImpact).toContain('current_position.on_hand_observed_at = correction.business_observed_at');
  expect(reservationShortageImpact).toContain('current_position.on_hand_evidence_ref = correction.owner_evidence_ref');
  expect(reservationShortageImpact).toContain(
    "position.on_hand_evidence_ref = effect.evidence_json ->> 'backendEvidenceRef'",
  );
  expect(reservationShortageImpact).toContain("NEW.health_before = 'VALID'");
  expect(reservationShortageImpact).toContain("NEW.health_before IN ('AT_RISK', 'UNVERIFIABLE')");
  expect(reservationShortageImpact).toContain('pg_catalog.row_number() OVER');
  expect(reservationShortageImpact).toContain('effect.legal_entity_id = p_legal_entity_id');
  expect(reservationShortageImpact).toContain('WITH ORDINALITY AS replay(entry, ordinal)');
  expect(reservationShortageImpact).toContain('stored.priority_ordinal = replay.ordinal::integer');
  expect(reservationShortageImpact).toContain("'{affectedQuantity,unitRef,resourceId}'");
  expect(reservationShortageImpact).toContain(
    `"inventory"."${findReservationShortageImpactForWorkerRoutine.name}"(uuid, uuid, text, uuid)`,
  );
  expect(reservationShortageImpact).toContain(
    `"inventory"."${readReservationShortageImpactContextForWorkerRoutine.name}"(uuid, uuid, text, uuid, uuid, timestamptz)`,
  );
  expect(reservationShortageImpact).toContain(
    `"inventory"."${applyReservationShortageImpactForWorkerRoutine.name}"(uuid, uuid, text, uuid, uuid, timestamptz, jsonb)`,
  );
  expect(reservationShortageImpact.match(/SECURITY DEFINER/gu)).toHaveLength(3);
  expect(reservationShortageImpact.match(/SET search_path = pg_catalog, pg_temp/gu)).toHaveLength(3);
  expect(reservationShortageImpact).toContain('INSERT INTO "inventory"."reservation_confirmation_history"');
  expect(reservationShortageImpact).toContain('INSERT INTO "inventory"."reservation_shortage_impact_decisions"');
  expect(reservationShortageImpact).toContain('inventory_reservation_shortage_impacts_replay_ck');
  expect(reservationShortageImpact).toContain('"fenced_amount" numeric(38,9) NOT NULL');
  expect(reservationShortageImpact).toContain('NEW.fenced_amount IS DISTINCT FROM expected_fenced_amount');
  expect(reservationShortageImpact).toContain('pg_catalog.greatest(impact.available_amount - impact.fenced_amount, 0)');
  expect(reservationShortageImpact).toContain("p_evaluation ->> 'fencedAmount'");
  expect(reservationShortageImpact).toContain(
    "fenced.entry #>> '{confirmation,health,state}' IN ('EXPIRED', 'REVOKED')",
  );
  expect(reservationShortageImpact).toContain(
    "p_evaluation #>> '{affectedPositionRef,resourceType}'\n        IS DISTINCT FROM 'commerce.inventory.stock-position'",
  );
  expect(reservationShortageImpact.match(/REVOKE ALL ON FUNCTION/gu)).toHaveLength(6);
  expect(reservationShortageImpact.match(/GRANT EXECUTE ON FUNCTION/gu)).toHaveLength(3);
  expect(reservationReleaseEffect.match(/CREATE TABLE "inventory"\./gu)).toHaveLength(2);
  expect(reservationReleaseEffect.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(2);
  expect(reservationReleaseEffect.match(/ALTER TABLE .* FORCE ROW LEVEL SECURITY/gu)).toHaveLength(2);
  expect(reservationReleaseEffect).toContain('inventory_reservation_release_effects_reservation_fk');
  expect(reservationReleaseEffect).toContain('inventory_reservation_release_effects_backend_configuration_fk');
  expect(reservationReleaseEffect).toContain(inventoryReservationReleaseEffectTransitionContract.triggerName);
  for (const immutableColumn of inventoryReservationReleaseEffectTransitionContract.immutableColumns) {
    expect(reservationReleaseEffect).toContain(`NEW.${immutableColumn} IS DISTINCT FROM OLD.${immutableColumn}`);
  }
  expect(reservationReleaseEffect).toContain(
    inventoryReservationReleaseEffectHistoryImmutabilityContract.updateTriggerName,
  );
  expect(reservationReleaseEffect).toContain(
    inventoryReservationReleaseEffectHistoryImmutabilityContract.deleteTriggerName,
  );
  expect(reservationReleaseEffect).toContain('inventory_reservation_release_effects_scope_trg');
  expect(reservationReleaseEffect).toContain('inventory_reservation_release_effect_history_scope_trg');
  expect(reservationReleaseEffect).toContain("'{safeReleaseProof,order,_tag}' IS DISTINCT FROM 'NOT_COMMITTED_CLOSED'");
  expect(reservationReleaseEffect).toContain("'{safeReleaseProof,protection,_tag}' IS DISTINCT FROM 'ABSENT_PROVEN'");
  expect(reservationReleaseEffect).toContain("NEW.snapshot -> 'activeAllocations' IS DISTINCT FROM '[]'::jsonb");
  expect(reservationReleaseEffect).toContain("OLD.current_state IN ('RELEASED', 'NOT_RELEASABLE')");
  expect(reservationReleaseEffect).toContain(
    `"inventory"."${readReservationReleaseEffectForWorkerRoutine.name}"(uuid, uuid, text)`,
  );
  expect(reservationReleaseEffect).toContain(
    `"inventory"."${finalizeReservationReleaseEffectForWorkerRoutine.name}"(uuid, uuid, text, integer, jsonb)`,
  );
  expect(reservationReleaseEffect).toContain('inventory_reservation_release_effects_worker_cas_ck');
  expect(reservationReleaseEffect).toMatch(
    /state_tag = 'NOT_RELEASABLE'[\s\S]*?jsonb_object_keys\(NEW\.snapshot\)\) <> 7[\s\S]*?state_tag = 'INDETERMINATE'[\s\S]*?jsonb_object_keys\(NEW\.snapshot\)\) <> 6/u,
  );
  expect(reservationReleaseEffect).toContain(
    'current_effect.current_revision IS DISTINCT FROM p_expected_revision + 1',
  );
  expect(reservationReleaseEffect).toContain(
    "current_effect.current_state NOT IN ('INDETERMINATE', 'RELEASED', 'NOT_RELEASABLE')",
  );
  expect(reservationReleaseEffect).toContain(
    "MESSAGE = 'Reservation Release replay must match the exact completed compare-and-set'",
  );
  expect(reservationReleaseEffect).toContain(
    'CREATE OR REPLACE FUNCTION "inventory"."read_reservation_shortage_impact_context_for_worker"',
  );
  expect(reservationReleaseEffect).toContain('LEFT JOIN "inventory"."reservation_release_effects" AS release_effect');
  expect(reservationReleaseEffect).toContain("release_effect.current_state <> 'RELEASED'");
  expect(reservationReleaseEffect).toContain(
    'CREATE OR REPLACE FUNCTION "inventory"."enforce_reservation_shortage_impact_source"',
  );
  expect(reservationReleaseEffect).toContain("confirmation.current_health_state IN ('EXPIRED', 'REVOKED')");
  expect(reservationReleaseEffect).toContain("release_effect.current_state = 'RELEASED'");
  expect(reservationReleaseEffect).toContain('release_effect.reservation_id = allocation.obligation_id');
  expect(reservationReleaseEffect).toContain(
    "fenced.entry #>> '{confirmation,health,state}' IN ('EXPIRED', 'REVOKED')",
  );
  expect(reservationReleaseEffect).toContain("'fencedAmount', pg_catalog.trim_scale(fenced_amount)::text");
  expect(reservationReleaseEffect.match(/SECURITY DEFINER/gu)).toHaveLength(3);
  expect(reservationReleaseEffect.match(/SET search_path = pg_catalog, pg_temp/gu)).toHaveLength(3);
  expect(reservationReleaseEffect.match(/REVOKE ALL ON FUNCTION/gu)).toHaveLength(9);
  expect(reservationReleaseEffect.match(/GRANT EXECUTE ON FUNCTION/gu)).toHaveLength(3);
  expect(effectLedger.match(/CREATE TABLE "inventory"\./gu)).toHaveLength(2);
  expect(effectLedger.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(2);
  expect(effectLedger.match(/ALTER TABLE .* FORCE ROW LEVEL SECURITY/gu)).toHaveLength(2);
  expect(effectLedger).toContain('inventory_effect_ledger_pkey');
  expect(effectLedger).toContain('inventory_effect_ledger_authority_fk');
  expect(effectLedger).toContain(inventoryEffectLedgerExactScopeContract.triggerName);
  expect(effectLedger).toContain(inventoryEffectLedgerTransitionContract.triggerName);
  for (const immutableColumn of inventoryEffectLedgerTransitionContract.immutableColumns) {
    expect(effectLedger).toContain(`NEW.${immutableColumn} IS DISTINCT FROM OLD.${immutableColumn}`);
  }
  expect(effectLedger).toContain(inventoryEffectLedgerHistoryImmutabilityContract.updateTriggerName);
  expect(effectLedger).toContain(inventoryEffectLedgerHistoryImmutabilityContract.deleteTriggerName);
  expect(effectLedger).toContain('inventory_effect_ledger_history_scope_trg');
  expect(inventoryEffectLedgerExactScopeContract.currentIntentKinds).toEqual([
    'RESERVATION_CREATE',
    'RESERVATION_RELEASE',
    'ESTABLISH_COMMITMENT_PROTECTION',
    'PHYSICAL_RECEIPT',
    'PHYSICAL_ISSUE',
  ]);
  expect(inventoryEffectLedgerExactScopeContract.reservedKinds).toEqual([]);
  expect(effectLedgerContractFix).toContain(
    "CHECK (\"effect_kind\" in ('RESERVATION_CREATE', 'RESERVATION_RELEASE', 'ESTABLISH_COMMITMENT_PROTECTION', 'PHYSICAL_RECEIPT', 'PHYSICAL_ISSUE'))",
  );
  expect(effectLedgerContractFix).not.toContain('STOCK_CORRECTION');
  expect(effectLedgerContractFix).toContain(
    'CREATE OR REPLACE FUNCTION "inventory"."enforce_effect_ledger_exact_scope"',
  );
  expect(effectLedgerContractFix).toContain('CREATE OR REPLACE FUNCTION "inventory"."claim_inventory_effect_ledger"');
  expect(effectLedgerContractFix).toContain("NEW.effect_kind = 'ESTABLISH_COMMITMENT_PROTECTION'");
  expect(effectLedgerContractFix).toContain("WHEN 'ESTABLISH_COMMITMENT_PROTECTION' THEN");
  expect(effectLedgerContractFix).toContain(
    "pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(intent -> 'request')) <> 5",
  );
  expect(effectLedgerContractFix).toContain(
    "pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(intent -> 'request')) <> 3",
  );
  expect(effectLedgerContractFix).toContain(
    "pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(intent -> 'request')) <> 12",
  );
  for (const retryMetadata of ['mutationId', 'requestedAt', 'sourceActionInvocationId']) {
    expect(effectLedgerContractFix).toContain(`- '${retryMetadata}'`);
  }
  for (const retryMetadata of ['actionInvocationId', 'requestedAt']) {
    expect(effectLedgerContractFix).toContain(`- '${retryMetadata}'`);
  }
  expect(effectLedgerContractFix).toContain("resolution_business_request IS DISTINCT FROM intent -> 'request'");
  expect(effectLedgerContractFix).toContain(
    'REVOKE ALL ON FUNCTION "inventory"."enforce_effect_ledger_exact_scope"() FROM PUBLIC, "ontos_runtime"',
  );
  expect(effectLedgerContractFix).toContain(
    'REVOKE ALL ON FUNCTION "inventory"."claim_inventory_effect_ledger"(uuid, uuid, text, jsonb) FROM PUBLIC',
  );
  expect(effectLedger).toContain("NEW.snapshot -> 'intent' IS DISTINCT FROM intent");
  expect(effectLedger).toContain('intent IS DISTINCT FROM parsed_canonical');
  expect(effectLedger).toContain("NEW.resolution_json ->> '_tag' IS DISTINCT FROM NEW.effect_kind");
  expect(effectLedger).toContain("NEW.resolution_json #> '{effect,request}' IS DISTINCT FROM intent -> 'request'");
  expect(effectLedger).toContain("WHEN 'RECONCILIATION_REQUIRED' THEN 'INDETERMINATE'");
  expect(effectLedger).toContain("WHEN 'ESTABLISHED' THEN 'SUCCEEDED'");
  expect(effectLedger).toContain("WHEN 'RESOLVED_NO_RESERVATION' THEN 'REJECTED'");
  expect(effectLedger).toContain('predecessor.revision = p_expected_revision');
  expect(effectLedger).toContain('predecessor.state = p_expected_state');
  expect(effectLedger).toContain("'{request,commerceContext,sellingLegalEntityRef,resourceId}'");
  expect(effectLedger).toContain('ON CONFLICT ON CONSTRAINT inventory_effect_ledger_pkey DO NOTHING');
  expect(effectLedger).toContain('AND stored.legal_entity_id = p_legal_entity_id');
  expect(effectLedger).toContain('FOR UPDATE');
  expect(effectLedger).toContain('current_effect.current_revision IS DISTINCT FROM p_expected_revision + 1');
  expect(effectLedger).toContain(`"inventory"."${claimInventoryEffectLedgerRoutine.name}"(uuid, uuid, text, jsonb)`);
  expect(effectLedger).toContain(`"inventory"."${readInventoryEffectLedgerForWorkerRoutine.name}"(uuid, uuid, text)`);
  expect(effectLedger).toContain(
    `"inventory"."${transitionInventoryEffectLedgerForWorkerRoutine.name}"(uuid, uuid, text, integer, text, jsonb)`,
  );
  expect(effectLedger.match(/SECURITY DEFINER/gu)).toHaveLength(3);
  expect(effectLedger.match(/SET search_path = pg_catalog, pg_temp/gu)).toHaveLength(3);
  expect(effectLedger.match(/REVOKE ALL ON FUNCTION/gu)).toHaveLength(7);
  expect(effectLedger.match(/GRANT EXECUTE ON FUNCTION/gu)).toHaveLength(3);
  expect(commitmentProtection.match(/CREATE TABLE "inventory"\./gu)).toHaveLength(2);
  expect(commitmentProtection.match(/ENABLE ROW LEVEL SECURITY/gu)).toHaveLength(2);
  expect(commitmentProtection.match(/ALTER TABLE .* FORCE ROW LEVEL SECURITY/gu)).toHaveLength(2);
  expect(commitmentProtection).toContain('inventory_effect_ledger_commitment_protection_attempt_uk');
  expect(commitmentProtection).toContain('ON CONFLICT DO NOTHING');
  expect(commitmentProtection).not.toContain('ON CONFLICT ON CONSTRAINT inventory_effect_ledger_pkey DO NOTHING');
  expect(commitmentProtection).toContain("v_effect_kind = 'ESTABLISH_COMMITMENT_PROTECTION'");
  expect(commitmentProtection).toContain("stored.effect_kind = 'ESTABLISH_COMMITMENT_PROTECTION'");
  expect(commitmentProtection).toContain('stored.reservation_id = v_reservation_id');
  expect(commitmentProtection).toContain('stored.attempt_id = v_attempt_id');
  expect(commitmentProtection).toContain('ORDER BY (stored.effect_id = v_effect_id) DESC');
  expect(commitmentProtection).toContain(inventoryCommitmentProtectionScopeContract.triggerName);
  expect(commitmentProtection).toContain(inventoryCommitmentProtectionLifecycleContract.triggerName);
  for (const immutableColumn of inventoryCommitmentProtectionLifecycleContract.immutableColumns) {
    expect(commitmentProtection).toContain(`NEW.${immutableColumn} IS DISTINCT FROM OLD.${immutableColumn}`);
  }
  expect(commitmentProtection).toContain(inventoryCommitmentProtectionHistoryImmutabilityContract.updateTriggerName);
  expect(commitmentProtection).toContain(inventoryCommitmentProtectionHistoryImmutabilityContract.deleteTriggerName);
  for (const constraintName of Object.values(inventoryCommitmentProtectionScopeContract.constraintNames)) {
    expect(commitmentProtection).toContain(constraintName);
  }
  expect(commitmentProtection).toContain('NEW.established_at >= confirmation.expires_at');
  expect(commitmentProtection).not.toContain('now() >= confirmation.expires_at');
  expect(commitmentProtection).toContain("NEW.snapshot #> '{authorityEvidence,evidence,allocations}'");
  expect(commitmentProtection).toContain("NEW.effect_kind = 'ESTABLISH_COMMITMENT_PROTECTION'");
  expect(commitmentProtection).toContain("WHEN 'ESTABLISH_COMMITMENT_PROTECTION' THEN");
  expect(commitmentProtection).toContain("WHEN 'PROTECTED' THEN 'SUCCEEDED'");
  expect(commitmentProtection).toContain("WHEN 'NOT_PROTECTABLE' THEN 'REJECTED'");
  expect(commitmentProtection).toContain("'{effect,protection,authorityEvidence,effectId}'");
  expect(commitmentProtection).toContain("'{effect,protection,confirmation}'");
  expect(commitmentProtection).toContain('inventory_commitment_protection_history_scope_trg');
  expect(commitmentProtection.match(/REVOKE ALL ON FUNCTION/gu)).toHaveLength(6);
  expect(commitmentProtection.match(/GRANT EXECUTE ON FUNCTION/gu)).toHaveLength(1);
});

it('registers the exact owner schema, journal, verifier, and runtime grants', () => {
  const rootVerifier = readFileSync(
    fileURLToPath(new URL('../../../../scripts/verify-application-db-schema.mts', import.meta.url)),
    'utf-8',
  );
  const runtimeBootstrap = readFileSync(
    fileURLToPath(new URL('../../../../scripts/postgres/bootstrap-runtime-role.mts', import.meta.url)),
    'utf-8',
  );
  expect(rootVerifier).toMatch(/'inventory'/u);
  expect(rootVerifier).toMatch(/'__drizzle_migrations_inventory'/u);
  expect(rootVerifier).toMatch(/verticals\/inventory\/scripts\/verify-db-schema\.mts/u);
  expect(runtimeBootstrap).toMatch(/'catalog', 'inventory'/u);
});

it('exact Inventory catalog comparison rejects missing and unexpected tables', () => {
  const exact = INVENTORY_TABLE_INVENTORY.map((table) => `inventory.${table}`);
  expect(compareInventoryCatalog(exact)).toEqual({ missing: [], unexpected: [] });
  expect(compareInventoryCatalog(exact.slice(1))).toEqual({
    missing: ['inventory.backend_configurations'],
    unexpected: [],
  });
  expect(compareInventoryCatalog([...exact, 'inventory.unowned'])).toEqual({
    missing: [],
    unexpected: ['inventory.unowned'],
  });
});
