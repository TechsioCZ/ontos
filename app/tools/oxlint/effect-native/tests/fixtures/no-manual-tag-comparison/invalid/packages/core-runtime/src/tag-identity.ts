// expect-count: 2
export const sameTag = (a: { readonly _tag: string }, b: { readonly _tag: string }): boolean => a._tag === b._tag;
export const same = (a: { readonly _tag: string }, b: { readonly _tag: string }): boolean => Object.is(a._tag, b._tag);
