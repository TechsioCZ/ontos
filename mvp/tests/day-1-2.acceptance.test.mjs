import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { accountingCoreManifest } from '../verticals/accounting-core/vertical.manifest.ts';
import { propertyRegistryManifest } from '../verticals/property-registry/vertical.manifest.ts';
import {
  CORE_TENANT_MODULE_STATES,
  discoverVisibleVerticals,
} from '../apps/shell-super-app/src/verticals/module-discovery.ts';
import { installedVerticalRegistrations } from '../apps/shell-super-app/src/verticals/installed.registry.ts';
import { getShellNavigationItems } from '../apps/shell-super-app/src/verticals/route-model.ts';

test('shell discovers active MVP MicroVerticals through registry and tenant module state', () => {
  const visibleVerticals = discoverVisibleVerticals({
    registrations: installedVerticalRegistrations,
    tenantModuleStates: CORE_TENANT_MODULE_STATES,
  });

  assert.deepEqual(
    visibleVerticals.map((vertical) => vertical.manifest.id),
    ['property.registry', 'accounting.core'],
  );

  assert.deepEqual(
    visibleVerticals.map((vertical) => vertical.tenantState.state),
    ['active', 'active'],
  );
});

test('public manifests expose Day 2 descriptors without private implementation paths', () => {
  const manifests = [propertyRegistryManifest, accountingCoreManifest];

  assert.deepEqual(
    manifests.map((manifest) => manifest.resources.map((resource) => resource.id)),
    [['property.unit'], ['accounting.draft_entry']],
  );
  assert.deepEqual(
    manifests.map((manifest) => manifest.components.map((component) => component.id)),
    [['PropertyUnitCard'], ['AccountingDraftEntryCard']],
  );
  assert.deepEqual(propertyRegistryManifest.components[0]?.locator, {
    exposedModule: './PropertyUnitCard',
    exportName: 'PropertyUnitCard',
    kind: 'module-federation',
    remote: 'propertyRegistry',
  });
  assert.deepEqual(accountingCoreManifest.dependencies, ['property.registry']);
  assert.deepEqual(
    manifests.map((manifest) => manifest.actions.map((action) => action.id)),
    [['property.registry.createUnit'], ['accounting.core.createDraftEntry']],
  );
  assert.deepEqual(
    manifests.map((manifest) => manifest.search.map((search) => search.id)),
    [['property.unit.search_result'], ['accounting.draft_entry.search_result']],
  );
  assert.deepEqual(
    manifests.map((manifest) => manifest.reports.map((report) => report.id)),
    [['property.unit.inventory'], ['accounting.draft_entry.summary']],
  );

  const manifestJson = JSON.stringify(manifests);
  assert.equal(manifestJson.includes('handler'), false);
  assert.equal(manifestJson.includes('migration'), false);
  assert.equal(manifestJson.includes('vertical.registration'), false);
});

test('module-state visibility keeps only active, read-only, and deprecated verticals visible', () => {
  const allStates = [
    'inactive',
    'active',
    'read_only',
    'suspended',
    'quarantined',
    'deprecated',
    'archived',
  ];

  const visibleStates = allStates.flatMap((state) =>
    discoverVisibleVerticals({
      registrations: installedVerticalRegistrations,
      tenantModuleStates: [
        {
          moduleId: 'property.registry',
          state,
        },
      ],
    }).map((vertical) => vertical.tenantState.state),
  );

  assert.deepEqual(visibleStates, ['active', 'read_only', 'deprecated']);
});

test('pnpm check runs the OntOS boundary check command', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf-8'));

  assert.equal(packageJson.scripts.check.includes('pnpm check:boundaries'), true);
  assert.equal(
    packageJson.scripts['check:boundaries'],
    'node ./scripts/check-ontos-boundaries.mjs',
  );
});

test('shell route model exposes visible boundary markers for both MicroVerticals', () => {
  const navigationItems = getShellNavigationItems({
    registrations: installedVerticalRegistrations,
    tenantModuleStates: CORE_TENANT_MODULE_STATES,
  });

  assert.deepEqual(
    navigationItems.map((item) => ({
      folderName: item.folderName,
      moduleId: item.moduleId,
      path: item.path,
      renderedFrom: item.renderedFrom,
      state: item.state,
    })),
    [
      {
        folderName: 'property-registry',
        moduleId: 'property.registry',
        path: '/property-registry',
        renderedFrom: 'verticals/property-registry',
        state: 'active',
      },
      {
        folderName: 'accounting-core',
        moduleId: 'accounting.core',
        path: '/accounting-core',
        renderedFrom: 'verticals/accounting-core',
        state: 'active',
      },
    ],
  );
});
