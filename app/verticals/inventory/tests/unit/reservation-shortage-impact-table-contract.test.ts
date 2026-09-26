import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'effect-rstest';

import {
  INVENTORY_RESERVATION_SHORTAGE_IMPACT_TABLES,
  inventoryReservationShortageImpactContract,
  inventoryReservationShortageImpactDecisions,
  inventoryReservationShortageImpacts,
} from '../../src/persistence/reservation-shortage-impact-table.ts';

describe('Reservation shortage impact persistence contract', () => {
  it('owns one immutable tenant-RLS impact ledger and its exact per-Confirmation decisions', () => {
    const impacts = getTableConfig(inventoryReservationShortageImpacts);
    const decisions = getTableConfig(inventoryReservationShortageImpactDecisions);

    expect(INVENTORY_RESERVATION_SHORTAGE_IMPACT_TABLES).toEqual([
      inventoryReservationShortageImpactDecisions,
      inventoryReservationShortageImpacts,
    ]);
    expect(`${impacts.schema}.${impacts.name}`).toBe('inventory.reservation_shortage_impacts');
    expect(`${decisions.schema}.${decisions.name}`).toBe('inventory.reservation_shortage_impact_decisions');
    expect(impacts.enableRLS).toBe(true);
    expect(decisions.enableRLS).toBe(true);
    expect(impacts.primaryKeys.map((primaryKey) => primaryKey.getName())).toEqual([
      'inventory_reservation_shortage_impacts_pk',
    ]);
    expect(decisions.primaryKeys.map((primaryKey) => primaryKey.getName())).toEqual([
      'inventory_reservation_shortage_impact_decisions_pk',
    ]);
    expect(impacts.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'inventory_reservation_shortage_impacts_position_fk',
        'inventory_reservation_shortage_impacts_effect_fk',
        'inventory_reservation_shortage_impacts_correction_fk',
      ]),
    );
    expect(decisions.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'inventory_reservation_shortage_impact_decisions_impact_fk',
        'inventory_reservation_shortage_impact_decisions_confirmation_fk',
      ]),
    );
    expect(impacts.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['available_amount', 'fenced_amount']),
    );
    expect(impacts.columns.map(({ name }) => name)).not.toContain('reserved');
  });

  it('publishes exact source, deferred decision-set, append-only, and worker routine hardening', () => {
    expect(inventoryReservationShortageImpactContract.source).toEqual({
      functionName: 'inventory.enforce_reservation_shortage_impact_source',
      triggerName: 'inventory_reservation_shortage_impacts_source_trg',
    });
    expect(inventoryReservationShortageImpactContract.decisionSet).toMatchObject({
      functionName: 'inventory.verify_reservation_shortage_impact_decisions',
      timing: 'AFTER INSERT DEFERRABLE INITIALLY DEFERRED',
    });
    expect(inventoryReservationShortageImpactContract.immutability.tables).toEqual([
      'inventory.reservation_shortage_impacts',
      'inventory.reservation_shortage_impact_decisions',
    ]);
    expect(inventoryReservationShortageImpactContract.routines).toEqual({
      apply: 'inventory.apply_reservation_shortage_impact_for_worker',
      find: 'inventory.find_reservation_shortage_impact_for_worker',
      readContext: 'inventory.read_reservation_shortage_impact_context_for_worker',
    });
  });
});
