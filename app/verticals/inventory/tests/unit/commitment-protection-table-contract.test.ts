import { getTableConfig } from 'drizzle-orm/pg-core';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CommitmentProtectionRejected } from '../../shared/domain/commitment-protection.ts';
import { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import { mapCommitmentProtectionWriteError } from '../../src/persistence/commitment-protection-repository.ts';
import {
  INVENTORY_COMMITMENT_PROTECTION_TABLES,
  inventoryCommitmentProtectionHistory,
  inventoryCommitmentProtectionHistoryImmutabilityContract,
  inventoryCommitmentProtectionLifecycleContract,
  inventoryCommitmentProtectionScopeContract,
  inventoryCommitmentProtections,
} from '../../src/persistence/commitment-protection-table.ts';

const effectId = Schema.decodeSync(ReservationAuthorityEffectIdSchema)('effect:protection:attempt-1');

describe('Commitment Protection persistence contract', () => {
  it('persists one tenant-scoped Protection for the exact Reservation and Attempt', () => {
    const current = getTableConfig(inventoryCommitmentProtections);

    expect(current.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'inventory_commitment_protections_confirmation_fk',
        'inventory_commitment_protections_reservation_fk',
        'inventory_commitment_protections_backend_configuration_fk',
      ]),
    );
    expect(current.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        'inventory_commitment_protections_scope_id_uk',
        'inventory_commitment_protections_reservation_attempt_uk',
        'inventory_commitment_protections_confirmation_uk',
        'inventory_commitment_protections_authority_effect_uk',
        'inventory_commitment_protections_health_idx',
      ]),
    );
    expect(current.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(INVENTORY_COMMITMENT_PROTECTION_TABLES).toEqual([
      inventoryCommitmentProtectionHistory,
      inventoryCommitmentProtections,
    ]);
    expect(inventoryCommitmentProtectionScopeContract.event).toBe('INSERT OR UPDATE');
  });

  it('freezes the original Confirmation, Reservation, authority, allocations, and proof identity', () => {
    expect(inventoryCommitmentProtectionLifecycleContract.immutableColumns).toEqual(
      expect.arrayContaining([
        'protection_id',
        'confirmation_id',
        'reservation_id',
        'attempt_id',
        'owner_configuration_id',
        'issuer_backend_kind',
        'issuer_backend_id',
        'authority_effect_id',
        'owner_evidence_ref',
        'established_at',
      ]),
    );
    expect(inventoryCommitmentProtectionLifecycleContract.allowedTransitions).toEqual([
      'PROTECTED -> AT_RISK',
      'AT_RISK -> AT_RISK',
    ]);
    expect(inventoryCommitmentProtectionLifecycleContract.monotonicRevision).toBe(true);
    expect(inventoryCommitmentProtectionLifecycleContract.releaseAllowed).toBe(false);
    expect(inventoryCommitmentProtectionScopeContract.constraintNames).toEqual({
      authority: 'inventory_commitment_protections_exact_authority_ck',
      confirmation: 'inventory_commitment_protections_exact_confirmation_ck',
      reservation: 'inventory_commitment_protections_exact_reservation_ck',
      snapshot: 'inventory_commitment_protections_snapshot_ck',
    });
  });

  it('makes Protection history append-only under tenant RLS', () => {
    const history = getTableConfig(inventoryCommitmentProtectionHistory);

    expect(history.indexes.map(({ config }) => config.name)).toEqual(
      expect.arrayContaining([
        'inventory_commitment_protection_history_scope_id_uk',
        'inventory_commitment_protection_history_revision_uk',
      ]),
    );
    expect(history.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(inventoryCommitmentProtectionHistoryImmutabilityContract).toMatchObject({
      deleteTriggerName: 'inventory_commitment_protection_history_no_delete_trg',
      updateTriggerName: 'inventory_commitment_protection_history_no_update_trg',
    });
  });

  it('maps uniqueness failures to exact identity, sibling, and revision conflicts', () => {
    const identity = mapCommitmentProtectionWriteError(effectId, {
      code: '23505',
      constraint: 'inventory_commitment_protections_authority_effect_uk',
    });
    const sibling = mapCommitmentProtectionWriteError(effectId, {
      code: '23505',
      constraint: 'inventory_commitment_protections_reservation_attempt_uk',
    });
    const revision = mapCommitmentProtectionWriteError(effectId, {
      code: '23505',
      constraint: 'inventory_commitment_protection_history_revision_uk',
    });

    expect(identity).toBeInstanceOf(CommitmentProtectionRejected);
    expect(identity).toMatchObject({ effectId, reason: 'PROTECTION_IDENTITY_CONFLICT' });
    expect(sibling).toMatchObject({ effectId, reason: 'SIBLING_PROTECTION_FORBIDDEN' });
    expect(revision).toMatchObject({ effectId, reason: 'REVISION_CONFLICT' });
  });
});
