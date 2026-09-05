// expect-count: 1
// `type H = Readonly<{ readonly _tag: 'H' }>` reports; the heritage-clause spelling of the same
// declaration does not.
export interface Heritage extends Readonly<{ readonly _tag: 'Heritage' }> {
  readonly status: number;
}
