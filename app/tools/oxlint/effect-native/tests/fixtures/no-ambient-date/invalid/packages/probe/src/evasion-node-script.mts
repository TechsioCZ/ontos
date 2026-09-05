// expect-count: 3
/** `.mts` operational script: bare `new Date` plus the usual reads. */
export const at = new Date;
export const millis = Date.now();
export const iso = at.toISOString();
