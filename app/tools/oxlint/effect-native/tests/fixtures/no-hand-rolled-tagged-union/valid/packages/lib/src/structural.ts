/** A structural constraint, not a declared union member. */
export interface Tagged {
  readonly _tag: string;
}

/** The tag is a type parameter: the literal set still lives in the Schema that produced it. */
export interface Problem<Tag extends string> {
  readonly _tag: Tag;
  readonly status: number;
}

/** Template-literal and `typeof` tags are derived, not declared. */
export interface DerivedTag {
  readonly _tag: `contacts/${string}`;
}

const TAG = 'ActionCommitOpen';
export interface FromConst {
  readonly _tag: typeof TAG;
}

/** Generic constraints and defaults are query positions. */
export function assertTag<Value extends { readonly _tag: 'ok' }>(value: Value): Value {
  return value;
}
export type WithDefault<Value = { readonly _tag: 'ok' }> = readonly Value[];

/** Function signatures and value annotations do not declare a union. */
export type Classify = (input: unknown) => { readonly _tag: 'ok' } | { readonly _tag: 'err' };
export const seed: { readonly _tag: 'ok' } = { _tag: 'ok' };

/** A different discriminant key is out of scope by default. */
export interface Kinded {
  readonly kind: 'customer';
}
