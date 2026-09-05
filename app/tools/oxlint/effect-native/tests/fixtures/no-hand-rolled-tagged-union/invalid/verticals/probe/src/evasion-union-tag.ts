// expect-count: 2
// A closed literal vocabulary, optional and behind a wrapper, is still declared outside Schema.
export type Status = Readonly<{ readonly _tag?: 'draft' | 'live' | 'retired'; readonly at: string }>;

export interface UnionTagInterface {
  readonly _tag: 'draft' | 'live';
}
