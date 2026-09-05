export const Effect = {
  all: <A,>(values: readonly A[]): readonly A[] => values,
  forEach: <A, B>(values: readonly A[], run: (value: A) => B): readonly B[] => values.map(run),
};
