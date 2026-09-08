// expect-count: 4
export const viaTemplate = (raw: Record<string, unknown>): boolean =>
  typeof raw[`kind`] === 'string' || `lifecycle` in raw;

export const viaSatisfies = (raw: unknown): boolean =>
  typeof (raw satisfies unknown) === 'object' && !Array.isArray(raw as Record<string, unknown>);

export const viaGlobalThis = (entry: object): boolean => globalThis.Object.hasOwn(entry, 'legacyRemote');
