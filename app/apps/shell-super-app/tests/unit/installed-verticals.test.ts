import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { deriveInstalledVerticalIds, InstalledVerticalTopologyError } from '../../api/verticals/installed-verticals.ts';

it.effect('derives installed vertical IDs from the injected topology without hardcoded registrations', () =>
  Effect.gen(function* verifyCase1() {
    const valid = yield* deriveInstalledVerticalIds({
      sharedPackages: [{ id: 'shared-contracts', kind: 'package' }],
      shell: { id: 'shell-super-app', kind: 'shell' },
      verticals: [
        { id: 'property-registry', kind: 'vertical' },
        { id: 'future-generated', kind: 'vertical' },
      ],
    });
    expect([...valid]).toEqual(['property-registry', 'future-generated']);
    expect(valid.has('property.registry')).toBe(false);
  }),
);

it.effect('rejects malformed, non-vertical, invalid, and duplicate installed entries', () =>
  Effect.gen(function* verifyCase2() {
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
    const errors = yield* Effect.all(
      inputs.map((input) =>
        Effect.gen(function* verifyCase3() {
          return yield* Effect.flip(deriveInstalledVerticalIds(input));
        }),
      ),
      { concurrency: 'unbounded' },
    );
    expect(errors.every(Schema.is(InstalledVerticalTopologyError))).toBe(true);
  }),
);
