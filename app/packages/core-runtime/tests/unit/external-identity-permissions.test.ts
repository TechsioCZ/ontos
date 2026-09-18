import { fileURLToPath } from 'node:url';

import { v1 } from '@authzed/authzed-node';
import { NodeFileSystem } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';

import type { SpiceDbPermissionClient } from '../../src/permissions/client.ts';
import {
  IDENTITY_NAMESPACE_PERMISSION_KEYS,
  TENANT_PERMISSION_KEYS,
  makeContextAccess,
  toIdentityNamespaceAccessObjectId,
} from '../../src/permissions/context-access.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '10000000-0000-4000-8000-000000000002';
const enrollmentPrincipalId = '30000000-0000-4000-8000-000000000011';
const memberPrincipalId = '30000000-0000-4000-8000-000000000012';
const relationOnlyPrincipalId = '30000000-0000-4000-8000-000000000013';
const administratorPrincipalId = '30000000-0000-4000-8000-000000000014';
const namespaceA = 'namespace-a';
const namespaceB = 'namespace-b';
const namespaceD = 'namespace-d';

const responseFor = (
  request: v1.CheckBulkPermissionsRequest,
  permissionships: readonly v1.CheckPermissionResponse_Permissionship[],
) =>
  v1.CheckBulkPermissionsResponse.create({
    pairs: request.items.map((item, index) =>
      v1.CheckBulkPermissionsPair.create({
        request: item,
        response: {
          item: v1.CheckBulkPermissionsResponseItem.create({
            permissionship: permissionships[index] ?? v1.CheckPermissionResponse_Permissionship.UNSPECIFIED,
          }),
          oneofKind: 'item',
        },
      }),
    ),
  });

const makeClient = (handle: SpiceDbPermissionClient['checkBulkPermissions']): SpiceDbPermissionClient => ({
  checkBulkPermissions: handle,
  checkPermission: () => Effect.die(new Error('Single permission checks are not part of ContextAccess')),
  close: () => {},
});

it('keeps identity provisioning to one neutral namespace capability', () => {
  expect(ONTOS_SPICEDB_SCHEMA).toMatch(
    /definition identity_namespace \{[\s\S]*relation tenant: tenant[\s\S]*relation provisioner: principal[\s\S]*permission provision = provisioner & tenant->access[\s\S]*\}/u,
  );
  expect(ONTOS_SPICEDB_SCHEMA).not.toMatch(/external_identity_(?:enroller|resolver|assertion_issuer|verifier)/u);
  expect(ONTOS_SPICEDB_SCHEMA).not.toMatch(
    /permission (?:enroll_external_identity|resolve_external_identity|issue_external_identity_assertion|verify_external_authentication)/u,
  );
  expect(TENANT_PERMISSION_KEYS).toEqual([
    'access',
    'impersonate',
    'manage_identity',
    'manage_party_identity',
    'manage_party_relationships',
    'merge_party_identity',
    'read_party_identity',
    'review_party_identity',
  ]);
  expect(IDENTITY_NAMESPACE_PERMISSION_KEYS).toEqual(['provision']);
});

it.effect('checks exact Tenant/namespace grants and keeps admin authority separate', () =>
  Effect.gen(function* identityNamespacePermissionChecks() {
    const namespaceAObjectId = toIdentityNamespaceAccessObjectId(tenantId, namespaceA) ?? '';
    const namespaceBObjectId = toIdentityNamespaceAccessObjectId(tenantId, namespaceB) ?? '';
    const namespaceDObjectId = toIdentityNamespaceAccessObjectId(tenantId, namespaceD) ?? '';
    const namespaceObjects = new Map([
      [namespaceAObjectId, { provisioners: new Set([enrollmentPrincipalId]), tenantId }],
      [namespaceBObjectId, { provisioners: new Set<string>(), tenantId }],
      [namespaceDObjectId, { provisioners: new Set([relationOnlyPrincipalId]), tenantId }],
    ]);
    const tenantMembers = new Map([
      [tenantId, new Set([enrollmentPrincipalId, memberPrincipalId, administratorPrincipalId])],
      [otherTenantId, new Set<string>()],
    ]);
    const access = makeContextAccess(
      makeClient((request) =>
        Effect.succeed(
          responseFor(
            request,
            request.items.map((item) => {
              const principalId = item.subject?.object?.objectId ?? '';
              if (item.resource?.objectType === 'identity_namespace') {
                const namespace = namespaceObjects.get(item.resource.objectId);
                return namespace !== undefined &&
                  tenantMembers.get(namespace.tenantId)?.has(principalId) === true &&
                  namespace.provisioners.has(principalId)
                  ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
                  : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION;
              }
              if (item.resource?.objectType === 'tenant' && item.permission === 'manage_identity') {
                return principalId === administratorPrincipalId
                  ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
                  : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION;
              }
              return v1.CheckPermissionResponse_Permissionship.NO_PERMISSION;
            }),
          ),
        ),
      ),
    );

    expect(access.identityNamespaces).toBeDefined();
    expect(
      yield* (
        access.identityNamespaces?.({
          authenticationNamespaceIds: [namespaceA, namespaceB],
          principalId: enrollmentPrincipalId,
          tenantId,
        }) ?? Effect.succeed([])
      ),
    ).toEqual([
      { decision: 'allowed', key: namespaceA },
      { decision: 'denied', key: namespaceB },
    ]);
    expect(
      yield* (
        access.identityNamespaces?.({
          authenticationNamespaceIds: [namespaceA],
          principalId: memberPrincipalId,
          tenantId,
        }) ?? Effect.succeed([])
      ),
    ).toEqual([{ decision: 'denied', key: namespaceA }]);
    expect(
      yield* (
        access.identityNamespaces?.({
          authenticationNamespaceIds: [namespaceD],
          principalId: relationOnlyPrincipalId,
          tenantId,
        }) ?? Effect.succeed([])
      ),
    ).toEqual([{ decision: 'denied', key: namespaceD }]);
    expect(
      yield* access.tenants({
        permission: 'manage_identity',
        principalId: enrollmentPrincipalId,
        tenantIds: [tenantId],
      }),
    ).toEqual([{ decision: 'denied', key: tenantId }]);
    expect(
      yield* access.tenants({
        permission: 'manage_identity',
        principalId: administratorPrincipalId,
        tenantIds: [tenantId],
      }),
    ).toEqual([{ decision: 'allowed', key: tenantId }]);
  }),
);

it.layer(NodeFileSystem.layer)('keeps identity provisioning grants out of bootstrap relationships', (suite) => {
  suite.effect('synchronizes the development and stage schema sections', () =>
    Effect.gen(function* synchronizedBootstrapSchemas() {
      const fs = yield* FileSystem.FileSystem;
      const bootstrapSources = yield* Effect.all(
        [
          fs.readFileString(fileURLToPath(new URL('../../spicedb/bootstrap.yaml', import.meta.url))),
          fs.readFileString(fileURLToPath(new URL('../../spicedb/stage-bootstrap.yaml', import.meta.url))),
        ],
        { concurrency: 'unbounded' },
      );
      const expectedSchemaBlock = `schema: |-\n${ONTOS_SPICEDB_SCHEMA.split('\n')
        .map((line) => (line.length === 0 ? '' : `  ${line}`))
        .join('\n')}`;
      expect(bootstrapSources[0].startsWith(expectedSchemaBlock)).toBeTruthy();
      expect(bootstrapSources[1].trimEnd()).toBe(expectedSchemaBlock);

      for (const source of bootstrapSources) {
        expect(source).not.toMatch(/identity_namespace:[^\n]*#(?:provisioner|tenant)@/u);
        expect(source).not.toMatch(/#provisioner@/u);
        expect(source).not.toMatch(/external_identity_(?:enroller|resolver|assertion_issuer|verifier)/u);
      }
    }),
  );
});
