// Interim authorization only: this fixture follows the current demo model, not a future authorization design.
// Namespace provisioning, Action execution, and identity administration are separate grants.

import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { Crypto, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  SPICEDB_CHECK_TIMEOUT_MS,
  createSpiceDbPermissionClient,
  fullyConsistent,
} from '../../src/permissions/client.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { makeContextAccess, toIdentityNamespaceAccessObjectId } from '../../src/permissions/context-access.ts';
import { toScopedRoleObjectId } from '../../src/permissions/scoped-role.ts';
import { toSpiceDbActionGrantObjectId, toSpiceDbActionObjectId } from '../../src/permissions/service.ts';

const ResourceIdSchema = Schema.String.pipe(Schema.brand('ResourceId'));
const SubjectIdSchema = Schema.String.pipe(Schema.brand('SubjectId'));

const FixtureTupleSchema = Schema.Struct({
  relation: Schema.String,
  resourceId: ResourceIdSchema,
  resourceType: Schema.String,
  subjectId: SubjectIdSchema,
  subjectRelation: Schema.optional(Schema.String),
  subjectType: Schema.String,
});

const FixtureAssertionSchema = Schema.Struct({
  permission: Schema.String,
  resourceId: ResourceIdSchema,
  resourceType: Schema.String,
  subjectId: SubjectIdSchema,
  subjectType: Schema.String,
});

type FixtureTuple = Schema.Schema.Type<typeof FixtureTupleSchema>;
type FixtureAssertion = Schema.Schema.Type<typeof FixtureAssertionSchema> & { readonly expected: boolean };

const spiceDbEffect = <Value>(operation: PromiseLike<Value>) => Effect.tryPromise(() => operation);

const relationship = (
  resourceType: string,
  resourceId: string,
  relation: string,
  subjectType: string,
  subjectId: string,
  subjectRelation?: string,
): FixtureTuple => ({
  relation,
  resourceId: ResourceIdSchema.make(resourceId),
  resourceType,
  subjectId: SubjectIdSchema.make(subjectId),
  subjectRelation,
  subjectType,
});

const fixtureAssertion = (
  resourceType: string,
  resourceId: string,
  permission: string,
  subjectId: string,
  expected: boolean,
): FixtureAssertion => ({
  expected,
  permission,
  resourceId: ResourceIdSchema.make(resourceId),
  resourceType,
  subjectId: SubjectIdSchema.make(subjectId),
  subjectType: 'principal',
});

const toSpiceDbRelationship = (tuple: FixtureTuple) =>
  v1.Relationship.create({
    relation: tuple.relation,
    resource: v1.ObjectReference.create({ objectId: tuple.resourceId, objectType: tuple.resourceType }),
    subject: v1.SubjectReference.create({
      object: v1.ObjectReference.create({ objectId: tuple.subjectId, objectType: tuple.subjectType }),
      optionalRelation: tuple.subjectRelation ?? '',
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

const namespaceObjectId = (tenantId: string, namespaceId: string) =>
  toIdentityNamespaceAccessObjectId(tenantId, namespaceId) ?? '';

const externalIdentityPermissionIntegration = Effect.gen(function* externalIdentityPermissionIntegration() {
  const configuration = yield* loadSpiceDbConfig();
  const crypto = yield* Crypto.Crypto;
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
  ] = yield* Effect.all(
    [
      crypto.randomUUIDv4(),
      crypto.randomUUIDv4(),
      crypto.randomUUIDv4(),
      crypto.randomUUIDv4(),
      crypto.randomUUIDv4(),
      crypto.randomUUIDv4(),
      crypto.randomUUIDv4(),
      crypto.randomUUIDv4(),
      crypto.randomUUIDv4(),
      crypto.randomUUIDv4(),
      crypto.randomUUIDv4(),
      crypto.randomUUIDv4(),
      crypto.randomUUIDv4(),
    ],
    { concurrency: 'unbounded' },
  );
  const namespaceAObjectId = namespaceObjectId(tenantA, namespaceA);
  const namespaceBObjectId = namespaceObjectId(tenantA, namespaceB);
  const namespaceCObjectId = namespaceObjectId(tenantB, namespaceC);
  const namespaceDObjectId = namespaceObjectId(tenantA, namespaceD);
  const reserveScope = { actionKey: 'core.identity.reserve-principal-binding', tenantId: tenantA };
  const activateScope = { actionKey: 'core.identity.activate-principal-binding', tenantId: tenantA };
  const statusScope = { actionKey: 'core.identity.change-principal-binding-status', tenantId: tenantA };
  const selfCredentialScopes = [
    { actionKey: 'core.identity.bind-self-api-key', tenantId: tenantA },
    { actionKey: 'core.identity.set-self-api-key-binding-status', tenantId: tenantA },
  ];
  const reserveAction = toSpiceDbActionObjectId(reserveScope);
  const activateAction = toSpiceDbActionObjectId(activateScope);
  const statusAction = toSpiceDbActionObjectId(statusScope);
  const enrollmentRole = toScopedRoleObjectId({ roleKey: 'external-identity-enrollment', tenantId: tenantA });
  const statusRole = toScopedRoleObjectId({ roleKey: 'external-identity-status', tenantId: tenantA });
  const relationships = [
    ...[enrollmentService, otherNamespaceService, memberOnly, ordinaryApplication, identityAdministrator].map(
      (principalId) => relationship('tenant', tenantA, 'member', 'principal', principalId),
    ),
    relationship('tenant', tenantA, 'identity_admin', 'principal', identityAdministrator),
    relationship('tenant', tenantB, 'member', 'principal', otherTenantMember),
    relationship('identity_namespace', namespaceAObjectId, 'tenant', 'tenant', tenantA),
    relationship('identity_namespace', namespaceAObjectId, 'provisioner', 'principal', enrollmentService),
    relationship('identity_namespace', namespaceBObjectId, 'tenant', 'tenant', tenantA),
    relationship('identity_namespace', namespaceBObjectId, 'provisioner', 'principal', otherNamespaceService),
    relationship('identity_namespace', namespaceCObjectId, 'tenant', 'tenant', tenantB),
    relationship('identity_namespace', namespaceCObjectId, 'provisioner', 'principal', enrollmentService),
    relationship('identity_namespace', namespaceDObjectId, 'tenant', 'tenant', tenantA),
    relationship('identity_namespace', namespaceDObjectId, 'provisioner', 'principal', relationOnly),
    ...[reserveScope, activateScope, statusScope, ...selfCredentialScopes].flatMap((scope) => [
      relationship('action', toSpiceDbActionObjectId(scope), 'tenant_scope', 'tenant', tenantA),
      relationship(
        'action',
        toSpiceDbActionObjectId(scope),
        'grant',
        'action_grant',
        toSpiceDbActionGrantObjectId(scope),
      ),
    ]),
    ...[reserveScope, activateScope].map((scope) =>
      relationship(
        'action_grant',
        toSpiceDbActionGrantObjectId(scope),
        'role',
        'scoped_role',
        enrollmentRole,
        'member',
      ),
    ),
    relationship(
      'action_grant',
      toSpiceDbActionGrantObjectId(statusScope),
      'role',
      'scoped_role',
      statusRole,
      'member',
    ),
    relationship('scoped_role', enrollmentRole, 'member', 'principal', enrollmentService),
    // A role alone must not create tenant access, even for the intended enrollment Actions.
    relationship('scoped_role', enrollmentRole, 'member', 'principal', relationOnly),
    relationship('scoped_role', enrollmentRole, 'member', 'principal', otherTenantMember),
    relationship('scoped_role', statusRole, 'member', 'principal', identityAdministrator),
    // Business Action authority does not create administrative identity authority.
    relationship('scoped_role', statusRole, 'member', 'principal', otherNamespaceService),
    ...selfCredentialScopes.map((scope) =>
      relationship('action', toSpiceDbActionObjectId(scope), 'self_credentials', 'tenant', tenantA),
    ),
    ...[memberOnly, relationOnly, otherTenantMember].flatMap((principalId) => [
      relationship('principal', principalId, 'self', 'principal', principalId),
      relationship('principal', principalId, 'tenant', 'tenant', tenantA),
    ]),
  ];
  const assertions = [
    fixtureAssertion('identity_namespace', namespaceAObjectId, 'provision', enrollmentService, true),
    fixtureAssertion('action', reserveAction, 'execute', enrollmentService, true),
    fixtureAssertion('action', activateAction, 'execute', enrollmentService, true),
    fixtureAssertion('action', statusAction, 'execute', identityAdministrator, true),
    fixtureAssertion('tenant', tenantA, 'manage_identity', identityAdministrator, true),
    fixtureAssertion('identity_namespace', namespaceAObjectId, 'provision', memberOnly, false),
    fixtureAssertion('identity_namespace', namespaceAObjectId, 'provision', ordinaryApplication, false),
    fixtureAssertion('identity_namespace', namespaceAObjectId, 'provision', otherTenantMember, false),
    fixtureAssertion('identity_namespace', namespaceBObjectId, 'provision', enrollmentService, false),
    fixtureAssertion('identity_namespace', namespaceCObjectId, 'provision', enrollmentService, false),
    fixtureAssertion('identity_namespace', namespaceDObjectId, 'provision', relationOnly, false),
    fixtureAssertion('tenant', tenantA, 'manage_identity', enrollmentService, false),
    fixtureAssertion('tenant', tenantA, 'manage_identity', memberOnly, false),
    fixtureAssertion('action', reserveAction, 'execute', memberOnly, false),
    fixtureAssertion('action', activateAction, 'execute', relationOnly, false),
    fixtureAssertion('action', statusAction, 'execute', enrollmentService, false),
    fixtureAssertion('identity_namespace', namespaceAObjectId, 'provision', identityAdministrator, false),
    fixtureAssertion('action', reserveAction, 'execute', identityAdministrator, false),
    fixtureAssertion('action', reserveAction, 'execute', otherTenantMember, false),
    fixtureAssertion('action', statusAction, 'execute', otherNamespaceService, true),
    fixtureAssertion('tenant', tenantA, 'manage_identity', otherNamespaceService, false),
    // Intrinsic own-credential access requires self and membership, not an Action role grant.
    ...selfCredentialScopes.flatMap((scope) => [
      fixtureAssertion('action', toSpiceDbActionObjectId(scope), 'execute', memberOnly, true),
      fixtureAssertion('action', toSpiceDbActionObjectId(scope), 'execute', ordinaryApplication, false),
      fixtureAssertion('action', toSpiceDbActionObjectId(scope), 'execute', relationOnly, false),
      fixtureAssertion('action', toSpiceDbActionObjectId(scope), 'execute', otherTenantMember, false),
    ]),
  ];
  const adminClient = newSpiceDbGrpcClient(configuration);
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
      expect(
        response.permissionship,
        `${assertion.resourceType}:${assertion.resourceId}#${assertion.permission}@${assertion.subjectId}`,
      ).toBe(
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
