// expect-count: 2
import { Effect, HttpApiBuilder } from "@modern-js/plugin-bff/effect-edge";

declare const ShellAuthenticationApi: never;
declare const problem: (error: unknown) => unknown;

/**
 * The Modern.js BFF barrel re-exports the `effect` namespaces verbatim, so these handlers are the
 * same anti-pattern as a direct `import { Effect } from "effect"`.
 */
export const authenticationGroupLive = HttpApiBuilder.group(
	ShellAuthenticationApi,
	"authentication",
	(handlers) =>
		handlers
			.handle("signIn", ({ payload }: { readonly payload: { readonly email: string } }) =>
				Effect.gen(function* () {
					yield* Effect.log(payload.email);
				}).pipe(Effect.mapError(problem)),
			)
			.handle("signOut", ({ request }: { readonly request: { readonly id: string } }) =>
				Effect.gen(function* () {
					yield* Effect.log(request.id);
				}),
			)
			// A zero-argument handler has no arguments to annotate.
			.handle("health", () =>
				Effect.gen(function* () {
					yield* Effect.log("ok");
				}),
			),
);
