/** A8: scaffolds emit `throw` as generated *text*; only the scaffold's own control flow is in scope. */
export function renderGuard(name: string): string {
	return [
		`export function assert${name}(value: unknown): void {`,
		'\tif (value === undefined) throw new Error("missing");',
		`\tif (typeof value !== "object") throw new TypeError(\`${name} must be an object\`);`,
		"}",
	].join("\n");
}

export const SNIPPET = String.raw`if (!ok) { throw new RangeError("out of range"); }`;
export const NESTED = `outer ${`inner throw new Error("x")`} end`;
