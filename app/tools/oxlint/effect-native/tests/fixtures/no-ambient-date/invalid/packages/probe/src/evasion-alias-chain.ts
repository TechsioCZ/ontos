// expect-count: 2
/** A transitive alias chain still resolves to the global constructor/namespace. */
const First = Date;
const Second = First;

export const at = new Second();
export const millis = Second.now();
