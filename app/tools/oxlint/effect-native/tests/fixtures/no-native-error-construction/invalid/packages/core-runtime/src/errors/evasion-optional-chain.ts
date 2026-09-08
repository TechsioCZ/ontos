// expect-count: 5
// The container global reached through an optional chain, with a static key and a computed key.
export const constructed = (): unknown => new (globalThis?.Error)("optional container");

export const narrowed = (value: unknown): boolean => value instanceof globalThis?.TypeError;

export const captured = globalThis?.Error.captureStackTrace;

export const optionalComputed = (): unknown => new (globalThis?.["Error"])("optional computed key");

export const escapedKey = (): unknown => new globalThis["Error"]("escaped computed key");
