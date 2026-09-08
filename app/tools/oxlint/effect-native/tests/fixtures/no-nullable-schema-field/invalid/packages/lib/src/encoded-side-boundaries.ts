// expect-count: 4
import { Schema } from "effect";
import { NullOr as Maybe } from "effect/Schema";
const { UndefinedOr: MaybeUndefined } = Schema;
export const nullable = Maybe(Schema.String);
export const undefinedValue = MaybeUndefined(Schema.String);
// Absence of the array is not absence of each payload element.
export const payload = Schema.Array(Schema.NullOr(Schema.String)).pipe(Schema.decodeTo(Schema.OptionFromNullOr(Schema.Array(Schema.String))));
// encodeTo preserves the source decoded type; it is NOT decodeTo.
export const reverse = Schema.NullOr(Schema.String).pipe(Schema.encodeTo(Schema.Option(Schema.String)));
