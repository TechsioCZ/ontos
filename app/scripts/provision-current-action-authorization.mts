#!/usr/bin/env node
/* eslint-disable node/no-process-env -- This parameterless operator command validates its deployment environment. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { v1 } from '@authzed/authzed-node';
import { Effect, Schema } from 'effect';
import {
  ActionAuthorizationProvisioningError,
  provisionActionAuthorization,
} from '../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import type {
  ActionAuthorizationContext,
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
): ActionAuthorizationProvisioningError =>
  new ActionAuthorizationProvisioningError({ code, reason });

const isLoopbackSpiceDb = (configuration: SpiceDbConfigValue): boolean => {
  try {
    const parsed = new URL(`http://${configuration.endpoint}`);
    return (
      configuration.insecureLocal &&
      parsed.port.length > 0 &&
      ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(parsed.hostname)
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
    const contexts = [STAGE_CONTEXTS.techsio, STAGE_CONTEXTS.siampark]
      .map(({ principalId, tenantId }) => ({ principalId, tenantId }))
      .toSorted((left, right) => left.tenantId.localeCompare(right.tenantId));
    return Effect.succeed({ configuration, contexts, environment: 'stage' });
  }
  return Effect.fail(
    failure(
      'action_authorization_configuration_invalid',
      'Current Action authorization can run only against fixed development or stage SpiceDB',
    ),
  );
};

const decodeRepositoryInventory = async (workspaceRoot: string) => {
  const [topologySource, ownershipSource] = await Promise.all([
    readFile(path.join(workspaceRoot, 'topology/reference-topology.json'), 'utf-8'),
    readFile(path.join(workspaceRoot, 'topology/ownership.json'), 'utf-8'),
  ]);
  return {
    ownership: Schema.decodeUnknownSync(OwnershipSchema, { onExcessProperty: 'preserve' })(
      JSON.parse(ownershipSource),
    ),
    topology: Schema.decodeUnknownSync(TopologySchema, { onExcessProperty: 'preserve' })(
      JSON.parse(topologySource),
    ),
  };
};

export const discoverCurrentActionKeys = async (
  workspaceRoot: string,
  deriveContract: DeriveContract = deriveOntosModuleDeploymentContract,
): Promise<readonly string[]> => {
  try {
    const { ownership, topology } = await decodeRepositoryInventory(workspaceRoot);
    if (topology.verticals.length === 0 || coreActionCatalog.length === 0) {
      throw new Error('Action owner discovery is empty');
    }
    const ownerKeys = new Set(
      ownership.owners.map(
        ({ id, package: packageName, path: ownerPath }) =>
          `${id}\u0000${packageName}\u0000${ownerPath}`,
      ),
    );
    const verticals = topology.verticals.toSorted((left, right) => left.id.localeCompare(right.id));
    if (
      new Set(verticals.map(({ id }) => id)).size !== verticals.length ||
      verticals.some(
        ({ id, package: packageName, path: ownerPath }) =>
          !ownerKeys.has(`${id}\u0000${packageName}\u0000${ownerPath}`) ||
          path.dirname(ownerPath) !== 'verticals' ||
          path.basename(ownerPath) !== id,
      )
    ) {
      throw new Error('Topology and ownership do not identify every MicroVertical exactly once');
    }
    const contracts = await Promise.all(
      verticals.map(async ({ id }) => ({
        contract: await deriveContract({ vertical: id, workspaceRoot }),
        id,
      })),
    );
    const verticalActionKeys = contracts.flatMap(({ contract, id }) => {
      if (
        contract.deployment.appId !== id ||
        contract.manifest.publicSurface.actions.length === 0
      ) {
        throw new Error('A derived MicroVertical contract is incomplete');
      }
      return contract.manifest.publicSurface.actions.map(({ actionKey }) => actionKey);
    });
    const actionKeys = [
      ...coreActionCatalog.map(({ actionKey }) => actionKey),
      ...verticalActionKeys,
    ].toSorted((left, right) => left.localeCompare(right));
    if (actionKeys.length === 0 || new Set(actionKeys).size !== actionKeys.length) {
      throw new Error('Current Action discovery is empty or duplicated');
    }
    return actionKeys;
  } catch (error) {
    if (error instanceof ActionAuthorizationProvisioningError) {
      throw error;
    }
    throw failure(
      'action_authorization_discovery_failed',
      'The complete current Action set could not be derived safely',
    );
  }
};

interface CloseableProvisioningClient extends ActionAuthorizationProvisioningClient {
  readonly close: () => void;
}

const createProvisioningClient = (
  configuration: SpiceDbConfigValue,
): CloseableProvisioningClient => {
  const client = v1.NewClient(
    configuration.preSharedKey,
    configuration.endpoint,
    spiceDbClientSecurity(configuration),
  );
  return {
    checkPermission: (request) => client.promises.checkPermission(request),
    close: () => client.close(),
    writeRelationships: (request) => client.promises.writeRelationships(request),
    writeSchema: (request) => client.promises.writeSchema(request),
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

export const runCurrentActionAuthorizationProvisioning = (
  workspaceRoot: string,
  arguments_: readonly string[] = [],
): Effect.Effect<
  ActionAuthorizationProvisioningResult & { readonly environment: 'development' | 'stage' },
  ActionAuthorizationProvisioningError
> =>
  Effect.gen(function* runCurrentActionAuthorizationProvisioningEffect() {
    if (arguments_.length > 0) {
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
    const actionKeys = yield* Effect.tryPromise({
      catch: (error) =>
        error instanceof ActionAuthorizationProvisioningError
          ? error
          : failure(
              'action_authorization_discovery_failed',
              'The complete current Action set could not be derived safely',
            ),
      try: () => discoverCurrentActionKeys(workspaceRoot),
    });
    const client = yield* acquireProvisioningClient(target.configuration);
    const result = yield* provisionActionAuthorization(client, {
      actionKeys,
      contexts: target.contexts,
    });
    return { ...result, environment: target.environment };
  }).pipe(Effect.scoped);

const main = (): void => {
  const workspaceRoot = path.resolve(import.meta.dirname, '..');
  Effect.runPromise(runCurrentActionAuthorizationProvisioning(workspaceRoot, process.argv.slice(2)))
    .then((result) => {
      console.log(
        `Provisioned ${result.grantCount} explicit Action grants for ${result.actionCount} Actions across ${result.tenantCount} ${result.environment} Tenant(s).`,
      );
    })
    .catch((error: ActionAuthorizationProvisioningError) => {
      console.error(`${error.code}: ${error.reason}`);
      process.exitCode = 1;
    });
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
