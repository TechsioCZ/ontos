import fs from 'node:fs';
import { expect, test } from '@rstest/core';
import { Effect, Schema } from 'effect';
import {
  deriveInstalledVerticalIds,
  installedVerticalIds,
} from '../../api/verticals/installed-verticals.ts';

test('derives installed vertical IDs from the injected topology without hardcoded registrations', async () => {
  const topology = Schema.decodeUnknownSync(Schema.Json)(
    JSON.parse(
      fs.readFileSync(
        new URL('../../../../topology/reference-topology.json', import.meta.url),
        'utf-8',
      ),
    ),
  );
  const expectedInstalledIds = await Effect.runPromise(deriveInstalledVerticalIds(topology));

  expect([...expectedInstalledIds]).toEqual(['projects']);
  expect([...(await Effect.runPromise(installedVerticalIds))]).toEqual([...expectedInstalledIds]);
  const valid = await Effect.runPromise(
    deriveInstalledVerticalIds({
      sharedPackages: [{ id: 'shared-contracts', kind: 'package' }],
      shell: { id: 'shell-super-app', kind: 'shell' },
      verticals: [
        { id: 'property-registry', kind: 'vertical' },
        { id: 'future-generated', kind: 'vertical' },
      ],
    }),
  );
  expect([...valid]).toEqual(['property-registry', 'future-generated']);
  expect(valid.has('property.registry')).toBe(false);
});

test('rejects malformed, non-vertical, invalid, and duplicate installed entries', async () => {
  const inputs = [
    {},
    { verticals: [{ id: 'shell-super-app', kind: 'shell' }] },
    { verticals: [{ id: '../inventory', kind: 'vertical' }] },
    {
      verticals: [
        { id: 'inventory-stock', kind: 'vertical' },
        { id: 'inventory-stock', kind: 'vertical' },
      ],
    },
  ];
  const errors = await Promise.all(
    inputs.map((input) => Effect.runPromise(Effect.flip(deriveInstalledVerticalIds(input)))),
  );
  expect(errors.every((error) => error._tag === 'InstalledVerticalTopologyError')).toBe(true);
});

test('emits only Projects routes, clients, package IDs, and environment names after cutover', () => {
  const activeCutoverSurface = [
    '../../../../.modernjs/ultramodern.json',
    '../../../../topology/reference-topology.json',
    '../../package.json',
    '../../src/api/vertical-clients.ts',
    '../../src/modern-tanstack/index/router.gen.ts',
    '../../src/routes/ultramodern-route-metadata.ts',
  ]
    .map((relativePath) => fs.readFileSync(new URL(relativePath, import.meta.url), 'utf-8'))
    .join('\n');

  expect(activeCutoverSurface).toContain('/projects');
  expect(activeCutoverSurface).toContain('projects.core');
  for (const retiredIdentity of ['/crm', '@app/crm', 'crm.core', 'verticalCrm', 'VERTICAL_CRM']) {
    expect(activeCutoverSurface).not.toContain(retiredIdentity);
  }
});
