import { Context, Effect, Schema } from "effect";

/** A local class that merely happens to be called `Layer` is not `effect`'s Layer. */
class Layer {
  readonly name = "local";
}

// Effect's own namespaced types are library types, never injected application dependencies.
export const describe = (
  tag: Context.Tag<never, never>,
  codec: Schema.Codec<string>,
  program: Effect.Effect<string>,
  local: Layer,
) => [tag, codec, program, local];

// Records of non-Effect operations are ordinary callback bags, not services.
export const render = (handlers: {
  readonly onSelect: (id: string) => void;
  readonly onClose: () => void;
}) => handlers;

// Configuration-only option bags stay allowed.
export interface RuntimeOptions {
  readonly timeoutMillis: number;
  readonly onStage?: (stage: string) => void;
}
export const boot = (options: RuntimeOptions) => options.timeoutMillis;
