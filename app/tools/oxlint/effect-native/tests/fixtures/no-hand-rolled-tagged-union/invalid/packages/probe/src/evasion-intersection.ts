// expect-count: 3
interface ProblemDetails {
  readonly status: number;
}
export type Merged = ProblemDetails & { readonly _tag: 'Merged' };

/** Declaration merging does not hide the tag. */
export interface DeclMerge {
  readonly _tag: 'DeclMerge';
}
export interface DeclMerge {
  readonly extra: string;
}

/** An index signature alongside the tag is still a declared union member. */
export interface WithIndex {
  readonly [key: string]: unknown;
  readonly _tag: 'WithIndex';
}
