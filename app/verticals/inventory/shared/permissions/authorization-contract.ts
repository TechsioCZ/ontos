import type { OwnerPermissionContract } from '@app/core-runtime';
import { inventoryAuditReadPermission } from './inventory-audit-read.ts';
import { inventoryCatalogToStockBindingManagePermission } from './inventory-catalog-to-stock-binding-manage.ts';
import { inventoryCommitmentProtectionEstablishPermission } from './inventory-commitment-protection-establish.ts';
import { inventoryExternalStockCorrelationManagePermission } from './inventory-external-stock-correlation-manage.ts';
import { inventoryMigrationManagePermission } from './inventory-migration-manage.ts';
import { inventoryRecoveryExecutePermission } from './inventory-recovery-execute.ts';
import { inventoryReservationEstablishPermission } from './inventory-reservation-establish.ts';
import { inventoryReservationReleasePermission } from './inventory-reservation-release.ts';
import { inventoryResourceReadPermission } from './inventory-resource-read.ts';
import { inventoryStockCorrectPermission } from './inventory-stock-correct.ts';
import { inventoryStockIssuePermission } from './inventory-stock-issue.ts';
import { inventoryStockReceiptPermission } from './inventory-stock-receipt.ts';
import { inventoryStockSharingEligibilityManagePermission } from './inventory-stock-sharing-eligibility-manage.ts';

export const inventoryAuthorizationContract = Object.freeze({
  owningModuleKey: 'commerce.inventory',
  permissions: Object.freeze([
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
  ]),
  schemaVersion: '1',
  targetResourceType: 'inventory_permission',
}) satisfies OwnerPermissionContract;
