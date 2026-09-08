// expect-count: 4
declare const raw: string;

// A3: JSON-valued configuration parsed by hand, then "checked" structurally.
export function loadTopology(): unknown {
	const parsed = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null) throw new Error("bad topology");
	return parsed;
}

// Renamed destructure and a window-hosted access.
const { parse: parseJson } = globalThis.JSON;
export const overlay = parseJson(raw);
export const legacy = window.JSON.parse(raw);
export const nested = ((JSON)).parse(raw);
