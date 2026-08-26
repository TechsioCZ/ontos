import { Effect, Schema, Predicate } from 'effect';

type JsonValue = Schema.Schema.Type<typeof Schema.Json>;
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);

declare const ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY: JsonValue;

export class InstalledVerticalTopologyError extends Schema.TaggedError<InstalledVerticalTopologyError>()(
  'InstalledVerticalTopologyError',
  { reason: Schema.String },
) {}

const stableAppIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;

const object = (value: JsonValue) => {
  if (!Predicate.isObjectKeyword(value) || value === null || Array.isArray(value)) {
    throw new TypeError('expected object');
  }
  return Schema.decodeUnknownSync(JsonObjectSchema)(value);
};

export const deriveInstalledVerticalIds = (
  input: JsonValue,
): Effect.Effect<ReadonlySet<string>, InstalledVerticalTopologyError> =>
  Effect.try({
    catch: () =>
      new InstalledVerticalTopologyError({
        reason: 'The authoritative installed MicroVertical topology is malformed',
      }),
    try: () => {
      const topology = object(input);
      if (!Array.isArray(topology['verticals'])) {
        throw new TypeError('Topology verticals are missing');
      }

      const installedVerticalIds = new Set<string>();
      for (const value of topology['verticals']) {
        const entry = object(value);
        if (entry['kind'] !== 'vertical') {
          throw new Error('Topology contains a non-vertical installed candidate');
        }
        const { id } = entry;
        if (!Predicate.isString(id) || !stableAppIdPattern.test(id)) {
          throw new Error('Topology contains an invalid vertical ID');
        }
        if (installedVerticalIds.has(id)) {
          throw new Error('Topology contains duplicate vertical IDs');
        }
        installedVerticalIds.add(id);
      }

      return installedVerticalIds;
    },
  });

export const installedVerticalIds: Effect.Effect<
  ReadonlySet<string>,
  InstalledVerticalTopologyError
> = Effect.suspend(() => deriveInstalledVerticalIds(ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY));
