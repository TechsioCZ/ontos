// expect-count: 4
// Deep submodule namespace import, computed member access, optional chaining, `as` casts and a
// module-scope alias chain — all the same shape-free document contract.
import * as EffectSchema from 'effect/unstable/schema/Schema';

const Json = EffectSchema.Json;
const ModuleFederationManifest = EffectSchema['Record'](EffectSchema.String, Json);

export const decodeManifest = (raw: unknown) =>
  EffectSchema?.decodeUnknownSync(ModuleFederationManifest as never)(raw);

export const decodeOverlay = EffectSchema.decodeUnknownSync(
  EffectSchema.NullOr(EffectSchema.Array(Json)),
);
