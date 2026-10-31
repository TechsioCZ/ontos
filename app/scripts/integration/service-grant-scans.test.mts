import { v1 } from '@authzed/authzed-node';
import { Config, Effect, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { parseSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../packages/core-runtime/src/permissions/schema.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { reconcileServiceGrants, serviceGrantMemberships } from '../demo/reconcile-stage-service-grants.mts';

const tuple = (id: string) =>
  v1.Relationship.create({
    relation: 'role',
    resource: { objectId: id, objectType: 'action_grant' },
    subject: { object: { objectId: 'owned-service-role', objectType: 'scoped_role' }, optionalRelation: 'member' },
  });

it.live('paginates real pinned-TLS SpiceDB scans and performs no writes on a second apply', (context) =>
  Effect.gen(function* serviceGrantScanProof() {
    const sandbox = yield* Config.option(
      Config.schema(Schema.Literals(['owned-spicedb']), 'SERVICE_GRANT_TEST_SANDBOX'),
    );
    if (Option.isNone(sandbox)) {
      return yield* Effect.sync(() => context.skip());
    }
    const config = yield* Config.all({
      ca: Config.Redacted('SPICEDB_CA_CERT'),
      endpoint: Config.String('SPICEDB_ENDPOINT'),
      key: Config.Redacted('SPICEDB_PRESHARED_KEY'),
    });
    expect(config.endpoint.startsWith('localhost:')).toBe(true);
    const settings = yield* parseSpiceDbConfig({
      SPICEDB_CA_CERT: Redacted.value(config.ca),
      SPICEDB_ENDPOINT: config.endpoint,
      SPICEDB_PRESHARED_KEY: Redacted.value(config.key),
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
    });
    const rpc = yield* Effect.acquireRelease(
      Effect.sync(() => openSpiceDbGrpcRpc(settings, 10_000)),
      (client) => Effect.sync(() => client.close()),
    );
    yield* rpc.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA }));
    const desired = Array.from({ length: 187 }, (_, index) => tuple(`desired-${index}`));
    const unrelated = Array.from({ length: 600 }, (_, index) => tuple(`unrelated-${index}`));
    yield* rpc.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: [...serviceGrantMemberships(), ...unrelated].map((relationship) =>
          v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.TOUCH, relationship }),
        ),
      }),
    );
    const reads: v1.ReadRelationshipsRequest[] = [];
    let writes = 0;
    const observed = {
      readRelationships: (request: v1.ReadRelationshipsRequest) =>
        Effect.sync(() => {
          reads.push(request);
        }).pipe(Effect.andThen(rpc.readRelationships(request))),
      writeRelationships: (request: v1.WriteRelationshipsRequest) =>
        Effect.sync(() => {
          writes += 1;
        }).pipe(Effect.andThen(rpc.writeRelationships(request))),
    };
    expect(yield* reconcileServiceGrants(observed, desired, 'apply')).toEqual({
      applied: 187,
      desired: 187,
      missing: 0,
    });
    expect(writes).toBe(1);
    expect(reads.some(({ optionalCursor }) => optionalCursor !== undefined)).toBe(true);
    expect(reads.length).toBeLessThan(20);
    expect(yield* reconcileServiceGrants(observed, desired, 'apply')).toEqual({ applied: 0, desired: 187, missing: 0 });
    expect(writes).toBe(1);
    return yield* Effect.void;
  }).pipe(Effect.scoped),
);
