// The document contract hoisted onto a class instead of a module `const`: still a shape-free
// topology/manifest schema, decoded through it and then walked by hand.
import { Schema } from 'effect';

export class ReferenceTopologyReader {
  static readonly Document = Schema.Record(Schema.String, Schema.Json);
  static readonly WouldDenyEvidence = Schema.Array(Schema.Json);

  read(raw: unknown) {
    return Schema.decodeUnknownSync(ReferenceTopologyReader.Document)(raw);
  }
}
