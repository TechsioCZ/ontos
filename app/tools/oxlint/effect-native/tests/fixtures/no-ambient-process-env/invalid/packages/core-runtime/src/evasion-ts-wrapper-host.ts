// expect-count: 4
// A3: a TypeScript assertion around the *host* hides the ambient read from a rule that only
// looks at bare identifiers. Each line is the same anti-pattern with a cast bolted on.
type Envish = { readonly env: Record<string, string | undefined> };

export const a = (globalThis as unknown as { readonly process: Envish }).process.env["A"];

export const b = (process as unknown as Envish).env["B"];

export const c = process!.env["C"];

export const d = (import.meta as unknown as Envish).env["D"];
