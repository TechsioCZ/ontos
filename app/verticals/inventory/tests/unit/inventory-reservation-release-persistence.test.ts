import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'effect-rstest';

import {
  InventoryReservationReleaseRejected,
  ReservationReleaseEffectIdSchema,
} from '../../shared/domain/inventory-reservation-release.ts';
import {
  finalizeReservationReleaseEffectForWorkerRoutine,
  mapReservationReleaseEffectWriteError,
  readReservationReleaseEffectForWorkerRoutine,
} from '../../src/persistence/reservation-release-effect-repository.ts';
import {
  INVENTORY_RESERVATION_RELEASE_TABLES,
  inventoryReservationReleaseEffectHistory,
  inventoryReservationReleaseEffectHistoryImmutabilityContract,
  inventoryReservationReleaseEffectScopeContract,
  inventoryReservationReleaseEffects,
  inventoryReservationReleaseEffectTransitionContract,
} from '../../src/persistence/reservation-release-effect-table.ts';

describe('Inventory Reservation Release persistence contract', () => {
  it('persists exactly one effect identity for one Reservation under its original authority', () => {
    const current = getTableConfig(inventoryReservationReleaseEffects);

    expect(current.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'inventory_reservation_release_effects_reservation_fk',
        'inventory_reservation_release_effects_backend_configuration_fk',
      ]),
    );
    expect(current.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        'inventory_reservation_release_effects_scope_effect_uk',
        'inventory_reservation_release_effects_reservation_uk',
        'inventory_reservation_release_effects_mutation_uk',
        'inventory_reservation_release_effects_state_idx',
      ]),
    );
    expect(current.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(INVENTORY_RESERVATION_RELEASE_TABLES).toEqual([
      inventoryReservationReleaseEffectHistory,
      inventoryReservationReleaseEffects,
    ]);
    expect(inventoryReservationReleaseEffectScopeContract).toMatchObject({
      functionName: 'inventory.enforce_reservation_release_effect_scope',
      triggerName: 'inventory_reservation_release_effects_scope_trg',
    });
  });

  it('allows only monotonic recovery through the original effect and makes terminal outcomes immutable', () => {
    expect(inventoryReservationReleaseEffectTransitionContract.allowedTransitions).toEqual({
      INDETERMINATE: ['INDETERMINATE', 'RELEASED', 'NOT_RELEASABLE'],
      NOT_RELEASABLE: [],
      RELEASED: [],
      REQUESTED: ['INDETERMINATE', 'RELEASED', 'NOT_RELEASABLE'],
    });
    expect(inventoryReservationReleaseEffectTransitionContract.immutableColumns).toEqual(
      expect.arrayContaining([
        'release_effect_id',
        'mutation_id',
        'source_action_invocation_id',
        'reservation_id',
        'attempt_id',
        'owner_configuration_id',
        'issuer_backend_kind',
        'issuer_backend_id',
      ]),
    );
    expect(inventoryReservationReleaseEffectTransitionContract.monotonicRevision).toBe(true);
  });

  it('keeps every effect revision in immutable tenant-scoped history', () => {
    const history = getTableConfig(inventoryReservationReleaseEffectHistory);

    expect(history.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        'inventory_reservation_release_effect_history_scope_id_uk',
        'inventory_reservation_release_effect_history_revision_uk',
      ]),
    );
    expect(history.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(inventoryReservationReleaseEffectHistoryImmutabilityContract).toMatchObject({
      deleteTriggerName: 'inventory_reservation_release_effect_history_no_delete_trg',
      functionName: 'inventory.reject_reservation_release_effect_history_mutation',
      updateTriggerName: 'inventory_reservation_release_effect_history_no_update_trg',
    });
  });

  it('freezes worker routines to scoped read and compare-and-set finalization', () => {
    expect(readReservationReleaseEffectForWorkerRoutine).toMatchObject({
      routineKey: 'inventory.read-reservation-release-effect-for-worker',
    });
    expect(readReservationReleaseEffectForWorkerRoutine.parameters.map(({ type }) => type)).toEqual([
      'uuid',
      'uuid',
      'text',
    ]);
    expect(finalizeReservationReleaseEffectForWorkerRoutine).toMatchObject({
      routineKey: 'inventory.finalize-reservation-release-effect-for-worker',
    });
    expect(finalizeReservationReleaseEffectForWorkerRoutine.parameters.map(({ type }) => type)).toEqual([
      'uuid',
      'uuid',
      'text',
      'integer',
      'jsonb',
    ]);
  });

  it('maps duplicate Reservation and effect identities to typed conflicts', () => {
    const effectId = ReservationReleaseEffectIdSchema.make('release-effect-1');
    const sibling = mapReservationReleaseEffectWriteError(effectId, {
      code: '23505',
      constraint: 'inventory_reservation_release_effects_reservation_uk',
    });
    const identity = mapReservationReleaseEffectWriteError(effectId, {
      code: '23505',
      constraint: 'inventory_reservation_release_effects_scope_effect_uk',
    });

    expect(sibling).toBeInstanceOf(InventoryReservationReleaseRejected);
    expect(sibling).toMatchObject({ reason: 'SIBLING_RELEASE_EFFECT_FORBIDDEN' });
    expect(identity).toMatchObject({ reason: 'EFFECT_ID_CONFLICT' });
  });
});
