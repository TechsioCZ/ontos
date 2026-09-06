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
  const inputs: Schema.Schema.Type<typeof Schema.Json>[] = [
    null,
    [],
    'topology',
    {},
    { verticals: null },
    { verticals: {} },
    { verticals: [null] },
    { verticals: [[]] },
    { verticals: ['inventory'] },
    { verticals: [{ kind: 'vertical' }] },
    { verticals: [{ id: 1, kind: 'vertical' }] },
    { verticals: [{ id: 'Inventory', kind: 'vertical' }] },
    { verticals: [{ id: 'inventory-', kind: 'vertical' }] },
    { verticals: [{ id: 'inventory', kind: 'package' }] },
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
  for (const error of errors) {
    expect(error._tag).toBe('InstalledVerticalTopologyError');
    expect(error.reason).toBe('The authoritative installed MicroVertical topology is malformed');
  }
});

test('accepts empty topology and dotted IDs without including other topology owners', async () => {
  expect([...(await Effect.runPromise(deriveInstalledVerticalIds({ verticals: [] })))]).toEqual([]);
  const ids = await Effect.runPromise(
    deriveInstalledVerticalIds({
      shell: { id: 'shell-super-app', kind: 'shell' },
      sharedPackages: [{ id: 'shared-contracts', kind: 'package' }],
      verticals: [{ id: 'inventory.stock', kind: 'vertical' }],
    }),
  );
  expect([...ids]).toEqual(['inventory.stock']);
});

test('keeps unexpected topology access exceptions as defects, not safe configuration failures', async () => {
  const defect = new Error('unexpected getter failure');
  const input = {
    get verticals(): [] {
      throw defect;
    },
  };
  const result = await Effect.runPromise(
    deriveInstalledVerticalIds(input).pipe(
      Effect.catchTag('InstalledVerticalTopologyError', () => Effect.succeed('typed failure')),
      Effect.catchDefect((cause) => Effect.succeed(cause)),
    ),
  );
  expect(result).toBe(defect);
});
