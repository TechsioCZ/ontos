import { ActiveApplicationCompositionUnavailableError } from '@app/core-runtime';
import { DateTime, Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it, rstest } from 'effect-rstest';

import { makeModuleContractFixture } from '../../../../packages/core-runtime/src/testing/module-contract.ts';
import {
  installedModuleCatalog,
  InstalledModuleCatalogUnavailableError,
  makeInstalledModuleCatalogLayer,
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../api/modules/installed-module-catalog.ts';
import { contentDigest, makeCompositionSnapshot, sealComposition } from '../fixtures/application-composition.ts';

const contract = (appId: string, moduleId: string) => makeModuleContractFixture({ appId, moduleId });
const property = () => contract('property-registry', 'property.registry');
const documents = () => contract('documents-center', 'documents.center');

it.effect('loads the complete approved documents without contacting module deployments', () =>
  Effect.gen(function* approvedDocuments() {
    const snapshot = yield* makeCompositionSnapshot([property(), documents()]);
    const fetch = rstest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('module deployments are offline'));
    try {
      const catalog = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
      expect(catalog.moduleIds).toEqual(['documents.center', 'property.registry']);
      expect(catalog.getByDeploymentAppId('property-registry')?.manifest.module.id).toBe('property.registry');
      expect(catalog.getByModuleId('property.registry')?.deployment.appId).toBe('property-registry');
      expect(catalog.composition.revision).toBe(snapshot.composition.revision);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  }),
);

it.effect('observes the next approved revision through the same Layer without retaining an earlier catalog', () =>
  Effect.gen(function* freshRevision() {
    const firstSnapshot = yield* makeCompositionSnapshot([property()]);
    const nextSnapshot = yield* makeCompositionSnapshot([property(), documents()]);
    let current = firstSnapshot;
    let reads = 0;
    const layer = makeInstalledModuleCatalogLayer(
      Effect.sync(() => {
        reads += 1;
        return current;
      }),
    );
    const first = yield* installedModuleCatalog.pipe(Effect.provide(layer));
    current = nextSnapshot;
    const next = yield* installedModuleCatalog.pipe(Effect.provide(layer));
    expect(first.moduleIds).toEqual(['property.registry']);
    expect(next.moduleIds).toEqual(['documents.center', 'property.registry']);
    expect(next.composition.revision).not.toBe(first.composition.revision);
    expect(reads).toBe(2);
  }),
);

it.effect('fails closed when approved source disappears instead of using the previous valid catalog', () =>
  Effect.gen(function* noRetainedFallback() {
    const snapshot = yield* makeCompositionSnapshot([property()]);
    let available = true;
    const loader = makeInstalledModuleCatalogLoader(
      Effect.suspend(() =>
        available
          ? Effect.succeed(snapshot)
          : Effect.fail(new ActiveApplicationCompositionUnavailableError({ reason: 'authority unavailable' })),
      ),
    );
    expect((yield* loader).moduleIds).toEqual(['property.registry']);
    available = false;
    expect(yield* Effect.flip(loader)).toBeInstanceOf(InstalledModuleCatalogUnavailableError);
    available = true;
    expect((yield* loader).moduleIds).toEqual(['property.registry']);
  }),
);

it.effect('rejects changed embedded bytes even when the outer revision is resealed', () =>
  Effect.gen(function* pinnedBytes() {
    const snapshot = yield* makeCompositionSnapshot([property()]);
    const [module] = snapshot.composition.modules;
    if (module === undefined) {
      throw new Error('missing fixture module');
    }
    const changed = sealComposition({
      ...snapshot.composition,
      modules: [{ ...module, contractDocument: `${module.contractDocument}\n` }],
    });
    const error = yield* Effect.flip(
      makeInstalledModuleCatalogLoader(Effect.succeed({ ...snapshot, composition: changed })),
    );
    expect(error).toBeInstanceOf(InstalledModuleCatalogUnavailableError);
  }),
);

it.effect('rejects an internally hashed document that contradicts the approved module identity', () =>
  Effect.gen(function* contradictoryIdentity() {
    const snapshot = yield* makeCompositionSnapshot([property()]);
    const [module] = snapshot.composition.modules;
    if (module === undefined) {
      throw new Error('missing fixture module');
    }
    const contractDocument = JSON.stringify(contract('other-deployment', 'property.registry'));
    const digest = contentDigest(contractDocument);
    const changed = sealComposition({
      ...snapshot.composition,
      modules: [
        {
          ...module,
          contract: { ...module.contract, sha256: digest },
          contractDocument,
          publicContract: { ...module.publicContract, sha256: digest },
        },
      ],
    });
    expect(
      yield* Effect.flip(makeInstalledModuleCatalogLoader(Effect.succeed({ ...snapshot, composition: changed }))),
    ).toBeInstanceOf(InstalledModuleCatalogUnavailableError);
  }),
);

it.effect('requires authority to be valid now, with neither future observations nor expired fallback', () =>
  Effect.gen(function* authorityWindow() {
    const snapshot = yield* makeCompositionSnapshot([property()]);
    const now = yield* TestClock.testClockWith((clock) => clock.currentTimeMillis);
    const invalidWindows = [
      { observedAt: DateTime.makeUnsafe(now - 60_000), validUntil: DateTime.makeUnsafe(now) },
      { observedAt: DateTime.makeUnsafe(now + 1000), validUntil: DateTime.makeUnsafe(now + 60_000) },
    ];
    for (const validity of invalidWindows) {
      expect(
        yield* Effect.flip(makeInstalledModuleCatalogLoader(Effect.succeed({ ...snapshot, ...validity }))),
      ).toBeInstanceOf(InstalledModuleCatalogUnavailableError);
    }
  }),
);

it.effect('rechecks expiry after successful admission and resumes only after the same release is freshly renewed', () =>
  Effect.gen(function* expiryAndRenewal() {
    const snapshot = yield* makeCompositionSnapshot([property()], 1000);
    let current = snapshot;
    const loader = makeInstalledModuleCatalogLoader(Effect.sync(() => current));
    expect((yield* loader).composition.revision).toBe(snapshot.composition.revision);
    yield* TestClock.adjust('1 second');
    expect(yield* Effect.flip(loader)).toBeInstanceOf(InstalledModuleCatalogUnavailableError);
    const now = yield* TestClock.testClockWith((clock) => clock.currentTimeMillis);
    current = { ...snapshot, observedAt: DateTime.makeUnsafe(now), validUntil: DateTime.makeUnsafe(now + 1000) };
    expect((yield* loader).composition.revision).toBe(snapshot.composition.revision);
  }),
);

it.effect('acquires the catalog service before authority exists and reports absence only on admission', () =>
  Effect.gen(function* coldBootstrap() {
    let reads = 0;
    const layer = makeInstalledModuleCatalogLayer(
      Effect.suspend(() => {
        reads += 1;
        return Effect.fail(new ActiveApplicationCompositionUnavailableError({ reason: 'not yet published' }));
      }),
    );
    expect(reads).toBe(0);
    yield* ShellInstalledModuleCatalog.pipe(Effect.provide(layer));
    expect(reads).toBe(0);
    const error = yield* Effect.flip(installedModuleCatalog.pipe(Effect.provide(layer)));
    expect(error).toBeInstanceOf(InstalledModuleCatalogUnavailableError);
    expect(reads).toBe(1);
  }),
);

it.effect('rejects a contradictory complete bundle without admitting a healthy subset', () =>
  Effect.gen(function* atomicCatalog() {
    const snapshot = yield* makeCompositionSnapshot([
      property(),
      contract('duplicate-property', 'property.registry'),
      documents(),
    ]);
    expect(yield* Effect.flip(makeInstalledModuleCatalogLoader(Effect.succeed(snapshot)))).toBeInstanceOf(
      InstalledModuleCatalogUnavailableError,
    );
  }),
);
