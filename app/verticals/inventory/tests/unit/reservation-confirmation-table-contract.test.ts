import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'effect-rstest';

import {
  ReservationConfirmationRejected,
  reservationConfirmationCanEstablishProtection,
} from '../../shared/domain/reservation-confirmation.ts';
import { mapReservationConfirmationWriteError } from '../../src/persistence/reservation-confirmation-repository.ts';
import {
  INVENTORY_RESERVATION_CONFIRMATION_TABLES,
  inventoryReservationConfirmationHistory,
  inventoryReservationConfirmationHistoryImmutabilityContract,
  inventoryReservationConfirmationLifecycleContract,
  inventoryReservationConfirmationScopeContract,
  inventoryReservationConfirmations,
} from '../../src/persistence/reservation-confirmation-table.ts';

describe('Reservation Confirmation persistence contract', () => {
  it('persists one Confirmation identity for each exact Reservation and Attempt under its selected authority', () => {
    const current = getTableConfig(inventoryReservationConfirmations);

    expect(current.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'inventory_reservation_confirmations_reservation_fk',
        'inventory_reservation_confirmations_backend_configuration_fk',
      ]),
    );
    expect(current.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        'inventory_reservation_confirmations_scope_id_uk',
        'inventory_reservation_confirmations_reservation_attempt_uk',
        'inventory_reservation_confirmations_authority_effect_uk',
        'inventory_reservation_confirmations_health_rank_idx',
      ]),
    );
    expect(current.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(INVENTORY_RESERVATION_CONFIRMATION_TABLES).toEqual([
      inventoryReservationConfirmationHistory,
      inventoryReservationConfirmations,
    ]);
    expect(inventoryReservationConfirmationScopeContract.event).toBe('INSERT OR UPDATE');
  });

  it('freezes proof identity, issuance, expiry, authority, and rank while allowing only monotonic health revisions', () => {
    expect(inventoryReservationConfirmationLifecycleContract.immutableColumns).toEqual(
      expect.arrayContaining([
        'confirmation_id',
        'reservation_id',
        'attempt_id',
        'owner_configuration_id',
        'issuer_backend_kind',
        'issuer_backend_id',
        'authority_effect_id',
        'owner_evidence_ref',
        'issued_at',
        'expires_at',
      ]),
    );
    expect(inventoryReservationConfirmationLifecycleContract.terminalStates).toEqual(['REVOKED', 'EXPIRED']);
    expect(inventoryReservationConfirmationLifecycleContract.allowedRecoveryStates).toEqual([
      'AT_RISK',
      'UNVERIFIABLE',
    ]);
    expect(inventoryReservationConfirmationLifecycleContract.monotonicRevision).toBe(true);
  });

  it('makes every history revision append-only under tenant RLS', () => {
    const history = getTableConfig(inventoryReservationConfirmationHistory);

    expect(history.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        'inventory_reservation_confirmation_history_scope_id_uk',
        'inventory_reservation_confirmation_history_revision_uk',
      ]),
    );
    expect(history.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(inventoryReservationConfirmationHistoryImmutabilityContract).toMatchObject({
      deleteTriggerName: 'inventory_reservation_confirmation_history_no_delete_trg',
      updateTriggerName: 'inventory_reservation_confirmation_history_no_update_trg',
    });
  });

  it('maps database uniqueness failures to exact identity and sibling conflicts', () => {
    const identity = mapReservationConfirmationWriteError({
      code: '23505',
      constraint: 'inventory_reservation_confirmations_authority_effect_uk',
    });
    const sibling = mapReservationConfirmationWriteError({
      code: '23505',
      constraint: 'inventory_reservation_confirmations_reservation_attempt_uk',
    });

    expect(identity).toBeInstanceOf(ReservationConfirmationRejected);
    expect(identity).toMatchObject({ reason: 'CONFIRMATION_IDENTITY_CONFLICT' });
    expect(sibling).toMatchObject({ reason: 'SIBLING_CONFIRMATION_FORBIDDEN' });
    expect(reservationConfirmationCanEstablishProtection).toBeTypeOf('function');
  });
});
