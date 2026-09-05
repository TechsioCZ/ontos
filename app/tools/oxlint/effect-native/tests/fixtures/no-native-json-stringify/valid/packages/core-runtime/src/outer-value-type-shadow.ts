// An inner erased type does not replace the outer injected JavaScript value.
export const local = (JSON: { parse(s: string): unknown; stringify(v: unknown): string }) => {
  { type JSON = { readonly brand: true }; return [JSON.parse("x"), JSON.stringify({})]; }
};
