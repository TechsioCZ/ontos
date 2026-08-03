import { Effect, Schema } from 'effect';

declare const ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY: unknown;

export class GatewayAudienceTopologyError extends Schema.TaggedErrorClass<GatewayAudienceTopologyError>()(
  'GatewayAudienceTopologyError',
  { reason: Schema.String },
) {}

const stableAppIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const deriveGatewayAudiences = (
  input: unknown,
): Effect.Effect<ReadonlySet<string>, GatewayAudienceTopologyError> =>
  Effect.try({
    catch: () =>
      new GatewayAudienceTopologyError({
        reason: 'The authoritative MicroVertical audience topology is malformed',
      }),
    try: () => {
      if (!isRecord(input) || !Array.isArray(input['verticals'])) {
        throw new Error('Topology verticals are missing');
      }

      const audiences = new Set<string>();
      for (const entry of input['verticals']) {
        if (!isRecord(entry) || entry['kind'] !== 'vertical') {
          throw new Error('Topology contains a non-vertical audience candidate');
        }
        const { id } = entry;
        if (typeof id !== 'string' || !stableAppIdPattern.test(id)) {
          throw new Error('Topology contains an invalid vertical ID');
        }
        if (audiences.has(id)) {
          throw new Error('Topology contains duplicate vertical IDs');
        }
        audiences.add(id);
      }

      return audiences;
    },
  });

export const gatewayAudiences: Effect.Effect<
  ReadonlySet<string>,
  GatewayAudienceTopologyError
> = Effect.suspend(() => deriveGatewayAudiences(ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY));
