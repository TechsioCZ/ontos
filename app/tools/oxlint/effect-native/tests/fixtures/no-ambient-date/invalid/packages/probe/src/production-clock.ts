// expect-count: 9
/** Every ambient clock entry point: construction, epoch reads and process timers. */
export const nowInstant = new Date();
export const fromEpoch = new Date(1735689600000);
export const epochMillis = Date.now();
export const parsed = Date.parse("2026-01-01T00:00:00Z");
export const utc = Date.UTC(2026, 0, 1);
export const elapsed = performance.now();
export const ticks = process.hrtime();
export const nanos = process.hrtime.bigint();
/** Point-free reference: still a wall-clock read once it is invoked. */
export const clockRead: () => number = Date.now;
