#!/usr/bin/env node
/** LOCAL ONLY: add the Siampark (0021) CRM grants without resetting other demo identities or data.
 * Vedení: demo.crm read_all + write_all + assign; Externí obchodník: demo.crm read_assigned only (no write).
 * Run from app/: node scripts/demo/siampark-crm-permissions.mts
 * Set ONTOS_DEMO_ENV_FILE to the running runtime's .env when its local TLS certificate differs.
 * Writes (touches) the full permissions.mts relationship set of both personas, as reset-permissions.mts would;
 * the only new relationships are the demo.crm module, context permissions and the demo.crm.apply-command grant.
 */
import { NodeServices } from '@effect/platform-node';
import { Console, Effect } from 'effect';
import { bootstrapRelationshipRequest } from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { rentalDemoLegalEntityId } from './fixture-ids.mts';
import { principalRelationships, siamparkRentalPersonas } from './permissions.mts';

const emails = new Set(['management@siampark.demo', 'external@siampark.demo']);

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
  const all = siamparkRentalPersonas
    .filter((persona) => emails.has(persona.email))
    .flatMap((persona) =>
      principalRelationships(
        persona.principalId,
        persona.role,
        [{ actionKey: 'demo.crm.apply-command', provisioning: 'explicit' }],
        rentalDemoLegalEntityId,
      ),
    );
  // SpiceDB rejects a write that names the same relationship twice (both personas share the company relations).
  const relationships = [
    ...new Map(
      all.map((entry) => [
        [entry.resourceType, entry.resourceId, entry.relation, entry.subjectType, entry.subjectId].join('|'),
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
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

await Effect.runPromise(program);
