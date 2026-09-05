// expect-count: 3
/** Test file (clock-only): only the wall-clock reads TestClock must own are reported. */
export function measure(): number {
	const startedAt = Date.now();
	const wall = new Date();
	const hr = performance.now();
	return startedAt + wall.getTime() + hr;
}
