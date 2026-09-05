/* eslint-disable no-await-in-loop, typescript/no-non-null-assertion, unicorn/consistent-function-scoping -- The integration fixture owns isolated live SpiceDB state. */
// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off processEnv:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { v1 } from '@authzed/authzed-node';
import { Effect } from 'effect';
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

void test('isolates live legal-entity, module, and resource batches by tenant and entity', async () => {
  const configuration = await Effect.runPromise(loadSpiceDbConfig());
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const legalEntityId = randomUUID();
  const otherLegalEntityId = randomUUID();
  const principalId = randomUUID();
  const moduleId = 'property.registry';
  const resource = { moduleId, resourceId: randomUUID(), resourceType: 'property.unit' };
  const legalObjectId = toLegalEntityAccessObjectId(tenantId, legalEntityId)!;
  const moduleObjectId = toModuleAccessObjectId(tenantId, legalEntityId, moduleId)!;
  const resourceObjectId = toResourceAccessObjectId(tenantId, legalEntityId, resource)!;
  const client = v1.NewClient(
    configuration.preSharedKey,
    configuration.endpoint,
    configuration.insecureLocal
      ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED
      : v1.ClientSecurity.SECURE,
  );
  const bootstrap = await readFile(
    new URL('../../spicedb/bootstrap.yaml', import.meta.url),
    'utf-8',
  );
  const bootstrapLines = bootstrap.split('\n');
  const schemaStart = bootstrapLines.indexOf('schema: |-') + 1;
  const schemaEnd = bootstrapLines.indexOf('relationships: |-');
  assert.ok(schemaStart > 0 && schemaEnd > schemaStart);
  const schemaBlock = bootstrapLines
    .slice(schemaStart, schemaEnd)
    .map((line) => line.replace(/^ {2}/u, ''))
    .join('\n');
  await client.promises.writeSchema(
    v1.WriteSchemaRequest.create({
      schema: schemaBlock,
    }),
  );
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

  try {
    await client.promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: relationships.map((item) =>
          v1.RelationshipUpdate.create({
            operation: v1.RelationshipUpdate_Operation.TOUCH,
            relationship: item,
          }),
        ),
      }),
    );
    const permissionClient = createSpiceDbPermissionClient(configuration, SPICEDB_CHECK_TIMEOUT_MS);
    try {
      const access = makeContextAccess(permissionClient);
      for (const permission of [
        'impersonate',
        'manage_identity',
        'manage_party_identity',
        'manage_party_relationships',
        'merge_party_identity',
        'read_party_identity',
        'review_party_identity',
      ] as const) {
        assert.deepEqual(
          await Effect.runPromise(
            access.tenants({
              permission,
              principalId,
              tenantIds: [tenantId, otherTenantId],
            }),
          ),
          [
            { decision: 'allowed', key: tenantId },
            { decision: 'denied', key: otherTenantId },
          ],
        );
      }
      for (const permission of ['access', 'manage_counterparty', 'read_counterparty'] as const) {
        assert.deepEqual(
          await Effect.runPromise(
            access.legalEntities({
              legalEntityIds: [legalEntityId, otherLegalEntityId],
              permission,
              principalId,
              tenantId,
            }),
          ),
          [
            { decision: 'allowed', key: legalEntityId },
            { decision: 'denied', key: otherLegalEntityId },
          ],
        );
      }
      assert.deepEqual(
        await Effect.runPromise(
          access.modules({ legalEntityId, moduleIds: [moduleId], principalId, tenantId }),
        ),
        [{ decision: 'allowed', key: moduleId }],
      );
      assert.deepEqual(
        await Effect.runPromise(
          access.modules({
            legalEntityId,
            moduleIds: [moduleId],
            principalId,
            tenantId: otherTenantId,
          }),
        ),
        [{ decision: 'denied', key: moduleId }],
      );
      assert.deepEqual(
        await Effect.runPromise(
          access.resources({ legalEntityId, principalId, resources: [resource], tenantId }),
        ),
        [{ decision: 'allowed', key: `${moduleId}:property.unit:${resource.resourceId}` }],
      );
    } finally {
      permissionClient.close();
    }
  } finally {
    for (const [resourceType, resourceId] of [
      ['resource', resourceObjectId],
      ['module_access', moduleObjectId],
      ['legal_entity', legalObjectId],
      ['tenant', tenantId],
    ] as const) {
      await client.promises.deleteRelationships(
        v1.DeleteRelationshipsRequest.create({
          relationshipFilter: v1.RelationshipFilter.create({
            optionalResourceId: resourceId,
            resourceType,
          }),
        }),
      );
    }
    client.close();
  }
});
