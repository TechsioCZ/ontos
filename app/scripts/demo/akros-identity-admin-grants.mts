#!/usr/bin/env node
/** LOCAL ONLY: repair the existing AKROS administrator's explicit people-action grant without any reseed.
 * Cold starts already provision this through permissions.mts and accounts-admin-grants.mts.
 * Run from app/: mise exec -- node scripts/demo/akros-identity-admin-grants.mts
 */
import { NodeServices } from '@effect/platform-node';
import { Console, Effect } from 'effect';
import { toSpiceDbActionObjectId } from '@app/core-runtime/actions/runtime-wiring';
import { bootstrapRelationshipRequest } from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { demoId } from './fixture-ids.mts';

const program = Effect.gen(function* () {
  const configuration = yield* loadSpiceDbConfig({
    envPath: process.env.ONTOS_DEMO_ENV_FILE ?? new URL('../../.env', import.meta.url).pathname,
  });
  if (
    configuration.deploymentEnvironment !== 'development' ||
    !/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/u.test(configuration.endpoint)
  ) {
    return yield* Effect.fail(new Error('AKROS identity repair requires local development SpiceDB'));
  }
  const action = toSpiceDbActionObjectId('core.identity.manage-demo-account');
  const client = yield* Effect.acquireRelease(
    Effect.try(() => openSpiceDbGrpcRpc(configuration, 5000)),
    (value) => Effect.sync(() => value.close()),
  );
  yield* client.writeRelationships(
    bootstrapRelationshipRequest([
      { resourceType: 'action', resourceId: action, relation: 'restriction', subjectType: 'action', subjectId: action },
      {
        resourceType: 'action',
        resourceId: action,
        relation: 'executor',
        subjectType: 'principal',
        subjectId: demoId('core.principal', 'akros-eshop'),
      },
    ]),
  );
  yield* Console.log('AKROS people-administration executor granted; no accounts, memberships or demo records reset.');
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

await Effect.runPromise(program);
