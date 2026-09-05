// expect-count: 1
/** The exact-key join survives a spread re-wrap of the key list. */
export const drifted = (record: Record<string, unknown>, exactKeys: readonly string[]): boolean =>
  [...Object.keys(record)].toSorted().join('\0') !== [...exactKeys].toSorted().join('\0');
