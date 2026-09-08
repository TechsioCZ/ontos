import { Effect, Schema } from 'effect';

export class InstalledVerticalTopologyError extends Schema.TaggedError<InstalledVerticalTopologyError>()(
  'InstalledVerticalTopologyError',
  { cause: Schema.Defect(), reason: Schema.String }
) {}

const stableAppIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const InstalledVerticalSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(stableAppIdPattern)),
  kind: Schema.Literal('vertical'),
});

const InstalledVerticalTopologySchema = Schema.Struct({
  verticals: Schema.Array(InstalledVerticalSchema),
}).check(
  Schema.makeFilter((topology) => {
    const installedVerticalIds = new Set(
      topology.verticals.map(({ id }) => id)
    );
    return installedVerticalIds.size === topology.verticals.length
      ? undefined
      : 'topology contains duplicate vertical IDs';
  })
);

interface InstalledVerticalInput {
  readonly id?: string;
  readonly kind?: string;
}

export interface InstalledVerticalTopologyInput {
  readonly sharedPackages?: readonly InstalledVerticalInput[];
  readonly shell?: InstalledVerticalInput;
  readonly verticals?: readonly InstalledVerticalInput[];
}

declare const ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY: InstalledVerticalTopologyInput;

const decodeInstalledVerticalTopology = Schema.decodeUnknownEffect(
  InstalledVerticalTopologySchema
);

export const deriveInstalledVerticalIds = (
  input: InstalledVerticalTopologyInput
): Effect.Effect<ReadonlySet<string>, InstalledVerticalTopologyError> =>
  decodeInstalledVerticalTopology(input).pipe(
    Effect.map((topology) => new Set(topology.verticals.map(({ id }) => id))),
    Effect.mapError(
      (cause) =>
        new InstalledVerticalTopologyError({
          cause,
          reason:
            'The authoritative installed MicroVertical topology is malformed',
        })
    )
  );

export const installedVerticalIds: Effect.Effect<
  ReadonlySet<string>,
  InstalledVerticalTopologyError
> = Effect.suspend(() =>
  deriveInstalledVerticalIds(ULTRAMODERN_GATEWAY_AUDIENCE_TOPOLOGY)
);
