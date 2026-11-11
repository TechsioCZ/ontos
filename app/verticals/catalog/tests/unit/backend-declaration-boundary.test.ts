import {
  defineOntosModuleManifest,
  defineVerticalRuntimeRegistration,
  extractVerticalRuntimeSafeDescriptors,
  getVerticalRuntimeActions,
  getVerticalRuntimeEntrypoints,
  getVerticalRuntimeOutboxWorkers,
} from '@app/core-runtime';
import { NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import { Effect, Layer, Path, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'effect-rstest';
import { catalogManifest as manifest } from '../../vertical.manifest.ts';
import { catalogRegistration as registration } from '../../vertical.registration.ts';
import {
  catalogBackendRegistration as backendRegistration,
  catalogRuntimeDeclaration as declaration,
  catalogRuntimeManifest as runtimeManifest,
} from '../../vertical.runtime-declaration.ts';
import { CatalogWidget } from '../../src/components/catalog-widget.tsx';
import { selectionEvidenceRead } from '../../src/api/selection-evidence.read.ts';
import { quantityPreparationRead } from '../../src/api/quantity-preparation.read.ts';
import { quantityBasisCompatibilityRead } from '../../src/api/quantity-basis-compatibility.read.ts';
import { pricingPurposeEquivalenceRead } from '../../src/api/pricing-purpose-equivalence.read.ts';
import { productVariantSnapshotRead } from '../../src/api/product-variant-snapshot.read.ts';
import { manufacturerRelationCurrentRead } from '../../src/api/manufacturer-relation-current.read.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));

describe('Catalog backend declaration and full publication', () => {
  it('shares genuine private Action, Read and Worker identities with the full registration', () => {
    expect(declaration.manifest).toBe(runtimeManifest);
    expect(declaration.actions).toBe(runtimeManifest.publicSurface.actions);
    const backendActions = getVerticalRuntimeActions(backendRegistration);
    const fullActions = getVerticalRuntimeActions(registration);
    expect(backendActions).toHaveLength(82);
    expect(fullActions).toHaveLength(backendActions.length);
    for (const [index, action] of backendActions.entries()) {
      expect(action).toBe(fullActions[index]);
      expect(action).toBe(manifest.publicSurface.actions[index]);
    }
    const backendWorkers = getVerticalRuntimeOutboxWorkers(backendRegistration);
    const fullWorkers = getVerticalRuntimeOutboxWorkers(registration);
    expect(backendWorkers).toHaveLength(0);
    expect(fullWorkers).toHaveLength(backendWorkers.length);
    for (const [index, worker] of backendWorkers.entries()) {
      expect(worker).toBe(fullWorkers[index]);
    }
    const reads = [
      selectionEvidenceRead,
      quantityPreparationRead,
      quantityBasisCompatibilityRead,
      pricingPurposeEquivalenceRead,
      productVariantSnapshotRead,
      manufacturerRelationCurrentRead,
    ];
    expect(declaration.reads).toHaveLength(reads.length);
    for (const [index, read] of reads.entries()) {
      expect(declaration.reads?.[index]).toBe(read);
    }
    for (const binding of runtimeManifest.publicSurface.operationContracts ?? []) {
      expect([...declaration.actions, ...(declaration.reads ?? [])]).toContain(binding.registration);
    }
    // Real public Read bindings cannot be satisfied by an empty private Read inventory.
    expect(() => defineVerticalRuntimeRegistration({ ...declaration, reads: [] })).toThrow();
    expect(extractVerticalRuntimeSafeDescriptors(backendRegistration)).toEqual(
      extractVerticalRuntimeSafeDescriptors(registration),
    );
  });

  it('retains the complete frontend publication and actual component exports', () => {
    expect(manifest.publicSurface.components).toEqual({
      'catalog-widget': CatalogWidget,
    });
    expect(manifest.publicSurface.resourceTypes).toHaveLength(11);
    expect(new Set(Object.keys(manifest.publicSurface))).toEqual(
      new Set([
        'actions',
        'api',
        'businessPermissions',
        'components',
        'events',
        'mcp',
        'operationContracts',
        'reports',
        'resourceTypes',
        'search',
        'shellContributions',
      ]),
    );
    expect(manifest.publicSurface.api).toEqual(runtimeManifest.publicSurface.api);
    expect(manifest.publicSurface.operationContracts).toEqual(runtimeManifest.publicSurface.operationContracts);
    expect(manifest.publicSurface.shellContributions).toEqual(runtimeManifest.publicSurface.shellContributions);
    expect(manifest.requirements).toEqual(runtimeManifest.requirements);
    const entrypoints = getVerticalRuntimeEntrypoints(registration);
    for (const key of Object.keys(manifest.publicSurface.components)) {
      expect(entrypoints.pages[key] ?? entrypoints.components[key]).toBeTypeOf('function');
    }
    expect(new Set(Object.keys(runtimeManifest.publicSurface))).toEqual(
      new Set(['actions', 'api', 'operationContracts', 'shellContributions']),
    );
  });

  it('still validates cookie and external identity provider declarations on the full manifest', () => {
    const cookie = {
      cookieNames: ['portal.session'],
      realmPrefix: 'portal',
      routes: [{ method: 'POST', path: '/api/sign-in' }],
    } as const;
    const provider = {
      admissionDeadlineMs: 1000,
      authenticationNamespaceId: 'commerce.catalog.customer',
      provider: 'commerce.catalog.identity',
      verification: { operation: 'verify', path: '/identity/verify' },
    };
    const full = defineOntosModuleManifest({
      ...manifest,
      publicSurface: {
        ...manifest.publicSurface,
        apiCookieTransport: [cookie],
        externalIdentityProviders: [provider],
      },
    });
    expect(full.publicSurface.components).toEqual(manifest.publicSurface.components);
    expect(full.publicSurface.apiCookieTransport).toEqual([cookie]);
    expect(full.publicSurface.externalIdentityProviders).toEqual([provider]);
    expect(() =>
      defineOntosModuleManifest({
        ...manifest,
        publicSurface: {
          ...manifest.publicSurface,
          apiCookieTransport: [{ ...cookie, cookieNames: ['shell.session'], realmPrefix: 'shell' }],
        },
      }),
    ).toThrow();
    expect(() =>
      defineOntosModuleManifest({
        ...manifest,
        publicSurface: {
          ...manifest.publicSurface,
          externalIdentityProviders: [{ ...provider, admissionDeadlineMs: 0 }],
        },
      }),
    ).toThrow();
  });
});

// Cold CI imports exceeded the default 5s; bound this native child separately.
// Interruption closes its scope and terminates the owned process.
it.effect(
  'imports the real backend declaration in native Node without a JSX loader',
  () =>
    Effect.scoped(
      Effect.gen(function* importNativeBackend() {
        const path = yield* Path.Path;
        const ownerUrl = pathToFileURL(path.join(process.cwd(), 'vertical.runtime-declaration.ts')).href;
        const child = yield* ChildProcess.make(
          process.execPath,
          [
            // Main's .19 packaging leaves this owner's package.json typeless, so Node names the ESM reparse of the
            // declaration source; only that notice is silenced, every other diagnostic still fails the import.
            '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
            '--input-type=module',
            '--eval',
            "const owner = await import(process.argv[1]); const core = await import('@app/core-runtime'); console.log(JSON.stringify(core.extractVerticalRuntimeSafeDescriptors(owner.catalogBackendRegistration)));",
            ownerUrl,
          ],
          { cwd: process.cwd(), stderr: 'pipe', stdin: 'ignore', stdout: 'pipe' },
        );
        const [code, stdout, stderr] = yield* Effect.all(
          [
            child.exitCode,
            child.stdout.pipe(Stream.decodeText, Stream.mkString),
            child.stderr.pipe(Stream.decodeText, Stream.mkString),
          ],
          { concurrency: 3 },
        );
        expect(code, `Native backend import exited with ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
        expect(stderr).toBe('');
        expect(stdout.trim()).toBe(JSON.stringify(extractVerticalRuntimeSafeDescriptors(registration)));
      }),
    ).pipe(Effect.provide(nativeServices)),
  { timeout: 30_000 },
);
