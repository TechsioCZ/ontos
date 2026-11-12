import { expect, it } from 'effect-rstest';

import { lockedInstallReport } from '../../src/install/release-tenant-modules.ts';

const entry = { moduleKey: 'commerce.tax', sellingModuleKeys: ['demo.merchandise'], tenantId: 'tenant-1' };

it('reports the state a concurrent writer left, never "installed concurrently" for a module a person turned off', () => {
  expect(lockedInstallReport(entry, { _tag: 'AlreadyPresent', state: 'suspended' })).toEqual({
    detail: 'set suspended by someone else while this release decided; a release never changes that',
    moduleKey: 'commerce.tax',
    outcome: 'left_as_set',
    tenantId: 'tenant-1',
  });
  expect(lockedInstallReport(entry, { _tag: 'AlreadyPresent', state: 'active' })).toMatchObject({
    detail: 'installed concurrently',
    outcome: 'already_active',
  });
  expect(lockedInstallReport(entry, { _tag: 'Installed' })).toMatchObject({ outcome: 'installed' });
  expect(lockedInstallReport(entry, { _tag: 'NotSelling' })).toMatchObject({
    detail: 'none of demo.merchandise is active',
    outcome: 'selling_module_missing',
  });
});
