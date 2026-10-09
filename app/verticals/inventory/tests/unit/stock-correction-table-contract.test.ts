import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'effect-rstest';

import { InventorySourceAssertionIdSchema } from '../../shared/domain/inventory-source-assertion.ts';
import { StockCorrectionSourceEvidenceIdSchema } from '../../shared/domain/stock-correction.ts';
import { stockCorrectionEvidenceIdentityValues } from '../../src/persistence/stock-correction-repository.ts';
import {
  inventoryStockCorrectionExactScopeVerifierContract,
  inventoryStockCorrectionImmutabilityContract,
  inventoryStockCorrectionOpenReconciliations,
  inventoryStockCorrectionOpenTransitionContract,
  inventoryStockCorrections,
} from '../../src/persistence/stock-correction-table.ts';

describe('Stock Correction persistence contract', () => {
  it('binds immutable correction provenance to exact Position, Source Assertion, and selected authority', () => {
    const corrections = getTableConfig(inventoryStockCorrections);

    expect(corrections.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'inventory_stock_corrections_position_fk',
        'inventory_stock_corrections_assertion_fk',
        'inventory_stock_corrections_source_evidence_fk',
        'inventory_stock_corrections_authority_fk',
        'inventory_stock_corrections_reconciles_fk',
      ]),
    );
    expect(corrections.uniqueConstraints).toHaveLength(0);
    expect(corrections.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        'inventory_stock_corrections_tenant_id_uk',
        'inventory_stock_corrections_assertion_uk',
        'inventory_stock_corrections_source_evidence_uk',
        'inventory_stock_corrections_reconciles_uk',
      ]),
    );
    expect(corrections.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(inventoryStockCorrectionImmutabilityContract.event).toBe('UPDATE OR DELETE');
    expect(inventoryStockCorrectionExactScopeVerifierContract.event).toBe('INSERT');
  });

  it('serializes one open indeterminate correction per Position without Reservation or Availability state', () => {
    const open = getTableConfig(inventoryStockCorrectionOpenReconciliations);
    const correctionColumnNames = Object.values(inventoryStockCorrections).map((column) => column.name);

    expect(open.primaryKeys).toHaveLength(1);
    expect(open.primaryKeys[0]?.columns.map((column) => column.name)).toEqual(['tenant_id', 'position_id']);
    expect(open.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(inventoryStockCorrectionOpenTransitionContract.event).toBe('INSERT OR UPDATE OR DELETE');
    expect(correctionColumnNames).not.toContain('reserved');
    expect(correctionColumnNames).not.toContain('availability');
    expect(correctionColumnNames).not.toContain('committed_obligation');
  });

  it('writes exactly one relational owner-evidence identity for each correction branch', () => {
    const assertionId = InventorySourceAssertionIdSchema.make('11111111-1111-4111-8111-111111111111');
    const evidenceId = StockCorrectionSourceEvidenceIdSchema.make('22222222-2222-4222-8222-222222222222');

    expect(
      stockCorrectionEvidenceIdentityValues({
        evidenceKind: 'EXTERNAL_SOURCE_ASSERTION',
        sourceAssertionId: assertionId,
        sourceEvidenceId: null,
      }),
    ).toEqual({
      evidenceKind: 'EXTERNAL_SOURCE_ASSERTION',
      sourceAssertionId: assertionId,
      sourceEvidenceId: null,
    });
    expect(
      stockCorrectionEvidenceIdentityValues({
        evidenceKind: 'ONTOS_WMS_OWNER_EVIDENCE',
        sourceAssertionId: null,
        sourceEvidenceId: evidenceId,
      }),
    ).toEqual({
      evidenceKind: 'ONTOS_WMS_OWNER_EVIDENCE',
      sourceAssertionId: null,
      sourceEvidenceId: evidenceId,
    });
  });
});
