import { v1 } from '@authzed/authzed-node';
import { Array as EffectArray, Context, Effect, Layer } from 'effect';

import type { ActionPermissionCheckError } from '../actions/errors.ts';
import {
  SPICEDB_CHECK_TIMEOUT_MS,
  acquireSpiceDbClientResource,
  createSpiceDbPermissionClient,
  fullyConsistent,
} from './client.ts';
import type { SpiceDbPermissionClient } from './client.ts';
import { loadSpiceDbConfig } from './config.ts';
import {
  SPICEDB_EXECUTE_PERMISSION,
  SPICEDB_PROPOSE_PERMISSION,
  actionReference,
  checkFailure,
  classifyPermissionship,
  principalReference,
  runCheck,
} from './service.ts';
import type { ActionPermissionDecision, ActionPermissionTargetInput } from './service.ts';

export interface ScopedActionAuthority extends ActionPermissionTargetInput {
  readonly execute: ActionPermissionDecision;
  readonly propose: ActionPermissionDecision;
}

export interface ActionAuthorityService {
  readonly checkActionAuthorities: (
    targets: readonly ActionPermissionTargetInput[],
  ) => Effect.Effect<readonly ScopedActionAuthority[], ActionPermissionCheckError>;
  readonly checkActionProposalPermission: (
    input: ActionPermissionTargetInput,
  ) => Effect.Effect<ActionPermissionDecision, ActionPermissionCheckError>;
}

const checkBulkPair = Effect.fn('ActionAuthority.checkBulkPair')(function* checkBulkPair(
  expected: v1.CheckBulkPermissionsRequestItem | undefined,
  pair: v1.CheckBulkPermissionsPair,
) {
  if (
    expected === undefined ||
    pair.request === undefined ||
    v1.CheckBulkPermissionsRequestItem.toJsonString(pair.request) !==
      v1.CheckBulkPermissionsRequestItem.toJsonString(expected) ||
    pair.response.oneofKind !== 'item'
  ) {
    return yield* checkFailure();
  }
  const decision = yield* classifyPermissionship(pair.response.item);
  return decision === 'has' ? ('allowed' as const) : ('denied' as const);
});

const checkAuthorityBatch = Effect.fn('ActionAuthority.checkBatch')(function* checkAuthorityBatch(
  client: SpiceDbPermissionClient,
  targets: readonly ActionPermissionTargetInput[],
) {
  const items = targets.flatMap((target) =>
    [SPICEDB_EXECUTE_PERMISSION, SPICEDB_PROPOSE_PERMISSION].map((permission) =>
      v1.CheckBulkPermissionsRequestItem.create({
        permission,
        resource: actionReference(target),
        subject: principalReference(target.principalId),
      }),
    ),
  );
  const response = yield* client
    .checkBulkPermissions(
      v1.CheckBulkPermissionsRequest.create({
        consistency: fullyConsistent,
        items,
        withTracing: false,
      }),
    )
    .pipe(Effect.mapError(checkFailure));
  if (response.pairs.length !== items.length) {
    return yield* checkFailure();
  }
  const decisions = yield* Effect.forEach(response.pairs, (pair, index) => checkBulkPair(items[index], pair), {
    concurrency: 1,
  });
  return targets.map((target, index): ScopedActionAuthority => ({
    ...target,
    execute: decisions[index * 2] ?? 'denied',
    propose: decisions[index * 2 + 1] ?? 'denied',
  }));
});

/** Exact fully consistent metadata in bounded batches; proposal authority never grants execution. */
export const makeActionAuthorityService = (client: SpiceDbPermissionClient): ActionAuthorityService => ({
  checkActionAuthorities: Effect.fn('ActionAuthority.checkActionAuthorities')(function* checkActionAuthorities(
    targets: readonly ActionPermissionTargetInput[],
  ) {
    const batches = yield* Effect.forEach(
      EffectArray.chunksOf(targets, 100),
      (batch) => checkAuthorityBatch(client, batch),
      { concurrency: 1 },
    );
    return batches.flat();
  }),
  checkActionProposalPermission: Effect.fn('ActionAuthority.checkProposal')(function* checkActionProposalPermission(
    input: ActionPermissionTargetInput,
  ) {
    const decision = yield* runCheck(
      client,
      v1.CheckPermissionRequest.create({
        consistency: fullyConsistent,
        permission: SPICEDB_PROPOSE_PERMISSION,
        resource: actionReference(input),
        subject: principalReference(input.principalId),
      }),
    );
    return decision === 'has' ? ('allowed' as const) : ('denied' as const);
  }),
});

export class ActionAuthority extends Context.Service<ActionAuthority, ActionAuthorityService>()(
  '@app/core-runtime/permissions/action-authority/ActionAuthority',
) {}

/** The request owns one client, closed by its scope on success, failure and interruption. */
export const ActionAuthorityLive = Layer.effect(
  ActionAuthority,
  Effect.gen(function* makeActionAuthorityLive() {
    const configuration = yield* loadSpiceDbConfig().pipe(Effect.mapError(checkFailure));
    const client = yield* acquireSpiceDbClientResource(
      () => createSpiceDbPermissionClient(configuration, SPICEDB_CHECK_TIMEOUT_MS),
      checkFailure,
    );
    return makeActionAuthorityService(client);
  }).pipe(
    Effect.catchTag('ActionPermissionCheckError', (failure) =>
      Effect.succeed({
        checkActionAuthorities: () => Effect.fail(failure),
        checkActionProposalPermission: () => Effect.fail(failure),
      }),
    ),
  ),
);
