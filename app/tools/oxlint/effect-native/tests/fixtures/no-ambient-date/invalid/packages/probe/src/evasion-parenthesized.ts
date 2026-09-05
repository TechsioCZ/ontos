// expect-count: 3
/** Parenthesised callees/receivers must not hide the global. */
export const at = new (Date)();
export const millis = (Date).now();
export const elapsed = (performance).now();
