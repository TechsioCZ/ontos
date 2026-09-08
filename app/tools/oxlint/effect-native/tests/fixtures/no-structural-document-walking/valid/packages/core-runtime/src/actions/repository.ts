/** Recursive JSON normalization — the audit's "Existing patterns to preserve" blesses this. */
export const normalise = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, normalise(entry)]),
    );
  }
  return value;
};

export const drifted = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) !== JSON.stringify(right);
