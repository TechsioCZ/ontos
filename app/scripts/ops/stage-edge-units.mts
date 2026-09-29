import { Effect, Schema } from 'effect';

import { StageOperationError } from './stage-operation-error.mts';
import { decodeInput, readAppText } from './stage-operations.mts';

// The placed edge units: the reference topology's Workers that topology/cloudflare-placement.json
// places on Cloudflare. The cut-over provisions them and the cost guard attributes usage to them.

/** One placed Worker: its topology unit, Worker name and public URL build variable. */
export interface EdgeUnit {
  readonly id: string;
  readonly kind: 'shell' | 'vertical';
  readonly publicUrlEnv: string;
  readonly workerName: string;
}

const CloudflareUnitSchema = Schema.Struct({ publicUrlEnv: Schema.String, workerName: Schema.String });
const TopologySchema = Schema.fromJsonString(
  Schema.Struct({
    shell: Schema.Struct({ cloudflare: CloudflareUnitSchema, id: Schema.String }),
    verticals: Schema.Array(Schema.Struct({ cloudflare: CloudflareUnitSchema, id: Schema.String })),
  }),
);
export const BuildEnvironmentSchema = Schema.Record(Schema.String, Schema.String);
export type BuildEnvironment = typeof BuildEnvironmentSchema.Type;
export const PlacementSchema = Schema.fromJsonString(
  Schema.Struct({ buildEnvironment: BuildEnvironmentSchema, units: Schema.Array(Schema.String) }),
);
export const PLACEMENT_PATH = ['topology', 'cloudflare-placement.json'] as const;
export const PLACEMENT_LABEL = 'topology/cloudflare-placement.json';

/** The placed units in placement order, with the topology's Worker names. */
export const edgeUnits = (topologyJson: string, placementJson: string) =>
  Effect.gen(function* edgeUnitsEffect() {
    const topology = yield* decodeInput(TopologySchema, 'topology/reference-topology.json')(topologyJson);
    const placement = yield* decodeInput(PlacementSchema, PLACEMENT_LABEL)(placementJson);
    const units = new Map<string, EdgeUnit>([
      [topology.shell.id, { id: topology.shell.id, kind: 'shell', ...topology.shell.cloudflare }],
    ]);
    for (const vertical of topology.verticals) {
      units.set(vertical.id, { id: vertical.id, kind: 'vertical', ...vertical.cloudflare });
    }
    return yield* Effect.forEach(
      placement.units,
      (id) => {
        const unit = units.get(id);
        return unit === undefined
          ? Effect.fail(new StageOperationError({ message: `placed unit ${id} is not in the reference topology` }))
          : Effect.succeed(unit);
      },
      { concurrency: 1 },
    );
  });

export const readEdgeUnits = Effect.gen(function* readEdgeUnitsEffect() {
  return yield* edgeUnits(
    yield* readAppText('topology', 'reference-topology.json'),
    yield* readAppText(...PLACEMENT_PATH),
  );
});
