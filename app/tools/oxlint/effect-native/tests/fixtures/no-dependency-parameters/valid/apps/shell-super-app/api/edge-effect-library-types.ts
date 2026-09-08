import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient } from "effect/unstable/http";

interface ContactsGateway {
  readonly list: () => Effect.Effect<string>;
}

// Effect's own namespaced types are library types, never injected application dependencies —
// including `Effect.Service`, whose last identifier matches the dependency pattern.
export const describe = (
  program: Effect.Effect<string>,
  service: Effect.Service<never>,
  tag: Context.Tag<never, never>,
  codec: Schema.Codec<string>,
  client: HttpClient.HttpClient,
) => [program, service, tag, codec, client];

// Requiring the dependency in the `R` channel is the target pattern, not the anti-pattern:
// this parameter *declares* the requirement instead of hiding it.
export const runWith = (effect: Effect.Effect<string, never, ContactsGateway>) => effect;

// A library type inside an option bag is still a library type.
export const boot = (options: {
  readonly label: string;
  readonly client: HttpClient.HttpClient;
  readonly program: Effect.Effect<void>;
}) => options.label;

// Composing at the application root: the layer is built here, not received.
export declare const rootLayer: Layer.Layer<never>;
