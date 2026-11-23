import { registerSystemWorkload } from '@app/core-runtime';

/** Native tenant-only receiver; the installer enrolls it without a company credential or external alias. */
export const inventorySourceProvisionSystemWorkload = registerSystemWorkload({
  jobKey: 'commerce.inventory.source-provision',
});
