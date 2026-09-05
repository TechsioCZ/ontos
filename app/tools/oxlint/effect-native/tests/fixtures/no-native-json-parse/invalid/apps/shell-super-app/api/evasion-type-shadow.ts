// expect-count: 2
// A `type` alias is a type-space binding (oxlint definition kind "Type"); it does not shadow
// the value-space global, so both calls below still reach the real `JSON.parse`.
declare const s: string;

type JSON = { readonly document: string };

export const parsed = JSON.parse(s) as JSON;
export function later(): JSON {
	return JSON.parse(s) as JSON;
}
