#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { v1 } from '@authzed/authzed-node';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  Array as EffectArray,
  Cause,
  Console,
  Duration,
  Effect,
  FileSystem,
  flow,
  Layer,
  ManagedRuntime,
  Option,
  Order,
  Path,
  Schema,
} from 'effect';
import { Command } from 'effect/unstable/cli';
import {
  ActionAuthorizationProvisioningError,
  provisionActionAuthorization,
} from '../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import type {
  ActionAuthorizationContext,
  ActionAuthorizationProvisioningAction,
  ActionAuthorizationProvisioningClient,
  ActionAuthorizationProvisioningResult,
} from '../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import { coreActionCatalog } from '../packages/core-runtime/src/index.ts';
import { spiceDbClientSecurity } from '../packages/core-runtime/src/permissions/client.ts';
import { loadSpiceDbConfig } from '../packages/core-runtime/src/permissions/config.ts';
import type { SpiceDbConfigValue } from '../packages/core-runtime/src/permissions/config.ts';
import { STAGE_CONTEXTS } from '../packages/core-runtime/src/install/stage-context-bootstrap.ts';
import { LOCAL_DEVELOPMENT_CONTEXT } from './initialize-local-development.mts';
import { deriveOntosModuleDeploymentContract } from './generate-ontos-module-contract.mts';

const TopologySchema = Schema.Struct({
  verticals: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      package: Schema.String,
      path: Schema.String,
    }),
  ),
});

const OwnershipSchema = Schema.Struct({
  owners: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      package: Schema.String,
      path: Schema.String,
    }),
  ),
});

type DeriveContract = typeof deriveOntosModuleDeploymentContract;

export interface ActionAuthorizationProvisioningTarget {
  readonly configuration: SpiceDbConfigValue;
  readonly contexts: readonly ActionAuthorizationContext[];
  readonly environment: 'development' | 'stage';
}

const failure = (
  code: ActionAuthorizationProvisioningError['code'],
  reason: string,
  cause?: unknown,
): ActionAuthorizationProvisioningError => {
  const error = new ActionAuthorizationProvisioningError({ code, reason });
  return cause === undefined ? error : Object.defineProperty(error, 'cause', { value: cause });
};

const isLoopbackSpiceDb = (configuration: SpiceDbConfigValue): boolean => {
  try {
    const parsed = new URL(`http://${configuration.endpoint}`);
    return (
      configuration.insecureLocal &&
      parsed.port.length > 0 &&
      ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
};

export const selectActionAuthorizationProvisioningTarget = (
  configuration: SpiceDbConfigValue,
): Effect.Effect<ActionAuthorizationProvisioningTarget, ActionAuthorizationProvisioningError> => {
  if (
    (configuration.deploymentEnvironment === undefined ||
      configuration.deploymentEnvironment === 'development') &&
    isLoopbackSpiceDb(configuration)
  ) {
    return Effect.succeed({
      configuration,
      contexts: [
        {
          principalId: LOCAL_DEVELOPMENT_CONTEXT.principalId,
          tenantId: LOCAL_DEVELOPMENT_CONTEXT.tenantId,
        },
      ],
      environment: 'development',
    });
  }
  if (
    configuration.deploymentEnvironment === 'stage' &&
    configuration.endpoint === 'spicedb:50051' &&
    configuration.insecureLocal
  ) {
    const contexts = EffectArray.sortWith(
      [STAGE_CONTEXTS.techsio, STAGE_CONTEXTS.siampark].map(({ principalId, tenantId }) => ({
        principalId,
        tenantId,
      })),
      ({ tenantId }) => tenantId,
      Order.String,
    );
    return Effect.succeed({ configuration, contexts, environment: 'stage' });
  }
  return Effect.fail(
    failure(
      'action_authorization_configuration_invalid',
      'Current Action authorization can run only against fixed development or stage SpiceDB',
    ),
  );
};

const discoveryFailure = (): ActionAuthorizationProvisioningError =>
  failure(
    'action_authorization_discovery_failed',
    'The complete current Action set could not be derived safely',
  );

const decodeRepositoryInventory = (workspaceRoot: string) =>
  Effect.gen(function* decodeRepositoryInventoryEffect() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const [topologySource, ownershipSource] = yield* Effect.all(
      [
        fileSystem.readFileString(
          path.join(workspaceRoot, 'topology/reference-topology.json'),
          'utf-8',
        ),
        fileSystem.readFileString(path.join(workspaceRoot, 'topology/ownership.json'), 'utf-8'),
      ],
      { concurrency: 'unbounded' },
    ).pipe(Effect.mapError(discoveryFailure));
    const ownership = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OwnershipSchema), {
      onExcessProperty: 'preserve',
    })(ownershipSource).pipe(Effect.mapError(discoveryFailure));
    const topology = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TopologySchema), {
      onExcessProperty: 'preserve',
    })(topologySource).pipe(Effect.mapError(discoveryFailure));
    return { ownership, topology };
  });

const discoverCurrentActionsEffect = (
  workspaceRoot: string,
  deriveContract: DeriveContract = deriveOntosModuleDeploymentContract,
): Effect.Effect<
  readonly ActionAuthorizationProvisioningAction[],
  ActionAuthorizationProvisioningError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* discoverCurrentActionsEffectGenerator() {
    const path = yield* Path.Path;
    const { ownership, topology } = yield* decodeRepositoryInventory(workspaceRoot);
    if (topology.verticals.length === 0 || coreActionCatalog.length === 0) {
      return yield* discoveryFailure();
    }
    const ownerKeys = new Set(
      ownership.owners.map(
        ({ id, package: packageName, path: ownerPath }) =>
          `${id}\u0000${packageName}\u0000${ownerPath}`,
      ),
    );
    const verticals = EffectArray.sortWith(topology.verticals, ({ id }) => id, Order.String);
    if (
      new Set(verticals.map(({ id }) => id)).size !== verticals.length ||
      verticals.some(
        ({ id, package: packageName, path: ownerPath }) =>
          !ownerKeys.has(`${id}\u0000${packageName}\u0000${ownerPath}`) ||
          path.dirname(ownerPath) !== 'verticals' ||
          path.basename(ownerPath) !== id,
      )
    ) {
      return yield* discoveryFailure();
    }
    const contracts = yield* Effect.forEach(
      verticals,
      ({ id }) =>
        Effect.tryPromise({
          catch: discoveryFailure,
          try: async () => await deriveContract({ vertical: id, workspaceRoot }),
        }).pipe(Effect.map((contract) => ({ contract, id }))),
      { concurrency: 'unbounded' },
    );
    const verticalActions: ActionAuthorizationProvisioningAction[] = [];
    for (const { contract, id } of contracts) {
      if (
        contract.deployment.appId !== id ||
        contract.manifest.publicSurface.actions.length === 0
      ) {
        return yield* discoveryFailure();
      }
      for (const { actionKey, entrypoint } of contract.manifest.publicSurface.actions) {
        if (entrypoint?.authorization.kind !== 'action_execution') {
          return yield* discoveryFailure();
        }
        verticalActions.push({ actionKey, provisioning: entrypoint.authorization.provisioning });
      }
    }
    const coreActions: ActionAuthorizationProvisioningAction[] = [];
    for (const { actionKey, entrypoint } of coreActionCatalog) {
      if (entrypoint.authorization.kind !== 'action_execution') {
        return yield* discoveryFailure();
      }
      coreActions.push({ actionKey, provisioning: entrypoint.authorization.provisioning });
    }
    const actions = EffectArray.sortWith(
      [...coreActions, ...verticalActions],
      ({ actionKey }) => actionKey,
      Order.String,
    );
    const actionKeys = actions.map(({ actionKey }) => actionKey);
    if (actionKeys.length === 0 || new Set(actionKeys).size !== actionKeys.length) {
      return yield* discoveryFailure();
    }
    return actions;
  }).pipe(Effect.catchDefect(discoveryFailure));

const repositoryRuntime = ManagedRuntime.make(NodeServices.layer);

const discoverCurrentActionsProgram = (
  workspaceRoot: string,
  deriveContract: DeriveContract = deriveOntosModuleDeploymentContract,
): Effect.Effect<
  readonly ActionAuthorizationProvisioningAction[],
  ActionAuthorizationProvisioningError,
  FileSystem.FileSystem | Path.Path
> => discoverCurrentActionsEffect(workspaceRoot, deriveContract);

export const discoverCurrentActions = flow(
  discoverCurrentActionsProgram,
  repositoryRuntime.runPromise,
);

const discoverCurrentActionKeysProgram = (
  workspaceRoot: string,
  deriveContract: DeriveContract = deriveOntosModuleDeploymentContract,
): Effect.Effect<
  readonly string[],
  ActionAuthorizationProvisioningError,
  FileSystem.FileSystem | Path.Path
> =>
  discoverCurrentActionsEffect(workspaceRoot, deriveContract).pipe(
    Effect.map((actions) => actions.map(({ actionKey }) => actionKey)),
  );

export const discoverCurrentActionKeys = flow(
  discoverCurrentActionKeysProgram,
  repositoryRuntime.runPromise,
);

interface CloseableProvisioningClient extends ActionAuthorizationProvisioningClient {
  readonly close: () => void;
}

const provisioningServiceFailure = (cause?: unknown): ActionAuthorizationProvisioningError =>
  failure(
    'action_authorization_service_unavailable',
    'The authorization service could not provision current Action rules safely',
    cause,
  );

const callProvisioningClient = <Value,>(operation: () => PromiseLike<Value>) =>
  Effect.tryPromise({ catch: provisioningServiceFailure, try: operation }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(30),
      orElse: () =>
        Effect.fail(
          provisioningServiceFailure(
            new Cause.TimeoutError('SpiceDB authorization provisioning request timed out'),
          ),
        ),
    }),
  );

const createProvisioningClient = (
  configuration: SpiceDbConfigValue,
): CloseableProvisioningClient => {
  const client = v1.NewClient(
    configuration.preSharedKey,
    configuration.endpoint,
    spiceDbClientSecurity(configuration),
  );
  return {
    checkPermission: (request) =>
      callProvisioningClient(client.promises.checkPermission.bind(client.promises, request)).pipe(
        Effect.map(Option.fromNullishOr),
      ),
    close: () => client.close(),
    writeRelationships: (request) =>
      callProvisioningClient(client.promises.writeRelationships.bind(client.promises, request)),
    writeSchema: (request) =>
      callProvisioningClient(client.promises.writeSchema.bind(client.promises, request)),
  };
};

const acquireProvisioningClient = (configuration: SpiceDbConfigValue) =>
  Effect.acquireRelease(
    Effect.try({
      catch: () =>
        failure(
          'action_authorization_service_unavailable',
          'The authorization provisioning client could not be created',
        ),
      try: () => createProvisioningClient(configuration),
    }),
    (client) => Effect.sync(() => client.close()),
  );

const runCurrentActionAuthorizationProvisioningWithServices = (
  workspaceRoot: string,
  commandArguments: readonly string[] = [],
): Effect.Effect<
  ActionAuthorizationProvisioningResult & { readonly environment: 'development' | 'stage' },
  ActionAuthorizationProvisioningError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* runCurrentActionAuthorizationProvisioningEffect() {
    if (commandArguments.length > 0) {
      return yield* failure(
        'action_authorization_configuration_invalid',
        'Current Action authorization provisioning accepts no command-line arguments',
      );
    }
    const configuration = yield* loadSpiceDbConfig().pipe(
      Effect.mapError(() =>
        failure(
          'action_authorization_configuration_invalid',
          'The SpiceDB provisioning configuration is invalid',
        ),
      ),
    );
    const target = yield* selectActionAuthorizationProvisioningTarget(configuration);
    const actions = yield* discoverCurrentActionsEffect(workspaceRoot);
    const client = yield* acquireProvisioningClient(target.configuration);
    const result = yield* provisionActionAuthorization(client, {
      actions,
      contexts: target.contexts,
    });
    return { ...result, environment: target.environment };
  }).pipe(Effect.scoped);

export function runCurrentActionAuthorizationProvisioning(
  workspaceRoot: string,
  commandArguments: readonly [string, ...string[]],
): Effect.Effect<
  ActionAuthorizationProvisioningResult & { readonly environment: 'development' | 'stage' },
  ActionAuthorizationProvisioningError
>;
export function runCurrentActionAuthorizationProvisioning(
  workspaceRoot: string,
): Effect.Effect<
  ActionAuthorizationProvisioningResult & { readonly environment: 'development' | 'stage' },
  ActionAuthorizationProvisioningError,
  FileSystem.FileSystem | Path.Path
>;
export function runCurrentActionAuthorizationProvisioning(
  workspaceRoot: string,
  commandArguments: readonly string[] = [],
): Effect.Effect<
  ActionAuthorizationProvisioningResult & { readonly environment: 'development' | 'stage' },
  ActionAuthorizationProvisioningError,
  FileSystem.FileSystem | Path.Path
> {
  return runCurrentActionAuthorizationProvisioningWithServices(workspaceRoot, commandArguments);
}

export const formatActionAuthorizationProvisioningFailure = (cause: unknown): string =>
  Schema.is(ActionAuthorizationProvisioningError)(cause)
    ? `${cause.code}: ${cause.reason}`
    : 'action_authorization_service_unavailable: Unexpected Action authorization provisioning failure';

const command = Command.make('authorization-provision-current-actions', {}, () =>
  Effect.gen(function* provisionCurrentActionsCommand() {
    const path = yield* Path.Path;
    const workspaceRoot = path.resolve(import.meta.dirname, '..');
    const result = yield* runCurrentActionAuthorizationProvisioningWithServices(workspaceRoot).pipe(
      Effect.tapError((cause) =>
        Console.error(formatActionAuthorizationProvisioningFailure(cause)),
      ),
    );
    yield* Console.log(
      `Provisioned ${result.grantCount} explicit Action grants for ${result.actionCount} Actions across ${result.tenantCount} ${result.environment} Tenant(s).`,
    );
  }),
);

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  NodeRuntime.runMain(
    Layer.effectDiscard(Command.run(command, { version: '0.1.0' })).pipe(
      Layer.provide(NodeServices.layer),
      Layer.launch,
    ),
    { disableErrorReporting: true },
  );
}
