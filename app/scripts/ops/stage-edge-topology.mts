import { Effect, Schema } from 'effect';

import { decodeInput, readAppText } from './stage-operations.mts';
import { StageOperationError } from './stage-operation-error.mts';

const AccountIdSchema = Schema.NonEmptyString.pipe(Schema.brand('CloudflareAccountId'));
export const StorefrontCatalogKvIdSchema = Schema.String.pipe(Schema.brand('StorefrontCatalogKvId'));

export const STAGE_EDGE_TOPOLOGY_PATH = ['topology', 'stage-edge.json'] as const;
export const StageEdgeTopologySchema = Schema.fromJsonString(
  Schema.Struct({
    accountId: AccountIdSchema,
    emailSender: Schema.NonEmptyString,
    shellHostname: Schema.NonEmptyString,
    spicedbHostname: Schema.NonEmptyString,
    storefrontHostname: Schema.NonEmptyString,
    workersDevSubdomain: Schema.NonEmptyString,
    zone: Schema.NonEmptyString,
    // Provisioning fills this in; consumers that bind KV must require a nonempty ID.
    storefrontCatalogKvId: StorefrontCatalogKvIdSchema,
  }),
  { space: 2 },
);

export const readStageEdgeTopology = Effect.gen(function* readStageEdgeTopologyEffect() {
  const topology = yield* decodeInput(
    StageEdgeTopologySchema,
    'topology/stage-edge.json',
  )(yield* readAppText(...STAGE_EDGE_TOPOLOGY_PATH));
  const hostname = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u;
  if (
    !hostname.test(topology.zone) ||
    ![topology.shellHostname, topology.storefrontHostname, topology.spicedbHostname].every(
      (value) => hostname.test(value) && value.endsWith(`.${topology.zone}`),
    ) ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(topology.workersDevSubdomain) ||
    !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/u.test(topology.emailSender)
  ) {
    return yield* new StageOperationError({
      message:
        'topology/stage-edge.json must define valid hostnames inside its zone, a workers.dev subdomain and an email sender',
    });
  }
  return topology;
});
