// expect-count: 6
// The same anti-pattern reached through container globals, computed keys, a cast, a call without
// `new`, and a point-free capture of the constructor's stack helper.
export const viaGlobalThis = (): unknown => new globalThis.Error("boom");

export const viaComputedKey = (): unknown => new globalThis["TypeError"]("boom");

export const viaWindow = (): unknown => new self.SyntaxError("boom");

export const withoutNew = (message: string): unknown => Error(message);

export const viaCast = (message: string): unknown => new (Error as ErrorConstructor)(message);

export const captureStack = globalThis.Error.captureStackTrace;
