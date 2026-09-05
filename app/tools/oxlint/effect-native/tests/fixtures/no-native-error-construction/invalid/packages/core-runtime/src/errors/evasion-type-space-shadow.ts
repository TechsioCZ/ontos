// expect-count: 2
// A TypeScript `interface`/`type` declaration lives in type space only: it does not shadow the
// value-space global, so `new TypeError(...)` / `new RangeError(...)` below still construct native
// errors. Declaration merging must not silently disable the rule for a whole file.
interface TypeError {
	readonly code: string;
}

type RangeError = { readonly code: string };

export type Codes = TypeError | RangeError;

export const first = (): never => {
	throw new TypeError("still the native global constructor");
};

export const second = (): never => {
	throw new RangeError("still the native global constructor");
};
