// False-positive probe: the Effect root barrel reached through a namespace import
// (`import * as Effect from "effect"` → `Effect.Schema.is`). Sibling rules in this plugin
// (`no-interface-first-codec`, `no-sync-schema-codec`, `no-layer-provide-in-library`, …) all resolve
// this shape; the delegation is to the owning Schema exactly as `Schema.is(S)(x)` is.
import * as Effect from 'effect';

export const PolicySchema = Effect.Schema.Struct({ id: Effect.Schema.String });
export type Policy = typeof PolicySchema.Type;

export const isPolicy = (value: unknown): value is Policy => Effect.Schema.is(PolicySchema)(value);
