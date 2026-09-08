/** JSX, generics, `satisfies`, `as const` — and a template that already emits the A3 target shape. */
const RENDERED = `
import { Config, Layer, Redacted, Schema } from 'effect';

const GatewayConfig = Config.schema(
  Schema.Struct({ ONTOS_GATEWAY_PUBLIC_JWKS: Schema.Redacted(Schema.fromJsonString(JsonWebKeySet)) }),
);

export const GatewayLayer = Layer.effect(GatewayTag)(GatewayConfig);
` as const;

export const Preview = <T,>({ items }: { readonly items: readonly T[] }): JSX.Element => (
	<ul>{items.map((item, index) => <li key={index}>{String(item)}</li>)}</ul>
);

export const rendered = RENDERED satisfies string;
