// expect-count: 2
// A7: declarations/types are document evidence. A fields bag alone can be hoisted
// into Schema.Struct or an opaque-payload registration, so its intent is not inferred.
// Cross-boundary workspace event contract declared as an untyped JSON bag.
import { Schema } from 'effect';

export type UltramodernWorkspaceJsonObject = Readonly<
  Record<string, Schema.Schema.Type<typeof Schema.Json>>
>;

export const UltramodernNavigateState = Schema.Record(Schema.String, Schema.Json);

export const workspaceContracts = {
  navigateState: Schema.Record(Schema.String, Schema.Json),
};
