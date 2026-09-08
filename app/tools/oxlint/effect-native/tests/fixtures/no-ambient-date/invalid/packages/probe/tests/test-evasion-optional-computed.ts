// expect-count: 2
/** Test file (clock-only): optional + computed access to the wall clock. */
export function measure(): number {
	const start = performance["now"]();
	const end = Date?.["now"]();
	return end - start;
}
