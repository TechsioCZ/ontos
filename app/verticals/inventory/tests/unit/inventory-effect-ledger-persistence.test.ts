import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'effect-rstest';

import {
  claimInventoryEffectLedgerRoutine,
  readInventoryEffectLedgerForWorkerRoutine,
  transitionInventoryEffectLedgerForWorkerRoutine,
} from '../../src/persistence/inventory-effect-ledger-repository.ts';
import {
  INVENTORY_EFFECT_LEDGER_TABLES,
  inventoryEffectLedger,
  inventoryEffectLedgerHistory,
  inventoryEffectLedgerHistoryImmutabilityContract,
  inventoryEffectLedgerTransitionContract,
} from '../../src/persistence/inventory-effect-ledger-table.ts';

describe('Inventory effect ledger persistence contract', () => {
  it('owns one tenant-scoped identity across every Inventory effect kind', () => {
    const current = getTableConfig(inventoryEffectLedger);

    expect(current.primaryKeys.map(({ name }) => name)).toEqual(['inventory_effect_ledger_pkey']);
    expect(current.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining(['inventory_effect_ledger_state_idx', 'inventory_effect_ledger_reservation_idx']),
    );
    expect(current.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
      'inventory_effect_ledger_authority_fk',
    );
    expect(current.policies.map(({ for: operation }) => operation)).toEqual(['select', 'insert', 'update', 'delete']);
  });

  it('freezes exact intent and permits only CAS recovery before terminal resolution', () => {
    expect(inventoryEffectLedgerTransitionContract.immutableColumns).toEqual(
      expect.arrayContaining([
        'tenant_id',
        'effect_id',
        'effect_kind',
        'reservation_id',
        'attempt_id',
        'authority_configuration_id',
        'intent_json',
        'intent_canonical',
        'requested_at',
      ]),
    );
    expect(inventoryEffectLedgerTransitionContract.allowedTransitions).toEqual({
      INDETERMINATE: ['INDETERMINATE', 'SUCCEEDED', 'REJECTED'],
      REJECTED: [],
      REQUESTED: ['INDETERMINATE', 'SUCCEEDED', 'REJECTED'],
      SUCCEEDED: [],
    });
    expect(inventoryEffectLedgerTransitionContract.monotonicRevision).toBe(true);
  });

  it('retains every revision in immutable tenant-scoped history', () => {
    const history = getTableConfig(inventoryEffectLedgerHistory);

    expect(history.indexes.map(({ config }) => config.name)).toContain('inventory_effect_ledger_history_revision_uk');
    expect(history.policies.map(({ for: operation }) => operation)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(inventoryEffectLedgerHistoryImmutabilityContract).toMatchObject({
      deleteTriggerName: 'inventory_effect_ledger_history_no_delete_trg',
      updateTriggerName: 'inventory_effect_ledger_history_no_update_trg',
    });
    expect(INVENTORY_EFFECT_LEDGER_TABLES).toEqual([inventoryEffectLedgerHistory, inventoryEffectLedger]);
  });

  it('claims atomically and limits workers to read and CAS transition of an existing identity', () => {
    expect(claimInventoryEffectLedgerRoutine).toMatchObject({ routineKey: 'inventory.claim-inventory-effect-ledger' });
    expect(claimInventoryEffectLedgerRoutine.parameters.map(({ type }) => type)).toEqual([
      'uuid',
      'uuid',
      'text',
      'jsonb',
    ]);
    expect(readInventoryEffectLedgerForWorkerRoutine.parameters.map(({ type }) => type)).toEqual([
      'uuid',
      'uuid',
      'text',
    ]);
    expect(transitionInventoryEffectLedgerForWorkerRoutine.parameters.map(({ type }) => type)).toEqual([
      'uuid',
      'uuid',
      'text',
      'integer',
      'text',
      'jsonb',
    ]);
  });
});
