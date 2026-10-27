#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { v1 } from '@authzed/authzed-node';
import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node';
import { eq, inArray, sql } from 'drizzle-orm';
import type { FileSystem } from 'effect';
import { Array as EffectArray, Cause, Config, Console, Duration, Effect, Layer, Option, Order, Schema } from 'effect';
import { Command } from 'effect/cli';

import { CoreDatabase } from '../packages/core-runtime/src/db/client.ts';
import {
  applicationCompositionAuthority,
  legalEntities,
  tenantModuleStates,
} from '../packages/core-runtime/src/db/schema.ts';
import {
  ActionAuthorizationProvisioningError,
  deriveScopedActionAuthorization,
  planActionAuthorizationProvisioning,
  provisionActionAuthorization,
  verifyActionAuthorizationProvisioning,
} from '../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import type {
  ActionAuthorizationContext,
  ActionAuthorizationInstalledModuleScope,
  ActionAuthorizationProvisioningAction,
  ActionAuthorizationProvisioningClient,
  ActionAuthorizationProvisioningInput,
  ActionAuthorizationProvisioningPlan,
} from '../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import {
  STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY,
  parseStageAccountsFile,
  readStageAccountsFileContents,
} from '../packages/core-runtime/src/install/stage-accounts-file.ts';
import type { StageAccountsFile } from '../packages/core-runtime/src/install/stage-accounts-file.ts';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '../packages/core-runtime/src/modules/active-application-composition.ts';
import type { ActiveApplicationCompositionSnapshot } from '../packages/core-runtime/src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionSourceLive } from '../packages/core-runtime/src/modules/active-application-composition-source.node.ts';
import { buildApplicationCompositionCatalog } from '../packages/core-runtime/src/modules/application-composition-catalog.ts';
import { coreActionCatalog } from '../packages/core-runtime/src/modules/actions/catalog.ts';
import { newSpiceDbGrpcClient } from '../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { loadSpiceDbConfig } from '../packages/core-runtime/src/permissions/config.ts';
import type { SpiceDbConfigValue } from '../packages/core-runtime/src/permissions/config.ts';
import { toSpiceDbActionObjectId } from '../packages/core-runtime/src/permissions/service.ts';
import {
  ApplicationCompositionAuthorityAdminDatabaseLive,
  withApplicationCompositionPublicationLock,
} from './application-composition-authority-publication.mts';

export interface StageAccountsAuthorization {
  readonly actionAssertions: ActionAuthorizationProvisioningInput['actionAssertions'];
  readonly contexts: readonly ActionAuthorizationContext[];
  readonly managedRoles: ActionAuthorizationProvisioningInput['managedRoles'];
  readonly roleGrants: ActionAuthorizationProvisioningInput['roleGrants'];
}

export interface ActionAuthorizationProvisioningTarget extends StageAccountsAuthorization {
  readonly configuration: SpiceDbConfigValue;
  readonly environment: 'development' | 'stage';
}

const ProvisioningModeSchema = Schema.Literals(['dry-run', 'apply', 'verify']);

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
    return parsed.port.length > 0 && ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname);
  } catch {
    return false;
  }
};

/** Operator data is exact policy evidence, never permissions inferred from emails or role labels. */
export const stageAccountsAuthorization = (file: StageAccountsFile): StageAccountsAuthorization => ({
  actionAssertions: file.actionAuthorization.actionAssertions,
  contexts: file.tenants.flatMap(({ accounts, legalEntity, tenantId }) =>
    accounts.flatMap(({ principalId }) => [
      { principalId, tenantId },
      { legalEntityId: legalEntity.legalEntityId, principalId, tenantId },
    ]),
  ),
  // Bootstrap installs these explicit principal memberships before provisioning the role's Action policy.
  managedRoles: file.scopedRoles,
  roleGrants: file.actionAuthorization.roleGrants,
});

/** Both environments require explicit operator policy; local development has no implicit blanket grant. */
export const loadStageAccountsAuthorization = (): Effect.Effect<
  StageAccountsAuthorization,
  ActionAuthorizationProvisioningError,
  FileSystem.FileSystem
> =>
  Config.schema(Schema.Trim.check(Schema.isNonEmpty()), STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY).pipe(
    Effect.mapError(() =>
      failure('action_authorization_configuration_invalid', `${STAGE_ACCOUNTS_FILE_ENVIRONMENT_KEY} is required`),
    ),
    Effect.flatMap((filePath) =>
      readStageAccountsFileContents(filePath).pipe(
        Effect.flatMap(parseStageAccountsFile),
        Effect.mapError(({ reason }) => failure('action_authorization_configuration_invalid', reason)),
      ),
    ),
    Effect.map(stageAccountsAuthorization),
  );

export const selectActionAuthorizationProvisioningTarget = (
  configuration: SpiceDbConfigValue,
  authorization: StageAccountsAuthorization,
): Effect.Effect<ActionAuthorizationProvisioningTarget, ActionAuthorizationProvisioningError> => {
  if (
    (configuration.deploymentEnvironment === undefined || configuration.deploymentEnvironment === 'development') &&
    isLoopbackSpiceDb(configuration)
  ) {
    return Effect.succeed({ configuration, environment: 'development', ...authorization });
  }
  if (configuration.deploymentEnvironment === 'stage' && configuration.endpoint === 'spicedb:50051') {
    return Effect.succeed({ configuration, environment: 'stage', ...authorization });
  }
  return Effect.fail(
    failure(
      'action_authorization_configuration_invalid',
      'Current Action authorization can run only against development loopback or fixed stage SpiceDB',
    ),
  );
};

const discoveryFailure = (): ActionAuthorizationProvisioningError =>
  failure(
    'action_authorization_discovery_failed',
    'The complete published Action set and installation scopes could not be derived safely',
  );

/** Contracts come only from the published, validated composition, never the local repository inventory. */
export const discoverCurrentActions = (
  snapshot: ActiveApplicationCompositionSnapshot,
): Effect.Effect<readonly ActionAuthorizationProvisioningAction[], ActionAuthorizationProvisioningError> =>
  Effect.gen(function* discoverCurrentActionsEffect() {
    const approved = yield* validateActiveApplicationCompositionSnapshot(snapshot).pipe(
      Effect.mapError(discoveryFailure),
    );
    const catalog = yield* buildApplicationCompositionCatalog(approved.composition).pipe(
      Effect.mapError(discoveryFailure),
    );
    const actions: ActionAuthorizationProvisioningAction[] = [];
    for (const descriptor of coreActionCatalog) {
      if (descriptor.entrypoint.authorization.kind !== 'action_execution') {
        return yield* discoveryFailure();
      }
      actions.push({
        actionKey: descriptor.actionKey,
        legalEntityScope: descriptor.legalEntityScope,
        owningModuleKey: descriptor.owningModuleKey,
        provisioning: descriptor.entrypoint.authorization.provisioning,
      });
    }
    for (const contract of catalog.contracts) {
      for (const action of contract.manifest.publicSurface.actions) {
        if (action.entrypoint.authorization.kind !== 'action_execution') {
          return yield* discoveryFailure();
        }
        actions.push({
          actionKey: action.actionKey,
          legalEntityScope: action.legalEntityScope,
          owningModuleKey: action.owningModuleId,
          provisioning: action.entrypoint.authorization.provisioning,
        });
      }
    }
    if (actions.length === 0 || new Set(actions.map(({ actionKey }) => actionKey)).size !== actions.length) {
      return yield* discoveryFailure();
    }
    return EffectArray.sortWith(actions, ({ actionKey }) => actionKey, Order.String);
  });

/** Active tenant installs apply to its companies; graph role grants decide who may use them. */
export const deriveActionAuthorizationInstalledModuleScopes = (
  publishedModuleKeys: readonly string[],
  tenantIds: readonly string[],
  moduleStates: readonly { readonly moduleKey: string; readonly state: string; readonly tenantId: string }[],
  companies: readonly { readonly legalEntityId: string; readonly status: string; readonly tenantId: string }[],
): readonly ActionAuthorizationInstalledModuleScope[] => {
  const published = new Set(publishedModuleKeys);
  const coreModuleKeys = [...new Set(coreActionCatalog.map(({ owningModuleKey }) => owningModuleKey))];
  return EffectArray.sort([...new Set(tenantIds)], Order.String).flatMap((tenantId) => {
    const moduleKeys = EffectArray.sort(
      [
        ...new Set([
          ...coreModuleKeys,
          ...moduleStates.flatMap((row) =>
            row.tenantId === tenantId && row.state === 'active' && published.has(row.moduleKey) ? [row.moduleKey] : [],
          ),
        ]),
      ],
      Order.String,
    );
    const tenantCompanies = EffectArray.sortWith(
      companies.filter((company) => company.tenantId === tenantId),
      ({ legalEntityId }) => legalEntityId,
      Order.String,
    );
    return [
      { moduleKeys, tenantId },
      ...tenantCompanies.map((company) => ({
        legalEntityId: company.legalEntityId,
        moduleKeys: company.status === 'active' ? moduleKeys : [],
        tenantId,
      })),
    ];
  });
};

export const loadCurrentActionAuthorizationComposition = (
  tenantIds: readonly string[],
  mode: 'dry-run' | 'apply' | 'verify',
) =>
  Effect.gen(function* loadComposition() {
    if (tenantIds.length === 0) {
      return yield* discoveryFailure();
    }
    const source = yield* ActiveApplicationCompositionService;
    const snapshot = yield* source.load.pipe(Effect.mapError(discoveryFailure));
    const database = yield* CoreDatabase;
    const [authority] = yield* database.executor
      .select({
        phase: applicationCompositionAuthority.phase,
        revision: applicationCompositionAuthority.revision,
        unexpired: sql<boolean>`${applicationCompositionAuthority.validUntil} > clock_timestamp()`,
      })
      .from(applicationCompositionAuthority)
      .where(eq(applicationCompositionAuthority.authorityKey, 'active'))
      .pipe(Effect.mapError(discoveryFailure));
    if (
      authority === undefined ||
      authority.revision !== snapshot.composition.revision ||
      !authority.unexpired ||
      (mode === 'apply'
        ? !['sealed', 'migrated'].includes(authority.phase)
        : !['active', 'sealed', 'migrated'].includes(authority.phase))
    ) {
      return yield* failure(
        'action_authorization_discovery_failed',
        'Provisioning requires the exact current composition; apply additionally requires sealed admission',
      );
    }
    const actions = yield* discoverCurrentActions(snapshot);
    const moduleStates = yield* database.executor
      .select({
        moduleKey: tenantModuleStates.moduleKey,
        state: tenantModuleStates.state,
        tenantId: tenantModuleStates.tenantId,
      })
      .from(tenantModuleStates)
      .where(inArray(tenantModuleStates.tenantId, [...tenantIds]))
      .pipe(Effect.mapError(discoveryFailure));
    const companies = yield* database.executor
      .select({
        legalEntityId: legalEntities.legalEntityId,
        status: legalEntities.status,
        tenantId: legalEntities.tenantId,
      })
      .from(legalEntities)
      .where(inArray(legalEntities.tenantId, [...tenantIds]))
      .pipe(Effect.mapError(discoveryFailure));
    return {
      actions,
      authorityPhase: authority.phase,
      companies,
      installedModuleScopes: deriveActionAuthorizationInstalledModuleScopes(
        snapshot.composition.modules.map(({ moduleId }) => moduleId),
        tenantIds,
        moduleStates,
        companies,
      ),
      moduleStates,
      snapshot,
    };
  });

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
          provisioningServiceFailure(new Cause.TimeoutError('SpiceDB authorization provisioning request timed out')),
        ),
    }),
  );
const createProvisioningClient = (configuration: SpiceDbConfigValue): CloseableProvisioningClient => {
  const client = newSpiceDbGrpcClient(configuration);
  return {
    checkPermission: (request) =>
      callProvisioningClient(client.promises.checkPermission.bind(client.promises, request)).pipe(
        Effect.map(Option.fromNullishOr),
      ),
    close: () => client.close(),
    diffSchema: (request) => callProvisioningClient(client.promises.diffSchema.bind(client.promises, request)),
    readRelationships: (request) =>
      callProvisioningClient(client.promises.readRelationships.bind(client.promises, request)),
    readSchema: (request) => callProvisioningClient(client.promises.readSchema.bind(client.promises, request)),
    writeRelationships: (request) =>
      callProvisioningClient(client.promises.writeRelationships.bind(client.promises, request)),
  };
};
const acquireProvisioningClient = (configuration: SpiceDbConfigValue) =>
  Effect.acquireRelease(
    Effect.try({ catch: provisioningServiceFailure, try: () => createProvisioningClient(configuration) }),
    (client) => Effect.sync(() => client.close()),
  );

const ProvisioningCompositionLive = ActiveApplicationCompositionConfigLive.pipe(
  Layer.provide(ActiveApplicationCompositionSourceLive),
  Layer.provide(NodeHttpClient.layerUndici),
);

export const runCurrentActionAuthorizationProvisioning = (
  commandArguments: readonly string[] = [],
): Effect.Effect<
  ActionAuthorizationProvisioningPlan & {
    readonly environment: 'development' | 'stage';
    readonly mode: 'dry-run' | 'apply' | 'verify';
  },
  ActionAuthorizationProvisioningError,
  ActiveApplicationCompositionService | CoreDatabase | FileSystem.FileSystem
> =>
  Effect.gen(function* runProvisioning() {
    if (commandArguments.length > 0) {
      return yield* failure(
        'action_authorization_configuration_invalid',
        'Current Action authorization provisioning accepts no command-line arguments',
      );
    }
    const configuration = yield* loadSpiceDbConfig().pipe(
      Effect.mapError(() =>
        failure('action_authorization_configuration_invalid', 'The SpiceDB provisioning configuration is invalid'),
      ),
    );
    const mode = yield* Config.schema(ProvisioningModeSchema, 'ONTOS_AUTHORIZATION_MODE').pipe(
      Config.withDefault('dry-run'),
      Effect.mapError(() =>
        failure(
          'action_authorization_configuration_invalid',
          'ONTOS_AUTHORIZATION_MODE must be dry-run, apply or verify',
        ),
      ),
    );
    const authorization = yield* loadStageAccountsAuthorization();
    const target = yield* selectActionAuthorizationProvisioningTarget(configuration, authorization);
    return yield* withApplicationCompositionPublicationLock(
      Effect.gen(function* provisionPublishedComposition() {
        const composition = yield* loadCurrentActionAuthorizationComposition(
          [...new Set(target.contexts.map(({ tenantId }) => tenantId))],
          mode,
        );
        const currentActions = yield* Effect.try({
          catch: discoveryFailure,
          try: () =>
            new Set(
              deriveScopedActionAuthorization(composition.actions, composition.installedModuleScopes).map(
                toSpiceDbActionObjectId,
              ),
            ),
        });
        const client = yield* acquireProvisioningClient(target.configuration);
        const input = {
          ...composition,
          actionAssertions: target.actionAssertions.filter((assertion) =>
            currentActions.has(toSpiceDbActionObjectId(assertion)),
          ),
          contexts: target.contexts,
          managedRoles: target.managedRoles,
          roleGrants: target.roleGrants,
        };
        let result: ActionAuthorizationProvisioningPlan;
        if (mode === 'apply') {
          const fingerprint = yield* Config.schema(
            Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
            'ONTOS_AUTHORIZATION_PLAN_SHA256',
          ).pipe(
            Effect.mapError(() =>
              failure(
                'action_authorization_configuration_invalid',
                'Apply requires the reviewed dry-run ONTOS_AUTHORIZATION_PLAN_SHA256',
              ),
            ),
          );
          result = yield* provisionActionAuthorization(client, input, fingerprint);
        } else {
          result = yield* mode === 'verify'
            ? verifyActionAuthorizationProvisioning(client, input)
            : planActionAuthorizationProvisioning(client, input);
        }
        return { ...result, environment: target.environment, mode };
      }),
    ).pipe(
      Effect.mapError((error) =>
        Schema.is(ActionAuthorizationProvisioningError)(error) ? error : provisioningServiceFailure(error),
      ),
    );
  }).pipe(Effect.scoped);

export const formatActionAuthorizationProvisioningFailure = (cause: unknown): string =>
  Schema.is(ActionAuthorizationProvisioningError)(cause)
    ? `${cause.code}: ${cause.reason}`
    : 'action_authorization_service_unavailable: Unexpected Action authorization provisioning failure';

const PlanReportSchema = Schema.Struct({
  actionCount: Schema.Number,
  environment: Schema.Literals(['development', 'stage']),
  fingerprint: Schema.String,
  grantCount: Schema.Number,
  mode: ProvisioningModeSchema,
  tenantCount: Schema.Number,
  updates: Schema.Array(Schema.String),
});

const command = Command.make('authorization-provision-current-actions', {}, () =>
  Layer.build(
    Layer.effectDiscard(
      Effect.gen(function* provisionCommand() {
        const result = yield* runCurrentActionAuthorizationProvisioning().pipe(
          Effect.tapError((cause) => Console.error(formatActionAuthorizationProvisioningFailure(cause))),
        );
        const report = yield* Schema.encodeEffect(Schema.fromJsonString(PlanReportSchema))({
          actionCount: result.actionCount,
          environment: result.environment,
          fingerprint: result.fingerprint,
          grantCount: result.grantCount,
          mode: result.mode,
          tenantCount: result.tenantCount,
          updates: result.updates.map((update) => v1.RelationshipUpdate.toJsonString(update)),
        });
        yield* Console.log(report);
      }),
    ).pipe(
      Layer.provide(Layer.mergeAll(ProvisioningCompositionLive, ApplicationCompositionAuthorityAdminDatabaseLive)),
    ),
  ).pipe(Effect.scoped, Effect.asVoid),
);

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(Command.run(command, { version: '0.1.0' })).pipe(Layer.provide(NodeServices.layer)),
    ).pipe(Effect.scoped),
    { disableErrorReporting: true },
  );
}
