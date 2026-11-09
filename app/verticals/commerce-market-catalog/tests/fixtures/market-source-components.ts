import { canonicalOntosPublicApiKey, extractVerticalRuntimeSafeDescriptors } from '@app/core-runtime';
import { Effect, FileSystem, Schema } from 'effect';

import { commerceMarketCatalogManifest } from '../../vertical.manifest.ts';
import { commerceMarketCatalogRegistration } from '../../vertical.registration.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

class MarketSourceComponentUnavailable extends Schema.TaggedError<MarketSourceComponentUnavailable>()(
  'MarketSourceComponentUnavailable',
  {},
) {}

/** SOURCE metadata comes from the owner's bindings and declared exposures, never its React functions. */
export const marketSourceComponentContracts = Effect.fn('MarketSourceComponents.contracts')(function* contracts() {
  const fs = yield* FileSystem.FileSystem;
  const topology = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        verticals: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            moduleFederation: Schema.optionalKey(Schema.Struct({ name: Schema.NonEmptyString })),
          }),
        ),
      }),
    ),
  )(yield* fs.readFileString(new URL('../../../../topology/reference-topology.json', import.meta.url).pathname));
  const placements = topology.verticals.filter(({ id }) => id === ultramodernApiMarker.appId);
  const [placement] = placements;
  if (placements.length !== 1 || placement?.moduleFederation === undefined) {
    return yield* new MarketSourceComponentUnavailable();
  }
  const mfBoundaryId = placement.moduleFederation.name;
  const configuration = yield* fs.readFileString(
    new URL('../../module-federation.config.ts', import.meta.url).pathname,
  );
  const declared = new Set<string>();
  for (const match of configuration.matchAll(
    /['"](?<key>\.\/[A-Za-z][A-Za-z0-9._-]*(?:\/[A-Za-z][A-Za-z0-9._-]*)*)['"]\s*:\s*['"][^'"]+['"]/gu,
  )) {
    if (match.groups?.key !== undefined) {
      declared.add(match.groups.key);
    }
  }
  const owner = yield* Effect.try({
    catch: () => new MarketSourceComponentUnavailable(),
    try: () => extractVerticalRuntimeSafeDescriptors(commerceMarketCatalogRegistration),
  });
  const bindings = [...owner.shellContributions.pages, ...owner.shellContributions.publicComponents];
  return yield* Effect.forEach(Object.keys(commerceMarketCatalogManifest.publicSurface.components), (localKey) => {
    const key = canonicalOntosPublicApiKey(owner.moduleId, localKey);
    const selectors = new Set(bindings.filter((binding) => binding.componentKey === key).map(({ expose }) => expose));
    const [expose] = selectors;
    if (selectors.size !== 1 || expose === undefined || !declared.has(expose)) {
      return Effect.fail(new MarketSourceComponentUnavailable());
    }
    return Effect.succeed({ expose, key, mfBoundaryId });
  });
});
