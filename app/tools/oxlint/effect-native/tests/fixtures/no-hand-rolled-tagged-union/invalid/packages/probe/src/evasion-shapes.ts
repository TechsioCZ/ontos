// expect-count: 7
// Parentheses, array types, `readonly` operators and nullable unions are all transparent.
export type Paren = ({ readonly _tag: 'Paren' });
export type ParenTag = { readonly _tag: ('ParenTag') };
export type ParenUnion = ({ readonly _tag: 'a' } | { readonly _tag: 'b' });
export type RoArray = readonly { readonly _tag: 'RoArray' }[];
export type Plain = { readonly _tag: 'Plain' }[];
export type Nullable = { readonly _tag: 'Nullable' } | undefined | null;
