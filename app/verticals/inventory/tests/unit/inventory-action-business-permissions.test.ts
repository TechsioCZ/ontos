import { describe, expect, it } from 'effect-rstest';

import { getActionOwnerPermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';

import { correctStockPositionAction } from '../../src/actions/correct-stock-position.action.ts';
import { createInventoryReservationAction } from '../../src/actions/create-inventory-reservation.action.ts';
import { establishCommitmentProtectionAction } from '../../src/actions/establish-commitment-protection.action.ts';
import { releaseInventoryReservationAction } from '../../src/actions/release-inventory-reservation.action.ts';
import { stockIssueAction } from '../../src/actions/stock-issue.action.ts';
import { stockReceiptAction } from '../../src/actions/stock-receipt.action.ts';

/**
 * Staff Inventory writes are scope-wide capabilities (O67-Q2): the Action's declaration is the whole
 * authorization question, decided by the one access gate inside the selected access scope. The retired
 * `businessPermission`/`resourcePermission` targets no longer carry a per-resource grant.
 */
const governedWrites = [
  {
    action: createInventoryReservationAction,
    capabilityKey: 'commerce.inventory.inventory-reservation.create',
    legalEntityScope: 'required',
    risk: 'routine',
  },
  {
    action: releaseInventoryReservationAction,
    capabilityKey: 'commerce.inventory.inventory-reservation.release',
    legalEntityScope: 'required',
    risk: 'critical',
  },
  {
    action: establishCommitmentProtectionAction,
    capabilityKey: 'commerce.inventory.commitment-protection.establish',
    legalEntityScope: 'required',
    risk: 'critical',
  },
  {
    action: stockReceiptAction,
    capabilityKey: 'commerce.inventory.stock-position.receive',
    legalEntityScope: 'required',
    risk: 'critical',
  },
  {
    action: stockIssueAction,
    capabilityKey: 'commerce.inventory.stock-position.issue',
    legalEntityScope: 'required',
    risk: 'critical',
  },
  {
    action: correctStockPositionAction,
    capabilityKey: 'commerce.inventory.stock-position.correct',
    legalEntityScope: 'forbidden',
    risk: 'critical',
  },
] as const;

describe('Inventory Action capabilities', () => {
  it('binds stable public writes to their own scope-wide capability', () => {
    for (const { action, capabilityKey, legalEntityScope, risk } of governedWrites) {
      expect(action.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
      expect(action.descriptor.accessDeclaration).toMatchObject({
        key: capabilityKey,
        kind: 'action',
        risk,
        selectors: [],
      });
      expect(action.descriptor.legalEntityScope).toBe(legalEntityScope);
    }
  });

  it('keeps no per-resource permission target beside the capability', () => {
    for (const { action } of governedWrites) {
      // O67-Q2: the retired targets are removed from the descriptor.
      expect(action.descriptor).not.toHaveProperty('ownerPermissions');
      expect(action.descriptor).not.toHaveProperty('resourcePermission');
    }
    // The retired resolver is gone from every one of them; the one gate is the sole authority.
    expect(
      [
        getActionOwnerPermissionTargetResolver(createInventoryReservationAction),
        getActionOwnerPermissionTargetResolver(releaseInventoryReservationAction),
        getActionOwnerPermissionTargetResolver(establishCommitmentProtectionAction),
        getActionOwnerPermissionTargetResolver(stockReceiptAction),
        getActionOwnerPermissionTargetResolver(stockIssueAction),
        getActionOwnerPermissionTargetResolver(correctStockPositionAction),
      ].filter((resolver) => resolver !== undefined),
    ).toEqual([]);
  });
});
