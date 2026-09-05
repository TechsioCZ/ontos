// expect-count: 3
export const optionalHasOwn = (document: object): boolean => Object.hasOwn?.(document, 'kind');

export const optionalField = (payload: Record<string, unknown> | undefined): boolean =>
  typeof payload?.['mode'] === 'string';

// A7 needs document evidence; opaque left/right may instead be native arrays (D tier).
// Keep optional-chain coverage on a document-like operand, with the opaque boundary in valid/.
export const optionalStringify = (document: unknown, expected: unknown): boolean =>
  JSON?.stringify(document) === JSON?.stringify(expected);
