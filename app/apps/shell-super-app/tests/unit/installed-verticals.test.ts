import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeModuleContractFixture } from '../../../../packages/core-runtime/src/testing/module-contract.ts';
import {
  InstalledModuleCatalogUnavailableError,
  makeInstalledModuleCatalogLayer,
} from '../../api/modules/installed-module-catalog.ts';
import { installedVerticalIds } from '../../api/verticals/installed-verticals.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';

it.effect('admits deployment IDs from the approved release independently of placement and module IDs', () =>
  Effect.gen(function* approvedDeploymentIds() {
    const first = yield* makeCompositionSnapshot([
      makeModuleContractFixture({ appId: 'property-registry', moduleId: 'property.registry' }),
    ]);
    const next = yield* makeCompositionSnapshot([
      makeModuleContractFixture({ appId: 'property-registry', moduleId: 'property.registry' }),
      makeModuleContractFixture({ appId: 'future-generated', moduleId: 'future.generated' }),
    ]);
    let current = first;
    const layer = makeInstalledModuleCatalogLayer(Effect.sync(() => current));
    const firstIds = yield* installedVerticalIds.pipe(Effect.provide(layer));
    expect([...firstIds]).toEqual(['property-registry']);
    expect(firstIds.has('property.registry')).toBe(false);
    current = next;
    expect([...(yield* installedVerticalIds.pipe(Effect.provide(layer)))]).toEqual([
      'future-generated',
      'property-registry',
    ]);
  }),
);

it.effect('refuses gateway admission when the approved bundle is incomplete or contradictory', () =>
  Effect.gen(function* invalidDeploymentIds() {
    const snapshot = yield* makeCompositionSnapshot([
      makeModuleContractFixture({ appId: 'property-registry', moduleId: 'property.registry' }),
      makeModuleContractFixture({ appId: 'duplicate-property', moduleId: 'property.registry' }),
    ]);
    const error = yield* Effect.flip(
      installedVerticalIds.pipe(Effect.provide(makeInstalledModuleCatalogLayer(Effect.succeed(snapshot)))),
    );
    expect(error).toBeInstanceOf(InstalledModuleCatalogUnavailableError);
  }),
);
