import { v1 } from '@authzed/authzed-node';
import { Config, Effect, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { parseSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../packages/core-runtime/src/permissions/schema.ts';
import { openSpiceDbGrpcRpc } from '../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { ServiceGrantError, reconcileStagePermissionSchema } from '../demo/reconcile-stage-service-grants.mts';

const RELATION_DECLARATION = '  relation self_service_grantee: principal\n';
const LEGACY_RELATION = 'schema_sync_test_grantee';
const PROFILE_ID = 'schema-sync-profile';
const oldSchema = ONTOS_SPICEDB_SCHEMA.replace(RELATION_DECLARATION, '').replace(
  'self_service_grantee + direct_use',
  'direct_use',
);
const legacySchema = ONTOS_SPICEDB_SCHEMA.replace(
  RELATION_DECLARATION,
  `${RELATION_DECLARATION}  relation ${LEGACY_RELATION}: principal\n`,
);
const readRequest = v1.ReadSchemaRequest.create({});

// Run against an operation-owned SpiceDB: this test changes schemas and creates/deletes only its tuple.
it.live('syncs canonical schema through pinned TLS, refuses occupied removals, and verifies native readback', () =>
  Effect.gen(function* stageSchemaSync() {
    const configuration = yield* Config.all({
      ca: Config.Redacted('SPICEDB_CA_CERT'),
      endpoint: Config.String('SPICEDB_ENDPOINT'),
      key: Config.Redacted('SPICEDB_PRESHARED_KEY'),
    });
    const settings = yield* parseSpiceDbConfig({
      SPICEDB_CA_CERT: Redacted.value(configuration.ca),
      SPICEDB_ENDPOINT: configuration.endpoint,
      SPICEDB_PRESHARED_KEY: Redacted.value(configuration.key),
      ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
    });
    const rpc = yield* Effect.acquireRelease(
      Effect.sync(() => openSpiceDbGrpcRpc(settings, 10_000)),
      (client) => Effect.sync(() => client.close()),
    );
    const subject = v1.SubjectReference.create({
      object: { objectId: 'schema-sync-principal', objectType: 'principal' },
    });
    const relationship = v1.Relationship.create({
      relation: LEGACY_RELATION,
      resource: { objectId: PROFILE_ID, objectType: 'business_permission' },
      subject,
    });
    const changeRelationship = (operation: v1.RelationshipUpdate_Operation) =>
      rpc.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          updates: [v1.RelationshipUpdate.create({ operation, relationship })],
        }),
      );
    yield* Effect.addFinalizer(() =>
      changeRelationship(v1.RelationshipUpdate_Operation.DELETE).pipe(
        Effect.ignore,
        Effect.andThen(rpc.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA }))),
        Effect.orDie,
      ),
    );
    yield* rpc.writeSchema(v1.WriteSchemaRequest.create({ schema: oldSchema }));
    let writes = 0;
    const observed = {
      diffSchema: rpc.diffSchema,
      readSchema: rpc.readSchema,
      writeSchema: (request: v1.WriteSchemaRequest) =>
        Effect.sync(() => {
          writes += 1;
        }).pipe(Effect.andThen(rpc.writeSchema(request))),
    };
    expect(yield* reconcileStagePermissionSchema(observed, 'check')).toEqual({ applied: false, differs: true });
    expect(
      Schema.is(ServiceGrantError)(yield* reconcileStagePermissionSchema(observed, 'verify').pipe(Effect.flip)),
    ).toBe(true);
    expect(writes).toBe(0);
    expect(yield* reconcileStagePermissionSchema(observed, 'apply')).toEqual({ applied: true, differs: false });
    expect((yield* rpc.readSchema(readRequest)).schemaText).toContain('relation self_service_grantee: principal');
    expect(writes).toBe(1);
    expect(yield* reconcileStagePermissionSchema(observed, 'apply')).toEqual({ applied: false, differs: false });
    expect(yield* reconcileStagePermissionSchema(observed, 'verify')).toEqual({ applied: false, differs: false });
    expect(writes).toBe(1);

    const selfServiceRelationship = v1.Relationship.create({ ...relationship, relation: 'self_service_grantee' });
    const selfServiceUpdate = (operation: v1.RelationshipUpdate_Operation) =>
      rpc.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          updates: [v1.RelationshipUpdate.create({ operation, relationship: selfServiceRelationship })],
        }),
      );
    yield* Effect.acquireUseRelease(
      selfServiceUpdate(v1.RelationshipUpdate_Operation.TOUCH),
      () =>
        Effect.gen(function* provesExactSelfServiceAccess() {
          for (const objectId of [PROFILE_ID, `${PROFILE_ID}-other`]) {
            const check = yield* rpc.checkPermission(
              v1.CheckPermissionRequest.create({
                consistency: { requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } },
                permission: 'use',
                resource: { objectId, objectType: 'business_permission' },
                subject,
              }),
            );
            expect(check.permissionship).toBe(
              objectId === PROFILE_ID
                ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
                : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
            );
          }
        }),
      () => selfServiceUpdate(v1.RelationshipUpdate_Operation.DELETE).pipe(Effect.orDie),
    );

    yield* rpc.writeSchema(v1.WriteSchemaRequest.create({ schema: legacySchema }));
    yield* changeRelationship(v1.RelationshipUpdate_Operation.TOUCH);
    const refusal = yield* reconcileStagePermissionSchema(observed, 'apply').pipe(Effect.flip);
    expect(refusal.reason).toContain('Native WriteSchema refused');
    expect(refusal.reason).toContain('live relationships');
    expect(refusal.reason).toContain(`business_permission#${LEGACY_RELATION}`);
    expect(refusal.reason).not.toContain(Redacted.value(configuration.key));
    expect((yield* rpc.readSchema(readRequest)).schemaText).toContain(LEGACY_RELATION);
    const relationships = yield* rpc.readRelationships(
      v1.ReadRelationshipsRequest.create({
        consistency: { requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } },
        relationshipFilter: {
          optionalRelation: LEGACY_RELATION,
          optionalResourceId: PROFILE_ID,
          resourceType: 'business_permission',
        },
      }),
    );
    expect(relationships).toHaveLength(1);
    // Explicitly removing this test-owned relationship allows an otherwise unused relation to be retired.
    yield* changeRelationship(v1.RelationshipUpdate_Operation.DELETE);
    expect(yield* reconcileStagePermissionSchema(observed, 'apply')).toEqual({ applied: true, differs: false });

    yield* rpc.writeSchema(v1.WriteSchemaRequest.create({ schema: oldSchema }));
    const readbackFailure = yield* reconcileStagePermissionSchema(
      {
        diffSchema: rpc.diffSchema,
        readSchema: rpc.readSchema,
        writeSchema: (request) =>
          rpc
            .writeSchema(request)
            .pipe(Effect.tap(() => rpc.writeSchema(v1.WriteSchemaRequest.create({ schema: oldSchema })))),
      },
      'apply',
    ).pipe(Effect.flip);
    expect(readbackFailure.reason).toContain('readback differs');
    yield* reconcileStagePermissionSchema(rpc, 'apply');
  }),
);
