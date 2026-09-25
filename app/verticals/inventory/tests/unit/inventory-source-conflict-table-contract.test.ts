import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'effect-rstest';

import {
  inventorySourceConflictRevisionContract,
  inventorySourceConflictRevisions,
  inventorySourceConflictScopeVerifierContract,
} from '../../src/persistence/inventory-source-conflict-table.ts';

describe('Inventory Source Conflict persistence contract', () => {
  it('stores stable identity as append-only lifecycle revisions under Tenant RLS', () => {
    const table = getTableConfig(inventorySourceConflictRevisions);

    expect(table.primaryKeys).toHaveLength(1);
    expect(table.primaryKeys[0]?.columns.map(({ name }) => name)).toEqual(['tenant_id', 'conflict_id', 'revision']);
    expect(table.policies.map(({ for: operation }) => operation)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(inventorySourceConflictRevisionContract.immutableTriggerName).toBe(
      'inventory_source_conflict_revisions_immutable_trg',
    );
    expect(inventorySourceConflictRevisionContract.sequenceTriggerName).toBe(
      'inventory_source_conflict_revisions_sequence_trg',
    );
  });

  it('binds only exact Position fact conflicts while configuration conflict scope stays Customer Configuration-wide', () => {
    const table = getTableConfig(inventorySourceConflictRevisions);

    expect(table.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
      'inventory_source_conflict_revisions_position_fk',
    );
    expect(inventorySourceConflictScopeVerifierContract.event).toBe('INSERT');
    expect(inventorySourceConflictScopeVerifierContract.triggerName).toBe(
      'inventory_source_conflict_revisions_exact_scope_trg',
    );
    expect(Object.values(inventorySourceConflictRevisions).map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(['reservation_id', 'availability', 'fallback_backend_id', 'provider_priority']),
    );
  });
});
