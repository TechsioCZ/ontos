import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import type { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { checkLeanCoreDependencies } from '../check-lean-core-dependencies.mts';

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
        // Market Catalog: allowed exact owner-client composition seam.
        'verticals/commerce-market-catalog/src/integrations/market-subject-restrictions.ts':
          "import { execute } from '@app/commerce-customer-context/api/market-subject-restrictions-current/client';\n",
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
        'packages/core-runtime/src/auth/allowed-unstable.ts': "import { Foo } from 'effect/unstable/bar';\n",
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
        'verticals/commerce-customer-context/package.json': JSON.stringify({
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
        // The narrow owner client is accepted only at the exact documented Market composition seam.
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
      const violations = yield* checkLeanCoreDependencies(root).pipe(Effect.provide(NodeServices.layer));
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
      'packages/core-runtime/package.json': JSON.stringify({ dependencies: { effect: '^4.0.0' } }),
      'packages/core-runtime/src/index.ts': "import { Effect } from 'effect';\n",
      'verticals/commerce-customer-context/package.json': JSON.stringify({
        exports: { './api/client': './src/api/client.ts' },
      }),
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
    const violations = yield* checkLeanCoreDependencies(root).pipe(Effect.provide(NodeServices.layer));
    expect(violations).toEqual([]);
  }),
);

const nodeDriverSource = [
  "import { Readable } from 'node:stream';",
  "import { ReadableStream } from 'node:stream/web';",
  "import { request } from '@effect/platform-node/Undici';",
  'export const driver = [Readable, ReadableStream, request];',
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
      const violations = yield* checkLeanCoreDependencies(root).pipe(Effect.provide(NodeServices.layer));
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
