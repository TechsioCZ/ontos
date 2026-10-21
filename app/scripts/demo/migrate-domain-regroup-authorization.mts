#!/usr/bin/env node
// regroup-codemod: keep (this file lists the legacy siampark names on purpose)
/**
 * LOCAL ONLY, idempotent: removes the SpiceDB relationships that still name a customer-named module after the
 * domain regroup (`migrate-domain-regroup.mts` covers Postgres). The demo SpiceDB runs in memory, so module_access,
 * context_permission, resource and action relationships written before the regroup survive until the container
 * restarts. The current provisioning (`reset-permissions.mts`, the reset and the authorization reconciler) already
 * writes every grant under the domain module ids, so obsolete grants are deleted, never translated. (On the live
 * demo, every obsolete grant without a domain-named twin belonged to a disabled principal.)
 *
 * Run from app/:
 *   mise exec -- node scripts/demo/migrate-domain-regroup-authorization.mts --dry-run
 *   mise exec -- node scripts/demo/migrate-domain-regroup-authorization.mts
 * Set ONTOS_DEMO_ENV_FILE to the running runtime's .env when its local TLS certificate differs.
 */
import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { Console, Effect } from 'effect';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';

const dryRun = process.argv.includes('--dry-run');

/** Old module ids, permission prefixes and action keys (decoded object ids are matched against this). */
const obsoletePattern =
  /demo[._-]siampark[-_]ops|siampark[._-](?:property|occupancy|agreements|billing[-_]finance|work|relationships)/u;
/** Every resource definition whose object id can carry a module id (ctx_/ak_ encode it, asp_ is a digest). */
const resourceTypes = ['module_access', 'context_permission', 'resource', 'business_permission', 'action'] as const;

const decodeObjectId = (objectId: string): string => {
  const encoded = /^(?:ctx|ak)_(?<encoded>.+)$/u.exec(objectId)?.groups?.encoded;
  return encoded === undefined ? objectId : Buffer.from(encoded, 'base64url').toString('utf-8');
};

const describe = (relationship: v1.Relationship): string =>
  `${relationship.resource?.objectType}:${decodeObjectId(relationship.resource?.objectId ?? '')}#${relationship.relation}@` +
  `${relationship.subject?.object?.objectType}:${decodeObjectId(relationship.subject?.object?.objectId ?? '')}`;

const isObsolete = (relationship: v1.Relationship): boolean =>
  obsoletePattern.test(decodeObjectId(relationship.resource?.objectId ?? '')) ||
  obsoletePattern.test(decodeObjectId(relationship.subject?.object?.objectId ?? ''));

const program = Effect.gen(function* migrateRegroupAuthorization() {
  const configuration = yield* loadSpiceDbConfig({
    envPath: process.env.ONTOS_DEMO_ENV_FILE ?? new URL('../../.env', import.meta.url).pathname,
  });
  if (
    configuration.deploymentEnvironment !== 'development' ||
    !/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/u.test(configuration.endpoint)
  ) {
    return yield* Effect.fail(new Error('This demo migration requires local development SpiceDB'));
  }
  const client = yield* Effect.acquireRelease(
    Effect.try(() => openSpiceDbGrpcRpc(configuration, 30_000)),
    (value) => Effect.sync(() => value.close()),
  );
  const consistency = v1.Consistency.create({ requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } });
  const obsolete: v1.Relationship[] = [];
  for (const resourceType of resourceTypes) {
    const responses = yield* client.readRelationships(
      v1.ReadRelationshipsRequest.create({
        consistency,
        relationshipFilter: v1.RelationshipFilter.create({ resourceType }),
      }),
    );
    const matches = responses.flatMap((response) =>
      response.relationship !== undefined && isObsolete(response.relationship) ? [response.relationship] : [],
    );
    yield* Console.log(`${resourceType}: ${responses.length} relationship(s), ${matches.length} obsolete`);
    obsolete.push(...matches);
  }
  for (const relationship of obsolete) {
    yield* Console.log(`  ${dryRun ? 'would delete' : 'delete'} ${describe(relationship)}`);
  }
  if (dryRun || obsolete.length === 0) {
    return yield* Console.log(dryRun ? 'dry run: nothing deleted' : 'domain regroup authorization: nothing to do');
  }
  // SpiceDB caps one write at 1,000 updates by default.
  for (let index = 0; index < obsolete.length; index += 500) {
    yield* client.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: obsolete
          .slice(index, index + 500)
          .map((relationship) =>
            v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.DELETE, relationship }),
          ),
      }),
    );
  }
  const remaining: string[] = [];
  for (const resourceType of resourceTypes) {
    const responses = yield* client.readRelationships(
      v1.ReadRelationshipsRequest.create({
        consistency,
        relationshipFilter: v1.RelationshipFilter.create({ resourceType }),
      }),
    );
    for (const response of responses) {
      if (response.relationship !== undefined && isObsolete(response.relationship)) {
        remaining.push(describe(response.relationship));
      }
    }
  }
  if (remaining.length > 0) {
    return yield* Effect.fail(new Error(`obsolete relationships remain: ${remaining.join(', ')}`));
  }
  yield* Console.log(`domain regroup authorization: deleted ${obsolete.length} obsolete relationship(s)`);
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

await Effect.runPromise(program);
