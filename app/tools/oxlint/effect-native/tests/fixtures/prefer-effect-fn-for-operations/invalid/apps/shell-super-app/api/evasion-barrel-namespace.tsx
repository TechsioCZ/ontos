// expect-count: 2
import * as Edge from "@modern-js/plugin-bff/effect-edge";
import { Effect as BffEffect } from "@modern-js/plugin-bff/effect-edge";

/** Namespace import of the BFF barrel: `Edge.Effect.gen` is the same handler anti-pattern. */
export const loadPanel = (tenantId: string) =>
	Edge.Effect.gen(function* () {
		yield* Edge.Effect.log(tenantId);
	});

/** Aliased named specifier off the same barrel. */
export const savePanel = (input: { readonly id: string }) =>
	BffEffect.gen(function* () {
		yield* BffEffect.log(input.id);
	});

export const Panel = (props: { readonly title: string }) => <section>{props.title}</section>;
