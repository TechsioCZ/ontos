import * as Config from "effect/Config";
import * as Schema from "effect/Schema";

const Allowlist = Schema.Struct({ modules: Schema.Array(Schema.String) });

// A3 target: JSON-valued configuration declared as Config over a JSON-string codec.
export const allowlist = Config.schema(Schema.fromJsonString(Allowlist), "MODULE_ALLOWLIST");
