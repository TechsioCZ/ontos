// expect-count: 2
/** A local alias of the global constructor/namespace is still the ambient clock. */
const AmbientDate = Date;
const ambientPerformance = performance;

export const at = new AmbientDate();
export const elapsed = ambientPerformance.now();
