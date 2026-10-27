#!/usr/bin/env node
/** LOCAL ONLY: add the Siampark (0021) CRM grants without resetting other demo identities or data.
 * Vedení: demo.crm read_all + write_all + assign; Externí obchodník: demo.crm read_assigned only (no write) and
 * demo.sales-pipeline read without read_all (only cases granted by scripts/demo/seed-siampark-cases.mts).
 * Run from app/: node scripts/demo/siampark-crm-permissions.mts
 * Set ONTOS_DEMO_ENV_FILE to the running runtime's .env when its local TLS certificate differs.
 * Writes (touches) the full permissions.mts relationship set of both personas, as reset-permissions.mts would;
 * the only new relationships are the demo.crm module, context permissions and the demo.crm.apply-command grant.
 */
import { NodeServices } from '@effect/platform-node';
import { Config, ConfigProvider, Console, Effect, Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
} from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionSourceLive } from '../../packages/core-runtime/src/modules/active-application-composition-source.node.ts';
import { discoverCurrentActions } from '../provision-current-action-authorization.mts';
import { bootstrapRelationshipRequest } from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { rentalDemoLegalEntityId, demoTenantId } from './fixture-ids.mts';
import type { DemoAction } from './permissions.mts';
import { principalRelationships, siamparkRentalPersonas } from './permissions.mts';

const emails = new Set(['management@siampark.demo', 'external@siampark.demo']);

export const siamparkCrmRelationships = (actions: readonly DemoAction[]) =>
  siamparkRentalPersonas
    .filter((persona) => emails.has(persona.email))
    .flatMap((persona) =>
      principalRelationships(
        persona.principalId,
        persona.role,
        actions.filter((action) => action.actionKey === 'demo.crm.apply-command'),
        rentalDemoLegalEntityId,
        demoTenantId,
        persona.email === 'management@siampark.demo' ? 'crm-repair-management' : 'crm-repair-external',
      ),
    );

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
    (action) => action.actionKey === 'demo.crm.apply-command',
  );
  if (actions.length !== 1) {
    return yield* Effect.fail(new Error('Required published Action is missing'));
  }
  const all = yield* Effect.try(() => siamparkCrmRelationships(actions));
  // SpiceDB rejects a write that names the same relationship twice (both personas share the company relations).
  const relationships = [
    ...new Map(
      all.map((entry) => [
        [
          entry.resourceType,
          entry.resourceId,
          entry.relation,
          entry.subjectType,
          entry.subjectId,
          entry.subjectRelation ?? '',
        ].join('|'),
        entry,
      ]),
    ).values(),
  ];
  const client = yield* Effect.acquireRelease(
    Effect.try(() => openSpiceDbGrpcRpc(configuration, 5000)),
    (value) => Effect.sync(() => value.close()),
  );
  yield* client.writeRelationships(bootstrapRelationshipRequest(relationships));
  yield* Console.log(`Siampark CRM grants applied (${relationships.length} relationships).`);
  return yield* Effect.void;
}).pipe(
  Effect.scoped,
  Effect.provide(compositionLive),
  Effect.provide(environmentLive),
  Effect.provide(NodeServices.layer),
);

if (import.meta.main) {
  await Effect.runPromise(program);
}
