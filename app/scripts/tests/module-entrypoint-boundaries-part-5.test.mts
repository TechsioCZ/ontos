import { mkdir, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { Cause, Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  PRIVATE_COLOCATED_CALLABLE_CASE,
  PARTY_VERTICAL_PATH,
  WORKSPACE_MANIFEST_PATH,
  WORKSPACE_DEPENDENCY_VERSION,
  SHELL_PACKAGE_JSON_PATH,
  SHELL_PACKAGE_SPECIFIER,
  APP_PACKAGE_LINK_DIRECTORY,
  FOREIGN_PRIVATE_DIAGNOSTIC,
  VERTICALS_WORKSPACE_DECLARATION,
  INVENTORY_DEPLOYMENT_ID,
  INVENTORY_PACKAGE_SPECIFIER,
  INVENTORY_MODULE_ID,
  checkModuleEntrypointBoundaries,
  PARTY_API_CLIENT_SPECIFIER,
  INVENTORY_VERTICAL_PATH,
  write,
  makeFixture,
  INVENTORY_BACKEND_CONTRACT,
  INVENTORY_SCHEMA_CONSUMER,
  makeSelectedInventoryFixture,
  makeActualPartyClientFixture,
} from './module-entrypoint-boundary-fixtures.mts';

for (const [name, source, contamination, allowed] of [
  [
    'selected schema value only',
    "import { InventoryBackendConfigurationSchema } from '@app/inventory/backend-configuration';\n",
    '',
    true,
  ],
  [
    'selected schema and derived type',
    "import { InventoryBackendConfigurationSchema } from '@app/inventory/backend-configuration';\nimport type { InventoryBackendConfiguration } from '@app/inventory/backend-configuration';\n",
    '',
    true,
  ],
  [
    'private dispatch from same specifier',
    "import { dispatchReservationAuthority } from '@app/inventory/backend-configuration';\n",
    '',
    false,
  ],
  [
    'private dispatch with discarded native hash',
    "import { dispatchWithDiscardedHash } from '@app/inventory/backend-configuration';\n",
    `\nimport { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
export const dispatchWithDiscardedHash = (configuration: InventoryBackendConfiguration) => {
  sha256(utf8ToBytes('discarded'));
  return dispatchReservationAuthority(configuration);
};\n`,
    false,
  ],
  [
    'private dispatch with discarded native codec',
    "import { dispatchWithDiscardedCodec } from '@app/inventory/backend-configuration';\n",
    `\nexport const dispatchWithDiscardedCodec = (configuration: InventoryBackendConfiguration) => {
  Schema.decodeUnknownEffect(InventoryBackendConfigurationSchema)(configuration);
  return dispatchReservationAuthority(configuration);
};\n`,
    false,
  ],
  [
    'private function type from same specifier',
    "import type { PrivateDispatch } from '@app/inventory/backend-configuration';\n",
    '\nexport type PrivateDispatch = typeof dispatchReservationAuthority;\n',
    false,
  ],
  [
    'eager private initializer beside selected schema',
    "import { InventoryBackendConfigurationSchema } from '@app/inventory/backend-configuration';\n",
    '\nexport const eagerPrivate = dispatchReservationAuthority({} as never);\n',
    false,
  ],
] as const) {
  it.live(`checks Inventory backend contract ${name}`, () =>
    Effect.gen(function* selectedInventoryContract() {
      const root = yield* makeSelectedInventoryFixture();
      yield* write(root, INVENTORY_SCHEMA_CONSUMER, source);
      if (contamination !== '') {
        const original = yield* Effect.promise(() => readFile(path.join(root, INVENTORY_BACKEND_CONTRACT), 'utf-8'));
        yield* write(root, INVENTORY_BACKEND_CONTRACT, `${original}${contamination}`);
      }
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      expect(Exit.isSuccess(result), Exit.isFailure(result) ? Cause.pretty(result.cause) : name).toBe(allowed);
      if (!allowed && Exit.isFailure(result)) {
        expect(Cause.pretty(result.cause)).toContain(FOREIGN_PRIVATE_DIAGNOSTIC);
      }
    }),
  );
}

it.live('publishes actual source-selector schemas and proved wire codecs without unproved routines', () =>
  Effect.gen(function* actualDormantEffectSchemaContract() {
    const root = yield* makeFixture();
    const workspace = path.resolve(import.meta.dirname, '../..');
    const source = yield* Effect.promise(() =>
      readFile(path.join(workspace, 'verticals/symmy-integration/shared/domain/symmy-source-selector.ts'), 'utf-8'),
    );
    const target = `${INVENTORY_VERTICAL_PATH}/shared/domain/source-selector.ts`;
    const specifier = `${INVENTORY_PACKAGE_SPECIFIER}/source-selector`;
    yield* write(root, WORKSPACE_MANIFEST_PATH, VERTICALS_WORKSPACE_DECLARATION);
    yield* write(
      root,
      `${INVENTORY_VERTICAL_PATH}/package.json`,
      JSON.stringify({
        exports: { './source-selector': './shared/domain/source-selector.ts' },
        modernjs: { appId: INVENTORY_DEPLOYMENT_ID, ontosModule: { moduleId: INVENTORY_MODULE_ID } },
        name: INVENTORY_PACKAGE_SPECIFIER,
      }),
    );
    yield* write(
      root,
      SHELL_PACKAGE_JSON_PATH,
      JSON.stringify({
        dependencies: { [INVENTORY_PACKAGE_SPECIFIER]: WORKSPACE_DEPENDENCY_VERSION },
        name: SHELL_PACKAGE_SPECIFIER,
      }),
    );
    yield* Effect.promise(() => mkdir(path.join(root, APP_PACKAGE_LINK_DIRECTORY), { recursive: true }));
    yield* Effect.promise(() =>
      symlink(
        path.join(root, INVENTORY_VERTICAL_PATH),
        path.join(root, APP_PACKAGE_LINK_DIRECTORY, INVENTORY_DEPLOYMENT_ID),
        'dir',
      ),
    );
    for (const [name, value, binding, allowed] of [
      ['native dormant callable', source, 'SymmyEncodedSourceCodeSchema, SymmySelectedSourceCodeSchema', true],
      [
        'erased codec error and result types',
        source,
        'type SymmySourceSelectorError, type SymmyDecodedSourceSelector',
        true,
      ],
      ['unapproved runtime class', source, 'SymmySourceSelectorError', false],

      ['published wire encoder', source, 'encodeSymmySourceSelector', true],
      ['published wire decoder', source, 'decodeSymmySourceSelector', true],
      ['published wire verifier', source, 'verifySymmySourceSelector', true],
      [
        'published wire codecs',
        source,
        'encodeSymmySourceSelector, decodeSymmySourceSelector, verifySymmySourceSelector',
        true,
      ],
      [
        'unproved business callable',
        `${source}\nexport const dispatchPrivateBusinessOperation = () => globalThis;`,
        'dispatchPrivateBusinessOperation',
        false,
      ],
      [
        'contextual ambient initializer',
        `${source}\nconst capturedAmbient = process.env.VALUE;`,
        'encodeSymmySourceSelector',
        false,
      ],
      [
        'contextual eager schema field getter',
        `${source}\nconst UnusedSchema = Schema.Struct({ get field() { return fetch('remote'); } });`,
        'encodeSymmySourceSelector',
        false,
      ],
      [
        'contextual native hash mutation',
        `${source}\nconst capturedHash = sha256; export const mutateHash = () => { capturedHash.create = foreignHash; };`,
        'encodeSymmySourceSelector',
        false,
      ],
      ['executed callable', `${source}\ndecodeSymmySourceSelector('code');`, 'SymmySelectedSourceCodeSchema', false],
      [
        'dynamic trace',
        source.replace("Effect.fn('SymmySourceSelector.decode')", 'Effect.fn(deriveTrace())'),
        'SymmySelectedSourceCodeSchema',
        false,
      ],
      [
        'foreign factory',
        `import { Effect as ForeignEffect } from './foreign-effect.ts';\n${source.replace("Effect.fn('SymmySourceSelector.decode')", "ForeignEffect.fn('SymmySourceSelector.decode')")}`,
        'SymmySelectedSourceCodeSchema',
        false,
      ],
      ['mutated native factory', `${source}\nEffect.fn = replacement;`, 'SymmySelectedSourceCodeSchema', false],
    ] as const) {
      yield* write(root, target, value);
      yield* write(
        root,
        'apps/shell-super-app/src/source-selector-consumer.ts',
        `import { ${binding} } from '${specifier}';\n`,
      );
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      expect(Exit.isSuccess(result), Exit.isFailure(result) ? `${name}: ${Cause.pretty(result.cause)}` : name).toBe(
        allowed,
      );
    }
  }),
);

for (const [name, source, allowed] of [
  [
    'public selected operation and schemas',
    `import { PartyDetailResponseSchema, executePartyDetailWithAuthorization } from '${PARTY_API_CLIENT_SPECIFIER}';\nimport type { PartyDetailResponse } from '${PARTY_API_CLIENT_SPECIFIER}';\n`,
    true,
  ],
  [
    'enrollment exact operations and erased types',
    `import { createPartyWithAuthorization, executePartyMatchWithAuthorization, recoverPartyCreateWithAuthorization } from '${PARTY_API_CLIENT_SPECIFIER}';\nimport type { createParty, executePartyMatch, recoverPartyCreate } from '${PARTY_API_CLIENT_SPECIFIER}';\n`,
    true,
  ],
  [
    PRIVATE_COLOCATED_CALLABLE_CASE,
    `import { privatePartyClientCallable } from '${PARTY_API_CLIENT_SPECIFIER}';\n`,
    false,
  ],
] as const) {
  it.live(`checks actual Party typed client ${name}`, () =>
    Effect.gen(function* actualPartyTypedClientPublication() {
      const root = yield* makeActualPartyClientFixture();
      const clientFile = `${PARTY_VERTICAL_PATH}/src/api/party-registry-client.ts`;
      const aggregate = yield* Effect.promise(() => readFile(path.join(root, clientFile), 'utf-8'));
      yield* write(root, clientFile, `${aggregate}\nexport const privatePartyClientCallable = () => 'private';\n`);
      const consumer = 'apps/shell-super-app/src/party-client-consumer.ts';
      yield* write(root, consumer, source);
      const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
      const diagnostic = Exit.isFailure(result) ? Cause.pretty(result.cause) : name;
      if (Exit.isFailure(result)) {
        expect(diagnostic).toContain(consumer);
        expect(diagnostic).toContain(clientFile);
      }
      expect(Exit.isSuccess(result), diagnostic).toBe(allowed);
    }),
  );
}

// A fixture holds every library file what it holds names, so it is no weaker than the full libraries: the Party handler
// root importing a name the shared contracts do not export fails against the fixture as it fails against the tree.
it.live('fails against the actual Party fixture a handler import of a name its library does not export', () =>
  Effect.gen(function* actualPartyLibraryClosure() {
    const root = yield* makeActualPartyClientFixture();
    const result = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
    expect(Exit.isSuccess(result), Exit.isFailure(result) ? Cause.pretty(result.cause) : '').toBe(true);
    const handlerFile = `${PARTY_VERTICAL_PATH}/api/index.ts`;
    const handler = yield* Effect.promise(() => readFile(path.join(root, handlerFile), 'utf-8'));
    const imported = 'import { RequestSchemaProblemLive }';
    expect(handler).toContain(imported);
    yield* write(
      root,
      handlerFile,
      handler.replace(imported, 'import { MissingProblemLive as RequestSchemaProblemLive }'),
    );
    const missing = yield* Effect.exit(checkModuleEntrypointBoundaries(root));
    expect(Exit.isFailure(missing) ? Cause.pretty(missing.cause) : '').toContain(
      `${handlerFile}: RequestSchemaProblemLive is no read, Action or own API of this module`,
    );
  }),
);
