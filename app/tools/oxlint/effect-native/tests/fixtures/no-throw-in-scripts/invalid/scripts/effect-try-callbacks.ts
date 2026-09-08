// expect-count: 3
import { Effect } from "effect";

export const decode = (raw: string): Effect.Effect<unknown, Error> =>
	Effect.try({
		try: () => {
			const parsed: unknown = JSON.parse(raw);
			if (parsed === null) throw new Error("null document");
			return parsed;
		},
		catch: (cause) => new Error(String(cause)),
	});

export const load = (raw: string): Effect.Effect<unknown, Error> =>
	Effect.tryPromise({
		try: async () => {
			await Promise.resolve();
			throw new TypeError(raw);
		},
		catch: (cause) => new Error(String(cause)),
	});

export function plain(value: unknown): unknown {
	if (value === undefined) throw new Error("value is required");
	return value;
}
