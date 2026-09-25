import { expect, it } from 'effect-rstest';

import { inventoryAuditReadPermission } from '../../shared/permissions/inventory-audit-read.ts';
import { inventoryCatalogToStockBindingManagePermission } from '../../shared/permissions/inventory-catalog-to-stock-binding-manage.ts';
import { inventoryCommitmentProtectionEstablishPermission } from '../../shared/permissions/inventory-commitment-protection-establish.ts';
import { inventoryExternalStockCorrelationManagePermission } from '../../shared/permissions/inventory-external-stock-correlation-manage.ts';
import { inventoryMigrationManagePermission } from '../../shared/permissions/inventory-migration-manage.ts';
import { inventoryRecoveryExecutePermission } from '../../shared/permissions/inventory-recovery-execute.ts';
import { inventoryReservationEstablishPermission } from '../../shared/permissions/inventory-reservation-establish.ts';
import { inventoryReservationReleasePermission } from '../../shared/permissions/inventory-reservation-release.ts';
import { inventoryResourceReadPermission } from '../../shared/permissions/inventory-resource-read.ts';
import { inventoryStockCorrectPermission } from '../../shared/permissions/inventory-stock-correct.ts';
import { inventoryStockIssuePermission } from '../../shared/permissions/inventory-stock-issue.ts';
import { inventoryStockReceiptPermission } from '../../shared/permissions/inventory-stock-receipt.ts';
import { inventoryStockSharingEligibilityManagePermission } from '../../shared/permissions/inventory-stock-sharing-eligibility-manage.ts';
import { inventoryManifest } from '../../vertical.manifest.ts';

const permissions = [
  inventoryAuditReadPermission,
  inventoryCatalogToStockBindingManagePermission,
  inventoryCommitmentProtectionEstablishPermission,
  inventoryExternalStockCorrelationManagePermission,
  inventoryMigrationManagePermission,
  inventoryRecoveryExecutePermission,
  inventoryReservationEstablishPermission,
  inventoryReservationReleasePermission,
  inventoryResourceReadPermission,
  inventoryStockCorrectPermission,
  inventoryStockIssuePermission,
  inventoryStockReceiptPermission,
  inventoryStockSharingEligibilityManagePermission,
] as const;

it('publishes the complete exact-intent Inventory permission vocabulary', () => {
  expect(new Set(permissions.map(({ key }) => key))).toEqual(
    new Set([
      'inventory.audit.read',
      'inventory.catalog_to_stock_binding.manage',
      'inventory.commitment_protection.establish',
      'inventory.external_stock_correlation.manage',
      'inventory.migration.manage',
      'inventory.recovery.execute',
      'inventory.reservation.establish',
      'inventory.reservation.release',
      'inventory.resource.read',
      'inventory.stock.correct',
      'inventory.stock.issue',
      'inventory.stock.receipt',
      'inventory.stock_sharing_eligibility.manage',
    ]),
  );
  expect(inventoryManifest.publicSurface.businessPermissions).toEqual(permissions);
});

it('keeps every authority non-delegable, sensitive, and bound to one exact Inventory Resource', () => {
  for (const permission of permissions) {
    expect(permission.allowedScopeKinds).toEqual(['inventory_resource']);
    expect(permission.auditSensitivity).toBe('sensitive');
    expect(permission.customerDelegable).toBe(false);
    expect(permission.internalGrantable).toBe(false);
    expect(permission.owningCapability).toBe('commerce.inventory');
    expect(permission.schemaVersion).toBe('1');
  }
});

it('does not collapse weaker, relation-management, high-risk, or migration authorities', () => {
  const distinctAuthorities = new Set([
    inventoryResourceReadPermission.key,
    inventoryReservationEstablishPermission.key,
    inventoryReservationReleasePermission.key,
    inventoryStockCorrectPermission.key,
    inventoryRecoveryExecutePermission.key,
    inventoryCatalogToStockBindingManagePermission.key,
    inventoryExternalStockCorrelationManagePermission.key,
    inventoryStockSharingEligibilityManagePermission.key,
    inventoryMigrationManagePermission.key,
  ]);
  expect(distinctAuthorities.size).toBe(9);
  expect(inventoryStockSharingEligibilityManagePermission.key).not.toBe(inventoryReservationEstablishPermission.key);
});

it('catalogs every protected Inventory mutation and audit-read entrypoint under one exact authority', () => {
  const protectedEntrypointsByPermission = new Map(
    permissions
      .filter(({ key }) => key !== inventoryResourceReadPermission.key)
      .map(({ key, protectedEntrypoints }) => [key, protectedEntrypoints]),
  );

  const expectedProtectedEntrypoints = {
    'inventory.audit.read': ['commerce.inventory.api.inventory-reconciliation-evidence'],
    'inventory.catalog_to_stock_binding.manage': [
      'commerce.inventory.establish-catalog-to-stock-binding',
      'commerce.inventory.correct-catalog-to-stock-binding',
      'commerce.inventory.end-catalog-to-stock-binding',
    ],
    'inventory.commitment_protection.establish': ['commerce.inventory.establish-commitment-protection'],
    'inventory.external_stock_correlation.manage': [
      'commerce.inventory.establish-external-stock-correlation',
      'commerce.inventory.correct-external-stock-correlation',
      'commerce.inventory.end-external-stock-correlation',
    ],
    'inventory.migration.manage': [
      'commerce.inventory.select-inventory-backend',
      'commerce.inventory.import-source-assertion',
    ],
    'inventory.recovery.execute': [
      'commerce.inventory.recover-inventory-effect',
      'commerce.inventory.compensate-inventory-pre-commit',
      'commerce.inventory.resolve-inventory-source-conflict',
    ],
    'inventory.reservation.establish': ['commerce.inventory.create-inventory-reservation'],
    'inventory.reservation.release': ['commerce.inventory.release-inventory-reservation'],
    'inventory.stock_sharing_eligibility.manage': [
      'commerce.inventory.establish-stock-sharing-eligibility',
      'commerce.inventory.change-stock-sharing-eligibility',
      'commerce.inventory.end-stock-sharing-eligibility',
    ],
    'inventory.stock.correct': ['commerce.inventory.correct-stock-position'],
    'inventory.stock.issue': ['commerce.inventory.stock-issue'],
    'inventory.stock.receipt': ['commerce.inventory.stock-receipt'],
  } as const;

  expect(Object.fromEntries(protectedEntrypointsByPermission)).toEqual(expectedProtectedEntrypoints);

  const catalogedActionEntrypoints = Object.values(expectedProtectedEntrypoints)
    .flat()
    .filter((entrypointKey) => !entrypointKey.includes('.api.'));
  expect(new Set(catalogedActionEntrypoints)).toEqual(
    new Set(inventoryManifest.publicSurface.actions.map(({ descriptor }) => descriptor.entrypoint.entrypointKey)),
  );
});
