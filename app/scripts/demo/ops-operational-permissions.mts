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
import { Console, Effect } from 'effect';
import { bootstrapRelationshipRequest } from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { demoTenantId, rentalDemoLegalEntityId } from './fixture-ids.mts';
import { principalRelationships, siamparkRentalPersonas } from './permissions.mts';

const program = Effect.gen(function* () {
  const configuration = yield* loadSpiceDbConfig({
    envPath: process.env.ONTOS_DEMO_ENV_FILE ?? new URL('../../.env', import.meta.url).pathname,
  });
  if (
    configuration.deploymentEnvironment !== 'development' ||
    !/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/u.test(configuration.endpoint)
  ) {
    return yield* Effect.fail(new Error('This demo grant helper requires local development SpiceDB'));
  }
  const persona = siamparkRentalPersonas.find((entry) => entry.email === 'external@siampark.demo');
  if (persona === undefined) return yield* Effect.fail(new Error('External demo persona is missing'));
  const relationships = principalRelationships(
    persona.principalId,
    persona.role,
    [{ actionKey: 'demo.siampark-ops.apply-command', provisioning: 'explicit' }],
    rentalDemoLegalEntityId,
  );
  const client = yield* Effect.acquireRelease(
    Effect.try(() => openSpiceDbGrpcRpc(configuration, 5000)),
    (value) => Effect.sync(() => value.close()),
  );
  yield* client.writeRelationships(bootstrapRelationshipRequest(relationships));
  const revoked = ['demo.siampark_ops.write_operational', 'demo.siampark_ops.write_all'].map((permission) =>
    v1.RelationshipUpdate.create({
      operation: v1.RelationshipUpdate_Operation.DELETE,
      relationship: v1.Relationship.create({
        relation: 'grantee',
        resource: v1.ObjectReference.create({
          objectId:
            toContextPermissionAccessObjectId(demoTenantId, rentalDemoLegalEntityId, {
              moduleId: 'demo.siampark-ops',
              permission,
            }) ?? '',
          objectType: 'context_permission',
        }),
        subject: v1.SubjectReference.create({
          object: v1.ObjectReference.create({ objectId: persona.principalId, objectType: 'principal' }),
        }),
      }),
    }),
  );
  yield* client.writeRelationships(v1.WriteRelationshipsRequest.create({ updates: revoked }));
  yield* Console.log(
    `External Siampark operational grants applied (${relationships.length} relationships); restricted agendas unchanged.`,
  );
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

await Effect.runPromise(program);
