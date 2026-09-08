import fs from 'node:fs';
import { expect, it } from '@app/effect-rstest';
import { Effect, Schema } from 'effect';
import {
  deriveInstalledVerticalIds,
  InstalledVerticalTopologyError,
  installedVerticalIds,
} from '../../api/verticals/installed-verticals.ts';
import { DeploymentAllowlistTopologySchema } from '../../api/modules/deployment-allowlist.ts';

it.effect(
  'derives installed vertical IDs from the injected topology without hardcoded registrations',
  () =>
    Effect.gen(function* verifyCase1() {
      const topology = Schema.decodeUnknownSync(DeploymentAllowlistTopologySchema)(
        JSON.parse(
          fs.readFileSync(
            new URL('../../../../topology/reference-topology.json', import.meta.url),
            'utf-8',
          ),
        ),
      );
      const expectedInstalledIds = yield* deriveInstalledVerticalIds(topology);

      expect([...expectedInstalledIds]).toEqual(['party-registry']);
      expect(expectedInstalledIds.has('party.registry')).toBe(false);
      expect([...(yield* installedVerticalIds)]).toEqual([...expectedInstalledIds]);
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
