import { IdentityPersistenceUnavailableError } from '@app/core-runtime';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeModuleContractFixture } from '../../../../packages/core-runtime/src/testing/module-contract.ts';
import { companyCatalog } from '../../api/auth/agent-entities.ts';
import { makeInstalledModuleCatalogLayer } from '../../api/modules/installed-module-catalog.ts';
import { ConnectionsUnavailable } from '../../api/oauth-connections-admin/ports.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';

const roles = Array.from({ length: 6 }, (_, index) => ({
  key: `role-${index}`,
  label: `Role ${index}`,
  templatePrincipalId: `principal-${index}`,
}));

it.effect('reads all six company role templates with at most two principals in flight', () =>
  Effect.gen(function* boundedRoleReads() {
    const snapshot = yield* makeCompositionSnapshot([
      makeModuleContractFixture({ appId: 'notes', moduleId: 'fixture.notes' }),
    ]);
    let active = 0;
    let peak = 0;
    const read: string[] = [];
    const catalog = yield* companyCatalog('company', roles, {
      rolePolicyOf: (principalId) =>
        Effect.gen(function* readRole() {
          active += 1;
          peak = Math.max(peak, active);
          read.push(principalId);
          yield* Effect.yieldNow;
          active -= 1;
          return [];
        }),
    }).pipe(Effect.provide(makeInstalledModuleCatalogLayer(Effect.succeed(snapshot))));
    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect(read.toSorted()).toEqual(roles.map((role) => role.templatePrincipalId).toSorted());
    expect(catalog.presets.map((preset) => preset.key)).toEqual(roles.map((role) => role.key));
  }),
);

it.effect('fails the catalog read rather than returning partial role authority', () =>
  Effect.gen(function* failedRoleRead() {
    const snapshot = yield* makeCompositionSnapshot([
      makeModuleContractFixture({ appId: 'notes', moduleId: 'fixture.notes' }),
    ]);
    const failure = new IdentityPersistenceUnavailableError({
      code: 'identity_persistence_unavailable',
      reason: 'Authorization grants are temporarily unavailable',
    });
    const error = yield* companyCatalog('company', roles, {
      rolePolicyOf: () => Effect.fail(failure),
    }).pipe(Effect.provide(makeInstalledModuleCatalogLayer(Effect.succeed(snapshot))), Effect.flip);
    expect(error).toBeInstanceOf(ConnectionsUnavailable);
    expect(error.cause).toBe(failure);
  }),
);
