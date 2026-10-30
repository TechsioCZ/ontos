/**
 * The units one app container serves: the Shell plus every module of topology/application-release-intent.json, each
 * on a stable loopback port. Topology ports come first; server-only owners get ports from 4200 up.
 */
import path from 'node:path';

import { Effect, FileSystem, Schema } from 'effect';

import { OntosDeploymentAppIdSchema } from '../../packages/core-runtime/src/modules/manifest.ts';

export const workspaceRoot = path.resolve(import.meta.dirname, '../..');
export const SHELL_ID = 'shell-super-app';
export const SHELL_PORT = 3020;
const FIRST_SERVER_ONLY_PORT = 4200;
/** Each unit's generated in-process server entry (scripts/zerops/owner-entry.mts). */
export const UNIT_ENTRY = 'dist/zerops-entry.mjs';

const TopologySchema = Schema.fromJsonString(
  Schema.Struct({
    shell: Schema.Struct({ path: Schema.NonEmptyString }),
    verticals: Schema.Array(
      Schema.Struct({
        id: OntosDeploymentAppIdSchema,
        moduleFederation: Schema.optionalKey(Schema.Struct({ manifestUrl: Schema.URLFromString })),
        path: Schema.NonEmptyString,
        surfaceProfile: Schema.optionalKey(Schema.Literal('api-only')),
      }),
    ),
  }),
);
export type Topology = typeof TopologySchema.Type;
const ReleaseIntentSchema = Schema.fromJsonString(
  Schema.Struct({ modules: Schema.Array(Schema.Struct({ appId: OntosDeploymentAppIdSchema })) }),
);
export type ReleaseIntent = typeof ReleaseIntentSchema.Type;

/** One unit server inside this container. */
export interface HostedUnit {
  /** The unit ships a browser Module Federation remote. */
  readonly browser: boolean;
  /** Workspace-relative package directory. */
  readonly directory: string;
  readonly id: string;
  readonly port: number;
}

export const hostedUnits = (topology: Topology, intent: ReleaseIntent): readonly HostedUnit[] => {
  const served = new Set(intent.modules.map(({ appId }) => appId));
  const verticals = topology.verticals.filter(({ id }) => served.has(id));
  const serverOnly = verticals.filter(
    (vertical) => vertical.surfaceProfile === 'api-only' || vertical.moduleFederation === undefined,
  );
  const owners = verticals.map((vertical): HostedUnit =>
    vertical.surfaceProfile !== 'api-only' && vertical.moduleFederation !== undefined
      ? {
          browser: true,
          directory: vertical.path,
          id: vertical.id,
          port: Number(vertical.moduleFederation.manifestUrl.port),
        }
      : {
          browser: false,
          directory: vertical.path,
          id: vertical.id,
          port: FIRST_SERVER_ONLY_PORT + serverOnly.indexOf(vertical),
        },
  );
  return [{ browser: true, directory: topology.shell.path, id: SHELL_ID, port: SHELL_PORT }, ...owners];
};

const readJson = <A,>(relative: string, schema: Schema.Codec<A, string>) =>
  Effect.gen(function* readWorkspaceJson() {
    const fs = yield* FileSystem.FileSystem;
    return yield* Schema.decodeEffect(schema)(yield* fs.readFileString(path.join(workspaceRoot, relative)));
  });

/** The units of the checked-in topology and release intent. */
export const readHostedUnits = Effect.gen(function* readHostedUnits() {
  return hostedUnits(
    yield* readJson('topology/reference-topology.json', TopologySchema),
    yield* readJson('topology/application-release-intent.json', ReleaseIntentSchema),
  );
});
