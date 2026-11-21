import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import type { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  checkLeanCoreDependencies,
  checkModuleEdgeFreeze,
  filesOnDisk,
  moduleEdgeBaselineRelative,
  trackedFiles,
} from '../check-lean-core-dependencies.mts';

const commercePrivateFixturePath = 'verticals/commerce-customer-context/src/api/private.ts';

const commercePrivateFixtureExport = './src/api/private.ts';

const commerceFixtureManifest = 'verticals/commerce-customer-context/package.json';

for (const [importer, suffixes] of [
  [
    'verticals/symmy-integration/src/services/symmy-party-commerce-adapters.ts',
    [
      'client',
      'customer-group-definition-source/client',
      'customer-group-membership-source-receipt/client',
      'customer-profile-ico/client',
      'organization-customer-profile-ico/client',
      'change-organization-customer-profile-ico-action/client',
      'migrate-organization-customer-profile-ico-action/client',
      'customer-profile-source/client',
      'customer-price-group-assignment-receipt/client',
      'add-saved-address-action/client',
      'update-saved-address-action/client',
      'remove-saved-address-action/client',
      'saved-address-source-receipt/client',
    ],
  ],
  [
    'apps/shell-super-app/api/symmy/source-read-projections.ts',
    [
      'customer-profile-ico/client',
      'customer-profile-source-page/client',
      'customer-profile-source-parties/client',
      'organization-customer-profile-ico/client',
    ],
  ],
  [
    'verticals/privacy/src/services/organization-profile-ico-applicability.service.ts',
    ['customer-profile-organization-ico-facts', 'customer-profile-organization-ico-facts/client'],
  ],
  [
    'verticals/privacy/src/services/organization-business-applicability.service.ts',
    ['customer-profile-organization-ico-facts', 'customer-profile-organization-ico-facts/client'],
  ],
] as const) {
  it.live(`admits exact C14 Commerce clients at ${importer} and refuses adjacent and private imports`, () =>
    Effect.gen(function* symmyCommerceClientPairs() {
      const root = yield* Effect.acquireRelease(
        Effect.tryPromise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-lean-core-symmy-'))),
        (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
      );
      const manifest = path.join(root, commerceFixtureManifest);
      yield* Effect.tryPromise(() => mkdir(path.dirname(manifest), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(
          manifest,
          JSON.stringify({
            exports: {
              ...Object.fromEntries(
                suffixes.map((suffix, index) => [`./api/${suffix}`, `./src/api/client-${index}.ts`]),
              ),
              './api/client-private': commercePrivateFixtureExport,
            },
          }),
        ),
      );
      const file = path.join(root, importer);
      yield* Effect.tryPromise(() => mkdir(path.dirname(file), { recursive: true }));
      yield* Effect.tryPromise(() =>
        writeFile(
          file,
          suffixes
            .map(
              (suffix, index) =>
                `import { execute as execute${index} } from '@app/commerce-customer-context/api/${suffix}';\n`,
            )
            .join(''),
        ),
      );
      expect(yield* checkLeanCoreDependencies(root, filesOnDisk).pipe(Effect.provide(NodeServices.layer))).toEqual([]);
      for (const [index, suffix] of suffixes.entries()) {
        yield* Effect.tryPromise(() =>
          writeFile(
            path.join(root, importer.replace(/\.ts$/u, `.adjacent-${index}.ts`)),
            `import { execute } from '@app/commerce-customer-context/api/${suffix}';\n`,
          ),
        );
      }
      const privatePath = path.relative(path.dirname(importer), commercePrivateFixturePath);
      yield* Effect.tryPromise(() =>
        writeFile(
          file,
          `import { privateClient } from '@app/commerce-customer-context/api/client-private';\nimport { privateOwner } from '${privatePath}';\n`,
        ),
      );
      const violations = yield* checkLeanCoreDependencies(root, filesOnDisk).pipe(Effect.provide(NodeServices.layer));
      expect(violations).toHaveLength(suffixes.length + 2);
      expect(violations.filter((violation) => violation.file === importer).map(({ line }) => line)).toEqual([1, 2]);
      for (const index of suffixes.keys()) {
        expect(
          violations.filter((violation) => violation.file === importer.replace(/\.ts$/u, `.adjacent-${index}.ts`)),
        ).toHaveLength(1);
      }
    }),
  );
}

const customerPriceGroupClientImport =
  "import { execute } from '@app/commerce-customer-context/api/customer-price-group-resolution/client';\n";

it.live(
  'flags Core Commerce/Storefront/Better-Auth vocabulary and non-Commerce mandatory imports of Commerce private implementation, while allowing documented seams',
  () =>
    Effect.gen(function* testEffect1() {
      const root = yield* Effect.acquireRelease(
        Effect.tryPromise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-lean-core-'))),
        (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
      );
      const files = {
        // Shell: allowed documented composition seams.
        'apps/shell-super-app/api/auth/commerce-external-identity.ts':
          "import { verify } from '@app/commerce-customer-context/portal-auth/verification/client';\n",
        // Shell: violates via the bare Commerce package specifier (no subpath), resolved against the
        // exports map's "." entry, which points at Commerce's private src.
        'apps/shell-super-app/api/auth/external-identity/bare-specifier-import.ts':
          "import CommercePrivate from '@app/commerce-customer-context';\n",
        // Shell: violates via a multi-line named import — a line-oriented regex would miss the
        // specifier because the `from` clause is on a different line than `import`.
        'apps/shell-super-app/api/auth/external-identity/multiline-import.ts':
          "import {\n  EnrollmentJourney,\n} from '../../../../verticals/commerce-customer-context/src/enrollment/journeys/index.ts';\n",
        // Shell: violates via a side-effect import (no bindings, no `from` keyword to match on).
        'apps/shell-super-app/api/auth/external-identity/side-effect-import.ts':
          "import '../../../../verticals/commerce-customer-context/src/enrollment/side-effects.ts';\n",
        // Shell: type-only imports of Commerce private implementation are exempt.
        'apps/shell-super-app/api/auth/external-identity/type-only.ts':
          "import type { EnrollmentJourney } from '../../../../verticals/commerce-customer-context/src/enrollment/journeys/index.ts';\n",
        // Shell: violates via a package specifier that resolves to Commerce private src (not a documented seam).
        'apps/shell-super-app/api/auth/external-identity/unauthorized-package-import.ts':
          "import { verify } from '@app/commerce-customer-context/portal-auth/verification/client';\nimport { EnrollmentJourney } from '@app/commerce-customer-context/api/client';\n",
        // Shell: violates by importing Commerce private src directly.
        'apps/shell-super-app/api/auth/external-identity/unauthorized-private-import.ts':
          "import { EnrollmentJourney } from '../../../../verticals/commerce-customer-context/src/enrollment/journeys/index.ts';\n",
        // Shell: allowed published shared contract, not a listed seam but not private implementation either.
        'apps/shell-super-app/src/api/uses-shared-contract.ts':
          "import { Contract } from '@app/commerce-customer-context/shared/contracts';\n",
        'apps/shell-super-app/src/api/vertical-clients.ts':
          "import { Client } from '@app/commerce-customer-context/api/client';\n",
        // Shell: test files under the ownership roots are exempt.
        'apps/shell-super-app/tests/unit/commerce-private-import.test.ts':
          "import { EnrollmentJourney } from '../../../../verticals/commerce-customer-context/src/enrollment/journeys/index.ts';\n",
        // Generated Cloudflare declarations are build output, not source dependencies.
        'apps/shell-super-app/dist-cloudflare/api/auth/commerce-external-identity.d.ts':
          "import { verify } from '@app/commerce-customer-context/portal-auth/verification/client';\n",
        // Core: allowed external specifiers pass.
        'packages/core-runtime/package.json': JSON.stringify({
          dependencies: { effect: '^4.0.0', pg: '^8.0.0' },
          imports: {
            '#escaping': { default: '../shared/escape.ts', workerd: './src/escape.workerd.ts' },
            '#runtime-transport': { default: './src/transport.node.ts', workerd: './src/transport.workerd.ts' },
          },
        }),
        'packages/core-runtime/src/auth/allowed-platform-subpath.ts':
          "import { SqlError } from 'effect/sql/SqlError';\n",
        'packages/core-runtime/src/auth/allowed.ts': "import { Effect } from 'effect';\nimport { Pool } from 'pg';\n",
        // Core: a package import mapped inside Core source and the workerd platform module pass.
        'packages/core-runtime/src/auth/allowed-package-import.ts':
          "import { transport } from '#runtime-transport';\nimport { env } from 'cloudflare:workers';\n",
        // Core: violates by importing Commerce vocabulary directly.
        'packages/core-runtime/src/auth/commerce-leak.ts':
          "import { CommercePortalAuth } from '@app/commerce-customer-context';\n",
        // Core: violates through a package import whose mapping escapes Core source.
        'packages/core-runtime/src/auth/escaping-package-import.ts': "import { escape } from '#escaping';\n",
        'packages/core-runtime/src/auth/relative.ts': "import { helper } from './allowed.ts';\n",
        // Core: violates by importing Commerce private implementation via a relative specifier that
        // resolves outside packages/core-runtime/src (regression for a gate that only checked bare specifiers).
        'packages/core-runtime/src/auth/relative-commerce-leak.ts':
          "import { CommercePortalAuth } from '../../../../verticals/commerce-customer-context/src/enrollment/journeys/index.ts';\n",
        // Core: violates by importing an unpinned external package.
        'packages/core-runtime/src/auth/unpinned.ts': "import { z } from 'zod';\n",
        // Core: tests directory is exempt.
        'packages/core-runtime/tests/unit/commerce-leak.test.ts':
          "import { CommercePortalAuth } from '@app/commerce-customer-context';\n",
        // Commerce publishes its exports map.
        [commerceFixtureManifest]: JSON.stringify({
          exports: {
            '.': './src/index.ts',
            './api/client': './src/api/client.ts',
            './api/customer-price-group-resolution/client': './src/api/customer-price-group-resolution-client.ts',
            './api/market-subject-restrictions-current/client':
              './src/api/market-subject-restrictions-current-client.ts',
            './api/pricing-purchase-context-verification/client':
              './src/api/pricing-purchase-context-verification-client.ts',
            './portal-auth/verification/client': './src/portal-auth/verification/client.ts',
            './shared/contracts': './shared/contracts.ts',
          },
        }),
        // party-registry: violates via direct api/ import.
        'verticals/party-registry/api/uses-commerce-api.ts':
          "import { OwnerTransition } from '../../commerce-customer-context/api/owner-transition.ts';\n",
        // The narrow subject-restrictions owner client has no documented composition seam.
        'verticals/party-registry/api/uses-subject-restrictions-client.ts':
          "import { execute } from '@app/commerce-customer-context/api/market-subject-restrictions-current/client';\n",
        // Pricing: only these four exact importer/client pairs are documented composition seams.
        'verticals/pricing/src/integrations/commerce-price-group-resolution.ts': customerPriceGroupClientImport,
        'verticals/pricing/src/integrations/current-pricing-decision-external-owner-evidence-live.ts': `${customerPriceGroupClientImport}import { verify } from '@app/commerce-customer-context/api/pricing-purchase-context-verification/client';\n`,
        'verticals/pricing/src/integrations/current-pricing-decision-owner-final-fence.ts':
          customerPriceGroupClientImport,
        'verticals/pricing/src/integrations/customer-context-subject-authority.ts':
          "import { verify } from '@app/commerce-customer-context/api/pricing-purchase-context-verification/client';\n",
        // An adjacent Pricing importer is not admitted merely because it uses the same narrow client.
        'verticals/pricing/src/integrations/unauthorized-price-group-resolution.ts': customerPriceGroupClientImport,
      } as const;
      yield* Effect.all(
        Object.entries(files).map(([relative, source]) =>
          Effect.gen(function* testEffect2() {
            const file = path.join(root, relative);
            yield* Effect.tryPromise(() => mkdir(path.dirname(file), { recursive: true }));
            yield* Effect.tryPromise(() => writeFile(file, source));
          }),
        ),
      );
      const violations = yield* checkLeanCoreDependencies(root, filesOnDisk).pipe(Effect.provide(NodeServices.layer));
      expect(violations.map(({ file, line, reason }) => `${file}:${line}: ${reason}`)).toEqual([
        'apps/shell-super-app/api/auth/external-identity/bare-specifier-import.ts:1: Non-Commerce unit takes a mandatory runtime import of Commerce\'s private implementation "@app/commerce-customer-context" (only published shared/ contracts and documented composition seams are allowed)',
        'apps/shell-super-app/api/auth/external-identity/multiline-import.ts:1: Non-Commerce unit takes a mandatory runtime import of Commerce\'s private implementation "../../../../verticals/commerce-customer-context/src/enrollment/journeys/index.ts" (only published shared/ contracts and documented composition seams are allowed)',
        'apps/shell-super-app/api/auth/external-identity/side-effect-import.ts:1: Non-Commerce unit takes a mandatory runtime import of Commerce\'s private implementation "../../../../verticals/commerce-customer-context/src/enrollment/side-effects.ts" (only published shared/ contracts and documented composition seams are allowed)',
        'apps/shell-super-app/api/auth/external-identity/unauthorized-package-import.ts:1: Non-Commerce unit takes a mandatory runtime import of Commerce\'s private implementation "@app/commerce-customer-context/portal-auth/verification/client" (only published shared/ contracts and documented composition seams are allowed)',
        'apps/shell-super-app/api/auth/external-identity/unauthorized-package-import.ts:2: Non-Commerce unit takes a mandatory runtime import of Commerce\'s private implementation "@app/commerce-customer-context/api/client" (only published shared/ contracts and documented composition seams are allowed)',
        'apps/shell-super-app/api/auth/external-identity/unauthorized-private-import.ts:1: Non-Commerce unit takes a mandatory runtime import of Commerce\'s private implementation "../../../../verticals/commerce-customer-context/src/enrollment/journeys/index.ts" (only published shared/ contracts and documented composition seams are allowed)',
        'packages/core-runtime/package.json:1: Core runtime package.json maps package import "#escaping" outside packages/core-runtime/src: "../shared/escape.ts"',
        'packages/core-runtime/src/auth/commerce-leak.ts:1: Core runtime source imports Commerce/Storefront/Better Auth package "@app/commerce-customer-context"',
        'packages/core-runtime/src/auth/escaping-package-import.ts:1: Core runtime source imports a dependency outside the pinned external specifier set: "#escaping"',
        'packages/core-runtime/src/auth/relative-commerce-leak.ts:1: Core runtime source imports Commerce/Storefront/Better Auth via relative specifier "../../../../verticals/commerce-customer-context/src/enrollment/journeys/index.ts" (resolves to "verticals/commerce-customer-context/src/enrollment/journeys/index.ts")',
        'packages/core-runtime/src/auth/unpinned.ts:1: Core runtime source imports a dependency outside the pinned external specifier set: "zod"',
        'verticals/party-registry/api/uses-commerce-api.ts:1: Non-Commerce unit takes a mandatory runtime import of Commerce\'s private implementation "../../commerce-customer-context/api/owner-transition.ts" (only published shared/ contracts and documented composition seams are allowed)',
        'verticals/party-registry/api/uses-subject-restrictions-client.ts:1: Non-Commerce unit takes a mandatory runtime import of Commerce\'s private implementation "@app/commerce-customer-context/api/market-subject-restrictions-current/client" (only published shared/ contracts and documented composition seams are allowed)',
        'verticals/pricing/src/integrations/current-pricing-decision-external-owner-evidence-live.ts:2: Non-Commerce unit takes a mandatory runtime import of Commerce\'s private implementation "@app/commerce-customer-context/api/pricing-purchase-context-verification/client" (only published shared/ contracts and documented composition seams are allowed)',
        'verticals/pricing/src/integrations/unauthorized-price-group-resolution.ts:1: Non-Commerce unit takes a mandatory runtime import of Commerce\'s private implementation "@app/commerce-customer-context/api/customer-price-group-resolution/client" (only published shared/ contracts and documented composition seams are allowed)',
      ]);
    }),
);

it.live('passes on a tree with only allowed dependencies and documented seams', () =>
  Effect.gen(function* testEffect3() {
    const root = yield* Effect.acquireRelease(
      Effect.tryPromise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-lean-core-clean-'))),
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    );
    const files = {
      'apps/shell-super-app/src/api/vertical-clients.ts':
        "import { Client } from '@app/commerce-customer-context/api/client';\n",
      [commerceFixtureManifest]: JSON.stringify({
        exports: { './api/client': './src/api/client.ts' },
      }),
      'packages/core-runtime/package.json': JSON.stringify({ dependencies: { effect: '^4.0.0' } }),
      'packages/core-runtime/src/index.ts': "import { Effect } from 'effect';\n",
    } as const;
    yield* Effect.all(
      Object.entries(files).map(([relative, source]) =>
        Effect.gen(function* testEffect4() {
          const file = path.join(root, relative);
          yield* Effect.tryPromise(() => mkdir(path.dirname(file), { recursive: true }));
          yield* Effect.tryPromise(() => writeFile(file, source));
        }),
      ),
    );
    const violations = yield* checkLeanCoreDependencies(root, filesOnDisk).pipe(Effect.provide(NodeServices.layer));
    expect(violations).toEqual([]);
  }),
);

const nodeDriverSource = [
  "import { fromReadable } from '@effect/platform-node/NodeStream';",
  "import { request } from '@effect/platform-node/Undici';",
  'export const driver = [fromReadable, request];',
].join('\n');
const nodeAdapterPath = './src/transport.adapter.ts';
const workerAdapterPath = './src/transport.worker.ts';
const driverReExportSource = "export { driver } from './driver.ts';";
const bootstrapImportSource = "import './bootstrap.cjs';";
const hostImports = {
  '#transport': Object.fromEntries([
    ['workerd', workerAdapterPath],
    ['node', nodeAdapterPath],
  ]),
};
const hostExports = { '.': './src/index.ts', './transport': './src/transport.ts' };
const hostSources = {
  'src/driver.ts': nodeDriverSource,
  'src/index.ts': "export { Effect } from 'effect';",
  'src/transport.adapter.ts': driverReExportSource,
  'src/transport.ts': "export { driver } from '#transport';",
  'src/transport.worker.ts': "export const driver = 'native worker';",
};

interface HostGraphControl {
  readonly exports?: Schema.Json;
  readonly imports?: Schema.Json;
  readonly name: string;
  readonly rejected: boolean;
  readonly sources?: Readonly<Record<string, string>>;
}

const hostGraphControls: readonly HostGraphControl[] = [
  { name: 'allows a consumed native Node conditional entry and its runtime descendants', rejected: false },
  {
    name: 'does not treat a type-only worker reference as a runtime Node dependency',
    rejected: false,
    sources: { 'src/transport.worker.ts': "import type { driver } from './driver.ts'; export const value = 'worker';" },
  },
  {
    imports: {
      '#transport': Object.fromEntries([
        ['workerd', workerAdapterPath],
        ['default', nodeAdapterPath],
      ]),
    },
    name: 'rejects a default Node adapter without an explicit Node condition',
    rejected: true,
  },
  {
    imports: {},
    name: 'rejects an orphan renamed Node adapter',
    rejected: true,
    sources: { 'src/merely-renamed.node.ts': nodeDriverSource },
  },
  {
    name: 'rejects a shared direct import into the Node-only descendant',
    rejected: true,
    sources: { 'src/shared.ts': "import { driver } from './driver.ts';" },
  },
  {
    name: 'rejects a shared dynamic import into the Node-only descendant',
    rejected: true,
    sources: { 'src/shared.ts': "const driver = import('./driver.ts');" },
  },
  {
    name: 'rejects a shared re-export of the Node-only descendant',
    rejected: true,
    sources: { 'src/shared.ts': "export * from './driver.ts';" },
  },
  {
    name: 'rejects a shared side-effect import of the Node-only descendant',
    rejected: true,
    sources: { 'src/shared.ts': "import './driver.ts';" },
  },
  {
    name: 'rejects a shared static template dynamic import of the Node-only descendant',
    rejected: true,
    sources: { 'src/shared.ts': 'const driver = import(`./driver.ts`);' },
  },
  {
    name: 'rejects a transitive shared bridge into the Node-only descendant',
    rejected: true,
    sources: {
      'src/shared-bridge.ts': driverReExportSource,
      'src/shared.ts': "export { driver } from './shared-bridge.ts';",
    },
  },
  {
    name: 'rejects a Workerd branch that reaches the Node-only descendant',
    rejected: true,
    sources: { 'src/transport.worker.ts': driverReExportSource },
  },
  {
    exports: { ...hostExports, './browser': { browser: nodeAdapterPath } },
    name: 'rejects a browser export that reaches the Node-only adapter',
    rejected: true,
  },
  {
    imports: {
      '#transport': Object.fromEntries([
        ['custom-host', workerAdapterPath],
        ['workerd', workerAdapterPath],
        ['node', nodeAdapterPath],
      ]),
    },
    name: 'rejects unsupported conditional host evidence',
    rejected: true,
  },
  {
    imports: {
      '#transport': Object.fromEntries([
        ['workerd', nodeAdapterPath],
        ['node', nodeAdapterPath],
      ]),
    },
    name: 'rejects a Node entry also selected by Workerd',
    rejected: true,
  },
  {
    imports: { '#transport': { default: nodeAdapterPath, node: nodeAdapterPath } },
    name: 'rejects an earlier default that shadows the explicit Node condition',
    rejected: true,
  },
  {
    imports: {
      '#transport': Object.fromEntries([
        ['workerd', workerAdapterPath],
        ['node', nodeAdapterPath],
        ['default', nodeAdapterPath],
      ]),
    },
    name: 'rejects a default browser fallback into the Node adapter',
    rejected: true,
  },
  {
    name: 'rejects a Node conditional mapping without a consuming runtime entry',
    rejected: true,
    sources: { 'src/transport.ts': "export const driver = 'unrelated';" },
  },
  {
    name: 'keeps unpinned Node adapter dependencies forbidden',
    rejected: true,
    sources: { 'src/driver.ts': "import { driver } from 'unapproved-node-driver';" },
  },
  {
    name: 'keeps unrelated Node builtins outside the existing specifier policy',
    rejected: true,
    sources: { 'src/driver.ts': "import { readFile } from 'node:fs';" },
  },
  {
    name: 'rejects nonliteral dynamic imports inside the purported Node boundary',
    rejected: true,
    sources: { 'src/driver.ts': `${nodeDriverSource}\nconst target = './unknown.ts'; void import(target);` },
  },
  {
    name: 'rejects nonliteral dynamic imports from the shared graph',
    rejected: true,
    sources: { 'src/shared.ts': "const target = './driver.ts'; void import(target);" },
  },
  {
    name: 'rejects an unresolved relative edge inside the purported Node boundary',
    rejected: true,
    sources: { 'src/transport.adapter.ts': "export { driver } from './driver.ts'; import './missing.ts';" },
  },
  {
    name: 'rejects an ambiguous relative edge inside the purported Node boundary',
    rejected: true,
    sources: {
      'src/driver.tsx': 'export const driver = true;',
      'src/transport.adapter.ts': "export { driver } from './driver';",
    },
  },
  {
    exports: { ...hostExports, './*': './src/*.ts' },
    name: 'rejects wildcard public paths that cannot prove host isolation',
    rejected: true,
  },
  {
    exports: { ...hostExports, './ambiguous': './src/driver' },
    name: 'rejects an ambiguous public path that cannot prove host isolation',
    rejected: true,
    sources: { 'src/driver.tsx': 'export const driver = true;' },
  },
  {
    imports: {
      '#transport': Object.fromEntries([
        ['workerd', workerAdapterPath],
        ['node', './src/transport.adapter.mjs'],
      ]),
    },
    name: 'rejects a nonexistent manifest target with an incompatible emitted extension',
    rejected: true,
  },
  {
    name: 'proves actual terminal CJS source instead of treating it as an unresolved edge',
    rejected: false,
    sources: {
      'src/bootstrap.cjs': 'module.exports = { ready: true };',
      'src/shared.ts': bootstrapImportSource,
    },
  },
  {
    name: 'rejects a CJS require path that cannot prove host isolation',
    rejected: true,
    sources: {
      'src/bootstrap.cjs': "module.exports = require('./driver.ts');",
      'src/shared.ts': bootstrapImportSource,
    },
  },
  {
    name: 'rejects an aliased CJS require that cannot prove host isolation',
    rejected: true,
    sources: {
      'src/bootstrap.cjs': "const load = require; module.exports = load('./driver.ts');",
      'src/shared.ts': bootstrapImportSource,
    },
  },
  {
    name: 'rejects computed CJS require that cannot prove host isolation',
    rejected: true,
    sources: {
      'src/bootstrap.cjs': "module.exports = module['require']('./driver.ts');",
      'src/shared.ts': bootstrapImportSource,
    },
  },
  {
    name: 'rejects static template CJS require that cannot prove host isolation',
    rejected: true,
    sources: {
      'src/bootstrap.cjs': 'module.exports = module[`require`]("./driver.ts");',
      'src/shared.ts': bootstrapImportSource,
    },
  },
  {
    name: 'rejects native CJS createRequire loading that cannot prove host isolation',
    rejected: true,
    sources: {
      'src/bootstrap.cjs':
        "const { createRequire } = process.getBuiltinModule('module'); const load = createRequire(__filename); module.exports = load('./driver.ts');",
      'src/shared.ts': bootstrapImportSource,
    },
  },
  {
    name: 'rejects runtime TypeScript import-equals that cannot prove host isolation',
    rejected: true,
    sources: { 'src/shared.ts': "import driver = require('./driver.ts'); void driver;" },
  },
  {
    name: 'preserves erased type-only TypeScript import-equals',
    rejected: false,
    sources: {
      'src/shared.ts': "import type driver = require('./driver.ts'); export type NativeDriver = typeof driver;",
    },
  },
];

for (const control of hostGraphControls) {
  it.live(control.name, () =>
    Effect.gen(function* proveNativeHostDependency() {
      const root = yield* Effect.acquireRelease(
        Effect.tryPromise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-lean-core-host-'))),
        (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
      );
      const manifest = {
        dependencies: { '@effect/platform-node': '4.0.0-rc.117', effect: '4.0.0-rc.117' },
        exports: control.exports ?? hostExports,
        imports: control.imports ?? hostImports,
      };
      const sources = { ...hostSources, ...control.sources };
      const files = {
        'package.json': JSON.stringify(manifest),
        ...sources,
      };
      yield* Effect.all(
        Object.entries(files).map(([relative, source]) =>
          Effect.gen(function* writeHostFixture() {
            const file = path.join(root, 'packages/core-runtime', relative);
            yield* Effect.tryPromise(() => mkdir(path.dirname(file), { recursive: true }));
            yield* Effect.tryPromise(() => writeFile(file, source));
          }),
        ),
      );
      const violations = yield* checkLeanCoreDependencies(root, filesOnDisk).pipe(Effect.provide(NodeServices.layer));
      if (control.rejected) {
        expect(violations.some(({ reason }) => reason.includes('outside the pinned external specifier set'))).toBe(
          true,
        );
      } else {
        expect(violations).toEqual([]);
      }
    }),
  );
}

it.live('admits only the six approved 1257 governed owner client composition pairs', () =>
  Effect.gen(function* approvedOwnerCompositionPairs() {
    const root = yield* Effect.acquireRelease(
      Effect.tryPromise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-lean-core-1257-'))),
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    );
    const approvalEvidenceClient = '@app/commerce-customer-context/api/order-service-approval-evidence/client';
    const approvalOwnerGateway = 'verticals/commerce-order/src/services/approval-owner-gateway.ts';
    const commerceManifest = commerceFixtureManifest;
    const pairs = [
      {
        importer: 'verticals/commerce-cart/src/services/final-cart-candidate-owners.service.ts',
        specifier: approvalEvidenceClient,
      },
      {
        importer: 'verticals/commerce-order/src/integrations/finalization-tax-payment-terms.ts',
        specifier: approvalEvidenceClient,
      },
      {
        importer: approvalOwnerGateway,
        specifier: approvalEvidenceClient,
      },
      {
        importer: approvalOwnerGateway,
        specifier: '@app/commerce-customer-context/api/revalidate-order-purchase-approval-action/client',
      },
      {
        importer: approvalOwnerGateway,
        specifier: '@app/commerce-customer-context/api/consume-order-purchase-approval-action/client',
      },
      {
        importer: 'verticals/pricing/src/services/preapproval-quotation-verification.service.ts',
        specifier: '@app/commerce-customer-context/api/purchase-proposal-basis/client',
      },
    ];
    const files = new Map<string, string>();
    const exports = Object.fromEntries(
      pairs.map(({ specifier }) => {
        const subpath = specifier.replace('@app/commerce-customer-context/', './');
        return [subpath, `./src/api/${subpath.slice(6).replace('/client', '-client')}.ts`];
      }),
    );
    files.set(commerceManifest, JSON.stringify({ exports }));
    for (const { importer, specifier } of pairs) {
      files.set(importer, `${files.get(importer) ?? ''}import { execute } from '${specifier}';\n`);
    }
    for (const [relative, source] of files) {
      const file = path.join(root, relative);
      yield* Effect.tryPromise(() => mkdir(path.dirname(file), { recursive: true }));
      yield* Effect.tryPromise(() => writeFile(file, source));
    }
    const valid = yield* checkLeanCoreDependencies(root, filesOnDisk).pipe(Effect.provide(NodeServices.layer));
    expect(valid).toEqual([]);
    const adjacent = pairs.map(({ importer, specifier }, index) => ({
      importer: importer.replace(/\.ts$/u, `.unauthorized-${index}.ts`),
      specifier,
    }));
    for (const { importer, specifier } of adjacent) {
      const file = path.join(root, importer);
      yield* Effect.tryPromise(() => writeFile(file, `import { execute } from '${specifier}';\n`));
    }
    for (const importer of new Set(pairs.map((pair) => pair.importer))) {
      const privatePath = path.relative(path.dirname(importer), commercePrivateFixturePath);
      yield* Effect.tryPromise(() =>
        writeFile(
          path.join(root, importer),
          `import { execute } from '@app/commerce-customer-context/api/order-service-approval-evidence/client-private';\nimport { executePrivate } from '${privatePath}';\n`,
        ),
      );
    }
    // The nearby wrong client is published too; publication alone must not grant a new seam.
    files.set(
      commerceManifest,
      JSON.stringify({
        exports: {
          ...exports,
          './api/order-service-approval-evidence/client-private': commercePrivateFixtureExport,
        },
      }),
    );
    yield* Effect.tryPromise(() => writeFile(path.join(root, commerceManifest), files.get(commerceManifest) ?? ''));
    const invalid = yield* checkLeanCoreDependencies(root, filesOnDisk).pipe(Effect.provide(NodeServices.layer));
    expect(invalid).toHaveLength(14);
    for (const { importer } of adjacent) {
      expect(invalid.filter((violation) => violation.file === importer)).toHaveLength(1);
    }
    for (const importer of new Set(pairs.map((pair) => pair.importer))) {
      expect(invalid.filter((violation) => violation.file === importer).map((violation) => violation.line)).toEqual([
        1, 2,
      ]);
    }
  }),
);

it.live('admits only the exact Privacy profile-authority client composition pairs', () =>
  Effect.gen(function* privacyProfileAuthorityClientPairs() {
    const root = yield* Effect.acquireRelease(
      Effect.tryPromise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-lean-core-privacy-'))),
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    );
    const importers = [
      'verticals/privacy/src/integrations/commerce-customer-context/commerce-customer-context-consent-withdrawal.service.ts',
      'verticals/privacy/src/integrations/commerce-customer-context/commerce-customer-context-notice-subject-authority.service.ts',
    ];
    const operations = [
      'customer-profile-read',
      'retail-access-decision',
      'retail-portal-profile-binding-read',
      'retail-principal-resolution',
    ];
    const exports = Object.fromEntries(
      operations.map((operation) => [`./api/${operation}/client`, `./src/api/${operation}-client.ts`]),
    );
    const manifest = path.join(root, commerceFixtureManifest);
    yield* Effect.tryPromise(() => mkdir(path.dirname(manifest), { recursive: true }));
    yield* Effect.tryPromise(() => writeFile(manifest, JSON.stringify({ exports })));
    for (const importer of importers) {
      const file = path.join(root, importer);
      yield* Effect.tryPromise(() => mkdir(path.dirname(file), { recursive: true }));
      const source = operations
        .map(
          (operation, index) =>
            `import { execute as execute${index} } from '@app/commerce-customer-context/api/${operation}/client';\n`,
        )
        .join('');
      yield* Effect.tryPromise(() => writeFile(file, source));
    }
    const valid = yield* checkLeanCoreDependencies(root, filesOnDisk).pipe(Effect.provide(NodeServices.layer));
    expect(valid).toEqual([]);
    for (const [index, operation] of operations.entries()) {
      for (const importer of importers) {
        const adjacent = path.join(root, importer.replace(/\.ts$/u, `.unauthorized-${index}.ts`));
        yield* Effect.tryPromise(() =>
          writeFile(adjacent, `import { execute } from '@app/commerce-customer-context/api/${operation}/client';\n`),
        );
      }
    }
    yield* Effect.tryPromise(() =>
      writeFile(
        manifest,
        JSON.stringify({
          exports: {
            ...exports,
            './api/customer-profile-read/client-private': commercePrivateFixtureExport,
          },
        }),
      ),
    );
    for (const importer of importers) {
      const privatePath = path.relative(path.dirname(importer), commercePrivateFixturePath);
      yield* Effect.tryPromise(() =>
        writeFile(
          path.join(root, importer),
          `import { execute } from '@app/commerce-customer-context/api/customer-profile-read/client-private';\nimport { privateOperation } from '${privatePath}';\n`,
        ),
      );
    }
    const invalid = yield* checkLeanCoreDependencies(root, filesOnDisk).pipe(Effect.provide(NodeServices.layer));
    expect(invalid).toHaveLength(12);
    for (const importer of importers) {
      expect(invalid.filter((violation) => violation.file === importer).map(({ line }) => line)).toEqual([1, 2]);
      for (const index of operations.keys()) {
        expect(
          invalid.filter((violation) => violation.file === importer.replace(/\.ts$/u, `.unauthorized-${index}.ts`)),
        ).toHaveLength(1);
      }
    }
  }),
);

const workspaceRange = 'workspace:*';
const alphaModule = 'verticals/alpha';
const betaModule = 'verticals/beta';
const alphaManifest = 'verticals/alpha/package.json';
const alphaUsesBeta = 'verticals/alpha/src/uses-beta.ts';
const alphaBetaTest = 'verticals/alpha/tests/unit/beta.test.ts';
const alphaToBetaEdge = 'verticals/alpha -> verticals/beta';
const betaImportSource = "import { beta } from '@app/beta';\n";
const alphaImportSource = "import { alpha } from '@app/alpha';\n";
const alphaName = '@app/alpha';

const freezeManifest = (name: string, fields: Readonly<Record<string, Readonly<Record<string, string>>>> = {}) =>
  JSON.stringify({ name, ...fields });

/** Two modules, a package and an app, with no edge between them. */
const freezeWorkspace = {
  [alphaManifest]: freezeManifest(alphaName),
  'apps/shell/package.json': freezeManifest('@app/shell'),
  'packages/contracts/package.json': freezeManifest('@app/contracts'),
  'verticals/alpha/src/index.ts': 'export const alpha = 1;\n',
  'verticals/beta/package.json': freezeManifest('@app/beta'),
  'verticals/beta/src/index.ts': 'export const beta = 1;\n',
} as const;

type FreezeFiles = Readonly<Record<string, string>>;

const freezeBaseline = (entries: readonly { readonly class: string; readonly from: string; readonly to: string }[]) =>
  ({ [moduleEdgeBaselineRelative]: JSON.stringify(entries) }) as const;

const alphaToBeta = { class: 'runtime', from: alphaModule, to: betaModule } as const;
const alphaToShell = { class: 'runtime', from: alphaModule, to: 'apps/shell' } as const;
const betaImport = { [alphaUsesBeta]: betaImportSource } as const;
const shellImport = { 'verticals/alpha/src/uses-shell.ts': "import { shell } from '@app/shell';\n" } as const;
const alphaDevDependsOnBeta = {
  [alphaBetaTest]: betaImportSource,
  [alphaManifest]: freezeManifest(alphaName, { devDependencies: { '@app/beta': workspaceRange } }),
} as const;

const writeFreezeFiles = (root: string, files: FreezeFiles) =>
  Effect.all(
    Object.entries(files).map(([relative, source]) =>
      Effect.tryPromise(async () => {
        await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
        await writeFile(path.join(root, relative), source);
      }),
    ),
    { discard: true },
  );

const freezeRoot = (files: FreezeFiles) =>
  Effect.gen(function* freezeRootProgram() {
    const root = yield* Effect.acquireRelease(
      Effect.tryPromise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-lean-core-freeze-'))),
      (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
    );
    yield* writeFreezeFiles(root, { ...freezeWorkspace, ...files });
    return root;
  });

const freezeReport = (root: string, base?: string) =>
  checkModuleEdgeFreeze(root, { base, files: filesOnDisk }).pipe(Effect.provide(NodeServices.layer));

const reportedViolations = (root: string, base?: string) =>
  Effect.map(freezeReport(root, base), ({ violations }) =>
    violations.map(({ file, line, reason }) => `${file}:${line}: ${reason}`),
  );

const freezeViolations = (files: FreezeFiles) => Effect.flatMap(freezeRoot(files), (root) => reportedViolations(root));

const baselineFile = (reason: string) => `${moduleEdgeBaselineRelative}:1: ${reason}`;
const moduleToModule = 'A module takes no edge to another module';
/** The violation of a frozen edge the baseline does not list, reported at `at`, the first place that makes it. */
const unlisted = (rule: string, edge: string, edgeClass: string, made: string, at = made) =>
  `${at}: ${rule} unless ${moduleEdgeBaselineRelative} lists it: ${edge} is a ${edgeClass} edge and the baseline does not list it; made by ${made}`;

it.live('freezes a new module-to-module runtime edge until the baseline lists it with its class', () =>
  Effect.gen(function* newModuleEdge() {
    const edge = {
      [alphaManifest]: freezeManifest(alphaName, { dependencies: { '@app/beta': workspaceRange } }),
      [alphaUsesBeta]: betaImportSource,
    };
    expect(yield* freezeViolations(edge)).toEqual([
      unlisted(
        moduleToModule,
        alphaToBetaEdge,
        'runtime',
        `${alphaManifest} dependencies; ${alphaUsesBeta}:1`,
        `${alphaManifest}:1`,
      ),
    ]);
    expect(yield* freezeViolations({ ...edge, ...freezeBaseline([alphaToBeta]) })).toEqual([]);
  }),
);

it.live('counts an edge declared only in devDependencies as runtime once a non-test source imports it', () =>
  Effect.gen(function* devDependencyRuntimeImport() {
    const declared = { ...alphaDevDependsOnBeta, ...freezeBaseline([{ ...alphaToBeta, class: 'test' }]) };
    expect(yield* freezeViolations(declared)).toEqual([]);
    expect(yield* freezeViolations({ ...declared, ...betaImport })).toEqual([
      `${alphaManifest}:1: ${moduleToModule} unless ${moduleEdgeBaselineRelative} lists it: ${alphaToBetaEdge} is a runtime edge and the baseline lists it only as test; made by ${alphaManifest} devDependencies; ${alphaUsesBeta}:1; ${alphaBetaTest}:1`,
    ]);
  }),
);

it.live('derives an edge from an undeclared package import, and refuses a source whose edges it cannot read', () =>
  Effect.gen(function* undeclaredImport() {
    expect(
      yield* freezeViolations({
        [alphaUsesBeta]: "export const load = () => import('@app/beta/shared/beta-value');\n",
        'verticals/alpha/src/unreadable.ts': 'export const = ;\n',
      }),
    ).toEqual([
      'verticals/alpha/src/unreadable.ts:1: Workspace source does not parse, so the package edges it makes are unknown',
      unlisted(moduleToModule, alphaToBetaEdge, 'runtime', `${alphaUsesBeta}:1`),
    ]);
  }),
);

it.live('attributes a relative import that leaves the package to the package owning its target', () =>
  Effect.gen(function* relativeEscape() {
    expect(
      yield* freezeViolations({
        // Stays inside its own package, and leaves for a file no workspace package owns: no edge.
        'verticals/alpha/src/inside.ts':
          "import { alpha } from './index.ts';\nimport { tool } from '../../../scripts/tool.mts';\n",
        'verticals/alpha/tests/unit/reaches-beta.test.ts': "import { beta } from '../../../beta/src/index.ts';\n",
      }),
    ).toEqual([unlisted(moduleToModule, alphaToBetaEdge, 'test', 'verticals/alpha/tests/unit/reaches-beta.test.ts:1')]);
  }),
);

it.live('freezes the edges of a package to a module and of a module to an app, and no other kind', () =>
  Effect.gen(function* frozenKinds() {
    expect(
      yield* freezeViolations({
        // An app may reach a module, and a module or a package may reach a package.
        'apps/shell/src/composition.ts': alphaImportSource,
        'packages/contracts/src/uses-alpha.ts': alphaImportSource,
        'verticals/alpha/src/uses-contracts.ts': "import { contract } from '@app/contracts';\n",
        'verticals/beta/tests/unit/shell.test.ts': "import { shell } from '@app/shell';\n",
      }),
    ).toEqual([
      unlisted(
        'A package under packages/ takes no edge to a module',
        'packages/contracts -> verticals/alpha',
        'runtime',
        'packages/contracts/src/uses-alpha.ts:1',
      ),
      unlisted(
        'A module takes no edge to an app',
        'verticals/beta -> apps/shell',
        'test',
        'verticals/beta/tests/unit/shell.test.ts:1',
      ),
    ]);
  }),
);

it.live('fails a baseline entry whose edge is gone, and a baseline that is out of order', () =>
  Effect.gen(function* staleEntry() {
    const betaToAlpha = { class: 'runtime', from: betaModule, to: alphaModule } as const;
    expect(yield* freezeViolations(freezeBaseline([alphaToBeta]))).toEqual([
      baselineFile(`Baseline entry ${alphaToBetaEdge} (runtime) is no frozen edge of the tree any more: remove it`),
    ]);
    const bothWays = { ...betaImport, 'verticals/beta/src/uses-alpha.ts': alphaImportSource };
    expect(yield* freezeViolations({ ...bothWays, ...freezeBaseline([alphaToBeta, betaToAlpha]) })).toEqual([]);
    expect(yield* freezeViolations({ ...bothWays, ...freezeBaseline([betaToAlpha, alphaToBeta]) })).toEqual([
      baselineFile(
        'Baseline entry 2 is out of order or repeats an edge: entries are sorted by from, then to, one per edge',
      ),
    ]);
  }),
);

it.live('fails a baseline entry whose class is wider than the edge the tree has', () =>
  Effect.gen(function* narrowedClass() {
    expect(yield* freezeViolations({ ...alphaDevDependsOnBeta, ...freezeBaseline([alphaToBeta]) })).toEqual([
      baselineFile(
        `Baseline entry ${alphaToBetaEdge} is runtime, but the tree has it only as test (${alphaManifest} devDependencies; ${alphaBetaTest}:1): change its class to test`,
      ),
    ]);
  }),
);

/** A repository whose first commit holds base and whose second holds head on top of it; root is its top. */
const comparisonRepository = (base: FreezeFiles, head: FreezeFiles) =>
  Effect.gen(function* comparisonRepositoryProgram() {
    const root = yield* freezeRoot(base);
    const git = (...args: readonly string[]) =>
      execFileSync(
        '/usr/bin/git',
        ['-c', 'user.name=Lean Core test', '-c', 'user.email=lean-core@example.invalid', ...args],
        { cwd: root, encoding: 'utf-8' },
      ).trim();
    git('init', '--quiet');
    git('add', '--all');
    git('commit', '--quiet', '-m', 'base');
    const baseCommit = git('rev-parse', 'HEAD');
    yield* writeFreezeFiles(root, head);
    git('add', '--all');
    git('commit', '--quiet', '-m', 'head');
    return { baseCommit, root };
  });

const absentFromBase = (edge: string, commit: string) =>
  baselineFile(
    `Baseline entry ${edge} (runtime) is not an edge of the comparison base ${commit}: the baseline only shrinks, so no new edge enters it`,
  );

it.live('fails a head baseline that names an edge the comparison base does not have, or widens a class', () =>
  Effect.gen(function* edgeAbsentFromBase() {
    const added = yield* comparisonRepository(
      { ...betaImport, ...freezeBaseline([alphaToBeta]) },
      { ...shellImport, ...freezeBaseline([alphaToShell, alphaToBeta]) },
    );
    // Rules 1 to 4 hold on the head; only the comparison with the base finds the new edge.
    expect(yield* reportedViolations(added.root)).toEqual([]);
    expect(yield* reportedViolations(added.root, added.baseCommit)).toEqual([
      absentFromBase('verticals/alpha -> apps/shell', added.baseCommit),
    ]);
    const widened = yield* comparisonRepository(
      { [alphaBetaTest]: betaImportSource, ...freezeBaseline([{ ...alphaToBeta, class: 'test' }]) },
      { ...betaImport, ...freezeBaseline([alphaToBeta]) },
    );
    expect(yield* reportedViolations(widened.root, widened.baseCommit)).toEqual([
      baselineFile(
        `Baseline entry ${alphaToBetaEdge} is runtime, but the comparison base ${widened.baseCommit} has it only as test (${alphaBetaTest}:1): the baseline only shrinks, so no class widens`,
      ),
    ]);
    // A shrinking baseline passes: the head drops the edge and its entry.
    const shrunk = yield* comparisonRepository(
      { ...betaImport, ...shellImport, ...freezeBaseline([alphaToShell, alphaToBeta]) },
      { [alphaUsesBeta]: 'export {};\n', ...freezeBaseline([alphaToShell]) },
    );
    expect(yield* reportedViolations(shrunk.root, shrunk.baseCommit)).toEqual([]);
  }),
);

it.live('fails closed when the comparison base cannot be read', () =>
  Effect.gen(function* unreadableComparisonBase() {
    const { root } = yield* comparisonRepository(freezeBaseline([]), {
      ...betaImport,
      ...freezeBaseline([alphaToBeta]),
    });
    const absent = 'f'.repeat(40);
    expect(yield* reportedViolations(root, absent)).toEqual([
      baselineFile(
        `The comparison base ${absent} cannot be read (it names no commit of this repository), so the shrink-only rule fails closed`,
      ),
    ]);
  }),
);

it.live('admits a first baseline against a base without one only when the base tree has every entry', () =>
  Effect.gen(function* firstBaseline() {
    const admitted = yield* comparisonRepository(betaImport, freezeBaseline([alphaToBeta]));
    const report = yield* freezeReport(admitted.root, admitted.baseCommit);
    expect(report.violations).toEqual([]);
    expect(report.shrinkOnly).toBe(
      `Shrink-only rule: the comparison base ${admitted.baseCommit} has no baseline, so its tree was derived and holds every baseline entry with the same or a wider class.`,
    );
    const refused = yield* comparisonRepository(betaImport, {
      ...shellImport,
      ...freezeBaseline([alphaToShell, alphaToBeta]),
    });
    expect(yield* reportedViolations(refused.root, refused.baseCommit)).toEqual([
      absentFromBase('verticals/alpha -> apps/shell', refused.baseCommit),
    ]);
  }),
);

const betaRuntimeEdge = (made: string) => [unlisted(moduleToModule, alphaToBetaEdge, 'runtime', made)];
const createRequireImport = "import { createRequire } from 'node:module';\n";

/** Each form a source can name a package with, the module file that uses it, and the line that names it. */
const referenceForms: readonly (readonly [form: string, file: string, source: string, line: number])[] = [
  ['a TypeScript import type', 'src/beta-type.ts', "export type Beta = import('@app/beta').Beta;\n", 1],
  ['a TypeScript import-equals', 'src/beta-equals.ts', "import beta = require('@app/beta');\nexport { beta };\n", 1],
  ['a literal require', 'src/beta-require.cjs', "module.exports = require('@app/beta');\n", 1],
  ['require.resolve', 'src/beta-resolve.ts', "export const beta = require.resolve('@app/beta');\n", 1],
  ['module.require', 'src/beta-module-require.cjs', "module.exports = module.require('@app/beta');\n", 1],
  [
    'a call of createRequire(...)',
    'src/beta-create-require.ts',
    `${createRequireImport}export const beta = createRequire(import.meta.url)('@app/beta');\n`,
    2,
  ],
  [
    'resolve on createRequire(...)',
    'src/beta-create-require-resolve.ts',
    `${createRequireImport}export const beta = createRequire(import.meta.url).resolve('@app/beta');\n`,
    2,
  ],
  [
    'a binding of createRequire(...)',
    'src/beta-load.ts',
    `${createRequireImport}const load = createRequire(import.meta.url);\nexport const beta = load('@app/beta');\n`,
    3,
  ],
  ['import.meta.resolve', 'src/beta-meta-resolve.ts', "export const beta = import.meta.resolve('@app/beta');\n", 1],
  ['a reference types directive', 'src/beta-types.d.ts', '/// <reference types="@app/beta" />\n', 1],
  ['a reference path directive', 'src/beta-path.d.ts', '/// <reference path="../../beta/src/index.ts" />\n', 1],
  [
    'a re-export inside an ambient module',
    'src/beta-ambient.d.ts',
    "declare module 'alpha-augment' {\n  export { beta } from '@app/beta';\n}\n",
    2,
  ],
  ['a relative import of the package directory', 'src/beta-directory.ts', "export { beta } from '../../beta';\n", 1],
  ['a .js module', 'src/beta.js', betaImportSource, 1],
  ['a .mjs module', 'src/beta.mjs', betaImportSource, 1],
  ['a .mts module', 'src/beta.mts', `${betaImportSource}export const value: number = beta;\n`, 1],
  ['a .cts module', 'src/beta.cts', `${betaImportSource}export const value: number = beta;\n`, 1],
  ['a .jsx module', 'src/beta.jsx', `${betaImportSource}export const view = <b>{beta}</b>;\n`, 1],
  [
    'a .tsx module',
    'src/beta.tsx',
    `${betaImportSource}export const view = (count: number) => <b>{beta + count}</b>;\n`,
    1,
  ],
];

for (const [form, relative, source, line] of referenceForms) {
  it.live(`derives a module edge from ${form}`, () =>
    Effect.gen(function* referenceForm() {
      const file = `${alphaModule}/${relative}`;
      expect(yield* freezeViolations({ [file]: source })).toEqual(betaRuntimeEdge(`${file}:${line}`));
    }),
  );
}

it.live('reads a reference path directive as a path, never as a package name', () =>
  Effect.gen(function* referencePathIsAPath() {
    expect(
      yield* freezeViolations({
        // "beta" is also the name of a workspace package; the directive names alpha's own src/beta/index.d.ts.
        'verticals/alpha/src/beta/index.d.ts': 'export {};\n',
        'verticals/alpha/src/local.d.ts': '/// <reference path="beta/index.d.ts" />\n',
        'verticals/gamma/package.json': freezeManifest('beta'),
      }),
    ).toEqual([]);
  }),
);

/** Dependency declarations that install @app/beta under another name, each imported by that name. */
const aliasedDeclarations: readonly (readonly [protocol: string, range: string])[] = [
  ['a workspace: alias', 'workspace:@app/beta@*'],
  ['an npm: alias onto a workspace package', 'npm:@app/beta@^1.0.0'],
  ['a workspace: path', 'workspace:../beta'],
  ['a link: path', 'link:../beta'],
  ['a file: path', 'file:../beta'],
];

for (const [protocol, range] of aliasedDeclarations) {
  it.live(`resolves ${protocol} to the workspace package it installs, for the declaration and its imports`, () =>
    Effect.gen(function* aliasedDeclaration() {
      expect(
        yield* freezeViolations({
          [alphaManifest]: freezeManifest(alphaName, { dependencies: { 'beta-alias': range } }),
          [alphaUsesBeta]: "import { beta } from 'beta-alias/shared';\n",
        }),
      ).toEqual([
        unlisted(
          moduleToModule,
          alphaToBetaEdge,
          'runtime',
          `${alphaManifest} dependencies; ${alphaUsesBeta}:1`,
          `${alphaManifest}:1`,
        ),
      ]);
    }),
  );
}

it.live('resolves a declared name to what it installs, not to the workspace package of that name', () =>
  Effect.gen(function* aliasedAway() {
    expect(
      yield* freezeViolations({
        [alphaManifest]: freezeManifest(alphaName, { dependencies: { '@app/beta': 'npm:left-pad@1.3.0' } }),
        [alphaUsesBeta]: betaImportSource,
      }),
    ).toEqual([]);
  }),
);

it.live('resolves a package imports entry to every target it maps a # specifier to', () =>
  Effect.gen(function* subpathImports() {
    const subpathFile = 'verticals/alpha/src/subpath.ts';
    expect(
      yield* freezeViolations({
        [alphaManifest]: JSON.stringify({
          imports: {
            '#beta': { default: '@app/beta', node: './src/own.ts' },
            '#peer/*': '../beta/src/*.ts',
          },
          name: alphaName,
        }),
        [subpathFile]:
          "import { beta } from '#beta';\nimport { peer } from '#peer/index';\nimport { own } from '#own';\n",
      }),
    ).toEqual([unlisted(moduleToModule, alphaToBetaEdge, 'runtime', `${subpathFile}:1,2`, `${subpathFile}:1`)]);
  }),
);

it.live('resolves a bare specifier through the root package.json when its own package does not declare it', () =>
  Effect.gen(function* rootDeclaration() {
    expect(
      yield* freezeViolations({
        [alphaUsesBeta]: "import { beta } from 'peer';\n",
        'package.json': JSON.stringify({ devDependencies: { peer: 'workspace:@app/beta@*' }, name: 'workspace-root' }),
      }),
    ).toEqual(betaRuntimeEdge(`${alphaUsesBeta}:1`));
  }),
);

it.live('selects the imports entry Node selects: the exact key, else the pattern with the longest prefix', () =>
  Effect.gen(function* subpathPrecedence() {
    const subpaths = 'verticals/alpha/src/subpaths.ts';
    expect(
      yield* freezeViolations({
        [alphaManifest]: JSON.stringify({
          imports: { '#*': '@app/beta', '#own': './src/own.ts', '#peer/*': './src/peer/*.ts' },
          name: alphaName,
        }),
        [subpaths]: "import { own } from '#own';\nimport { peer } from '#peer/x';\nimport { beta } from '#beta';\n",
      }),
    ).toEqual(betaRuntimeEdge(`${subpaths}:3`));
  }),
);

/** A Git repository at root whose one commit holds the freeze workspace with files; root is its top. */
const trackedRepository = (files: FreezeFiles) =>
  Effect.gen(function* trackedRepositoryProgram() {
    const root = yield* freezeRoot(files);
    for (const args of [
      ['init', '--quiet'],
      ['add', '--all'],
      ['commit', '--quiet', '-m', 'tracked'],
    ]) {
      execFileSync(
        '/usr/bin/git',
        ['-c', 'user.name=Lean Core test', '-c', 'user.email=lean-core@example.invalid', ...args],
        { cwd: root },
      );
    }
    return root;
  });

/** The commit under judgment: a Core package, the freeze workspace and committed build output it never reads. */
const committedTree = {
  ...freezeBaseline([]),
  'packages/core-runtime/package.json': JSON.stringify({
    dependencies: { effect: '4.0.7' },
    name: '@app/core-runtime',
  }),
  'packages/core-runtime/src/index.ts': "export { Effect } from 'effect';\n",
  'verticals/alpha/dist/bundle.js': betaImportSource,
} as const;

/** What module contract generation writes beside the check: a bundle directory inside a vertical, and more. */
const transientDirectory = 'verticals/alpha/.ontos-contract-a1b2c3';
const transientFiles = {
  [`${transientDirectory}/bundle.mjs`]: betaImportSource,
  [`${transientDirectory}/entry.mts`]: 'export const = ;\n',
  'packages/core-runtime/src/transient.ts': "import { z } from 'zod';\n",
} as const;

const checkerEntryPoint = fileURLToPath(new URL('../check-lean-core-dependencies.mts', import.meta.url));
/** Runs lean-core:check as CI does, from the root of the tree it judges. */
const runCheck = (root: string) => spawnSync(process.execPath, [checkerEntryPoint], { cwd: root, encoding: 'utf-8' });

it.live('judges only the files Git tracks: files written beside the check neither change the result nor fail it', () =>
  Effect.gen(function* untrackedFiles() {
    const root = yield* trackedRepository(committedTree);
    yield* writeFreezeFiles(root, transientFiles);
    const run = runCheck(root);
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
    expect(run.stdout).toContain('Lean-Core dependency boundaries verified');
  }),
);

it.live('does not read a file that disappears between the listing and the read', () =>
  Effect.gen(function* vanishingFile() {
    const root = yield* trackedRepository(committedTree);
    yield* writeFreezeFiles(root, transientFiles);
    // The generator removes its bundle directory while the check runs: here, right after the listing.
    const listing = (listed: string) =>
      trackedFiles(listed).pipe(
        Effect.tap(() =>
          Effect.promise(() => rm(path.join(root, transientDirectory), { force: true, recursive: true })),
        ),
      );
    const leanCore = yield* checkLeanCoreDependencies(root, listing).pipe(Effect.provide(NodeServices.layer));
    yield* writeFreezeFiles(root, transientFiles);
    const freeze = yield* checkModuleEdgeFreeze(root, { files: listing }).pipe(Effect.provide(NodeServices.layer));
    expect({ freeze: freeze.violations, leanCore }).toEqual({ freeze: [], leanCore: [] });
  }),
);

it.live('fails loudly, naming the file, when a tracked file cannot be read', () =>
  Effect.gen(function* unreadableTrackedFile() {
    const gone = 'verticals/alpha/src/gone.ts';
    const root = yield* trackedRepository({ ...committedTree, [gone]: betaImportSource });
    yield* Effect.promise(() => rm(path.join(root, gone)));
    const run = runCheck(root);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(gone);
    // Each check fails on its own: neither skips the file.
    const failures = yield* Effect.all([
      checkLeanCoreDependencies(root, trackedFiles).pipe(Effect.flip),
      checkModuleEdgeFreeze(root, { files: trackedFiles }).pipe(Effect.flip),
    ]).pipe(Effect.provide(NodeServices.layer));
    expect(failures.map(({ message }) => message.includes(gone))).toEqual([true, true]);
  }),
);

it.live('fails, rather than reading nothing, when Git cannot list the tracked files', () =>
  Effect.gen(function* notARepository() {
    const root = yield* freezeRoot(committedTree);
    const failure = yield* trackedFiles(root).pipe(Effect.provide(NodeServices.layer), Effect.flip);
    expect(failure.message).toContain('git ls-files exited with');
  }),
);

it.live("passes today's tree against its committed baseline", () =>
  Effect.gen(function* todaysTree() {
    const report = yield* checkModuleEdgeFreeze(fileURLToPath(new URL('../..', import.meta.url)), {
      files: trackedFiles,
    }).pipe(Effect.provide(NodeServices.layer));
    expect(report.violations).toEqual([]);
  }),
);
