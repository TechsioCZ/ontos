import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { currentAgentProfileRelationships } from '../../src/permissions/agent-profile-lifecycle.ts';
import { buildApplicationCompositionCatalog } from '../../src/modules/application-composition-catalog.ts';
import { buildInstalledModuleCatalog } from '../../src/modules/catalog.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { toSpiceDbActionGrantObjectId } from '../../src/permissions/service.ts';
import { toContextPermissionAccessObjectId, toModuleAccessObjectId } from '../../src/permissions/context-access.ts';
import { makeOutboxWorkerComposition } from '../support/outbox-worker-composition.ts';

it.effect(
  'includes intrinsic Core lifecycle execution only while active installed business proposal authority exists',
  () =>
    Effect.gen(function* proposalLifecyclePolicy() {
      const tenantId = 'tenant-a';
      const legalEntityId = 'company-a';
      const moduleId = 'work.tasks';
      const businessActionKey = 'work.tasks.apply-command';
      const lifecycleActionKey = 'core.identity.mutate-agent-proposals';
      const base = yield* buildApplicationCompositionCatalog(
        makeOutboxWorkerComposition([{ appId: 'work-tasks', moduleId }]),
      );
      const catalog = buildInstalledModuleCatalog(
        base.contracts.map((contract) => ({
          contract: {
            ...contract,
            manifest: {
              ...contract.manifest,
              publicSurface: {
                ...contract.manifest.publicSurface,
                actions: [
                  {
                    actionKey: businessActionKey,
                    auditProfile: 'standard',
                    entrypoint: defineTenantModuleEntrypoint({
                      access: 'write',
                      authorization: { kind: 'action_execution', provisioning: 'explicit' },
                      entrypointKey: businessActionKey,
                      moduleKey: moduleId,
                      role: 'action',
                    }),
                    idempotency: 'required',
                    legalEntityScope: 'required',
                    owningModuleId: moduleId,
                    schemaVersion: '1',
                  },
                ],
              },
            },
          },
          expectedAppId: contract.deployment.appId,
        })),
      );
      const input = {
        catalog,
        company: {
          active: true,
          legalEntityId,
          profile: { modules: [{ access: 'write' as const, moduleId }], writePolicy: 'approval' as const },
        },
        // Core is intrinsically installed, not a row in tenant_module_states or a business contract.
        installedModuleKeys: new Set([moduleId]),
        namedPermissions: [],
        principalId: 'agent-a',
        tenantId,
      };
      const lifecycleId = toSpiceDbActionGrantObjectId({ actionKey: lifecycleActionKey, legalEntityId, tenantId });
      const businessId = toSpiceDbActionGrantObjectId({ actionKey: businessActionKey, legalEntityId, tenantId });
      const active = currentAgentProfileRelationships(input);
      expect(
        active
          .filter((item) => item.resource?.objectType === 'action_grant')
          .map((item) => [item.resource?.objectId, item.relation]),
      ).toEqual([
        [businessId, 'proposer_role'],
        [lifecycleId, 'role'],
      ]);
      for (const restricted of [
        { ...input, installedModuleKeys: new Set<string>() },
        { ...input, company: { ...input.company, active: false } },
        { ...input, company: { ...input.company, profile: null } },
        {
          ...input,
          company: { ...input.company, profile: { ...input.company.profile, writePolicy: 'read_only' as const } },
        },
        { ...input, company: { ...input.company, profile: { ...input.company.profile, modules: [] } } },
      ]) {
        const relationships = currentAgentProfileRelationships(restricted);
        expect(relationships.filter((item) => item.resource?.objectType === 'action_grant')).toEqual([]);
      }
      const foreign = currentAgentProfileRelationships({
        ...input,
        company: { ...input.company, legalEntityId: 'company-b' },
      });
      expect(
        foreign.some((item) => item.resource?.objectId === lifecycleId || item.resource?.objectId === businessId),
      ).toBe(false);
    }),
);

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
