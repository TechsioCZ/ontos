// expect-count: 3
// `TSArrayType` is already transparent (`{ _tag: 'x' }[]` reports), so tuple elements are an
// inconsistent gap in the same walk.
export type Pair = readonly [{ readonly _tag: 'left' }, { readonly _tag: 'right' }];
export type Named = [head: { readonly _tag: 'head' }];
