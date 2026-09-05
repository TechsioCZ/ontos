// expect-count: 5
// Build-time deployment allowlist: reference topology plus local overlay decoded as opaque JSON.
import * as Predicate from 'effect/Predicate';
import * as Schema from 'effect/Schema';

type JsonValue = Schema.Schema.Type<typeof Schema.Json>;
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);

const object = (value: JsonValue, label: string) => {
  if (!Predicate.isObjectKeyword(value) || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return Schema.decodeUnknownSync(JsonObjectSchema)(value);
};

export const createModuleDeploymentAllowlistBuildInput = (
  developmentOverlay: unknown,
  topology: unknown,
) => {
  const parsedDevelopmentOverlay = Schema.decodeUnknownSync(Schema.Json)(developmentOverlay);
  const parsedTopology = Schema.decodeUnknownSync(Schema.Json)(topology);
  return Object.freeze({
    overlay: object(parsedDevelopmentOverlay, 'development overlay'),
    topology: parsedTopology,
  });
};
