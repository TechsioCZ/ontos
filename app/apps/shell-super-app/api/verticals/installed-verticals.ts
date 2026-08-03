import { Effect, Schema } from 'effect';

declare const ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY: unknown;

export class InstalledVerticalTopologyError extends Schema.TaggedErrorClass<InstalledVerticalTopologyError>()(
  'InstalledVerticalTopologyError',
  { reason: Schema.String },
) {}

const stableAppIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const deriveInstalledVerticalIds = (
  input: unknown,
): Effect.Effect<ReadonlySet<string>, InstalledVerticalTopologyError> =>
  Effect.try({
    catch: () =>
      new InstalledVerticalTopologyError({
        reason: 'The authoritative installed MicroVertical topology is malformed',
      }),
    try: () => {
      if (!isRecord(input) || !Array.isArray(input['verticals'])) {
        throw new Error('Topology verticals are missing');
      }

      const installedVerticalIds = new Set<string>();
      for (const entry of input['verticals']) {
        if (!isRecord(entry) || entry['kind'] !== 'vertical') {
          throw new Error('Topology contains a non-vertical installed candidate');
        }
        const { id } = entry;
        if (typeof id !== 'string' || !stableAppIdPattern.test(id)) {
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
