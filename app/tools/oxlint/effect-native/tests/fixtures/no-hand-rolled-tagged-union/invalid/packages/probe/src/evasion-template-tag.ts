// expect-count: 3
// A template literal with no substitution IS a string-literal type: `` `X` `` and `'X'` are the same
// type. Swapping the quotes is a zero-cost evasion, and it is distinguishable from the deliberately
// allowed derived form `` `contacts/${string}` `` (which has substitution expressions).
export interface TemplateTag {
  readonly _tag: `TemplateTag`;
}
export type TemplateUnion = { readonly _tag: `left` } | { readonly _tag: `right` };
