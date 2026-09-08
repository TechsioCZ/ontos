import fs from 'node:fs';

import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import { expect, test } from '@rstest/core';
import { Effect, Schema } from 'effect';

import { DeploymentAllowlistTopologySchema } from '../../api/modules/deployment-allowlist.ts';
import {
  deriveInstalledVerticalIds,
  InstalledVerticalTopologyError,
  installedVerticalIds,
} from '../../api/verticals/installed-verticals.ts';

test('derives installed vertical IDs from the injected topology without hardcoded registrations', async () => {
  const topology = Schema.decodeUnknownSync(DeploymentAllowlistTopologySchema)(
    JSON.parse(
      fs.readFileSync(
        new URL(
          '../../../../topology/reference-topology.json',
          import.meta.url
        ),
        'utf-8'
      )
    )
  );
  const expectedInstalledIds = await runEffectTestPromise(
    deriveInstalledVerticalIds(topology)
  );

  expect([...expectedInstalledIds]).toEqual(['party-registry']);
  expect(expectedInstalledIds.has('party.registry')).toBe(false);
  expect([...(await runEffectTestPromise(installedVerticalIds))]).toEqual([
    ...expectedInstalledIds,
  ]);
  const valid = await runEffectTestPromise(
    deriveInstalledVerticalIds({
      sharedPackages: [{ id: 'shared-contracts', kind: 'package' }],
      shell: { id: 'shell-super-app', kind: 'shell' },
      verticals: [
        { id: 'property-registry', kind: 'vertical' },
        { id: 'future-generated', kind: 'vertical' },
      ],
    })
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
    inputs.map(
      async (input) =>
        await runEffectTestPromise(
          Effect.flip(deriveInstalledVerticalIds(input))
        )
    )
  );
  expect(errors.every(Schema.is(InstalledVerticalTopologyError))).toBe(true);
});
