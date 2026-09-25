import { defineRelations } from 'drizzle-orm';
import type { EmptyRelations, ExtractTablesFromSchema, ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

import { inventoryBackendConfigurations } from '../persistence/inventory-backend-configuration-table.ts';
import {
  inventoryCatalogToStockBindingHistory,
  inventoryCatalogToStockBindings,
} from '../persistence/catalog-to-stock-binding-table.ts';
import {
  inventoryCommitmentProtectionHistory,
  inventoryCommitmentProtections,
} from '../persistence/commitment-protection-table.ts';
import { inventoryExternalStockCorrelations } from '../persistence/external-stock-correlation-table.ts';
import { inventoryEffectLedger, inventoryEffectLedgerHistory } from '../persistence/inventory-effect-ledger-table.ts';
import {
  inventoryObligationAllocations,
  inventoryObligationRequirements,
  inventoryObligations,
} from '../persistence/inventory-obligation-table.ts';
import { inventoryPhysicalStockEffects } from '../persistence/physical-stock-effect-table.ts';
import {
  inventoryReservationConfirmationHistory,
  inventoryReservationConfirmations,
} from '../persistence/reservation-confirmation-table.ts';
import { inventoryReservationCreateEffects } from '../persistence/reservation-create-effect-table.ts';
import {
  inventoryReservationReleaseEffectHistory,
  inventoryReservationReleaseEffects,
} from '../persistence/reservation-release-effect-table.ts';
import {
  inventoryReservationShortageImpactDecisions,
  inventoryReservationShortageImpacts,
} from '../persistence/reservation-shortage-impact-table.ts';
import {
  inventorySourceAssertionCoverage,
  inventorySourceAssertions,
} from '../persistence/inventory-source-assertion-table.ts';
import { inventorySourceConflictRevisions } from '../persistence/inventory-source-conflict-table.ts';
import { inventorySourceImportLedger } from '../persistence/inventory-source-import-ledger-table.ts';
import {
  inventoryStockCorrectionOpenReconciliations,
  inventoryStockCorrections,
} from '../persistence/stock-correction-table.ts';
import {
  inventoryStockCorrectionSourceEvidence,
  inventoryStockCorrectionSourceEvidenceCoverage,
  inventoryStockCorrectionSourceEvidenceCurrent,
} from '../persistence/stock-correction-source-evidence-table.ts';
import { inventoryStockItems } from '../persistence/stock-item-table.ts';
import { inventoryStockLocationRevisions, inventoryStockLocations } from '../persistence/stock-location-table.ts';
import { inventoryStockPositions } from '../persistence/stock-position-table.ts';
import {
  inventoryStockSharingEligibilities,
  inventoryStockSharingEligibilityHistory,
} from '../persistence/stock-sharing-eligibility-table.ts';

export { INVENTORY_SCHEMA_NAME, inventorySchema } from './inventory-schema.ts';
export { inventoryBackendConfigurations } from '../persistence/inventory-backend-configuration-table.ts';
export {
  inventoryCatalogToStockBindingHistory,
  inventoryCatalogToStockBindings,
} from '../persistence/catalog-to-stock-binding-table.ts';
export {
  inventoryCommitmentProtectionHistory,
  inventoryCommitmentProtections,
} from '../persistence/commitment-protection-table.ts';
export { inventoryExternalStockCorrelations } from '../persistence/external-stock-correlation-table.ts';
export { inventoryEffectLedger, inventoryEffectLedgerHistory } from '../persistence/inventory-effect-ledger-table.ts';
export {
  inventoryObligationAllocations,
  inventoryObligationRequirements,
  inventoryObligations,
} from '../persistence/inventory-obligation-table.ts';
export { inventoryPhysicalStockEffects } from '../persistence/physical-stock-effect-table.ts';
export {
  inventoryReservationConfirmationHistory,
  inventoryReservationConfirmations,
} from '../persistence/reservation-confirmation-table.ts';
export { inventoryReservationCreateEffects } from '../persistence/reservation-create-effect-table.ts';
export {
  inventoryReservationReleaseEffectHistory,
  inventoryReservationReleaseEffects,
} from '../persistence/reservation-release-effect-table.ts';
export {
  inventoryReservationShortageImpactDecisions,
  inventoryReservationShortageImpacts,
} from '../persistence/reservation-shortage-impact-table.ts';
export {
  inventorySourceAssertionCoverage,
  inventorySourceAssertions,
} from '../persistence/inventory-source-assertion-table.ts';
export { inventorySourceConflictRevisions } from '../persistence/inventory-source-conflict-table.ts';
export { inventorySourceImportLedger } from '../persistence/inventory-source-import-ledger-table.ts';
export {
  inventoryStockCorrectionOpenReconciliations,
  inventoryStockCorrections,
} from '../persistence/stock-correction-table.ts';
export {
  inventoryStockCorrectionSourceEvidence,
  inventoryStockCorrectionSourceEvidenceCoverage,
  inventoryStockCorrectionSourceEvidenceCurrent,
} from '../persistence/stock-correction-source-evidence-table.ts';
export { inventoryStockItems } from '../persistence/stock-item-table.ts';
export { inventoryStockLocationRevisions, inventoryStockLocations } from '../persistence/stock-location-table.ts';
export { inventoryStockPositions } from '../persistence/stock-position-table.ts';
export {
  inventoryStockSharingEligibilities,
  inventoryStockSharingEligibilityHistory,
} from '../persistence/stock-sharing-eligibility-table.ts';

export const INVENTORY_TABLE_INVENTORY = [
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
] as const;

export const INVENTORY_TABLES: readonly PgTable[] = [
  inventoryBackendConfigurations,
  inventoryCatalogToStockBindingHistory,
  inventoryCatalogToStockBindings,
  inventoryCommitmentProtectionHistory,
  inventoryCommitmentProtections,
  inventoryEffectLedger,
  inventoryEffectLedgerHistory,
  inventoryExternalStockCorrelations,
  inventoryObligationAllocations,
  inventoryObligationRequirements,
  inventoryObligations,
  inventoryPhysicalStockEffects,
  inventoryReservationConfirmationHistory,
  inventoryReservationConfirmations,
  inventoryReservationCreateEffects,
  inventoryReservationReleaseEffectHistory,
  inventoryReservationReleaseEffects,
  inventoryReservationShortageImpactDecisions,
  inventoryReservationShortageImpacts,
  inventorySourceAssertionCoverage,
  inventorySourceAssertions,
  inventorySourceConflictRevisions,
  inventorySourceImportLedger,
  inventoryStockCorrectionOpenReconciliations,
  inventoryStockCorrections,
  inventoryStockCorrectionSourceEvidence,
  inventoryStockCorrectionSourceEvidenceCoverage,
  inventoryStockCorrectionSourceEvidenceCurrent,
  inventoryStockItems,
  inventoryStockLocationRevisions,
  inventoryStockLocations,
  inventoryStockPositions,
  inventoryStockSharingEligibilities,
  inventoryStockSharingEligibilityHistory,
] as const;

const inventoryDatabaseSchemaIdentity = {
  inventoryBackendConfigurations,
  inventoryCatalogToStockBindingHistory,
  inventoryCatalogToStockBindings,
  inventoryCommitmentProtectionHistory,
  inventoryCommitmentProtections,
  inventoryEffectLedger,
  inventoryEffectLedgerHistory,
  inventoryExternalStockCorrelations,
  inventoryObligationAllocations,
  inventoryObligationRequirements,
} as const;

const inventoryDatabaseSchemaReservations = {
  inventoryObligations,
  inventoryPhysicalStockEffects,
  inventoryReservationConfirmationHistory,
  inventoryReservationConfirmations,
  inventoryReservationCreateEffects,
  inventoryReservationReleaseEffectHistory,
  inventoryReservationReleaseEffects,
  inventoryReservationShortageImpactDecisions,
  inventoryReservationShortageImpacts,
} as const;

const inventoryDatabaseSchemaEvidence = {
  inventorySourceAssertionCoverage,
  inventorySourceAssertions,
  inventorySourceConflictRevisions,
  inventorySourceImportLedger,
  inventoryStockCorrectionOpenReconciliations,
  inventoryStockCorrections,
  inventoryStockCorrectionSourceEvidence,
  inventoryStockCorrectionSourceEvidenceCoverage,
} as const;

const inventoryDatabaseSchemaStock = {
  inventoryStockCorrectionSourceEvidenceCurrent,
  inventoryStockItems,
  inventoryStockLocationRevisions,
  inventoryStockLocations,
  inventoryStockPositions,
  inventoryStockSharingEligibilities,
  inventoryStockSharingEligibilityHistory,
} as const;

const inventoryDatabaseSchema: typeof inventoryDatabaseSchemaIdentity &
  typeof inventoryDatabaseSchemaReservations &
  typeof inventoryDatabaseSchemaEvidence &
  typeof inventoryDatabaseSchemaStock = {
  ...inventoryDatabaseSchemaIdentity,
  ...inventoryDatabaseSchemaReservations,
  ...inventoryDatabaseSchemaEvidence,
  ...inventoryDatabaseSchemaStock,
};

type InventoryRelations = ExtractTablesWithRelations<
  EmptyRelations,
  ExtractTablesFromSchema<typeof inventoryDatabaseSchema>
>;

/** Relational Queries v2 entry point for the Inventory owner. */
export const inventoryRelations: InventoryRelations = defineRelations(inventoryDatabaseSchema);
