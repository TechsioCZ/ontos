// expect-count: 3
// Evasion probe: generators nested inside a class property arrow, a nested arrow inside a method,
// and a decorated method — all in a TSX file.
import { Effect } from "effect";

declare const decorate: (target: unknown, key: unknown) => void;
declare const registry: { readonly manifestFor: (id: string) => Effect.Effect<string> };
declare const assets: { readonly bundleFor: (id: string) => Effect.Effect<string> };

export class EntrypointLoader {
	readonly load = (id: string) =>
		Effect.gen(function* () {
			const manifest = yield* registry.manifestFor(id);
			const bundle = yield* assets.bundleFor(id);
			return { bundle, manifest };
		});

	nested(id: string) {
		const inner = () =>
			Effect.fn("inner")(function* () {
				const manifest = yield* registry.manifestFor(id);
				const bundle = yield* assets.bundleFor(id);
				return { bundle, manifest };
			});
		return inner();
	}

	@decorate
	decorated(id: string) {
		return Effect.gen(function* () {
			const manifest = yield* registry.manifestFor(id);
			const bundle = yield* assets.bundleFor(id);
			return { bundle, manifest };
		});
	}
}

export const Badge = () => <span>{"loader"}</span>;
