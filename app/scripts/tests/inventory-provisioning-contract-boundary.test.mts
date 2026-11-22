import { mkdir, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { Cause, Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

import {
  checkModuleEntrypointBoundaries,
  makeActualCatalogSelectionFixture,
  write,
} from './module-entrypoint-boundary-fixtures.mts';

const selectedCodecImport = (source: string) => {
  const selected = parseSync('codec-import.ts', source).program.body.find(
    (statement) =>
      statement.type === 'ImportDeclaration' &&
      statement.importKind !== 'type' &&
      statement.source.value === '@app/inventory/source-provisioning' &&
      statement.specifiers.some(
        (specifier) =>
          specifier.type === 'ImportSpecifier' &&
          specifier.importKind !== 'type' &&
          specifier.imported.type === 'Identifier' &&
          specifier.imported.name === 'ProvisionSourceStockItemPayloadSchema',
      ),
  );
  return selected === undefined ? undefined : source.slice(selected.start, selected.end);
};

for (const declaration of [
  "import { ProvisionSourceStockItemPayloadSchema } from '@app/inventory/source-provisioning';",
  "import {\n  ProvisionSourceStockItemPayloadSchema,\n} from '@app/inventory/source-provisioning';",
  "import { ProvisionSourceStockItemPayloadSchema as Payload } from '@app/inventory/source-provisioning';",
]) {
  it(`selects the public codec import independently of layout and local name: ${declaration}`, () => {
    expect(selectedCodecImport(declaration)).toBe(declaration);
  });
}

it('does not select an identically named codec from a private module', () => {
  expect(
    selectedCodecImport("import { ProvisionSourceStockItemPayloadSchema } from '@app/inventory/src/private-codec';"),
  ).toBeUndefined();
});

it.live('publishes the real Inventory request codec selected by Symmy across the owner boundary', () =>
  Effect.gen(function* publicProvisioningContract() {
    const root = yield* makeActualCatalogSelectionFixture(
      'verticals/inventory/shared/apis/provision-source-stock-item-action.ts',
    );
    const workspace = path.resolve(import.meta.dirname, '../..');
    yield* write(
      root,
      'topology/reference-topology.json',
      JSON.stringify({
        shell: { id: 'shell-super-app', path: 'apps/shell-super-app' },
        verticals: [
          { id: 'inventory-stock', path: 'verticals/inventory-stock' },
          { id: 'catalog', path: 'verticals/catalog' },
          { id: 'inventory', path: 'verticals/inventory' },
        ],
      }),
    );
    for (const file of ['verticals/inventory/package.json', 'verticals/inventory/vertical.manifest.ts']) {
      const source = yield* Effect.promise(() => readFile(path.join(workspace, file), 'utf-8'));
      yield* write(
        root,
        file,
        file.endsWith('manifest.ts') ? `${source.split('\n').slice(0, 3).join('\n')}\n` : source,
      );
    }
    yield* write(
      root,
      'apps/shell-super-app/package.json',
      JSON.stringify({
        dependencies: { '@app/inventory': 'workspace:*' },
        name: '@app/shell-super-app',
      }),
    );
    yield* Effect.promise(() => mkdir(path.join(root, 'node_modules/@app'), { recursive: true }));
    yield* Effect.promise(() =>
      symlink(path.join(root, 'verticals/inventory'), path.join(root, 'node_modules/@app/inventory'), 'dir'),
    );
    const consumer = 'apps/shell-super-app/src/api/inventory-provisioning.ts';
    const intents = yield* Effect.promise(() =>
      readFile(
        path.join(workspace, 'verticals/symmy-integration/shared/domain/symmy-catalog-pricing-inventory-intents.ts'),
        'utf-8',
      ),
    );
    const selectedImport = selectedCodecImport(intents);
    expect(selectedImport).toBeDefined();
    yield* write(root, consumer, selectedImport ?? '');
    const accepted = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
    expect(Exit.isSuccess(accepted), Exit.isFailure(accepted) ? Cause.pretty(accepted.cause) : '').toBe(true);
    const contract = 'verticals/inventory/shared/domain/source-provisioning.ts';
    const source = yield* Effect.promise(() => readFile(path.join(workspace, contract), 'utf-8'));
    const payloadStart = source.indexOf('export const ProvisionSourceStockItemPayloadSchema =');
    const payloadEnd = source.indexOf('export type ProvisionSourceStockItemPayload', payloadStart);
    expect(payloadStart).toBeGreaterThan(0);
    expect(payloadEnd).toBeGreaterThan(payloadStart);
    const invalidPayload = `${source.slice(0, payloadStart)}
export const ProvisionSourceStockItemPayloadSchema = ProvisionSourceStockItemInputSchema.mapFields(
  (fields) => ({
    ...fields,
    expectedPolicy: fields.expectedPolicy.pipe(Schema.decode({ decode: canonicalTerms, encode: canonicalTerms })),
  }),
  { unsafePreserveChecks: true },
);
${source.slice(payloadEnd)}`;
    const policyStart = source.indexOf('export const SourceProvisioningExpectedPolicySchema =');
    const policyEnd = source.indexOf('export type SourceProvisioningExpectedPolicy', policyStart);
    expect(policyStart).toBeGreaterThan(0);
    expect(policyEnd).toBeGreaterThan(policyStart);
    const invalidInitialization = `${source.slice(0, policyStart)}
export const SourceProvisioningExpectedPolicySchema = Schema.Struct(
  Struct.pick(SourceProvisioningPolicySchema.fields, [
    'customerConfigurationId', 'externalScope', 'issuer', 'namespace', 'unitRef', 'locations',
  ]),
);
${source.slice(policyEnd)}`;
    for (const invalid of [invalidPayload, invalidInitialization]) {
      yield* write(root, contract, invalid);
      const rejected = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      expect(Exit.isFailure(rejected)).toBe(true);
      if (Exit.isFailure(rejected)) {
        expect(Cause.pretty(rejected.cause)).toContain(`foreign private implementation ${contract}`);
      }
    }
  }),
);
