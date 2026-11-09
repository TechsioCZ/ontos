import { canonicalOntosPublicApiKey, extractVerticalRuntimeSafeDescriptors } from '@app/core-runtime';
import { Effect, FileSystem, Schema } from 'effect';

import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { partyRegistryManifest } from '../../vertical.manifest.ts';
import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';

class PartySourceComponentUnavailable extends Schema.TaggedError<PartySourceComponentUnavailable>()(
  'PartySourceComponentUnavailable',
  {},
) {}

/** SOURCE metadata comes from the owner's bindings and declared exposures, never its React functions. */
export const partySourceComponentContracts = Effect.fn('PartySourceComponents.contracts')(function* contracts() {
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
    return yield* new PartySourceComponentUnavailable();
  }
  const mfBoundaryId = placement.moduleFederation.name;
  // The topology list is a route-level view; the actual component source of truth is the module
  // federation config the deployment build consumes.
  const configuration = yield* fs.readFileString(
    new URL('../../module-federation.config.ts', import.meta.url).pathname,
  );
  const declaredExposes = new Set<string>();
  for (const match of configuration.matchAll(
    /['"](?<key>\.\/[A-Za-z][A-Za-z0-9._-]*(?:\/[A-Za-z][A-Za-z0-9._-]*)*)['"]\s*:\s*['"][^'"]+['"]/gu,
  )) {
    const declaredExpose = match.groups?.['key'];
    if (declaredExpose !== undefined) {
      declaredExposes.add(declaredExpose);
    }
  }
  const owner = yield* Effect.try({
    catch: () => new PartySourceComponentUnavailable(),
    try: () => extractVerticalRuntimeSafeDescriptors(partyRegistryBackendRegistration),
  });
  const bindings = [...owner.shellContributions.pages, ...owner.shellContributions.publicComponents];
  return yield* Effect.forEach(Object.keys(partyRegistryManifest.publicSurface.components), (localKey) => {
    const key = canonicalOntosPublicApiKey(owner.moduleId, localKey);
    const selectors = new Set(bindings.filter((binding) => binding.componentKey === key).map(({ expose }) => expose));
    const [expose] = selectors;
    if (selectors.size !== 1 || expose === undefined || !declaredExposes.has(expose)) {
      return Effect.fail(new PartySourceComponentUnavailable());
    }
    return Effect.succeed({ expose, key, mfBoundaryId });
  });
});
