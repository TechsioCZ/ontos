import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'effect-rstest';

import {
  INVENTORY_RESERVATION_SHORTAGE_IMPACT_TABLES,
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
});
