// expect-count: 2
/** Destructuring the member off the global hides the wall-clock read. */
const { now } = Date;
const { now: elapsedNow } = performance;

export const millis = now();
export const elapsed = elapsedNow();
