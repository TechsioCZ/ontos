// expect-count: 3
/** Computed and optional member access must not hide the ambient clock. */
export function stamps(): readonly string[] {
	const a = Date["now"]();
	const b = Date?.now();
	const c = new Date(a).toISOString();
	return [String(a), String(b), c];
}
