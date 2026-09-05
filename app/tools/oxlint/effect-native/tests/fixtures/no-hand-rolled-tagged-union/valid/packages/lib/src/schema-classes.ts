import { Schema } from "effect";
import * as Data from "effect/Data";
import { TaggedError } from "effect/Data";

/** The blessed form: the tag comes from the Schema, not from a hand-written field. */
export class GatewayUnavailableProblem extends Schema.TaggedError<GatewayUnavailableProblem>()(
  'GatewayUnavailableProblem',
  { status: Schema.Literal(503) },
) {}

/** Effect-derived bases own `_tag`; a redeclaration for narrowing is still the Schema's vocabulary. */
export class RedeclaredProblem extends Schema.TaggedError<RedeclaredProblem>()('RedeclaredProblem', {
  status: Schema.Number,
}) {
  readonly _tag = 'RedeclaredProblem';
}

export class BridgeFailure extends Data.TaggedError('BridgeFailure')<{ readonly cause: unknown }> {}

export class BareImportFailure extends TaggedError('BareImportFailure')<{ readonly cause: unknown }> {}

/** `_tag: string` on a class is a structural constraint, exactly as on an interface. */
export class StructuralTag {
  readonly _tag: string = 'StructuralTag';
}

/** A tag that is not a declared literal: computed, derived, or read from elsewhere. */
const SOURCE = 'FromConst';
export class DerivedTags {
  readonly ['_tag'] = 'Computed';
  readonly kind = 'DerivedTags';
}
export class RuntimeTag {
  readonly _tag = SOURCE;
}
export class InterpolatedTag {
  readonly prefix = 'contacts';
  readonly _tag = `contacts/${SOURCE}`;
}

/** Constructor parameter properties and methods never declare a union. */
export class Envelope {
  constructor(readonly payload: { readonly _tag: 'ok' }) {}
  classify(): { readonly _tag: 'ok' } {
    return this.payload;
  }
}
