// expect-count: 2
// A generic alias with a type-parameter default is still the second authority.
export type Outcome<Value, Error = string> =
  | { readonly _tag: 'ok'; readonly value: Value }
  | { readonly _tag: 'err'; readonly error: Error };
