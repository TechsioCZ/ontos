// A7 governs structured documents, not every use of native array equality (audit D).
// No type checker or producer evidence distinguishes opaque left/right from those arrays.
export const equalOpaque = (left: unknown, right: unknown): boolean =>
  JSON?.stringify(left) === JSON?.stringify(right);
