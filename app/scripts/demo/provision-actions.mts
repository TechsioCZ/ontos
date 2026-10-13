#!/usr/bin/env node
/**
 * Development-only replacement for `pnpm authorization:provision-current-actions` (LOCAL demo stack).
 *
 * Root cause of the upstream failure: in development the upstream script passes no explicit Action
 * assertions (`explicitAccountGrants: []` and no `deriveExplicitActionAuthorization`), but
 * `provisionActionAuthorization` requires an allowed + denied assertion set for every Action with
 * `provisioning: 'explicit'`. Every apply-command Action and several core identity Actions are explicit, so
 * the development run always fails with `action_authorization_input_invalid`.
 *
 * This wrapper derives the assertions in development the same way the stage path does, granting every
 * explicit Action to the fixed local development Principal (`demo@test.com`). It only writes grants for that
 * Principal; the sales-demo accounts get theirs from `scripts/demo/reset-permissions.mts`.
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Duration, Effect, Layer, Option, Path } from 'effect';
import { Command } from 'effect/unstable/cli';

import {
  ActionAuthorizationProvisioningError,
  deriveExplicitActionAuthorization,
  provisionActionAuthorization,
} from '../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import type { ActionAuthorizationProvisioningClient } from '../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import type { SpiceDbConfigValue } from '../../packages/core-runtime/src/permissions/config.ts';
import { newSpiceDbGrpcClient } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import {
  discoverCurrentActions,
  formatActionAuthorizationProvisioningFailure,
  selectActionAuthorizationProvisioningTarget,
} from '../provision-current-action-authorization.mts';

const failure = (code: ActionAuthorizationProvisioningError['code'], reason: string) =>
  new ActionAuthorizationProvisioningError({ code, reason });
const serviceUnavailable = () =>
  failure('action_authorization_service_unavailable', 'The authorization service request failed');

const call = <Value,>(operation: () => PromiseLike<Value>) =>
  Effect.tryPromise({ catch: serviceUnavailable, try: operation }).pipe(
    Effect.timeoutOrElse({ duration: Duration.seconds(30), orElse: () => Effect.fail(serviceUnavailable()) }),
  );

const acquireClient = (configuration: SpiceDbConfigValue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const client = newSpiceDbGrpcClient(configuration);
      const provisioning: ActionAuthorizationProvisioningClient & { readonly close: () => void } = {
        checkPermission: (request) =>
          call(client.promises.checkPermission.bind(client.promises, request)).pipe(Effect.map(Option.fromNullishOr)),
        close: () => client.close(),
        writeRelationships: (request) => call(client.promises.writeRelationships.bind(client.promises, request)),
        writeSchema: (request) => call(client.promises.writeSchema.bind(client.promises, request)),
      };
      return provisioning;
    }),
    (client) => Effect.sync(() => client.close()),
  );

const provision = Effect.gen(function* provisionDevelopmentActions() {
  const path = yield* Path.Path;
  const workspaceRoot = path.resolve(import.meta.dirname, '../..');
  const configuration = yield* loadSpiceDbConfig().pipe(
    Effect.mapError(() =>
      failure('action_authorization_configuration_invalid', 'The SpiceDB provisioning configuration is invalid'),
    ),
  );
  const target = yield* selectActionAuthorizationProvisioningTarget(configuration);
  if (target.environment !== 'development') {
    return yield* failure('action_authorization_configuration_invalid', 'This wrapper runs only in development');
  }
  const actions = yield* discoverCurrentActions(workspaceRoot);
  const explicit = yield* deriveExplicitActionAuthorization(
    actions,
    target.contexts,
    target.contexts.map(({ principalId }) => ({ explicitActions: 'all' as const, principalId })),
  );
  const client = yield* acquireClient(target.configuration);
  const result = yield* provisionActionAuthorization(client, { actions, contexts: target.contexts, ...explicit });
  return yield* Console.log(
    `Provisioned ${result.grantCount} Action executor grants for ${result.actionCount} Actions (${explicit.explicitActionGrants.length} explicit) across ${result.tenantCount} development Tenant(s).`,
  );
}).pipe(
  Effect.scoped,
  Effect.tapError((cause) => Console.error(formatActionAuthorizationProvisioningFailure(cause))),
);

const command = Command.make('demo-provision-actions', {}, () => provision);
NodeRuntime.runMain(
  Layer.build(
    Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(Layer.provide(NodeServices.layer)),
  ).pipe(Effect.scoped),
  { disableErrorReporting: true },
);
