// expect-count: 1
// Evasion probe: multi-segment callees (`deps.gateway.readCustomer`) and template-literal arguments
// must not hide independence, and `var` / `let` bindings are candidates like `const`.
import { Effect } from "effect";

declare const deps: { readonly gateway: { readonly readCustomer: (id: string) => Effect.Effect<string> } };
declare const registry: { readonly ares: { readonly readSubject: (ico: string) => Effect.Effect<string> } };

export const load = (id: string) =>
	Effect.gen(function* () {
		let customer = yield* deps.gateway.readCustomer(`customer-${id}`);
		var subject = yield* registry.ares.readSubject(`ico-${id}`);
		return { customer, subject };
	});
