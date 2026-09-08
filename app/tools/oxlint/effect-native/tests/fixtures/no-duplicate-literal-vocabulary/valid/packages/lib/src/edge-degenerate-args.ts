// Argument shapes that carry no inline string member list: never collected, never crash.
import { Schema } from 'effect';

const MEMBERS = ['alpha', 'beta'] as const;
const key = 'Literals';

export const fromConst = Schema.Literals(MEMBERS);
export const empty = Schema.Literals([]);
export const alsoEmpty = Schema.Literals([]);
export const noArgs = (Schema.Literals as unknown as () => unknown)();
export const spread = Schema.Literals([...MEMBERS]);
export const spreadAgain = Schema.Literals([...MEMBERS]);
export const mixed = Schema.Literals(['alpha', 1 as unknown as string]);
export const mixedAgain = Schema.Literals(['alpha', 1 as unknown as string]);
export const numeric = Schema.Literals([1, 2] as unknown as readonly string[]);
export const computedKey = Schema[key](['gamma', 'delta']);
export const sparse = Schema.Literals(['gamma', , 'delta'] as unknown as readonly string[]);
export const deep = Schema.Literals(
  ['x', 'y'] as const as const as const as const as const as const as const as const as const as const,
);
