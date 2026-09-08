/** D tier: native array/object operations where Effect collection APIs add no semantic value. */
export const uppercase = (values: readonly string[]): readonly string[] =>
  values.map((value) => value.toUpperCase()).filter((value) => value.length > 0);

/** An if/else chain over a non-closed input is not a switch and is not this rule's business. */
export const label = (count: number): string => {
  if (count === 0) return 'none';
  if (count === 1) return 'one';
  return 'many';
};
