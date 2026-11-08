import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const appRoot = path.resolve(import.meta.dirname, '../../..');
const partyRegistry = 'party-registry';
const owners = [
  partyRegistry,
  'storefront-registry',
  'catalog',
  'assortment',
  'payment-term-catalog',
  'price-group-catalog',
  'pricing',
] as const;

it.effect('feeds actual owner enrollment into access enforcement and downstream Read runtime dependencies', () =>
  Effect.gen(function* enrollmentComposition() {
    for (const owner of owners) {
      const source = yield* Effect.promise(() =>
        readFile(path.join(appRoot, 'verticals', owner, 'api/index.ts'), 'utf-8'),
      );
      const enrollment =
        owner === partyRegistry ? 'partyRegistryDatabaseIdentityEnrollmentLive' : 'databaseIdentitiesLive';
      const enforcement = source.slice(source.indexOf('const accessEnforcementLive ='));
      const enforcementDefinition = enforcement.slice(0, enforcement.indexOf('\n);'));
      expect(enforcementDefinition, owner).toContain(`Layer.provide(${enrollment})`);
      if (owner === partyRegistry) {
        expect(source).toContain('PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT');
        expect(source).toContain('makeDatabaseConfigLive(PARTY_REGISTRY_REQUEST_IDENTITY)');
      } else {
        expect(source).toContain('makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]))');
        const readBindings = new Map([
          ['catalog', 'catalogReadRuntime'],
          ['price-group-catalog', 'priceGroupCatalogReadRuntimeLive'],
          ['pricing', 'readRuntimeLive'],
        ]);
        const binding = readBindings.get(owner) ?? 'productionReadRuntimeLive';
        const read = source.slice(source.indexOf(`const ${binding} =`));
        expect(read.slice(0, read.indexOf('\n);')), owner).toContain(`Layer.provide(${enrollment})`);
      }
    }
  }),
);

it('imports the backend-only composition roots through native Node without opening runtime layers', () => {
  // Catalog's existing full manifest imports catalog-widget.tsx. Its backend declaration split belongs to its owner.
  const imports = owners
    .filter((owner) => owner !== 'catalog')
    .map((owner) => `await import('./verticals/${owner}/api/index.ts');`)
    .join('\n');
  const imported = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `${imports}\nconsole.log('owner-roots-imported');`],
    { cwd: appRoot, encoding: 'utf-8', timeout: 30_000 },
  );
  expect(imported.status, imported.stderr).toBe(0);
  expect(imported.stdout).toContain('owner-roots-imported');
});
