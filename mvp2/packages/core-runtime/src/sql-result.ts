export const rowsFromResult = <TRow>(result: unknown): readonly TRow[] => {
  if (Array.isArray(result)) {
    return result as readonly TRow[];
  }

  if (result !== null && typeof result === 'object' && Symbol.iterator in result) {
    return Array.from(result as Iterable<TRow>);
  }

  return [];
};
