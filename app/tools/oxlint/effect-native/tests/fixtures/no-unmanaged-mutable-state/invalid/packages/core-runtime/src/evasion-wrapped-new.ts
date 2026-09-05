// expect-count: 3
// Robustness: the weak constructor behind casts, non-null assertions, parentheses and an
// optional-chained container global.
export const causes = new WeakMap<object, unknown>() as unknown as Map<object, unknown>;
export const trusted = new globalThis.WeakSet<object>()!;
export const lazy = (): object => new (globalThis?.WeakMap)();
