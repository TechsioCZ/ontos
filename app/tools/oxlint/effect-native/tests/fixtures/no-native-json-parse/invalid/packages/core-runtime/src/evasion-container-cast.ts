// expect-count: 3
// The rule already unwraps `as`/`!` around the JSON *host* (`(JSON as typeof JSON).parse`),
// but the container of `globalThis.JSON` is matched as a bare Identifier, so a cast on the
// container hides the same access.
declare const s: string;

export const a = (globalThis as { JSON: { parse: (t: string) => unknown } }).JSON.parse(s);
export const b = (globalThis as unknown as typeof globalThis).JSON["parse"](s);
export const c = (window as typeof window)!.JSON.parse(s);
