// expect-count: 3
// `staticPropertyName` only accepts `Literal` computed keys, so a no-substitution template
// literal is an unhandled computed member on either half of `globalThis.JSON.parse`.
declare const s: string;

export const a = JSON[`parse`](s);
export const b = globalThis[`JSON`].parse(s);
export const c = JSON?.[`parse`]?.(s);
