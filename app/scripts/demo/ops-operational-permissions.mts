#!/usr/bin/env node
/** LOCAL ONLY: apply the external Siampark operational grants without resetting other demo identities/data.
 * Run from app/: mise exec -- node scripts/demo/ops-operational-permissions.mts
 * Set ONTOS_DEMO_ENV_FILE to the running runtime's .env when its local TLS certificate differs.
 * Restricted agendas still require read_all/write_all, which this persona never receives. S00: the persona is
 * provoz read-only (own assigned calendar events, operational meters), so an earlier write_operational grant
 * is deleted here; SpiceDB TOUCH alone never removes it.
 */
import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { toContextPermissionAccessObjectId } from '@app/core-runtime';
import { Config, ConfigProvider, Console, Effect, Layer } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
} from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionSourceLive } from '../../packages/core-runtime/src/modules/active-application-composition-source.node.ts';
import { discoverCurrentActions } from '../provision-current-action-authorization.mts';
import { bootstrapRelationshipRequest } from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { toScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import { demoTenantId, rentalDemoLegalEntityId } from './fixture-ids.mts';
import { demoPrincipalRoleKey, principalRelationships, siamparkRentalPersonas } from './permissions.mts';

const environmentLive = ConfigProvider.layer(
  Effect.gen(function* loadOperatorConfiguration() {
    const path = yield* Config.String('ONTOS_DEMO_ENV_FILE').pipe(
      Config.withDefault(new URL('../../.env', import.meta.url).pathname),
    );
    return ConfigProvider.orElse(ConfigProvider.fromEnv(), yield* ConfigProvider.fromDotEnv({ path }));
  }),
);
const compositionLive = ActiveApplicationCompositionConfigLive.pipe(
  Layer.provide(ActiveApplicationCompositionSourceLive),
  Layer.provide(FetchHttpClient.layer),
);
const program = Effect.gen(function* repairPublishedRolePermissions() {
  const configuration = yield* loadSpiceDbConfig({
    envPath: yield* Config.String('ONTOS_DEMO_ENV_FILE').pipe(
      Config.withDefault(new URL('../../.env', import.meta.url).pathname),
    ),
  });
  if (
    configuration.deploymentEnvironment !== 'development' ||
    !/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/u.test(configuration.endpoint)
  ) {
    return yield* Effect.fail(new Error('This demo grant helper requires local development SpiceDB'));
  }
  const source = yield* ActiveApplicationCompositionService;
  const actions = (yield* discoverCurrentActions(yield* source.load)).filter(
    (action) => action.actionKey === 'facility.operations.apply-command',
  );
  if (actions.length !== 1) {
    return yield* Effect.fail(new Error('Required published Action is missing'));
  }
  const persona = siamparkRentalPersonas.find((entry) => entry.email === 'external@siampark.demo');
  if (persona === undefined) {
    return yield* Effect.fail(new Error('External demo persona is missing'));
  }
  const relationships = yield* Effect.try(() =>
    principalRelationships(persona.principalId, persona.role, actions, rentalDemoLegalEntityId),
  );
  const client = yield* Effect.acquireRelease(
    Effect.try(() => openSpiceDbGrpcRpc(configuration, 5000)),
    (value) => Effect.sync(() => value.close()),
  );
  yield* client.writeRelationships(bootstrapRelationshipRequest(relationships));
  const revoked = ['facility.operations.write_operational', 'facility.operations.write_all'].map((permission) =>
    v1.RelationshipUpdate.create({
      operation: v1.RelationshipUpdate_Operation.DELETE,
      relationship: v1.Relationship.create({
        relation: 'role_grantee',
        resource: v1.ObjectReference.create({
          objectId:
            toContextPermissionAccessObjectId(demoTenantId, rentalDemoLegalEntityId, {
              moduleId: 'facility.operations',
              permission,
            }) ?? '',
          objectType: 'context_permission',
        }),
        subject: v1.SubjectReference.create({
          object: v1.ObjectReference.create({
            objectId: toScopedRoleObjectId({
              legalEntityId: rentalDemoLegalEntityId,
              roleKey: demoPrincipalRoleKey(persona.principalId),
              tenantId: demoTenantId,
            }),
            objectType: 'scoped_role',
          }),
          optionalRelation: 'member',
        }),
      }),
    }),
  );
  yield* client.writeRelationships(v1.WriteRelationshipsRequest.create({ updates: revoked }));
  yield* Console.log(
    `External Siampark operational grants applied (${relationships.length} relationships); restricted agendas unchanged.`,
  );
  return yield* Effect.void;
}).pipe(
  Effect.scoped,
  Effect.provide(compositionLive),
  Effect.provide(environmentLive),
  Effect.provide(NodeServices.layer),
);

await Effect.runPromise(program);
