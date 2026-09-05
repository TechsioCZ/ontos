// expect-count: 3
// A hand-rolled discriminant is hand-rolled whatever the base class is; only a base resolved through
// an `effect` import binding (Schema.Tagged*/Data.Tagged*) is the blessed, tag-generating form.
import { Schema } from "effect";

class LocalProblemBase {
  readonly status: number = 500;
}

export class LocalDerivedProblem extends LocalProblemBase {
  readonly _tag = 'LocalDerivedProblem';
}

export class NativeErrorProblem extends Error {
  readonly _tag = `NativeErrorProblem`;
}

/** A local helper that merely *shares* the Schema name is not the Effect base. */
const Local = { TaggedError: (tag: string) => class { readonly tag = tag; } };
export class LookalikeProblem extends Local.TaggedError('LookalikeProblem') {
  readonly _tag = 'LookalikeProblem' as const;
}

export const codec = Schema.Struct({ status: Schema.Number });
