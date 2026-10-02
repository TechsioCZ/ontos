import { describe, expect, it } from 'effect-rstest';

import { mapManageQuantityTierActionProblem } from '../../api/manage-quantity-tier-action-problems.ts';
import {
  ManageQuantityTierConflict,
  ManageQuantityTierRejected,
} from '../../src/actions/manage-quantity-tier.action.ts';
import { CurrencySupportPersistenceUnavailable } from '../../src/actions/currency-support-persistence-unavailable.ts';
import { QuantityTierPersistenceUnavailable } from '../../src/services/quantity-tier-persistence.service.ts';

describe('Manage Quantity Tier Action HTTP problems', () => {
  it('maps current-state and currency-support conflicts to 409', () => {
    expect(
      mapManageQuantityTierActionProblem(
        new ManageQuantityTierConflict({ code: 'manage_quantity_tier_conflict', reason: 'EXPECTED_CURRENT_STALE' }),
      ),
    ).toMatchObject({ code: 'manage_quantity_tier_conflict', status: 409 });
    expect(
      mapManageQuantityTierActionProblem(
        new ManageQuantityTierRejected({
          code: 'manage_quantity_tier_currency_support_conflict',
          reason: 'Currency support has conflicting Current rows',
        }),
      ),
    ).toMatchObject({ code: 'manage_quantity_tier_currency_support_conflict', status: 409 });
  });

  it.each([
    ['manage_quantity_tier_scope_mismatch', 403],
    ['manage_quantity_tier_currency_support_absent', 404],
    ['manage_quantity_tier_acknowledgement_mismatch', 422],
    ['manage_quantity_tier_currency_not_enabled', 422],
    ['manage_quantity_tier_currency_support_gap', 422],
    ['manage_quantity_tier_target_mismatch', 422],
  ] as const)('maps %s to %s', (code, status) => {
    expect(
      mapManageQuantityTierActionProblem(new ManageQuantityTierRejected({ code, reason: 'Rejected' })),
    ).toMatchObject({
      code,
      status,
    });
  });

  it('maps owner storage failures to retryable 503 problems', () => {
    expect(
      mapManageQuantityTierActionProblem(
        new QuantityTierPersistenceUnavailable({ reason: 'Quantity Tier storage unavailable' }),
      ),
    ).toMatchObject({ code: 'quantity_tier_persistence_unavailable', retryable: true, status: 503 });
    expect(
      mapManageQuantityTierActionProblem(
        new CurrencySupportPersistenceUnavailable({ reason: 'Currency Support storage unavailable' }),
      ),
    ).toMatchObject({ code: 'currency_support_persistence_unavailable', retryable: true, status: 503 });
  });
});
