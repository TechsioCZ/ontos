// expect-count: 6
// Every spelling of the ambient global must report exactly once.
export const dump = JSON.stringify;

const { stringify } = JSON;

export const dumpAll = (values: readonly unknown[]): readonly string[] => values.map(JSON.stringify);

export const computedAccess = (value: unknown): string => JSON["stringify"](value);

export const optionalAccess = (value: unknown): string | undefined => JSON?.stringify?.(value);

export const viaGlobalThis = (value: unknown): string => globalThis.JSON.stringify(value);

export const viaDestructured = (value: unknown): string => stringify(value);
