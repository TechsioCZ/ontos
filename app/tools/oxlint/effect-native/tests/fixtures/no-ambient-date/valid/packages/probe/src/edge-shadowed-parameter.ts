/** Parameters that shadow the globals are not the globals. */
export function render(
	performance: { readonly now: () => number },
	Date: { readonly parse: (value: string) => number },
): number {
	return performance.now() + Date.parse("2026-01-01T00:00:00Z");
}
