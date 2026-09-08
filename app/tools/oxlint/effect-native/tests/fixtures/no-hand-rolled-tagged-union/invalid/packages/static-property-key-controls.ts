// expect-count: 3
export interface IdentifierPropertyKey {
  readonly _tag: 'IdentifierPropertyKey';
}
export interface LiteralPropertyKey {
  readonly '_tag': 'LiteralPropertyKey';
}
export interface ComputedLiteralPropertyKey {
  readonly ['_tag']: 'ComputedLiteralPropertyKey';
}
