import { Schema } from 'effect';
import * as S from 'effect/Schema';

export const ProblemSchema = Schema.Struct({
  detail: Schema.String,
  status: Schema.Number,
});
export type Problem = typeof ProblemSchema.Type;

// The Schema owns the refinement; the predicate is only a typing seam over that one authority.
export const isProblem = (value: unknown): value is Problem => Schema.is(ProblemSchema)(value);

export const assertProblem = (value: unknown): asserts value is Problem => {
  Schema.asserts(ProblemSchema)(value);
};

// Namespace import of an `effect/*` submodule under a different local name.
export const NonEmptyName = S.String.pipe(S.minLength(1));
export const isNonEmptyName = (value: unknown): value is string => S.is(NonEmptyName)(value);

// Point-free: the annotation carries the predicate, the value is the Schema's own narrowing function.
export const isProblemPointFree: (value: unknown) => value is Problem = Schema.is(ProblemSchema);

// Block body whose single statement returns the delegated call.
export function isProblemBlock(value: unknown): value is Problem {
  return Schema.is(ProblemSchema)(value);
}
