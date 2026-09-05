// expect-count: 1
import { Schema } from "effect";
// Not every use is encoded-only, so keep the diagnostic on the shared nullable model.
const Shared = Schema.NullOr(Schema.String);
export const option = Shared.pipe(Schema.decodeTo(Schema.OptionFromNullOr(Schema.String)));
export const rawModel = Schema.Struct({ value: Shared });
