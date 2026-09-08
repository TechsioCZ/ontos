import type { Schema } from "effect";

export type Problem =
  | { readonly kind: 'a'; readonly status: 400 }
  | { readonly kind: 'b'; readonly status: 500 };

declare const registry: Problem;

/** Opaque queries stay opaque through heritage clauses and tuple positions alike. */
export interface NarrowedHeritage extends Extract<Problem, { readonly _tag: 'a' }> {
  readonly retryable: boolean;
}
export interface OmittedHeritage extends Omit<Problem, '_tag'> {
  readonly _tag2: 'OmittedHeritage';
}
export type NarrowedPair = readonly [Extract<Problem, { readonly _tag: 'a' }>, Pick<Problem, 'status'>];
export type NarrowedRest = readonly [...Exclude<Problem, { readonly _tag: 'b' }>[]];
export type CodecTuple = readonly [Schema.Codec<{ readonly _tag: 'a' }>];

/** A derived template tag keeps its substitution and must not be read as a literal. */
export interface DerivedRoute {
  readonly _tag: `contacts/${string}`;
}
export type DerivedTuple = readonly [{ readonly _tag: `${string}Problem` }];

export const use = (): Problem => registry;
