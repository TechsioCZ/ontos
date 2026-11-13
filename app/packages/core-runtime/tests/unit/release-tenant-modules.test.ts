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
  expect(lockedInstallReport(entry, { _tag: 'Installed', installedWith: [] })).toMatchObject({
    detail: 'installed active by the release',
    outcome: 'installed',
  });
  // The modules the manifest installs with it are named in the same line.
  expect(lockedInstallReport(entry, { _tag: 'Installed', installedWith: ['crm.notes', 'work.tasks'] })).toMatchObject({
    detail: 'installed active by the release, with crm.notes, work.tasks',
    outcome: 'installed',
  });
  expect(lockedInstallReport(entry, { _tag: 'NotSelling' })).toMatchObject({
    detail: 'none of demo.merchandise is active',
    outcome: 'selling_module_missing',
  });
});
