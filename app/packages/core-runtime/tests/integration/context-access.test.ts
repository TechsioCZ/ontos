import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { Crypto, Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { SPICEDB_CHECK_TIMEOUT_MS, createSpiceDbPermissionClient } from '../../src/permissions/client.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import {
  makeContextAccess,
  toBusinessPermissionAccessKey,
  toBusinessPermissionAccessObjectId,
  toContextPermissionAccessKey,
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from '../../src/permissions/context-access.ts';
import { BusinessPermissionCodeSchema } from '../../src/permissions/business-permission.ts';

const spiceDbEffect = <Value>(operation: PromiseLike<Value>) => Effect.tryPromise(() => operation);

const relationship = (
  resourceType: string,
  resourceId: string,
  relation: string,
  subjectType: string,
  subjectId: string,
) =>
  v1.Relationship.create({
    relation,
    resource: v1.ObjectReference.create({
      objectId: resourceId,
      objectType: resourceType,
    }),
    subject: v1.SubjectReference.create({
      object: v1.ObjectReference.create({
        objectId: subjectId,
        objectType: subjectType,
      }),
    }),
  });

const requireBusinessPermissions = (
  access: ReturnType<typeof makeContextAccess>,
): NonNullable<ReturnType<typeof makeContextAccess>['businessPermissions']> => {
  const check = access.businessPermissions;
  if (check === undefined) {
    throw new Error('Expected business permission access');
  }
  return check;
};

const contextAccessProgram = Effect.gen(function* contextAccessIntegration() {
  const configuration = yield* loadSpiceDbConfig();
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const [tenantId, otherTenantId, legalEntityId, otherLegalEntityId, principalId, resourceId] = yield* Effect.all(
    [
      crypto.randomUUIDv4,
      crypto.randomUUIDv4,
      crypto.randomUUIDv4,
      crypto.randomUUIDv4,
      crypto.randomUUIDv4,
      crypto.randomUUIDv4,
    ],
    { concurrency: 'unbounded' },
  );
  const moduleId = 'property.registry';
  const resource = { moduleId, resourceId, resourceType: 'property.unit' };
  const legalObjectId = toLegalEntityAccessObjectId(tenantId, legalEntityId);
  const moduleObjectId = toModuleAccessObjectId(tenantId, legalEntityId, moduleId);
  const resourceObjectId = toResourceAccessObjectId(tenantId, legalEntityId, resource);
  const businessPermission = yield* Schema.decodeUnknownEffect(BusinessPermissionCodeSchema)(
    'counterparty.purchase.submit',
  );
  const businessTarget = {
    permission: businessPermission,
    target: {
      counterpartyId: 'counterparty-live',
      kind: 'counterparty_storefront' as const,
      legalEntityId,
      storefrontId: 'storefront-live',
      tenantId,
    },
  };
  const businessPermissionObjectId = toBusinessPermissionAccessObjectId(
    businessPermission,
    businessTarget.target,
  );
  const contextPermissionTarget = {
    moduleId: 'commerce.customer-context',
    permission: 'customer.group.history.read',
  } as const;
  const contextPermissionObjectId = toContextPermissionAccessObjectId(
    tenantId,
    legalEntityId,
    contextPermissionTarget,
  );
  if (
    legalObjectId === undefined ||
    moduleObjectId === undefined ||
    resourceObjectId === undefined ||
    businessPermissionObjectId === undefined ||
    contextPermissionObjectId === undefined
  ) {
    throw new Error('Expected valid SpiceDB object identifiers');
  }
  const client = v1.NewClient(
    configuration.preSharedKey,
    configuration.endpoint,
    configuration.insecureLocal ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED : v1.ClientSecurity.SECURE,
  );
  const bootstrap = yield* fileSystem.readFileString(new URL('../../spicedb/bootstrap.yaml', import.meta.url).pathname);
  const bootstrapLines = bootstrap.split('\n');
  const schemaStart = bootstrapLines.indexOf('schema: |-') + 1;
  const schemaEnd = bootstrapLines.indexOf('relationships: |-');
  expect(schemaStart > 0 && schemaEnd > schemaStart).toBeTruthy();
  const schemaBlock = bootstrapLines
    .slice(schemaStart, schemaEnd)
    .map((line) => line.replace(/^ {2}/u, ''))
    .join('\n');
  yield* spiceDbEffect(
    client.promises.writeSchema(
      v1.WriteSchemaRequest.create({
        schema: schemaBlock,
      }),
    ),
  );
  const relationships = [
    relationship('tenant', tenantId, 'member', 'principal', principalId),
    relationship('tenant', tenantId, 'identity_admin', 'principal', principalId),
    relationship('tenant', tenantId, 'party_identity_manager', 'principal', principalId),
    relationship('tenant', tenantId, 'party_identity_merger', 'principal', principalId),
    relationship('tenant', tenantId, 'party_identity_reader', 'principal', principalId),
    relationship('tenant', tenantId, 'party_identity_reviewer', 'principal', principalId),
    relationship('tenant', tenantId, 'party_relationship_manager', 'principal', principalId),
    relationship('tenant', tenantId, 'support', 'principal', principalId),
    relationship('legal_entity', legalObjectId, 'tenant', 'tenant', tenantId),
    relationship('legal_entity', legalObjectId, 'member', 'principal', principalId),
    relationship('legal_entity', legalObjectId, 'counterparty_manager', 'principal', principalId),
    relationship('legal_entity', legalObjectId, 'counterparty_reader', 'principal', principalId),
    relationship('module_access', moduleObjectId, 'legal_entity', 'legal_entity', legalObjectId),
    relationship('module_access', moduleObjectId, 'accessor', 'principal', principalId),
    relationship('resource', resourceObjectId, 'module', 'module_access', moduleObjectId),
    relationship('resource', resourceObjectId, 'reader', 'principal', principalId),
    relationship(
      'business_permission',
      businessPermissionObjectId,
      'legal_entity',
      'legal_entity',
      legalObjectId,
    ),
    relationship(
      'business_permission',
      businessPermissionObjectId,
      'grantee',
      'principal',
      principalId,
    ),
    relationship('context_permission', contextPermissionObjectId, 'tenant', 'tenant', tenantId),
    relationship(
      'context_permission',
      contextPermissionObjectId,
      'grantee',
      'principal',
      principalId,
    ),
  ];

  yield* Effect.gen(function* exerciseContextAccess() {
    yield* spiceDbEffect(
      client.promises.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          updates: relationships.map((item) =>
            v1.RelationshipUpdate.create({
              operation: v1.RelationshipUpdate_Operation.TOUCH,
              relationship: item,
            }),
          ),
        }),
      ),
    );
    const permissionClient = createSpiceDbPermissionClient(configuration, SPICEDB_CHECK_TIMEOUT_MS);
    yield* Effect.gen(function* checkContextAccess() {
      const access = makeContextAccess(permissionClient);
      const tenantDecisions = yield* Effect.forEach(
        [
          'impersonate',
          'manage_identity',
          'manage_party_identity',
          'manage_party_relationships',
          'merge_party_identity',
          'read_party_identity',
          'review_party_identity',
        ] as const,
        (permission) =>
          access.tenants({
            permission,
            principalId,
            tenantIds: [tenantId, otherTenantId],
          }),
        { concurrency: 'unbounded' },
      );
      for (const decisions of tenantDecisions) {
        expect(decisions).toEqual([
          { decision: 'allowed', key: tenantId },
          { decision: 'denied', key: otherTenantId },
        ]);
      }
      const legalEntityDecisions = yield* Effect.forEach(
        ['access', 'manage_counterparty', 'read_counterparty'] as const,
        (permission) =>
          access.legalEntities({
            legalEntityIds: [legalEntityId, otherLegalEntityId],
            permission,
            principalId,
            tenantId,
          }),
        { concurrency: 'unbounded' },
      );
      for (const decisions of legalEntityDecisions) {
        expect(decisions).toEqual([
          { decision: 'allowed', key: legalEntityId },
          { decision: 'denied', key: otherLegalEntityId },
        ]);
      }
      expect(
        yield* access.modules({
          legalEntityId,
          moduleIds: [moduleId],
          principalId,
          tenantId,
        }),
      ).toEqual([{ decision: 'allowed', key: moduleId }]);
      expect(
        yield* access.modules({
          legalEntityId,
          moduleIds: [moduleId],
          principalId,
          tenantId: otherTenantId,
        }),
      ).toEqual([{ decision: 'denied', key: moduleId }]);
      expect(
        yield* access.resources({ legalEntityId, principalId, resources: [resource], tenantId }),
      ).toEqual([{ decision: 'allowed', key: `${moduleId}:property.unit:${resource.resourceId}` }]);
      const checkBusinessPermissions = requireBusinessPermissions(access);
      expect(
        yield* checkBusinessPermissions({
          principal: { principalId, tenantId },
          targets: [businessTarget],
          trustedStorefrontId: 'storefront-live',
        }),
      ).toEqual([{ decision: 'allowed', key: toBusinessPermissionAccessKey(businessTarget) }]);
      const checkContextPermissions = access.contextPermissions;
      if (checkContextPermissions === undefined) {
        throw new Error('Expected context permission access');
      }
      expect(
        yield* checkContextPermissions({
          legalEntityId,
          principalId,
          targets: [
            contextPermissionTarget,
            { ...contextPermissionTarget, permission: 'customer.group.read' },
          ],
          tenantId,
        }),
      ).toEqual([
        {
          decision: 'allowed',
          key: toContextPermissionAccessKey(contextPermissionTarget),
        },
        {
          decision: 'denied',
          key: 'commerce.customer-context:customer.group.read',
        },
      ]);
    }).pipe(Effect.ensuring(Effect.sync(() => permissionClient.close())));
  }).pipe(
    Effect.ensuring(
      Effect.forEach(
        [
          ['context_permission', contextPermissionObjectId],
          ['business_permission', businessPermissionObjectId],
          ['resource', resourceObjectId],
          ['module_access', moduleObjectId],
          ['legal_entity', legalObjectId],
          ['tenant', tenantId],
        ] as const,
        ([resourceType, cleanupResourceId]) =>
          spiceDbEffect(
            client.promises.deleteRelationships(
              v1.DeleteRelationshipsRequest.create({
                relationshipFilter: v1.RelationshipFilter.create({
                  optionalResourceId: cleanupResourceId,
                  resourceType,
                }),
              }),
            ),
          ),
        { concurrency: 'unbounded', discard: true },
      ).pipe(Effect.ensuring(Effect.sync(() => client.close())), Effect.orDie),
    ),
  );
});

it.layer(NodeServices.layer, { excludeTestServices: true })('context-access', (suite) => {
  suite.effect(
    'isolates live legal-entity, module, and resource batches by tenant and entity',
    () => contextAccessProgram,
  );
});
