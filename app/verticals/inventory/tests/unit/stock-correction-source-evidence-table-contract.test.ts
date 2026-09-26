import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'effect-rstest';

import {
  inventoryStockCorrectionSourceEvidence,
  inventoryStockCorrectionSourceEvidenceCoverage,
  inventoryStockCorrectionSourceEvidenceCoverageCompletenessContract,
  inventoryStockCorrectionSourceEvidenceCurrent,
  inventoryStockCorrectionSourceEvidenceCurrentOrderContract,
  inventoryStockCorrectionSourceEvidenceImmutabilityContract,
  inventoryStockCorrectionSourceEvidenceScopeVerifierContract,
} from '../../src/persistence/stock-correction-source-evidence-table.ts';

describe('Stock Correction source evidence table contract', () => {
  it('binds append-only OntOS WMS evidence to exact selected owner and Stock Position scope', () => {
    const evidence = getTableConfig(inventoryStockCorrectionSourceEvidence);
    const coverage = getTableConfig(inventoryStockCorrectionSourceEvidenceCoverage);
    const current = getTableConfig(inventoryStockCorrectionSourceEvidenceCurrent);

    expect(evidence.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'inventory_stock_correction_source_evidence_authority_fk',
        'inventory_stock_correction_source_evidence_position_fk',
        'inventory_stock_correction_source_evidence_item_fk',
        'inventory_stock_correction_source_evidence_location_fk',
      ]),
    );
    expect(coverage.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'inventory_stock_correction_source_evidence_coverage_evidence_fk',
        'inventory_stock_correction_source_evidence_coverage_effect_fk',
      ]),
    );
    expect(evidence.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(coverage.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(current.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
      'inventory_stock_correction_source_evidence_current_evidence_fk',
    );
    expect(current.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(inventoryStockCorrectionSourceEvidenceScopeVerifierContract).toMatchObject({
      businessTime: 'AT_OR_AFTER_AUTHORITY_SELECTION',
      event: 'INSERT',
      selectedAuthority: 'ONTOS_WMS_WITH_STOCK_CORRECTION_SUPPORTED',
      timing: 'BEFORE',
    });
    expect(inventoryStockCorrectionSourceEvidenceImmutabilityContract.tables).toEqual([
      'inventory.stock_correction_source_evidence',
      'inventory.stock_correction_source_evidence_coverage',
    ]);
  });

  it('persists evidence-bound coverage and an immutable owner-sortable current-order proof', () => {
    const evidence = getTableConfig(inventoryStockCorrectionSourceEvidence);
    const evidenceColumns = Object.values(inventoryStockCorrectionSourceEvidence).map((column) => column.name);

    expect(evidence.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        'inventory_stock_correction_source_evidence_tenant_id_uk',
        'inventory_stock_correction_source_evidence_stream_order_uk',
        'inventory_stock_correction_source_evidence_source_reference_uk',
      ]),
    );
    expect(inventoryStockCorrectionSourceEvidenceCoverageCompletenessContract).toMatchObject({
      mode: 'DEFERRABLE INITIALLY DEFERRED',
      relation: 'BIJECTION',
    });
    expect(inventoryStockCorrectionSourceEvidenceCurrentOrderContract).toMatchObject({
      event: 'INSERT OR UPDATE OR DELETE',
      ordering: 'LEXICOGRAPHIC',
      orderingEvidenceKind: 'OWNER_ORDER_KEY',
    });
    expect(evidenceColumns).not.toContain('is_current');
    expect(evidenceColumns).not.toContain('current');
  });
});
