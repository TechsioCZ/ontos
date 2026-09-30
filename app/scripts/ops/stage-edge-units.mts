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

export const HYPERDRIVE_ID_VARIABLE = 'ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID';
export const SPICEDB_VPC_SERVICE_ID_VARIABLE = 'ULTRAMODERN_CLOUDFLARE_SPICEDB_VPC_SERVICE_ID';
export const MF_DEV_ORIGIN_VARIABLE = 'ULTRAMODERN_MF_DEV_ORIGIN';
export const COMPOSITION_KV_ID_VARIABLE = 'ULTRAMODERN_CLOUDFLARE_COMPOSITION_KV_ID';
// Every placed Worker bakes the Shell origin into its API CORS allowlist and binds the private data
// plane: PostgreSQL through its Hyperdrive config, SpiceDB through its Workers VPC service, and the
// active Application Composition through the composition KV namespace.
const SHARED_BUILD_VARIABLES = [
  MF_DEV_ORIGIN_VARIABLE,
  HYPERDRIVE_ID_VARIABLE,
  SPICEDB_VPC_SERVICE_ID_VARIABLE,
  COMPOSITION_KV_ID_VARIABLE,
] as const;

/** Every topology unit (Shell first, then the verticals), keyed by id, with its Worker names. */
const topologyUnits = (topologyJson: string) =>
  Effect.gen(function* topologyUnitsEffect() {
    const topology = yield* decodeInput(TopologySchema, 'topology/reference-topology.json')(topologyJson);
    const units = new Map<string, EdgeUnit>([
      [topology.shell.id, { id: topology.shell.id, kind: 'shell', ...topology.shell.cloudflare }],
    ]);
    for (const vertical of topology.verticals) {
      units.set(vertical.id, { id: vertical.id, kind: 'vertical', ...vertical.cloudflare });
    }
    return units;
  });

/** The placed units in placement order, with the topology's Worker names. */
export const edgeUnits = (topologyJson: string, placementJson: string) =>
  Effect.gen(function* edgeUnitsEffect() {
    const units = yield* topologyUnits(topologyJson);
    const placement = yield* decodeInput(PlacementSchema, PLACEMENT_LABEL)(placementJson);
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

/**
 * What the placement lacks for a complete stage edge deploy: stage targets Cloudflare, so a topology
 * unit the placement leaves out never deploys, and a placed Worker without its public URL or the
 * shared data-plane variables fails its build. Needs no credentials, so every pull request checks it.
 */
export const placementGaps = (topologyJson: string, placementJson: string) =>
  Effect.gen(function* placementGapsEffect() {
    const units = yield* topologyUnits(topologyJson);
    const placement = yield* decodeInput(PlacementSchema, PLACEMENT_LABEL)(placementJson);
    const placed = new Set(placement.units);
    const unplaced = [...units.keys()].filter((id) => !placed.has(id)).map((id) => `units: ${id}`);
    const required = [
      ...SHARED_BUILD_VARIABLES,
      ...placement.units.flatMap((id) => {
        const publicUrlEnv = units.get(id)?.publicUrlEnv;
        return publicUrlEnv === undefined ? [] : [publicUrlEnv];
      }),
    ];
    const unset = required
      .filter((key) => (placement.buildEnvironment[key] ?? '') === '')
      .map((key) => `buildEnvironment.${key}`);
    return [...unplaced, ...unset];
  });

export const readEdgeUnits = Effect.gen(function* readEdgeUnitsEffect() {
  return yield* edgeUnits(
    yield* readAppText('topology', 'reference-topology.json'),
    yield* readAppText(...PLACEMENT_PATH),
  );
});
