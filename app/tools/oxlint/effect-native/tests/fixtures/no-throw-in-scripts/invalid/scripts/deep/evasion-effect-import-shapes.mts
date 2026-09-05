// expect-count: 5
import { Effect as E, pipe } from "effect";
import * as EffectNs from "effect/Effect";
import { tryPromise } from "effect/Effect";

declare const load: () => Promise<string>;

export const decode = E.try({
	try: () => {
		throw new Error("decode failed");
	},
	catch: (cause: unknown) => cause,
});

export const fetchOne = EffectNs.tryPromise({
	try: async () => {
		const value = await load();
		if (value === "") throw new TypeError("empty payload");
		return value;
	},
	catch: (cause: unknown) => cause,
});

export const direct = tryPromise(async () => {
	throw new Error("destructured member import");
});

export const computed = EffectNs["try"](() => {
	throw new Error("computed member access");
});

export const optional = E.try?.(() => {
	throw new Error("optional call");
});

export const program = pipe(decode, E.runPromise);
