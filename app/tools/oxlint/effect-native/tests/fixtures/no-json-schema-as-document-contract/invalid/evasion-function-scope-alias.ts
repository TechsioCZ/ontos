// A7 reader that builds the shape-free document schema *inside* the function that decodes with it.
// Identical anti-pattern to `api/verticals/installed-verticals.ts`, only the alias is function-scoped.
import * as Schema from 'effect/Schema';

export const readReferenceTopology = (raw: unknown) => {
  const TopologyDocument = Schema.Record(Schema.String, Schema.Json);
  return Schema.decodeUnknownSync(TopologyDocument)(raw);
};

export const readOwnership = (raw: unknown) => {
  const OwnershipDocument = Schema.Array(Schema.Json);
  return Schema.decodeUnknownEffect(OwnershipDocument)(raw);
};
