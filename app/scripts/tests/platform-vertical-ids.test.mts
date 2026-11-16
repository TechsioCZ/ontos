import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  checkPlatformVerticalIds,
  discoverPlatformVerticals,
  platformVerticalIdViolations,
} from '../check-lean-core-dependencies.mts';

const verticals = [
  { appId: 'party-registry', moduleId: 'party.registry' },
  { appId: 'inventory', moduleId: 'inventory.stock' },
  { appId: 'catalog', moduleId: 'catalog.products' },
  { appId: 'crm', moduleId: 'demo.crm' },
  { appId: 'privacy', moduleId: 'privacy.core' },
  { appId: 'symmy-integration', moduleId: 'symmy.integration' },
  { appId: 'payment', moduleId: 'payment.core' },
];
const named = (file: string, source: string) =>
  platformVerticalIdViolations(file, source, verticals).map(({ line, reason }) => `${line} ${reason}`);
const coreFile = 'packages/core-runtime/src/access/example.ts';
const enrollmentRoot = 'apps/shell-super-app/api/database-identity-enrollment.ts';

it('allows the published identity-contract package at the Shell enrollment root', () => {
  expect(
    named(
      enrollmentRoot,
      "import { PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR } from '@app/party-registry-identity-contracts';",
    ),
  ).toEqual([]);
});

it('rejects vertical package imports, quoted app ids and module ids on their own lines', () => {
  expect(
    named(
      enrollmentRoot,
      [
        "import { PARTY_REGISTRY_DATABASE_IDENTITY_DESCRIPTOR } from '@app/party-registry/database-identities';",
        "const audience = 'party-registry';",
        "const moduleId = 'party.registry';",
      ].join('\n'),
    ),
  ).toEqual([
    '1 platform source names MicroVertical party-registry',
    '2 platform source names MicroVertical party-registry',
    '3 platform source names MicroVertical party.registry',
  ]);
});

it('tells Core-local catalog directories from the catalog vertical', () => {
  expect(named(coreFile, "import { CatalogSnapshot } from './catalog/index.ts';")).toEqual([]);
  expect(named(coreFile, "import { CatalogSnapshot } from '../catalog/queries.ts';")).toEqual([]);
  expect(named(coreFile, "import { catalog } from '@app/catalog';")).toEqual([
    '1 platform source names MicroVertical catalog',
  ]);
  expect(named(coreFile, "import { catalog } from '../../../../verticals/catalog/src/index.ts';")).toEqual([
    '1 platform source names MicroVertical catalog',
  ]);
});

it('rejects a domain workload literal inside a generic Core schema', () => {
  expect(
    named('packages/core-runtime/src/install/example.ts', "const workloads = new Set(['demo.crm.party-intake']);"),
  ).toEqual(['1 platform source names MicroVertical demo.crm']);
});

it("exempts main's integration layer, only the audiences mixed files name, and non-platform sources", () => {
  expect(named('apps/shell-super-app/api/symmy/ingress.ts', "const owner = 'symmy-integration';")).toEqual([]);
  expect(named('apps/shell-super-app/api/auth/gateway-issuer.ts', "const audience = 'privacy';")).toEqual([]);
  expect(named('apps/shell-super-app/api/auth/gateway-issuer.ts', "const audience = 'crm';")).toEqual([
    '1 platform source names MicroVertical crm',
  ]);
  for (const file of [
    'apps/shell-super-app/src/demo-guide/guides/crm.ts',
    'apps/shell-super-app/src/demo-seed/crm.ts',
    'packages/core-runtime/src/testing/crm-fixture.ts',
    'apps/shell-super-app/tests/unit/crm.test.ts',
    'verticals/crm/src/page.tsx',
  ]) {
    expect(named(file, "const owner = 'crm';")).toEqual([]);
  }
});

it('admits Payment only in the Payment gateway relay files that carry its contract and transport', () => {
  const relay = 'apps/shell-super-app/api/payment-gateway';
  expect(named(`${relay}/transport.ts`, "import { relay } from '@app/payment/payment-gateway-relay';")).toEqual([]);
  expect(named(`${relay}/owner-release-transport.ts`, "const paymentOwner = 'payment';")).toEqual([]);
  expect(named(`${relay}/transport.ts`, "const audience = 'crm';")).toEqual([
    '1 platform source names MicroVertical crm',
  ]);
  expect(named(`${relay}/transport.ts`, "const moduleId = 'payment.core';")).toEqual([
    '1 platform source names MicroVertical payment.core',
  ]);
  for (const file of ['defect-boundary.ts', 'relay-credentials.ts', 'new-relay-helper.ts']) {
    expect(named(`${relay}/${file}`, "const owner = 'payment';")).toEqual([
      '1 platform source names MicroVertical payment',
    ]);
  }
});

it.live('rejects another Payment gateway file that names a vertical in a workspace tree', () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(nodePath.join(os.tmpdir(), 'platform-vertical-ids-'))),
    (root) =>
      Effect.gen(function* rejectsUnlistedRelayFile() {
        yield* Effect.promise(async () => {
          await mkdir(nodePath.join(root, 'verticals/payment'), { recursive: true });
          await mkdir(nodePath.join(root, 'apps/shell-super-app/api/payment-gateway'), { recursive: true });
          await writeFile(
            nodePath.join(root, 'verticals/payment/package.json'),
            '{"modernjs":{"appId":"payment","ontosModule":{"moduleId":"payment.core"}}}',
          );
          await writeFile(
            nodePath.join(root, 'apps/shell-super-app/api/payment-gateway/transport.ts'),
            "export const owner = 'payment';\n",
          );
          await writeFile(
            nodePath.join(root, 'apps/shell-super-app/api/payment-gateway/defect-boundary.ts'),
            "export const owner = 'payment';\n",
          );
        });
        expect(yield* checkPlatformVerticalIds(root)).toEqual([
          {
            file: 'apps/shell-super-app/api/payment-gateway/defect-boundary.ts',
            line: 1,
            reason: 'platform source names MicroVertical payment',
          },
        ]);
      }),
    (root) => Effect.promise(() => rm(root, { force: true, recursive: true })),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('discovers the verticals of this workspace', () =>
  Effect.gen(function* discoversWorkspaceVerticals() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL('../..', import.meta.url));
    const discovered = yield* discoverPlatformVerticals(fileSystem, root, path);
    expect(discovered.length).toBeGreaterThan(5);
    expect(discovered).toContainEqual({ appId: 'payment', moduleId: 'payment.core' });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('finds no vertical id in the Core and Shell platform of this workspace', () =>
  Effect.gen(function* platformHasNoVerticalIds() {
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(new URL('../..', import.meta.url));
    expect(yield* checkPlatformVerticalIds(root)).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
