// expect-count: 3
/** The ambient clock reached through `globalThis` is still the ambient clock. */
export const at = new globalThis.Date();
export const millis = globalThis.Date.now();
export const elapsed = globalThis.performance.now();
