// expect-count: 2
/** The duration name is on the function, not on a variable initialiser. */
export const leaseMs = (): number => 5 * 60 * 1000;

export function claimTimeoutMs(): number {
	return 30 * 1000;
}
