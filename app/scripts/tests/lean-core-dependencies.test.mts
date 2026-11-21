import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Cause, Effect, Exit } from 'effect';
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
const betaWorkspaceAlias = 'workspace:@app/beta@*';
const unparsableSource = 'export const = ;\n';
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

const freezeBaseline = (
  edges: readonly { readonly class: string; readonly from: string; readonly to: string }[],
  computedLoads: readonly { readonly count: number; readonly file: string }[] = [],
) => ({ [moduleEdgeBaselineRelative]: JSON.stringify({ computedLoads, edges }) }) as const;

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
        'verticals/alpha/src/unreadable.ts': unparsableSource,
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
      `Shrink-only rule: the comparison base ${admitted.baseCommit} has no baseline it reads, so its tree was derived and holds every edge entry with the same or a wider class and at least every computed-load count.`,
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
const renamedCreateRequireImport = "import { createRequire as make } from 'node:module';\n";

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
  [
    'a call of createRequire imported under another name',
    'src/beta-make.ts',
    `${renamedCreateRequireImport}export const beta = make(import.meta.url)('@app/beta');\n`,
    2,
  ],
  [
    'a binding of createRequire imported under another name',
    'src/beta-make-load.ts',
    `${renamedCreateRequireImport}const load = make(import.meta.url);\nexport const beta = load('@app/beta');\n`,
    3,
  ],
  [
    'createRequire of a node:module namespace',
    'src/beta-namespace.ts',
    "import * as nodeModule from 'node:module';\nexport const beta = nodeModule.createRequire(import.meta.url)('@app/beta');\n",
    2,
  ],
  [
    'createRequire required from node:module under another name',
    'src/beta-required-make.cjs',
    "const { createRequire: make } = require('node:module');\nmodule.exports = make(__filename)('@app/beta');\n",
    2,
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
  ['a workspace: alias', betaWorkspaceAlias],
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

/** The violation of a module or package source whose computed loads the baseline does not count in full. */
const computedLoad = (file: string, lines: readonly number[], listedAs = 'does not list it') =>
  `${file}:${lines[0]}: A module or package source makes a computed load unless ${moduleEdgeBaselineRelative} counts it: ${file}:${lines.join(',')} (${lines.length} computed load${lines.length === 1 ? '' : 's'}), and the baseline ${listedAs}; a load whose target the check cannot read can add a package edge nobody sees, so write a static import or a literal import() instead`;
const betaTarget = "const target = '@app/beta';\n";

/** Each use of a loader capability whose target the check cannot read, the file, and the line of the use. */
const computedLoadForms: readonly (readonly [form: string, file: string, source: string, line: number])[] = [
  ['a non-literal import()', 'src/import-target.ts', `${betaTarget}export const beta = await import(target);\n`, 2],
  ['require of a variable', 'src/require-target.ts', `${betaTarget}export const beta = require(target);\n`, 2],
  [
    'module.require of a variable',
    'src/module-require-target.cjs',
    `${betaTarget}module.exports = module.require(target);\n`,
    2,
  ],
  [
    'import.meta.resolve of a variable',
    'src/meta-resolve-target.ts',
    `${betaTarget}export const beta = import.meta.resolve(target);\n`,
    2,
  ],
  [
    'a loader assigned to a binding later',
    'src/assigned-loader.ts',
    `${createRequireImport}let load;\nload = createRequire(import.meta.url);\nexport const beta = load('@app/beta');\n`,
    3,
  ],
  [
    'a member destructured from a loader',
    'src/destructured-loader.ts',
    `${createRequireImport}const { resolve } = createRequire(import.meta.url);\nexport const beta = resolve('@app/beta');\n`,
    2,
  ],
  [
    'a loader called through a sequence',
    'src/sequence-loader.ts',
    "export const beta = (0, require)('@app/beta');\n",
    1,
  ],
  ['a loader stored in an object', 'src/stored-loader.ts', 'export const loaders = { load: require };\n', 1],
  [
    'a renamed loader in a shape the check does not resolve',
    'src/renamed-loader.ts',
    `${renamedCreateRequireImport}const load = make(import.meta.url);\nexport const beta = [load][0]?.('@app/beta');\n`,
    3,
  ],
  [
    'a loader its file exports',
    'src/exported-loader.ts',
    `${createRequireImport}export const load = createRequire(import.meta.url);\n`,
    2,
  ],
  [
    'a loader installed as a global',
    'src/global-loader.ts',
    `${createRequireImport}Object.assign(globalThis, { require: createRequire(import.meta.url) });\n`,
    2,
  ],
  [
    'another member of node:module',
    'src/register-hooks.ts',
    "import { register } from 'node:module';\nregister('./hooks.mjs', import.meta.url);\n",
    2,
  ],
  ['a re-export of node:module', 'src/re-export.ts', "export { createRequire } from 'node:module';\n", 1],
];

for (const [form, relative, source, line] of computedLoadForms) {
  it.live(`freezes ${form} as a computed load`, () =>
    Effect.gen(function* computedLoadForm() {
      const file = `${alphaModule}/${relative}`;
      expect(yield* freezeViolations({ [file]: source })).toEqual([computedLoad(file, [line])]);
      expect(yield* freezeViolations({ [file]: source, ...freezeBaseline([], [{ count: 1, file }]) })).toEqual([]);
    }),
  );
}

const loaderFile = 'verticals/alpha/src/loader.ts';
const againFile = 'verticals/alpha/src/again.ts';
const twoLoads = {
  [loaderFile]: `${betaTarget}export const first = await import(target);\nexport const second = await import(target);\n`,
} as const;
const oneLoad = { [loaderFile]: `${betaTarget}export const first = await import(target);\n` } as const;

it.live('holds the tree to the exact computed-load counts of a sorted baseline section', () =>
  Effect.gen(function* computedLoadCounts() {
    expect(yield* freezeViolations({ ...twoLoads, ...freezeBaseline([], [{ count: 2, file: loaderFile }]) })).toEqual(
      [],
    );
    expect(yield* freezeViolations({ ...twoLoads, ...freezeBaseline([], [{ count: 1, file: loaderFile }]) })).toEqual([
      computedLoad(loaderFile, [2, 3], 'counts 1'),
    ]);
    expect(yield* freezeViolations({ ...twoLoads, ...freezeBaseline([], [{ count: 3, file: loaderFile }]) })).toEqual([
      baselineFile(`Computed-load entry ${loaderFile} counts 3, but the tree has 2: change its count to 2`),
    ]);
    expect(yield* freezeViolations(freezeBaseline([], [{ count: 1, file: loaderFile }]))).toEqual([
      baselineFile(`Computed-load entry ${loaderFile} (1) names a file without computed loads: remove it`),
    ]);
    const both = { ...twoLoads, [againFile]: 'export const again = await import(String(1));\n' };
    expect(
      yield* freezeViolations({
        ...both,
        ...freezeBaseline(
          [],
          [
            { count: 2, file: loaderFile },
            { count: 1, file: againFile },
          ],
        ),
      }),
    ).toEqual([
      baselineFile('Computed-load entry 2 is out of order or repeats a file: entries are sorted by file, one per file'),
    ]);
  }),
);

it.live('counts the computed loads of modules and packages, and none of an app, which may take any edge', () =>
  Effect.gen(function* computedLoadOwners() {
    const packageLoad = 'packages/contracts/src/load.ts';
    expect(
      yield* freezeViolations({
        'apps/shell/src/load.ts': "const target = '@app/alpha';\nexport const alpha = await import(target);\n",
        [packageLoad]: "const target = '@app/alpha';\nexport const alpha = await import(target);\n",
      }),
    ).toEqual([computedLoad(packageLoad, [2])]);
  }),
);

it.live('fails a head baseline that counts more computed loads than its file makes at the comparison base', () =>
  Effect.gen(function* computedLoadsAgainstBase() {
    const entered = yield* comparisonRepository(freezeBaseline([]), {
      ...twoLoads,
      ...freezeBaseline([], [{ count: 2, file: loaderFile }]),
    });
    expect(yield* reportedViolations(entered.root)).toEqual([]);
    expect(yield* reportedViolations(entered.root, entered.baseCommit)).toEqual([
      baselineFile(
        `Computed-load entry ${loaderFile} (2) names a file without computed loads at the comparison base ${entered.baseCommit}: the baseline only shrinks, so no computed load enters it`,
      ),
    ]);
    const grown = yield* comparisonRepository(
      { ...oneLoad, ...freezeBaseline([], [{ count: 1, file: loaderFile }]) },
      { ...twoLoads, ...freezeBaseline([], [{ count: 2, file: loaderFile }]) },
    );
    expect(yield* reportedViolations(grown.root, grown.baseCommit)).toEqual([
      baselineFile(
        `Computed-load entry ${loaderFile} counts 2, but the comparison base ${grown.baseCommit} has 1: the baseline only shrinks, so no count grows`,
      ),
    ]);
    const shrunk = yield* comparisonRepository(
      { ...twoLoads, ...freezeBaseline([], [{ count: 2, file: loaderFile }]) },
      { ...oneLoad, ...freezeBaseline([], [{ count: 1, file: loaderFile }]) },
    );
    expect(yield* reportedViolations(shrunk.root, shrunk.baseCommit)).toEqual([]);
  }),
);

it.live(
  'takes no require member of another object for a loader, and counts a local binding named require as computed',
  () =>
    Effect.gen(function* unrelatedRequire() {
      const store = 'verticals/alpha/src/store.ts';
      expect(
        yield* freezeViolations({
          [store]: `${betaTarget}const store = { require: (name: string) => name };\nexport const beta = store.require('@app/beta');\nexport const local = (require: (name: string) => string) => require(target);\n`,
        }),
      ).toEqual([computedLoad(store, [4, 4])]);
    }),
);

it.live('counts every load of a loader based anywhere but its own file as computed, bare or relative', () =>
  Effect.gen(function* foreignBase() {
    const load = 'verticals/alpha/src/load.mts';
    expect(
      yield* freezeViolations({
        [alphaManifest]: freezeManifest(alphaName, { dependencies: { peer: 'npm:some-third-party@1.0.0' } }),
        [load]:
          "import { createRequire } from 'node:module';\nconst load = createRequire(new URL('../../../package.json', import.meta.url));\nexport const beta = load('peer');\nexport const own = load('./src/index.ts');\n",
        'package.json': JSON.stringify({ devDependencies: { peer: betaWorkspaceAlias }, name: 'workspace-root' }),
      }),
    ).toEqual([computedLoad(load, [3, 4])]);
  }),
);

it.live('counts a recognised load with any argument beyond its one literal as computed', () =>
  Effect.gen(function* extraArguments() {
    const searchPaths = 'verticals/alpha/src/search-paths.cjs';
    const parentUrl = 'verticals/alpha/src/parent-url.ts';
    expect(
      yield* freezeViolations({
        [parentUrl]: "export const beta = import.meta.resolve('./index.ts', 'file:///elsewhere/');\n",
        [searchPaths]: "module.exports = require.resolve('./package.json', { paths: [__dirname + '/../../beta'] });\n",
      }),
    ).toEqual([computedLoad(parentUrl, [1]), computedLoad(searchPaths, [1])]);
  }),
);

/** Helpers outside the one form whose call literals are its loader's targets, each loading @app/beta unseen. */
const helperEscapes: readonly (readonly [form: string, file: string, source: string, line: number])[] = [
  [
    'an erased this parameter that shifts the positions',
    'src/this-load.ts',
    "function load(this: void, a: string, b: string) {\n  return require(a);\n}\nexport const e = load('@app/beta', 'effect');\n",
    2,
  ],
  [
    'an erased this parameter before a relative target',
    'field.ts',
    "function field(this: void, specifier: string, key: string) {\n  return require(specifier)[key];\n}\nexport const version = field('../beta/package.json', 'version');\n",
    2,
  ],
  [
    'a destructured parameter',
    'src/destructured-load.ts',
    "function load({ x }: { x: string }, p: string) {\n  return require(p) + x;\n}\nexport const e = load({ x: '' }, '@app/beta');\n",
    2,
  ],
  [
    'a var that redeclares the parameter',
    'src/var-load.ts',
    "function load(p) {\n  var p = '@app/beta';\n  return require(p);\n}\nexport const e = load('effect');\n",
    3,
  ],
  [
    'a for-of var that redeclares the parameter',
    'src/for-load.ts',
    "function load(p) {\n  for (var p of ['@app/beta']) require(p);\n}\nload('effect');\n",
    2,
  ],
  [
    'an assignment to the parameter through as',
    'src/as-load.ts',
    "const load = (p: string) => {\n  (p as string) = '@app/beta';\n  return require(p);\n};\nexport const e = load('effect');\n",
    3,
  ],
  [
    'an assignment to the parameter through a non-null assertion',
    'src/non-null-load.ts',
    "const load = (p: string) => {\n  p! = '@app/beta';\n  return require(p);\n};\nexport const e = load('effect');\n",
    3,
  ],
  [
    'arguments in a sloppy CommonJS function',
    'src/arguments-load.cjs',
    "function load(p) {\n  arguments[0] = '@app/beta';\n  return require(p);\n}\nmodule.exports = load('effect');\n",
    3,
  ],
  [
    'eval in the function',
    'src/eval-load.ts',
    "function load(p: string) {\n  eval(\"p = '@app/beta'\");\n  return require(p);\n}\nexport const e = load('effect');\n",
    3,
  ],
];

for (const [form, relative, source, line] of helperEscapes) {
  it.live(`keeps the load of a helper with ${form} computed`, () =>
    Effect.gen(function* helperEscape() {
      const file = `${alphaModule}/${relative}`;
      expect(yield* freezeViolations({ [file]: source })).toEqual([computedLoad(file, [line])]);
    }),
  );
}

it.live('keeps the load of a helper with eval anywhere in its file computed', () =>
  Effect.gen(function* fileEval() {
    const file = 'verticals/alpha/src/file-eval.ts';
    expect(
      yield* freezeViolations({
        [file]:
          "function load(p: string) {\n  return require(p);\n}\neval(\"load = () => require('@app/beta')\");\nexport const e = load('effect');\n",
      }),
    ).toEqual([computedLoad(file, [2])]);
  }),
);

const commonJsAlpha = { [alphaManifest]: JSON.stringify({ name: alphaName, type: 'commonjs' }) } as const;
const ownBaseLoader = "const here = require('node:module').createRequire(__filename);\n";
const blockHelper =
  "{\n  function load(p) {\n    return require(p);\n  }\n  load('effect');\n}\nmodule.exports = load('@app/beta');\n";

for (const [variant, file, files] of [
  ['a .cjs source', 'verticals/alpha/src/b.cjs', {}],
  ['a .js source of a commonjs package', 'verticals/alpha/src/b.js', commonJsAlpha],
] as const) {
  it.live(`admits no helper in ${variant}, so a block function's load stays computed`, () =>
    Effect.gen(function* blockFunction() {
      expect(yield* freezeViolations({ ...files, [file]: blockHelper })).toEqual([computedLoad(file, [3])]);
    }),
  );
}

for (const [variant, extra] of [
  ['beside a direct call', "load('node:path');\n"],
  ['as its only other occurrence', ''],
] as const) {
  it.live(`keeps a helper computed whose name a default parameter captures, ${variant}`, () =>
    Effect.gen(function* capturedHelper() {
      const file = 'verticals/alpha/src/capture.js';
      expect(
        yield* freezeViolations({
          ...commonJsAlpha,
          [file]: `${ownBaseLoader}function load(p) {\n  return here(p);\n}\n${extra}function run(read = load) {\n  var load;\n  return read('../../beta/package.json');\n}\nrun();\n`,
        }),
      ).toEqual([computedLoad(file, [3])]);
    }),
  );
}

it.live('trusts no loader of a file with a with statement, so its first load is already computed', () =>
  Effect.gen(function* withStatement() {
    const file = 'verticals/alpha/src/with.js';
    expect(
      yield* freezeViolations({
        ...commonJsAlpha,
        [file]: `${ownBaseLoader}function load(p) {\n  with ({ ['p']: '../../beta/package.json' }) {\n    return here(p);\n  }\n}\nload('effect');\n`,
      }),
    ).toEqual([computedLoad(file, [1])]);
  }),
);

/** Sloppy CommonJS helpers whose caller reaches the loader with a target no call of theirs passes. */
const callerEscapes: readonly (readonly [form: string, source: string, line: number])[] = [
  [
    'hook.caller',
    "function load(p) {\n  hook();\n  return require(p);\n}\nfunction hook() {\n  if (!hook.done) {\n    hook.done = 1;\n    hook.caller('@app/beta');\n  }\n}\nmodule.exports = load('effect');\n",
    3,
  ],
  [
    'arguments.callee.caller',
    "function load(p) {\n  hook();\n  return require(p);\n}\nfunction hook() {\n  if (!arguments.callee.done) {\n    arguments.callee.done = 1;\n    arguments.callee.caller('@app/beta');\n  }\n}\nmodule.exports = load('effect');\n",
    3,
  ],
  [
    'a caller kept for later',
    "let read;\nfunction remember() {\n  read = remember.caller;\n}\nfunction load(p) {\n  remember();\n  return require(p);\n}\nload('node:path');\nread('../../beta/package.json');\n",
    7,
  ],
];

/**
 * Formats that can run as sloppy CommonJS: `.cjs`, `.cts` even with an import, and typeless `.js` and `.ts`
 * without an import or export that stays in the code Node runs once it strips the types; a namespace that
 * holds only types is stripped whole.
 */
const commonJsCapable: readonly (readonly [variant: string, extension: string, prefix: string])[] = [
  ['a .cjs source', '.cjs', ''],
  ['a .cts source', '.cts', ''],
  ['a .cts source with an import', '.cts', "import 'node:path';\n"],
  ['a .js source of a typeless package', '.js', ''],
  ['a .ts source of a typeless package', '.ts', ''],
  ['a .ts source with only a type import', '.ts', "import type { Effect } from 'effect';\n"],
  ['a .ts source that exports only a namespace of types', '.ts', 'export namespace N { export type X = 1 }\n'],
];

for (const [form, source, line] of callerEscapes) {
  for (const [variant, extension, prefix] of commonJsCapable) {
    it.live(`admits no helper in ${variant}, so a load reached through ${form} stays computed`, () =>
      Effect.gen(function* callerEscape() {
        const file = `verticals/alpha/src/b${extension}`;
        expect(yield* freezeViolations({ [file]: `${prefix}${source}` })).toEqual([
          computedLoad(file, [line + (prefix === '' ? 0 : 1)]),
        ]);
      }),
    );
  }
}

it.live('takes a .ts source of a module package as module source, which admits a helper', () =>
  Effect.gen(function* modulePackageHelper() {
    const file = 'verticals/alpha/src/b.ts';
    expect(
      yield* freezeViolations({
        [alphaManifest]: JSON.stringify({ name: alphaName, type: 'module' }),
        [file]: "function load(p: string) {\n  return import.meta.resolve(p);\n}\nload('@app/beta');\n",
      }),
    ).toEqual(betaRuntimeEdge(`${file}:4`));
  }),
);

for (const [variant, extension, prefix] of commonJsCapable) {
  it.live(`takes module for the module object in ${variant}, also passed on under another name`, () =>
    Effect.gen(function* moduleObjectAlias() {
      const file = `verticals/alpha/src/self${extension}`;
      expect(
        yield* freezeViolations({ [file]: `${prefix}const self = module;\nself.require('@app/beta');\n` }),
      ).toEqual(betaRuntimeEdge(`${file}:${prefix === '' ? 2 : 3}`));
    }),
  );
}

const reviewCjs = 'verticals/alpha/src/review.cjs';

it.live('takes every occurrence of a capability name as the capability, and counts each other declaration of it', () =>
  Effect.gen(function* capabilityByName() {
    const review = reviewCjs;
    expect(
      yield* freezeViolations({
        [review]: "function get(v = require('../../beta/package.json')) {\n  var require;\n  return v;\n}\nget();\n",
      }),
    ).toEqual([...betaRuntimeEdge(`${review}:1`), computedLoad(review, [2])]);
  }),
);

it.live(
  'takes module for a capability only where a file can run as CommonJS, and the text module.require for a loader everywhere',
  () =>
    Effect.gen(function* moduleName() {
      const named = 'verticals/alpha/src/module-name.ts';
      expect(
        yield* freezeViolations({
          [named]: "for (const module of [1]) {\n  void module;\n}\nexport const beta = module.require('@app/beta');\n",
        }),
      ).toEqual(betaRuntimeEdge(`${named}:4`));
    }),
);

/** Declarations that would give the free `require` another capability, in a nested scope. */
const freeNameRivals: readonly (readonly [reviewer: string, file: string, source: string, lines: readonly number[]])[] =
  [
    [
      "Sol's nested createRequire",
      reviewCjs,
      "function local() { const require = module.require('node:module').createRequire; }\nconst beta = require('@app/beta');\n",
      [1, 2],
    ],
    [
      "Astra's destructured createRequire",
      reviewCjs,
      "{ const { createRequire: require } = module.require('node:module'); }\nconst beta = require('@app/beta');\n",
      [1, 2],
    ],
    [
      'a destructured createRequire in module source',
      'verticals/alpha/src/review.ts',
      "import 'node:path';\n{ const { createRequire: require } = await import('node:module'); }\nexport const beta = require('@app/beta');\n",
      [2, 3],
    ],
  ];

for (const [reviewer, file, source, lines] of freeNameRivals) {
  it.live(`keeps the free meaning of require beside ${reviewer}, so each reference is a computed load`, () =>
    Effect.gen(function* freeNameRival() {
      expect(yield* freezeViolations({ [file]: source })).toEqual([computedLoad(file, lines)]);
    }),
  );
}

for (const file of ['verticals/alpha/src/own.cjs', 'verticals/alpha/src/own.cts']) {
  it.live(`keeps require a loader where a declaration gives it the free meaning again, in ${file}`, () =>
    Effect.gen(function* sameMeaning() {
      expect(
        yield* freezeViolations({
          [file]: "const require = module.require('node:module').createRequire(__filename);\nrequire('@app/beta');\n",
        }),
      ).toEqual(betaRuntimeEdge(`${file}:2`));
    }),
  );
}

const ownLoad = '{\n  const load = createRequire(import.meta.url);\n}\n';
const foreignLoad = "{\n  const load = createRequire('/elsewhere/');\n}\n";
for (const [order, first, second] of [
  ['own base first', ownLoad, foreignLoad],
  ['foreign base first', foreignLoad, ownLoad],
] as const) {
  it.live(`takes a name two declarations give two capabilities as ambiguous, ${order}`, () =>
    Effect.gen(function* ambiguousName() {
      const file = 'verticals/alpha/src/ambiguous.ts';
      expect(
        yield* freezeViolations({
          [file]: `${createRequireImport}${first}${second}export const beta = load('@app/beta');\n`,
        }),
      ).toEqual([computedLoad(file, [3, 6, 8])]);
    }),
  );
}

it.live('resolves the literals a same-file helper passes to its loader, and counts any other helper as computed', () =>
  Effect.gen(function* helperParameter() {
    const config = 'verticals/alpha/backend-federation.config.ts';
    const exported = 'verticals/alpha/src/exported-helper.ts';
    const reassigned = 'verticals/alpha/src/reassigned-helper.ts';
    const variable = 'verticals/alpha/src/variable-helper.ts';
    const loader = `${createRequireImport}const require = createRequire(import.meta.url);\n`;
    expect(
      yield* freezeViolations({
        [config]: `${loader}const packageVersion = (specifier: string): string => require(specifier).version;\nexport const effectVersion = packageVersion('effect/package.json');\nexport const betaVersion = packageVersion('../beta/package.json');\n`,
        [exported]: `${loader}export const packageVersion = (specifier: string): string => require(specifier).version;\n`,
        [reassigned]: `${loader}const load = (specifier: string) => {\n  specifier += '';\n  return require(specifier);\n};\nexport const effect = load('effect');\n`,
        [variable]: `${loader}const load = (specifier: string) => require(specifier);\nconst name = '../beta/package.json';\nexport const values = [load('effect'), load(name)];\n`,
      }),
    ).toEqual([
      ...betaRuntimeEdge(`${config}:5`),
      computedLoad(exported, [3]),
      computedLoad(reassigned, [5]),
      computedLoad(variable, [3]),
    ]);
  }),
);

it.live('parses a .cjs source as CommonJS, where a top-level return is valid', () =>
  Effect.gen(function* commonJsReturn() {
    const early = 'verticals/alpha/src/early.cjs';
    expect(
      yield* freezeViolations({
        [early]: "if (process.env.SKIP_BETA === '1') {\n  return;\n}\nmodule.exports = require('@app/beta');\n",
      }),
    ).toEqual(betaRuntimeEdge(`${early}:4`));
  }),
);

const betaIndex = "__dirname + '/../../beta/index.cjs'";
const loaderOfFilename = "const load = require('node:module').createRequire(__filename);\nload('./package.json');\n";
/** In a `.cts` source the factory is imported, so the free `require` plays no part. */
const importedLoaderOfFilename = "const load = createRequire(__filename);\nload('./package.json');\n";
const loaderOfMetaUrl = `${createRequireImport}const load = createRequire(import.meta.url);\nload('./package.json');\n`;
const rebasedCjs = 'review.cjs';
const rebasedCts = 'review.cts';
const rebasedMts = 'review.mts';
const namespaceOfTypes = 'export namespace N { export type T = string; }\n';

/**
 * Ways a file gives its own location another value, so that a relative load lands in another package: the
 * source that does it before the loader is made, the file, and the lines of the computed loads.
 */
const rebasedLoaders: readonly (readonly [form: string, file: string, source: string, lines: readonly number[]])[] = [
  ['__filename is assigned', rebasedCjs, `__filename = ${betaIndex};\n${loaderOfFilename}`, [3]],
  ['__filename is declared again', rebasedCjs, `var __filename = ${betaIndex};\n${loaderOfFilename}`, [3]],
  [
    '__filename is assigned in a typeless .ts',
    'review.ts',
    `${namespaceOfTypes}__filename = ${betaIndex};\n${loaderOfFilename}`,
    [4],
  ],
  [
    '__filename is assigned through an array pattern',
    rebasedCjs,
    `[__filename] = [${betaIndex}];\n${loaderOfFilename}`,
    [3],
  ],
  [
    '__filename is assigned through an object pattern',
    rebasedCjs,
    `({ to: __filename } = { to: ${betaIndex} });\n${loaderOfFilename}`,
    [3],
  ],
  ['__filename is the variable of a loop', rebasedCjs, `for (__filename of [${betaIndex}]);\n${loaderOfFilename}`, [3]],
  ['__filename is added to', rebasedCjs, `__filename += '/../../../beta/index.cjs';\n${loaderOfFilename}`, [3]],
  [
    'the wrapper arguments alias __filename',
    rebasedCts,
    `${createRequireImport}arguments[3] = ${betaIndex};\n${importedLoaderOfFilename}`,
    [4],
  ],
  [
    'an eval can assign __filename',
    rebasedCts,
    `${createRequireImport}eval("__filename = ${betaIndex}");\n${importedLoaderOfFilename}`,
    [4],
  ],
  [
    'import.meta.url is assigned',
    rebasedMts,
    `import.meta.url = 'file:///elsewhere/index.mjs';\n${loaderOfMetaUrl}`,
    [4],
  ],
  [
    'import.meta.url is assigned under a cast',
    rebasedMts,
    `(import.meta.url as string) = 'file:///elsewhere/index.mjs';\n${loaderOfMetaUrl}`,
    [4],
  ],
  [
    'import.meta.url is assigned through a pattern',
    rebasedMts,
    `[import.meta.url] = ['file:///elsewhere/index.mjs'];\n${loaderOfMetaUrl}`,
    [4],
  ],
];

for (const [form, name, source, lines] of rebasedLoaders) {
  it.live(`takes a loader for one of another base when ${form}`, () =>
    Effect.gen(function* rebasedLoader() {
      const file = `verticals/alpha/src/${name}`;
      expect(yield* freezeViolations({ [file]: source })).toEqual([computedLoad(file, lines)]);
    }),
  );
}

it.live('keeps a loader based on the file itself where its location is only read', () =>
  Effect.gen(function* readLocation() {
    const meta = 'verticals/alpha/src/read.mts';
    const filename = 'verticals/alpha/src/read.cjs';
    expect(
      yield* freezeViolations({
        [filename]:
          "const dir = require('node:path').dirname(__filename);\nconst load = require('node:module').createRequire(__filename);\nmodule.exports = [dir, load('../../beta/package.json')];\n",
        [meta]: `${createRequireImport}const here = import.meta.url;\nconst from = { dir: import.meta.dirname, from: import.meta.url };\nconst load = createRequire(import.meta.url);\nexport const beta = [here, from, load('../../beta/package.json')];\n`,
      }),
    ).toEqual([unlisted(moduleToModule, alphaToBetaEdge, 'runtime', `${filename}:3; ${meta}:5`, `${filename}:3`)]);
  }),
);

/** Sloppy code that can give the free `require` or `module` another value without writing the name. */
const reboundFreeNames: readonly (readonly [form: string, source: string, lines: readonly number[]])[] = [
  ['the wrapper arguments alias require', "arguments[1] = globalThis.other;\nrequire('./package.json');\n", [2]],
  ['a with statement can shadow require', "with (globalThis.scope) {\n  require('./package.json');\n}\n", [2]],
  ['an eval can assign require', "eval('require = globalThis.other');\nrequire('./package.json');\n", [2]],
  ['the wrapper arguments alias module', "arguments[2] = globalThis.other;\nmodule.require('./package.json');\n", [2]],
];

for (const [form, source, lines] of reboundFreeNames) {
  it.live(`takes a load through a free name for a computed load when ${form}`, () =>
    Effect.gen(function* reboundFreeName() {
      expect(yield* freezeViolations({ [reviewCjs]: source })).toEqual([computedLoad(reviewCjs, lines)]);
    }),
  );
}

it.live('takes every member of module but exports and require for a computed load', () =>
  Effect.gen(function* moduleMembers() {
    expect(
      yield* freezeViolations({
        [reviewCjs]: `module.filename = ${betaIndex};\nmodule.exports = module.require('./package.json');\nmodule.parent.require('@app/beta');\n`,
      }),
    ).toEqual([computedLoad(reviewCjs, [1, 3])]);
  }),
);

for (const extension of ['.cjs', '.cts']) {
  it.live(`parses a ${extension} source as CommonJS only, so a top-level await does not parse`, () =>
    Effect.gen(function* commonJsOnly() {
      const waiting = `verticals/alpha/src/waiting${extension}`;
      expect(yield* freezeViolations({ [waiting]: 'await 0;\n' })).toEqual([
        `${waiting}:1: Workspace source does not parse, so the package edges it makes are unknown`,
      ]);
    }),
  );
}

for (const extension of ['.js', '.jsx']) {
  it.live(`parses a ${extension} source as CommonJS when it does not parse as a module, and only then fails it`, () =>
    Effect.gen(function* commonJsFallback() {
      const early = `verticals/alpha/src/early${extension}`;
      const broken = `verticals/alpha/src/broken${extension}`;
      expect(
        yield* freezeViolations({
          [broken]: unparsableSource,
          [early]: "if (process.env.SKIP_BETA === '1') {\n  return;\n}\nmodule.exports = require('@app/beta');\n",
        }),
      ).toEqual([
        `${broken}:1: Workspace source does not parse, so the package edges it makes are unknown`,
        ...betaRuntimeEdge(`${early}:4`),
      ]);
    }),
  );
}

it.live('parses a .js source of a package of type module as a module only, so a top-level return does not parse', () =>
  Effect.gen(function* modulePackage() {
    const early = 'verticals/alpha/src/early.js';
    expect(
      yield* freezeViolations({
        [alphaManifest]: JSON.stringify({ name: alphaName, type: 'module' }),
        [early]: "if (true) return;\nmodule.exports = require('@app/beta');\n",
      }),
    ).toEqual([`${early}:1: Workspace source does not parse, so the package edges it makes are unknown`]);
  }),
);

it.live('parses a .js source under a nearest package.json of type commonjs as CommonJS, based on the file itself', () =>
  Effect.gen(function* commonJsPackage() {
    const legacy = 'verticals/alpha/legacy/load.js';
    expect(
      yield* freezeViolations({
        [alphaManifest]: JSON.stringify({ name: alphaName, type: 'module' }),
        [legacy]:
          "const { createRequire } = require('node:module');\nmodule.exports = createRequire(__filename)('../../beta/package.json');\n",
        'verticals/alpha/legacy/package.json': JSON.stringify({ type: 'commonjs' }),
      }),
    ).toEqual(betaRuntimeEdge(`${legacy}:2`));
  }),
);

it.live('refuses a computed-load count that is not a positive integer, and an entry for a file without loads', () =>
  Effect.gen(function* computedLoadCountValues() {
    const missing = 'verticals/alpha/src/missing.ts';
    for (const count of [0, -1, 1.5]) {
      const root = yield* freezeRoot(freezeBaseline([], [{ count, file: missing }]));
      const exit = yield* Effect.exit(freezeReport(root));
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause).includes('count')).toBe(true);
    }
    expect(yield* freezeViolations(freezeBaseline([], [{ count: 1, file: missing }]))).toEqual([
      baselineFile(`Computed-load entry ${missing} (1) names a file without computed loads: remove it`),
    ]);
  }),
);

it.live('resolves a bare specifier through the root package.json when its own package does not declare it', () =>
  Effect.gen(function* rootDeclaration() {
    expect(
      yield* freezeViolations({
        [alphaUsesBeta]: "import { beta } from 'peer';\n",
        'package.json': JSON.stringify({ devDependencies: { peer: betaWorkspaceAlias }, name: 'workspace-root' }),
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
  [`${transientDirectory}/entry.mts`]: unparsableSource,
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
