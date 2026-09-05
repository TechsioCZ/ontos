// expect-count: 3
// Computed, single-quoted and double-quoted keys all name `_tag`.
export interface ComputedKey {
  readonly ['_tag']: 'ComputedKey';
}
export interface EscapedKey {
  readonly '_tag': 'EscapedKey';
}
export interface DoubleQuoted {
  readonly "_tag": "DoubleQuoted";
}
