// expect-count: 3
// A substitution-free template literal is a static computed key exactly like the string-literal form
// `globalThis["Error"]`, which the rule already resolves.
export const constructed = (): unknown => new globalThis[`Error`]("template computed key");

export const captured = globalThis[`Error`].captureStackTrace;

export const narrowed = (value: unknown): boolean => value instanceof globalThis[`TypeError`];
