import {
  ActiveApplicationCompositionUnavailableError,
  loadActiveApplicationComposition,
  makeActiveApplicationCompositionService,
} from '@app/core-runtime';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeModuleContractFixture } from '../../../../packages/core-runtime/src/testing/module-contract.ts';
import { CapturedShellCompositionCatalog, narrowToCapturedRelease } from '../../api/modules/captured-shell-catalog.ts';
import { makeInstalledModuleCatalogLoader } from '../../api/modules/installed-module-catalog.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';

const property = () => makeModuleContractFixture({ appId: 'property-registry', moduleId: 'property.registry' });
const documents = () => makeModuleContractFixture({ appId: 'documents-center', moduleId: 'documents.center' });

it.effect('admits a Shell-hosted read only for the release its request captured', () =>
  Effect.gen(function* capturedReleaseOnly() {
    const captured = yield* makeCompositionSnapshot([property()]);
    const changed = yield* makeCompositionSnapshot([property(), documents()]);
    expect(changed.composition.revision).not.toBe(captured.composition.revision);
    const capturedCatalog = yield* makeInstalledModuleCatalogLoader(Effect.succeed(captured));
    let current = captured;
    const authority = narrowToCapturedRelease(makeActiveApplicationCompositionService(Effect.sync(() => current)));
    const inRequest = Effect.provideService(CapturedShellCompositionCatalog, capturedCatalog);
    expect((yield* inRequest(loadActiveApplicationComposition(authority))).composition.revision).toBe(
      captured.composition.revision,
    );
    current = changed;
    const moved = yield* Effect.flip(inRequest(loadActiveApplicationComposition(authority)));
    expect(moved).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
    expect(moved.reason).toBe('The Shell request release changed');
    current = captured;
    expect((yield* Effect.flip(loadActiveApplicationComposition(authority))).reason).toBe(
      'The Shell request release is unavailable',
    );
  }),
);

it.effect('does not let a copy of the service answer for the release pin', () =>
  Effect.gen(function* forgedNarrowKeepsThePin() {
    const captured = yield* makeCompositionSnapshot([property()]);
    const changed = yield* makeCompositionSnapshot([property(), documents()]);
    const capturedCatalog = yield* makeInstalledModuleCatalogLoader(Effect.succeed(captured));
    const built = makeActiveApplicationCompositionService(Effect.succeed(changed));
    const inRequest = Effect.provideService(CapturedShellCompositionCatalog, capturedCatalog);
    const unpinned = { narrow: () => built };
    const assigned = Object.assign(unpinned, built);
    const proxy = new Proxy(built, { get: (_target, key) => (key === 'narrow' ? unpinned.narrow : undefined) });
    for (const copy of [assigned, proxy]) {
      const refused = yield* Effect.flip(inRequest(loadActiveApplicationComposition(narrowToCapturedRelease(copy))));
      expect(refused).toBeInstanceOf(ActiveApplicationCompositionUnavailableError);
      expect(refused.cause).toBe('The service was not built by the Active Application Composition module');
    }
    const honest = yield* Effect.flip(inRequest(loadActiveApplicationComposition(narrowToCapturedRelease(built))));
    expect(honest.reason).toBe('The Shell request release changed');
  }),
);
