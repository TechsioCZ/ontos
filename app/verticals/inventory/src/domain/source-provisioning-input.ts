import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';

import { canonicalSourceProvisioningExpectedPolicy } from '../../shared/domain/source-provisioning.ts';
import type { ProvisionSourceStockItemInput } from '../../shared/domain/source-provisioning.ts';

// Only the location set is unordered. Keep the original input in the receipt, not this comparison form.
const inputHash = (input: ProvisionSourceStockItemInput) =>
  computeCanonicalValueHash({
    ...input,
    expectedPolicy: canonicalSourceProvisioningExpectedPolicy(input.expectedPolicy),
  });
export const sameProvisionSourceStockItemInput = (
  left: ProvisionSourceStockItemInput,
  right: ProvisionSourceStockItemInput,
): boolean => inputHash(left) === inputHash(right);
