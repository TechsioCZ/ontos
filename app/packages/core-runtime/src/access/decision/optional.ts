/**
 * Adds `key` only when a value is present, so optional properties stay truly absent under
 * `exactOptionalPropertyTypes` without conditional empty-object spreads.
 */
export const withOptional = <Base extends object, Key extends string, Value>(
  base: Base,
  key: Key,
  value: Value | undefined,
): Base & Partial<Record<Key, Value>> => (value === undefined ? base : { ...base, [key]: value });
