import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';

import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import type { AccessCatalogModule } from '../../src/authorization/access-declaration.ts';
import { installedModuleKeysOf } from '../../src/install/installation-runtime.ts';
import { CORE_MEDIA_MODULE_ID } from '../../src/media/identity.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { validateTenantModuleStateTransition } from '../../src/modules/tenant-module-state-service.ts';
import { makeInstalledCatalogFixture } from '../support/installed-catalog.ts';

/*
 * Core Media is a Core-owned system capability, not a tenant-installed module. These checks prove the two
 * halves of that statement on the mechanism that already exists: the installation row is derived from the
 * access catalog (so a tenant bootstrapped before Core Media gets it when the bootstrap runs again), and
 * nothing can activate Core Media as a business module. The bootstrap against PostgreSQL and SpiceDB is
 * `tests/integration/stage-context-bootstrap-access.test.ts`; the first Core Media declaration does not exist
 * yet, so this fixture stands in for it.
 */

const entrypoint = (moduleKey: string, entrypointKey: string) =>
  defineSystemModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey,
    moduleKey,
    role: 'api',
  });

const readModule = (moduleId: string, key: string, entrypointKey: string): AccessCatalogModule => {
  const owner = entrypoint(moduleId, entrypointKey);
  return {
    descriptors: [
      {
        accessDeclaration: decodeAccessDeclarationOrThrow(
          {
            key,
            kind: 'read',
            modes: ['run'],
            placement: { group: 'media', level: 'basic' },
            risk: 'routine',
            selectors: [],
          },
          owner,
        ),
        entrypoint: owner,
      },
    ],
    moduleId,
  };
};

const releaseWithoutMedia: readonly AccessCatalogModule[] = [
  readModule('core.identity', 'core.identity.principal.read', 'core.identity.api.principal'),
  readModule('core.shell', 'core.shell.composition.read', 'core.shell.api.composition'),
  readModule('party.registry', 'party.registry.party.read', 'party.registry.api.party'),
];
const releaseWithMedia: readonly AccessCatalogModule[] = [
  ...releaseWithoutMedia,
  readModule(CORE_MEDIA_MODULE_ID, 'core.media.asset-metadata.read', 'core.media.api.asset-metadata'),
];

it('accepts a core.media system entrypoint and an access key prefixed by the owner key', () => {
  expect(() => readModule(CORE_MEDIA_MODULE_ID, 'core.media.asset-metadata.read', 'core.media.api.x')).not.toThrow();
  // The negative control: another owner's key under the core.media entrypoint is refused.
  expect(() => readModule(CORE_MEDIA_MODULE_ID, 'core.identity.asset.read', 'core.media.api.x')).toThrow();
});

it('derives the core.media installation only once its declarations are part of the catalog, for any tenant', () => {
  const tenant = ['party.registry'];
  // A tenant bootstrapped before D20 saw this catalog: no core.media row was derived.
  expect(installedModuleKeysOf(tenant, releaseWithoutMedia)).toEqual(['core.identity', 'core.shell', 'party.registry']);
  // The same tenant, bootstrapped again against the catalog that carries core.media, gains exactly that module.
  expect(installedModuleKeysOf(tenant, releaseWithMedia)).toEqual([
    'core.identity',
    'core.media',
    'core.shell',
    'party.registry',
  ]);
  // The tenant's own module list never has to name it: it is derived, not tenant-installed.
  expect(tenant).not.toContain(CORE_MEDIA_MODULE_ID);
});

it.effect('cannot be activated as a business module through the module-state transition', () =>
  Effect.gen(function* cannotActivate() {
    const installed = makeInstalledCatalogFixture();
    const refused = yield* Effect.flip(validateTenantModuleStateTransition(installed, CORE_MEDIA_MODULE_ID, 'active'));
    expect(Predicate.isTagged(refused, 'TenantModuleStateUnknownModuleError')).toBe(true);
  }),
);
