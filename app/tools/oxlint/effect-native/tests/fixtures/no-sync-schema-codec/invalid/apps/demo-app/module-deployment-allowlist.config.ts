// expect-count: 1
// A7 explicitly cites this config reader; an arbitrary config name is not a forced framework seam.
import { Schema } from "effect";
export const decodeTopology = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }));
