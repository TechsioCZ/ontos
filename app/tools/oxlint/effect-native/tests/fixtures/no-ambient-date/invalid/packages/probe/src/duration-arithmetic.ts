// expect-count: 8
/** Durations written out as magic millisecond arithmetic. */
export const LEASE_MILLISECONDS = 5 * 60 * 1000;
export const claimTimeoutMs = 30 * 1000;
export const pollIntervalSeconds = 3600 / 60;
export const policy = { retryBackoffMs: 2 * 1000, clockSkew: 5 * 60 };

let cacheTtl = 0;
cacheTtl = 24 * 3600 * 1000;
export const ttl = cacheTtl;

/** No owning name, but a duration-named factor is still hand duration arithmetic. */
export function observedLongEnough(minimumObservationSeconds: number, elapsed: number): boolean {
	return elapsed >= minimumObservationSeconds * 1000;
}

export function withinSkew(input: { readonly clockSkewSeconds: number }, delta: number): boolean {
	return delta < input.clockSkewSeconds * 1000;
}
