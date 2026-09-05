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

  expect([...expectedInstalledIds]).toEqual(['contacts', 'party-registry']);
  expect(expectedInstalledIds.has('party.registry')).toBe(false);
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
    inputs.map(
      async (input) => await Effect.runPromise(Effect.flip(deriveInstalledVerticalIds(input))),
    ),
  );
  expect(errors.every((error) => error._tag === 'InstalledVerticalTopologyError')).toBe(true);
});
