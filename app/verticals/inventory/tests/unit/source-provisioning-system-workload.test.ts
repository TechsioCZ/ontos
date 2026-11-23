import { expect, it } from 'effect-rstest';

import { declaresSystemWorkload } from '../../../../packages/core-runtime/src/access/workloads/system-workload-enrollment.ts';
import { provisionSourceStockItemAction } from '../../src/actions/provision-source-stock-item.action.ts';
import { sourceStockItemProvisioningReceiptRead } from '../../src/api/source-stock-item-provisioning-receipt.read.ts';
import { inventoryManifest } from '../../vertical.manifest.ts';
import { inventorySourceProvisionSystemWorkload } from '../../src/source-provision-system-workload.ts';

const workloadKey = 'commerce.inventory.source-provision';

it('publishes the exact native SYSTEM workload accepted by Core enrollment for source provisioning', () => {
  // The deployment contract generator serializes these registrations to their job keys.
  const registrations = inventoryManifest.systemWorkloads ?? [];
  const contract = { manifest: { systemWorkloads: registrations.map(({ jobKey }) => jobKey) } };

  expect(declaresSystemWorkload(contract, workloadKey)).toBe(true);
  expect(contract.manifest.systemWorkloads).toEqual([workloadKey]);
  expect(registrations[0]).toBe(inventorySourceProvisionSystemWorkload);
  expect(registrations.every(({ allowServicePrincipal }) => allowServicePrincipal === false)).toBe(true);
  expect(declaresSystemWorkload(contract, 'integration.symmy-admit')).toBe(false);
  expect(declaresSystemWorkload(contract, 'commerce.inventory.source-write')).toBe(false);
});

it('keeps provisioning and its receipt tenant-only under the exact enrolled workload', () => {
  expect(provisionSourceStockItemAction.descriptor.accessWorkload?.workloads).toEqual([workloadKey]);
  expect(provisionSourceStockItemAction.descriptor.legalEntityScope).toBe('forbidden');
  expect(provisionSourceStockItemAction.descriptor.accessDeclaration?.key).toBe(
    'commerce.inventory.source-stock-item.provision',
  );
  expect(sourceStockItemProvisioningReceiptRead.descriptor.accessWorkload?.workloads).toEqual([
    workloadKey,
    'commerce.inventory.source-read',
  ]);
  expect(sourceStockItemProvisioningReceiptRead.descriptor.legalEntityScope).toBe('forbidden');
});
