import { fileURLToPath } from 'node:url';

import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { Crypto, Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse as parseYaml } from 'yaml';

import {
  SPICEDB_CHECK_TIMEOUT_MS,
  createSpiceDbPermissionClient,
  fullyConsistent,
} from '../../src/permissions/client.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { makeContextAccess, toIdentityNamespaceAccessObjectId } from '../../src/permissions/context-access.ts';

const ResourceIdSchema = Schema.String.pipe(Schema.brand('ResourceId'));
const SubjectIdSchema = Schema.String.pipe(Schema.brand('SubjectId'));

const FixtureTupleSchema = Schema.Struct({
  relation: Schema.String,
  resourceId: ResourceIdSchema,
  resourceType: Schema.String,
  subjectId: SubjectIdSchema,
  subjectType: Schema.String,
});

const FixtureAssertionSchema = Schema.Struct({
  permission: Schema.String,
  resourceId: ResourceIdSchema,
  resourceType: Schema.String,
  subjectId: SubjectIdSchema,
  subjectType: Schema.String,
});

const ExternalIdentityPermissionFixtureSchema = Schema.Struct({
  assertions: Schema.Struct({
    assertFalse: Schema.Array(FixtureAssertionSchema),
    assertTrue: Schema.Array(FixtureAssertionSchema),
  }),
  relationships: Schema.Array(FixtureTupleSchema),
});

type FixtureTuple = Schema.Schema.Type<typeof FixtureTupleSchema>;
type FixtureAssertion = Schema.Schema.Type<typeof FixtureAssertionSchema> & { readonly expected: boolean };
type FixtureMaterializable = Pick<FixtureTuple, 'resourceId' | 'resourceType' | 'subjectId' | 'subjectType'>;

const spiceDbEffect = <Value>(operation: PromiseLike<Value>) => Effect.tryPromise(() => operation);

const fixtureTuples = (fixture: Schema.Schema.Type<typeof ExternalIdentityPermissionFixtureSchema>) => ({
  assertions: [
    ...fixture.assertions.assertTrue.map((assertion) => ({ ...assertion, expected: true })),
    ...fixture.assertions.assertFalse.map((assertion) => ({ ...assertion, expected: false })),
  ] satisfies readonly FixtureAssertion[],
  relationships: fixture.relationships,
});

const toSpiceDbRelationship = (tuple: FixtureTuple) =>
  v1.Relationship.create({
    relation: tuple.relation,
    resource: v1.ObjectReference.create({ objectId: tuple.resourceId, objectType: tuple.resourceType }),
    subject: v1.SubjectReference.create({
      object: v1.ObjectReference.create({ objectId: tuple.subjectId, objectType: tuple.subjectType }),
    }),
  });

const toSpiceDbCheckRequest = (assertion: FixtureAssertion) =>
  v1.CheckPermissionRequest.create({
    consistency: fullyConsistent,
    permission: assertion.permission,
    resource: v1.ObjectReference.create({ objectId: assertion.resourceId, objectType: assertion.resourceType }),
    subject: v1.SubjectReference.create({
      object: v1.ObjectReference.create({ objectId: assertion.subjectId, objectType: assertion.subjectType }),
    }),
  });

const externalIdentityPermissionIntegration = Effect.gen(function* externalIdentityPermissionIntegration() {
  const configuration = yield* loadSpiceDbConfig();
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const fixtureSource = yield* fileSystem.readFileString(
    fileURLToPath(new URL('../../spicedb/external-identity-permissions.test.yaml', import.meta.url)),
  );
  const fixture = fixtureTuples(
    yield* Schema.decodeUnknownEffect(ExternalIdentityPermissionFixtureSchema)(parseYaml(fixtureSource)),
  );
  const ids = yield* Effect.all(
    [
      crypto.randomUUIDv4,
      crypto.randomUUIDv4,
      crypto.randomUUIDv4,
      crypto.randomUUIDv4,
      crypto.randomUUIDv4,
      crypto.randomUUIDv4,
      crypto.randomUUIDv4,
      crypto.randomUUIDv4,
      crypto.randomUUIDv4,
      crypto.randomUUIDv4,
      crypto.randomUUIDv4,
      crypto.randomUUIDv4,
      crypto.randomUUIDv4,
      crypto.randomUUIDv4,
    ],
    { concurrency: 'unbounded' },
  );
  const [
    tenantA,
    tenantB,
    enrollmentService,
    otherNamespaceService,
    memberOnly,
    ordinaryApplication,
    identityAdministrator,
    otherTenantMember,
    relationOnly,
    namespaceA,
    namespaceB,
    namespaceC,
    namespaceD,
    reserveAction,
  ] = ids;
  const idMapping = new Map<string, string>([
    ['tenant-a', tenantA],
    ['tenant-b', tenantB],
    ['enrollment-service', enrollmentService],
    ['other-namespace-service', otherNamespaceService],
    ['member-only', memberOnly],
    ['ordinary-application', ordinaryApplication],
    ['identity-administrator', identityAdministrator],
    ['other-tenant-member', otherTenantMember],
    ['relation-only', relationOnly],
    ['namespace-a', namespaceA],
    ['namespace-b', namespaceB],
    ['namespace-c', namespaceC],
    ['namespace-d', namespaceD],
    ['reserve-action', reserveAction],
    ['activate-action', `${reserveAction}-activate`],
    ['status-action', `${reserveAction}-status`],
  ]);
  const namespaceTenants = new Map([
    ['namespace-a', 'tenant-a'],
    ['namespace-b', 'tenant-a'],
    ['namespace-c', 'tenant-b'],
    ['namespace-d', 'tenant-a'],
  ]);
  const materialize = <Fixture extends FixtureMaterializable>(item: Fixture): Fixture => ({
    ...item,
    resourceId: ResourceIdSchema.make(
      item.resourceType === 'identity_namespace'
        ? (toIdentityNamespaceAccessObjectId(
            idMapping.get(namespaceTenants.get(item.resourceId) ?? '') ?? '',
            idMapping.get(item.resourceId) ?? item.resourceId,
          ) ?? item.resourceId)
        : (idMapping.get(item.resourceId) ?? item.resourceId),
    ),
    subjectId: SubjectIdSchema.make(idMapping.get(item.subjectId) ?? item.subjectId),
  });
  const relationships = fixture.relationships.map(materialize);
  const assertions = fixture.assertions.map((assertion) => ({
    ...materialize(assertion),
    expected: assertion.expected,
  }));
  const adminClient = v1.NewClient(
    configuration.preSharedKey,
    configuration.endpoint,
    configuration.insecureLocal ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED : v1.ClientSecurity.SECURE,
  );
  const permissionClient = createSpiceDbPermissionClient(configuration, SPICEDB_CHECK_TIMEOUT_MS);
  const cleanup = Effect.forEach(
    relationships,
    ({ relation, resourceId, resourceType, subjectId, subjectType }) =>
      spiceDbEffect(
        adminClient.promises.deleteRelationships(
          v1.DeleteRelationshipsRequest.create({
            relationshipFilter: v1.RelationshipFilter.create({
              optionalRelation: relation,
              optionalResourceId: resourceId,
              optionalSubjectFilter: v1.SubjectFilter.create({
                optionalSubjectId: subjectId,
                subjectType,
              }),
              resourceType,
            }),
          }),
        ),
      ),
    { concurrency: 'unbounded', discard: true },
  ).pipe(Effect.orDie);

  const runFixture = Effect.gen(function* runFixture() {
    const schema = yield* spiceDbEffect(adminClient.promises.readSchema(v1.ReadSchemaRequest.create({})));
    expect(schema.schemaText).toMatch(
      /definition identity_namespace \{[\s\S]*relation tenant: tenant[\s\S]*relation provisioner: principal[\s\S]*permission provision = provisioner & tenant->access[\s\S]*\}/u,
    );
    expect(schema.schemaText).not.toMatch(/external_identity_(?:enroller|resolver|assertion_issuer|verifier)/u);
    expect(schema.schemaText).not.toMatch(
      /permission (?:enroll_external_identity|resolve_external_identity|issue_external_identity_assertion|verify_external_authentication)/u,
    );
    yield* spiceDbEffect(
      adminClient.promises.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          updates: relationships.map((item) =>
            v1.RelationshipUpdate.create({
              operation: v1.RelationshipUpdate_Operation.TOUCH,
              relationship: toSpiceDbRelationship(item),
            }),
          ),
        }),
      ),
    );

    for (const assertion of assertions) {
      const response = yield* spiceDbEffect(adminClient.promises.checkPermission(toSpiceDbCheckRequest(assertion)));
      expect(response.permissionship).toBe(
        assertion.expected
          ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
          : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
      );
    }

    const access = makeContextAccess(permissionClient);
    expect(
      yield* (
        access.identityNamespaces?.({
          authenticationNamespaceIds: [namespaceA, namespaceB, namespaceC],
          principalId: enrollmentService,
          tenantId: tenantA,
        }) ?? Effect.succeed([])
      ),
    ).toEqual([
      { decision: 'allowed', key: namespaceA },
      { decision: 'denied', key: namespaceB },
      { decision: 'denied', key: namespaceC },
    ]);
    expect(
      yield* (
        access.identityNamespaces?.({
          authenticationNamespaceIds: [namespaceB],
          principalId: otherNamespaceService,
          tenantId: tenantA,
        }) ?? Effect.succeed([])
      ),
    ).toEqual([{ decision: 'allowed', key: namespaceB }]);
    expect(
      yield* (
        access.identityNamespaces?.({
          authenticationNamespaceIds: [namespaceD],
          principalId: relationOnly,
          tenantId: tenantA,
        }) ?? Effect.succeed([])
      ),
    ).toEqual([{ decision: 'denied', key: namespaceD }]);
    expect(
      yield* access.tenants({
        permission: 'manage_identity',
        principalId: enrollmentService,
        tenantIds: [tenantA],
      }),
    ).toEqual([{ decision: 'denied', key: tenantA }]);
    expect(
      yield* access.tenants({
        permission: 'manage_identity',
        principalId: identityAdministrator,
        tenantIds: [tenantA],
      }),
    ).toEqual([{ decision: 'allowed', key: tenantA }]);
  });

  yield* runFixture.pipe(
    Effect.ensuring(
      cleanup.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            permissionClient.close();
            adminClient.close();
          }),
        ),
      ),
    ),
  );
});

it.layer(NodeServices.layer, { excludeTestServices: true })('external identity permissions', (suite) => {
  suite.effect(
    'enforces namespace provisioning and separate administrative authority',
    () => externalIdentityPermissionIntegration,
  );
});
