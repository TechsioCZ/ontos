// expect-count: 5
// The member host is the ambient `JSON` bag, only reached through a wrapper the rule already
// treats as transparent on the consumer side (`skipWrappers` / `TRANSPARENT_PARENTS`).
declare const v: unknown;

export const viaNonNull = globalThis!.JSON.stringify(v);

export const viaAs = (JSON as typeof JSON).stringify(v);

export const viaSatisfies = (JSON satisfies typeof JSON).stringify(v);

export const viaDoubleCast = (globalThis as unknown as { readonly JSON: typeof JSON }).JSON.stringify(v);

export const viaSequence = (0, JSON).stringify(v);
