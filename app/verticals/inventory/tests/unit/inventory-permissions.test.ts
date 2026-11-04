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

it('freezes every published owner descriptor including canonical capability and dormant entrypoints', () => {
  expect([
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
  ]).toEqual([
    {
      allowedScopeKinds: ['inventory_resource'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: false,
      key: 'inventory.audit.read',
      meaning: 'Inventory Audit Read business permission.',
      owningCapability: 'commerce.inventory',
      protectedEntrypoints: ['commerce.inventory.api.inventory-reconciliation-evidence'],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['inventory_resource'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: false,
      key: 'inventory.catalog_to_stock_binding.manage',
      meaning: 'Inventory Catalog To Stock Binding Manage business permission.',
      owningCapability: 'commerce.inventory',
      protectedEntrypoints: [
        'commerce.inventory.establish-catalog-to-stock-binding',
        'commerce.inventory.correct-catalog-to-stock-binding',
        'commerce.inventory.end-catalog-to-stock-binding',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['inventory_resource'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: false,
      key: 'inventory.commitment_protection.establish',
      meaning: 'Inventory Commitment Protection Establish business permission.',
      owningCapability: 'commerce.inventory',
      protectedEntrypoints: ['commerce.inventory.establish-commitment-protection'],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['inventory_resource'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: false,
      key: 'inventory.external_stock_correlation.manage',
      meaning: 'Inventory External Stock Correlation Manage business permission.',
      owningCapability: 'commerce.inventory',
      protectedEntrypoints: [
        'commerce.inventory.establish-external-stock-correlation',
        'commerce.inventory.correct-external-stock-correlation',
        'commerce.inventory.end-external-stock-correlation',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['inventory_resource'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: false,
      key: 'inventory.migration.manage',
      meaning: 'Inventory Migration Manage business permission.',
      owningCapability: 'commerce.inventory',
      protectedEntrypoints: [
        'commerce.inventory.select-inventory-backend',
        'commerce.inventory.import-source-assertion',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['inventory_resource'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: false,
      key: 'inventory.recovery.execute',
      meaning: 'Inventory Recovery Execute business permission.',
      owningCapability: 'commerce.inventory',
      protectedEntrypoints: [
        'commerce.inventory.recover-inventory-effect',
        'commerce.inventory.compensate-inventory-pre-commit',
        'commerce.inventory.resolve-inventory-source-conflict',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['inventory_resource'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: false,
      key: 'inventory.reservation.establish',
      meaning: 'Inventory Reservation Establish business permission.',
      owningCapability: 'commerce.inventory',
      protectedEntrypoints: ['commerce.inventory.create-inventory-reservation'],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['inventory_resource'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: false,
      key: 'inventory.reservation.release',
      meaning: 'Inventory Reservation Release business permission.',
      owningCapability: 'commerce.inventory',
      protectedEntrypoints: ['commerce.inventory.release-inventory-reservation'],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['inventory_resource'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: false,
      key: 'inventory.resource.read',
      meaning: 'Inventory Resource Read business permission.',
      owningCapability: 'commerce.inventory',
      protectedEntrypoints: [
        'commerce.inventory.api.catalog-to-stock-binding-resolution',
        'commerce.inventory.api.commitment-protection-verification',
        'commerce.inventory.api.current-stock-evidence-for-availability',
        'commerce.inventory.api.inventory-effect-outcome',
        'commerce.inventory.api.inventory-reservation-detail',
        'commerce.inventory.api.reservation-confirmation-verification',
        'commerce.inventory.api.stock-sharing-eligibility-resolution',
      ],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['inventory_resource'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: false,
      key: 'inventory.stock.correct',
      meaning: 'Inventory Stock Correct business permission.',
      owningCapability: 'commerce.inventory',
      protectedEntrypoints: ['commerce.inventory.correct-stock-position'],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['inventory_resource'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: false,
      key: 'inventory.stock.issue',
      meaning: 'Inventory Stock Issue business permission.',
      owningCapability: 'commerce.inventory',
      protectedEntrypoints: ['commerce.inventory.stock-issue'],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['inventory_resource'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: false,
      key: 'inventory.stock.receipt',
      meaning: 'Inventory Stock Receipt business permission.',
      owningCapability: 'commerce.inventory',
      protectedEntrypoints: ['commerce.inventory.stock-receipt'],
      schemaVersion: '1',
    },
    {
      allowedScopeKinds: ['inventory_resource'],
      auditSensitivity: 'sensitive',
      authorityGroups: [],
      customerDelegable: false,
      internalGrantable: false,
      key: 'inventory.stock_sharing_eligibility.manage',
      meaning: 'Inventory Stock Sharing Eligibility Manage business permission.',
      owningCapability: 'commerce.inventory',
      protectedEntrypoints: [
        'commerce.inventory.establish-stock-sharing-eligibility',
        'commerce.inventory.change-stock-sharing-eligibility',
        'commerce.inventory.end-stock-sharing-eligibility',
      ],
      schemaVersion: '1',
    },
  ]);
});
