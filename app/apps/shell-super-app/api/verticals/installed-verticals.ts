import { Effect, Schema, Predicate } from 'effect';

type JsonValue = Schema.Schema.Type<typeof Schema.Json>;
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);

declare const ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY: JsonValue;

export class InstalledVerticalTopologyError extends Schema.TaggedError<InstalledVerticalTopologyError>()(
  'InstalledVerticalTopologyError',
  { reason: Schema.String },
) {}

const stableAppIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;

const malformedTopology = () =>
  new InstalledVerticalTopologyError({
    reason: 'The authoritative installed MicroVertical topology is malformed',
  });

const object = (value: JsonValue) =>
  Effect.gen(function* () {
    if (!Predicate.isObjectKeyword(value) || value === null || Array.isArray(value)) {
      return yield* malformedTopology();
    }
    return yield* Schema.decodeUnknownEffect(JsonObjectSchema)(value).pipe(
      Effect.mapError(malformedTopology),
    );
  });

export const deriveInstalledVerticalIds = (
  input: JsonValue,
): Effect.Effect<ReadonlySet<string>, InstalledVerticalTopologyError> =>
  Effect.gen(function* () {
    const topology = yield* object(input);
    if (!Array.isArray(topology['verticals'])) {
      return yield* malformedTopology();
    }

    const installedVerticalIds = new Set<string>();
    for (const value of topology['verticals']) {
      const entry = yield* object(value);
      if (entry['kind'] !== 'vertical') {
        return yield* malformedTopology();
      }
      const { id } = entry;
      if (!Predicate.isString(id) || !stableAppIdPattern.test(id)) {
        return yield* malformedTopology();
      }
      if (installedVerticalIds.has(id)) {
        return yield* malformedTopology();
      }
      installedVerticalIds.add(id);
    }

    return installedVerticalIds;
  });

export const installedVerticalIds: Effect.Effect<
  ReadonlySet<string>,
  InstalledVerticalTopologyError
> = Effect.suspend(() => deriveInstalledVerticalIds(ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY));
