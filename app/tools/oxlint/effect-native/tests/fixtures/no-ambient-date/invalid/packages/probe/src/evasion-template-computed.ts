// expect-count: 2
/** A template-literal key is still a static member name. */
export const millis = Date[`now`]();
export function iso(at: Date): string {
	return at[`toISOString`]();
}
