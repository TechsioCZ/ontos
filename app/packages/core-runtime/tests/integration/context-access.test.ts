import { expect, it } from '@app/effect-rstest';
import { NodeServices } from '@effect/platform-node';
import { v1 } from '@authzed/authzed-node';
import { Crypto, Effect, FileSystem } from 'effect';
import {
  makeContextAccess,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from '../../src/permissions/context-access.ts';
import {
  SPICEDB_CHECK_TIMEOUT_MS,
  createSpiceDbPermissionClient,
} from '../../src/permissions/client.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';

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
    resource: v1.ObjectReference.create({ objectId: resourceId, objectType: resourceType }),
    subject: v1.SubjectReference.create({
      object: v1.ObjectReference.create({ objectId: subjectId, objectType: subjectType }),
    }),
  });

const contextAccessProgram = Effect.gen(function* contextAccessIntegration() {
  const configuration = yield* loadSpiceDbConfig();
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const [tenantId, otherTenantId, legalEntityId, otherLegalEntityId, principalId, resourceId] =
    yield* Effect.all(
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
  if (
    legalObjectId === undefined ||
    moduleObjectId === undefined ||
    resourceObjectId === undefined
  ) {
    throw new Error('Expected valid SpiceDB object identifiers');
  }
  const client = v1.NewClient(
    configuration.preSharedKey,
    configuration.endpoint,
    configuration.insecureLocal
      ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED
      : v1.ClientSecurity.SECURE,
  );
  const bootstrap = yield* fileSystem.readFileString(
    new URL('../../spicedb/bootstrap.yaml', import.meta.url).pathname,
  );
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
        yield* access.modules({ legalEntityId, moduleIds: [moduleId], principalId, tenantId }),
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
    }).pipe(Effect.ensuring(Effect.sync(() => permissionClient.close())));
  }).pipe(
    Effect.ensuring(
      Effect.forEach(
        [
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
