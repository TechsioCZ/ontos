import { expect, test } from '@rstest/core';
import { Effect } from 'effect';
import {
  deriveInstalledVerticalIds,
  installedVerticalIds,
} from '../../api/verticals/installed-verticals.ts';

test('derives installed vertical IDs from the injected topology without hardcoded registrations', async () => {
  expect([...(await Effect.runPromise(installedVerticalIds))]).toEqual([]);
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
