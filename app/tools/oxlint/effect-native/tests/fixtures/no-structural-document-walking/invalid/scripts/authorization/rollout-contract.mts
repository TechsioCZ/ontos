// expect-count: 4
export const drifted = (
  record: Record<string, unknown>,
  exactKeys: readonly string[],
  expected: unknown,
): boolean =>
  Object.keys(record).toSorted().join('\0') !== [...exactKeys].toSorted().join('\0') ||
  Object.keys(record).sort().join(',') !== 'readiness,wouldDeny' ||
  JSON.stringify(record) !== JSON.stringify(expected) ||
  Object.prototype.hasOwnProperty.call(record, 'wouldDeny');
