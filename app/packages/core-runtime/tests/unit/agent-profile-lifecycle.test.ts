import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { currentAgentProfileRelationships } from '../../src/permissions/agent-profile-lifecycle.ts';
import { buildApplicationCompositionCatalog } from '../../src/modules/application-composition-catalog.ts';
import { toContextPermissionAccessObjectId, toModuleAccessObjectId } from '../../src/permissions/context-access.ts';
import { makeOutboxWorkerComposition } from '../support/outbox-worker-composition.ts';

it.effect(
  'materializes current profile writes, approval/read-only ceilings, and installed-module boundaries without persona authority',
  () =>
    Effect.gen(function* nativeProfilePolicy() {
      const tenantId = '20000000-0000-4000-8000-000000000001';
      const legalEntityId = '20000000-0000-4000-8000-000000000002';
      const principalId = '20000000-0000-4000-8000-000000000003';
      const moduleId = 'work.tasks';
      const catalog = yield* buildApplicationCompositionCatalog(
        makeOutboxWorkerComposition([{ appId: 'work-tasks', moduleId }]),
      );
      const permissionId = (permission: string) =>
        toContextPermissionAccessObjectId(tenantId, legalEntityId, { moduleId, permission }) ?? '';
      const input = {
        catalog,
        company: {
          active: true,
          legalEntityId,
          profile: { modules: [{ access: 'write' as const, moduleId }], writePolicy: 'direct' as const },
        },
        installedModuleKeys: new Set([moduleId]),
        namedPermissions: ['tasks.read_all', 'tasks.write_all'].map((permission) => ({
          relation: 'role_grantee',
          resourceId: permissionId(permission),
          resourceType: 'context_permission',
        })),
        principalId,
        tenantId,
      };
      const moduleAccessId = toModuleAccessObjectId(tenantId, legalEntityId, moduleId);
      const direct = currentAgentProfileRelationships(input);
      expect(direct.some((item) => item.resource?.objectId === moduleAccessId && item.relation === 'writer_role')).toBe(
        true,
      );
      expect(direct.some((item) => item.resource?.objectId === permissionId('tasks.write_all'))).toBe(true);
      for (const writePolicy of ['approval', 'read_only'] as const) {
        const restricted = currentAgentProfileRelationships({
          ...input,
          company: { ...input.company, profile: { ...input.company.profile, writePolicy } },
        });
        expect(
          restricted.some((item) => item.resource?.objectId === moduleAccessId && item.relation === 'reader_role'),
        ).toBe(true);
        expect(restricted.some((item) => item.resource?.objectId === permissionId('tasks.read_all'))).toBe(true);
        expect(restricted.some((item) => item.resource?.objectId === permissionId('tasks.write_all'))).toBe(false);
        expect(restricted.some((item) => item.relation === 'writer_role')).toBe(false);
      }
      const notInstalled = currentAgentProfileRelationships({ ...input, installedModuleKeys: new Set<string>() });
      expect(notInstalled.some((item) => item.resource?.objectId === moduleAccessId)).toBe(false);
      expect(currentAgentProfileRelationships({ ...input, company: { ...input.company, active: false } })).toEqual([]);
      expect(currentAgentProfileRelationships({ ...input, company: { ...input.company, profile: null } })).toEqual([]);
    }),
);
