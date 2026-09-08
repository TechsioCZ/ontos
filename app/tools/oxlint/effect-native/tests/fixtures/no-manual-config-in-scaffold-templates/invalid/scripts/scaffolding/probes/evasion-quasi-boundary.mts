// expect-count: 2
/** Pattern at the first offset of a quasi, and pattern ending at the last offset of a quasi. */
export const head = `JSON.parse(`;

export const guard = (name: string): string => `Array.isArray(${name}Config)`;
