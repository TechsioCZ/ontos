#!/usr/bin/env node
/** Local sales-demo fixture repair: original Siampark bootstrap accounts belong in Siampark, not Obchodní firma.
 * Remove ONLY their four stale commercial legal_entity#member edges; all company 0021 grants remain untouched.
 * Run after both reset baselines and reset-permissions. No accounts, records, or other grants are reset.
 */
import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { toLegalEntityAccessObjectId } from '@app/core-runtime';
import { Console, Effect } from 'effect';
import { bootstrapRelationshipRequest } from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { demoLegalEntityId, demoTenantId } from './fixture-ids.mts';
import { siamparkRentalPersonas } from './permissions.mts';

const program = Effect.gen(function* repairCompanyMemberships() {
  const configuration = yield* loadSpiceDbConfig({
    envPath: process.env.ONTOS_DEMO_ENV_FILE ?? new URL('../../.env', import.meta.url).pathname,
  });
  if (
    configuration.deploymentEnvironment !== 'development' ||
    !/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/u.test(configuration.endpoint)
  ) {
    return yield* Effect.fail(new Error('Company fixture repair requires local development SpiceDB'));
  }
  const resourceId = toLegalEntityAccessObjectId(demoTenantId, demoLegalEntityId);
  if (resourceId === undefined) return yield* Effect.fail(new Error('Invalid fixed demo company identity'));
  const request = bootstrapRelationshipRequest(
    siamparkRentalPersonas.map(({ principalId }) => ({
      relation: 'member',
      resourceId,
      resourceType: 'legal_entity',
      subjectId: principalId,
      subjectType: 'principal',
    })),
  );
  for (const update of request.updates) update.operation = v1.RelationshipUpdate_Operation.DELETE;
  const client = yield* Effect.acquireRelease(
    Effect.try(() => openSpiceDbGrpcRpc(configuration, 5000)),
    (value) => Effect.sync(() => value.close()),
  );
  yield* client.writeRelationships(request);
  yield* Console.log(
    'Company fixture repair: removed four stale Siampark memberships in Obchodní firma; Siampark retained.',
  );
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

await Effect.runPromise(program);
