import { Effect, Predicate } from 'effect';

import { parseStageEdgeConfig, STAGE_EDGE_FILE } from '../ci/stage-edge.mts';
import { readAppText } from './stage-operations.mts';
import { StageOperationError } from './stage-operation-error.mts';

export const STAGE_EDGE_TOPOLOGY_PATH = ['topology', 'stage-edge.json'] as const;

/**
 * topology/stage-edge.json through the one parser every consumer shares (scripts/ci/stage-edge.mts), so the operator
 * CLIs and the deploy workflow accept exactly the same document. storefrontCatalogKvId stays "" until provisioning
 * fills it in; consumers that bind the KV must require it nonempty.
 */
export const readStageEdgeTopology = readAppText(...STAGE_EDGE_TOPOLOGY_PATH).pipe(
  Effect.flatMap((text) =>
    Effect.try({
      // The parser names invalid fields, never their values.
      catch: (cause) =>
        new StageOperationError({
          cause,
          message:
            Predicate.hasProperty(cause, 'message') && Predicate.isString(cause.message)
              ? cause.message
              : `${STAGE_EDGE_FILE} is not a valid stage edge config`,
        }),
      try: () => parseStageEdgeConfig(text),
    }),
  ),
);
