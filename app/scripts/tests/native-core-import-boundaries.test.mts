import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Cause, ConfigProvider, Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';

import { checkModuleEntrypointBoundaries } from '../check-module-entrypoint-boundaries.mts';

const CONSUMER = 'verticals/party-registry/src/database-grants.ts';
const CORE_PACKAGE = '@app/core-runtime';
const OWNER_PACKAGE = '@contracts/renamed-tax';
const PRIVATE_OWNER_SOURCE = 'verticals/tax/src/handlers/private.ts';
const WORKSPACE_VERSION = 'workspace:*';
const SUPPORT_PACKAGE = '@app/runtime-support';

interface FixtureDependencies {
  [CORE_PACKAGE]: string;
  [OWNER_PACKAGE]?: string;
  [SUPPORT_PACKAGE]: string;
}

const write = (root: string, file: string, source: string) =>
  Effect.promise(async () => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), source);
  });

// Only the four mounted gateway sources are needed beyond the import fixtures.
// Keeping those valid lets positive cases finish the actual checker, not merely
// reach a later expected failure.
const gatewaySources = {
  'apps/shell-super-app/api/index.ts': `
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { Effect } from 'effect';
import { ShellAuthenticationApi } from '../shared/api.ts';
export const gatewayContextGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'gatewayContext', (handlers) => handlers
  .handle('issueGatewayContext', () => Effect.void)
  .handle('issueApiKeyGatewayContext', () => Effect.void)
  .handle('readWithApiKeyGatewayContext', () => Effect.void)
  .handle('issueDelegatedGatewayContext', () => Effect.void));
export const documentGatewayGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'documentGateway', (handlers) => handlers
  .handle('issueDocumentGatewayContexts', () => Effect.void));
export const documentContextGroupLive = HttpApiBuilder.group(ShellAuthenticationApi, 'documentContext', (handlers) => handlers
  .handle('documentContext', () => Effect.void));
export const makeShellAuthenticationApiRuntime = () => {
  const apiHandlersLive = Layer.mergeAll(gatewayContextGroupLive, documentGatewayGroupLive, documentContextGroupLive);
  return assembleEffectBffRuntime({ api: ShellAuthenticationApi, handlers: apiHandlersLive });
};
const apiRuntime = makeShellAuthenticationApiRuntime();
export default apiRuntime;
`,
  'apps/shell-super-app/shared/api.ts': `
import { GatewayContextApiGroup } from '@app/shared-contracts';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
import { DocumentGatewayApiGroup } from './document-gateway-api.ts';
export const ShellDocumentContextApiGroup = HttpApiGroup.make('documentContext')
  .add(HttpApiEndpoint.post('documentContext', '/shell/document-context', {}));
export const ShellAuthenticationApi = HttpApi.make('shell')
  .add(GatewayContextApiGroup)
  .add(DocumentGatewayApiGroup)
  .add(ShellDocumentContextApiGroup);
`,
  'apps/shell-super-app/shared/document-gateway-api.ts': `
import { HttpApiEndpoint, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
export const DocumentGatewayApiGroup = HttpApiGroup.make('documentGateway')
  .add(HttpApiEndpoint.post('issueDocumentGatewayContexts', '/auth/gateway-contexts', {}));
`,
  'packages/shared-contracts/src/gateway-context.ts': `
import { HttpApiEndpoint, HttpApiGroup } from '@modern-js/bff-effect/effect-client';
export const GatewayContextApiGroup = HttpApiGroup.make('gatewayContext')
  .add(HttpApiEndpoint.post('issueGatewayContext', '/auth/gateway-context', {}))
  .add(HttpApiEndpoint.post('issueApiKeyGatewayContext', '/auth/api-key/gateway-context', {}))
  .add(HttpApiEndpoint.post('readWithApiKeyGatewayContext', '/auth/api-key/gateway-read', {}))
  .add(HttpApiEndpoint.post('issueDelegatedGatewayContext', '/auth/delegated/gateway-context', {}));
`,
};

const fixture = Effect.fn(function* nativeCoreImportFixture(source: string, declaredOwner: boolean) {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-native-core-imports-'))),
    (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
  );
  const dependencies: FixtureDependencies = {
    [CORE_PACKAGE]: WORKSPACE_VERSION,
    [SUPPORT_PACKAGE]: WORKSPACE_VERSION,
  };
  if (declaredOwner) {
    dependencies[OWNER_PACKAGE] = WORKSPACE_VERSION;
  }
  const sources = {
    ...gatewaySources,
    [CONSUMER]: source,
    'packages/core-runtime/package.json': JSON.stringify({
      exports: { './db/database-identity-manifest': './src/db/database-identity-manifest.ts' },
      name: CORE_PACKAGE,
    }),
    'packages/core-runtime/src/db/database-identity-manifest.ts':
      'export interface DatabaseRoleGrants { readonly routines: readonly string[] }\n',
    'packages/core-runtime/src/db/unpublished.ts': 'export const secret = true;\n',
    'packages/runtime-support/package.json': JSON.stringify({
      exports: { './db/contract': './src/db/contract.ts' },
      name: SUPPORT_PACKAGE,
    }),
    'packages/runtime-support/src/db/contract.ts': 'export interface Contract { readonly id: string }\n',
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n  - verticals/*\n',
    [PRIVATE_OWNER_SOURCE]: 'export const executePrivate = () => true;\n',
    'topology/reference-topology.json': JSON.stringify({
      shell: { id: 'shell-super-app', path: 'apps/shell-super-app' },
      verticals: [
        { id: 'party-registry', path: 'verticals/party-registry' },
        { id: 'tax', path: 'verticals/tax' },
      ],
    }),
    'verticals/party-registry/package.json': JSON.stringify({
      dependencies,
      name: '@app/party-registry',
    }),
    'verticals/party-registry/tsconfig.json': JSON.stringify({ references: [{ path: '../tax' }] }),
    'verticals/tax/package.json': JSON.stringify({
      exports: { './arbitrary': './shared/arbitrary.ts', './contracts': './shared/contracts.ts' },
      modernjs: { apiRuntime: 'effect', appId: 'tax', ontosModule: { moduleId: 'tax' } },
      name: OWNER_PACKAGE,
    }),
    'verticals/tax/shared/arbitrary.ts': 'let calls = 0;\nexport const arbitrary = () => ++calls;\n',
    'verticals/tax/shared/contracts.ts': "export { executePrivate } from '../src/handlers/private.ts';\n",
  };
  for (const [file, contents] of Object.entries(sources)) {
    yield* write(root, file, contents);
  }
  for (const [name, directory] of [
    [CORE_PACKAGE, 'packages/core-runtime'],
    [SUPPORT_PACKAGE, 'packages/runtime-support'],
    [OWNER_PACKAGE, 'verticals/tax'],
  ] as const) {
    yield* Effect.promise(async () => {
      const link = path.join(root, 'node_modules', name);
      await mkdir(path.dirname(link), { recursive: true });
      await symlink(path.join(root, directory), link, 'dir');
    });
  }
  return root;
});

const check = (root: string) =>
  checkModuleEntrypointBoundaries(root).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ULTRAMODERN_SOURCE_REVISION: 'working-tree' }))),
  );

for (const [name, source] of [
  [
    'the published Core identity-manifest subpath',
    "import type { DatabaseRoleGrants as Grants } from '@app/core-runtime/db/database-identity-manifest';\nexport type OwnerGrants = Grants;\n",
  ],
  [
    'a published non-owner workspace subpath without a Core-name exemption',
    "export type { Contract as DatabaseContract } from '@app/runtime-support/db/contract';\n",
  ],
] as const) {
  it.live(`accepts ${name}`, () =>
    Effect.gen(function* acceptsPublishedLibrary() {
      const root = yield* fixture(source, true);
      yield* check(root);
    }),
  );
}

for (const [name, source, declaredOwner] of [
  [
    'an unpublished Core subpath even when its file exists',
    "import { secret } from '@app/core-runtime/db/unpublished';\n",
    true,
  ],
  [
    'an unknown private package instead of assuming it is a library',
    "import value from '@app/billing/src/handlers/private.ts';\n",
    true,
  ],
  [
    'a direct sibling owner implementation with a local binding alias',
    "import { executePrivate as run } from '../../tax/src/handlers/private.ts';\n",
    true,
  ],
  ['a relative foreign reexport', "export { executePrivate as run } from '../../tax/shared/contracts.ts';\n", true],
  [
    'a renamed owner package barrel with a local binding alias',
    "import { executePrivate as run } from '@contracts/renamed-tax/contracts';\n",
    true,
  ],
  [
    'an arbitrary published owner export',
    "import { arbitrary as run } from '@contracts/renamed-tax/arbitrary';\n",
    true,
  ],
  [
    'an undeclared owner export through a renamed package',
    "export { arbitrary as run } from '@contracts/renamed-tax/arbitrary';\n",
    false,
  ],
] as const) {
  it.live(`rejects ${name}`, () =>
    Effect.gen(function* rejectsPrivateOrUnprovenSource() {
      const root = yield* fixture(source, declaredOwner);
      const result = yield* Effect.exit(check(root));
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const failure = Cause.pretty(result.cause);
        expect(failure).toContain(CONSUMER);
        expect(failure).toMatch(/foreign private|cross-vertical private/u);
      }
    }),
  );
}
