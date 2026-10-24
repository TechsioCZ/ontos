import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '@app/core-runtime';
import { StageAccountsFileSchema, parseStageAccountsFile } from '@app/core-runtime/install/stage-accounts-file';
import { expect, it } from 'effect-rstest';
import { Effect, Redacted, Schema } from 'effect';
import { toScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import {
  toSpiceDbActionObjectId,
  toSpiceDbActionGrantObjectId,
} from '../../packages/core-runtime/src/permissions/service.ts';
import { stageVerificationAccounts } from '../demo/ensure-stage-verification.mts';
import { stageAccountsAuthorization } from '../provision-current-action-authorization.mts';
import { demoPrincipalRoleKey } from '../demo/permissions.mts';
import {
  verificationAccount,
  verificationContext,
  verificationLegalEntityId,
  verificationTenantId,
} from '../demo/verification-context.mts';

const taskModule = 'work.tasks';
const taskAction = 'work.tasks.apply-command';
const roleId = toScopedRoleObjectId({
  legalEntityId: verificationLegalEntityId,
  roleKey: demoPrincipalRoleKey(verificationAccount.principalId),
  tenantId: verificationTenantId,
});

it.effect(
  'bootstraps an isolated verification company with explicit membership and role-only capabilities, offline without Actions',
  () =>
    Effect.gen(function* verifiesContext() {
      const context = yield* verificationContext();
      expect(context.tenant.tenantId).toBe(verificationTenantId);
      expect(context.legalEntity.legalEntityId).toBe(verificationLegalEntityId);
      expect(context.accounts.map((account) => account.principalId)).toEqual([verificationAccount.principalId]);
      expect(context.companyMemberships).toEqual([
        {
          affiliation: 'external',
          legalEntityId: verificationLegalEntityId,
          principalId: verificationAccount.principalId,
        },
      ]);
      expect(context.modules.map((module) => module.moduleId)).toEqual([taskModule]);
      const principalGrants = context.relationships.filter((relationship) => relationship.subjectType === 'principal');
      expect(
        principalGrants.every(
          (relationship) =>
            relationship.subjectId === verificationAccount.principalId && relationship.relation === 'member',
        ),
      ).toBe(true);
      expect(new Set(principalGrants.map((row) => row.resourceType))).toEqual(
        new Set(['legal_entity', 'scoped_role', 'tenant']),
      );
      expect(
        context.relationships.some((row) => row.resourceType === 'action' || row.resourceType === 'action_grant'),
      ).toBe(false);
      for (const moduleId of ['core.shell', taskModule]) {
        expect(
          context.relationships.some(
            (row) =>
              row.resourceId === toModuleAccessObjectId(verificationTenantId, verificationLegalEntityId, moduleId) &&
              row.relation === 'accessor_role' &&
              row.subjectId === roleId &&
              row.subjectRelation === 'member',
          ),
        ).toBe(true);
      }
      for (const permission of ['work.tasks.read_all', 'work.tasks.write_all']) {
        const resourceId = toContextPermissionAccessObjectId(verificationTenantId, verificationLegalEntityId, {
          moduleId: taskModule,
          permission,
        });
        expect(
          context.relationships.some(
            (row) => row.resourceId === resourceId && row.relation === 'role_grantee' && row.subjectId === roleId,
          ),
        ).toBe(true);
        expect(
          context.relationships.some(
            (row) =>
              row.resourceId === resourceId &&
              row.relation === 'legal_entity' &&
              row.subjectId === toLegalEntityAccessObjectId(verificationTenantId, verificationLegalEntityId),
          ),
        ).toBe(true);
      }
    }),
);

it.effect('installs only the published scoped task Action and userset role grant after publication', () =>
  Effect.gen(function* verifiesPublishedPolicy() {
    const context = yield* verificationContext([
      { actionKey: taskAction, legalEntityScope: 'required', owningModuleKey: taskModule, provisioning: 'explicit' },
    ]);
    const scope = { actionKey: taskAction, legalEntityId: verificationLegalEntityId, tenantId: verificationTenantId };
    expect(context.relationships.filter((row) => row.resourceType === 'action_grant')).toEqual([
      {
        relation: 'role',
        resourceId: toSpiceDbActionGrantObjectId(scope),
        resourceType: 'action_grant',
        subjectId: roleId,
        subjectRelation: 'member',
        subjectType: 'scoped_role',
      },
    ]);
    expect(
      context.relationships
        .filter((row) => row.resourceType === 'action')
        .every((row) => row.resourceId === toSpiceDbActionObjectId(scope)),
    ).toBe(true);
    expect(
      context.relationships.some(
        (row) => row.relation === 'superadmin' || row.relation === 'admin' || row.relation === 'executor',
      ),
    ).toBe(false);
    expect(new Set(context.relationships.map((row) => JSON.stringify(row))).size).toBe(context.relationships.length);
  }),
);

it.effect('generates a v4 stage accounts policy confined to the verification tenant and company', () =>
  Effect.gen(function* validatesNativeStageFile() {
    const accounts = yield* stageVerificationAccounts(Redacted.make('verification-test-password'));
    const source = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toEncoded(StageAccountsFileSchema)))(
      accounts,
    );
    const file = yield* parseStageAccountsFile({ mode: 0o600, source });
    expect(file.schemaVersion).toBe(4);
    const policy = stageAccountsAuthorization(file);
    expect(policy.managedRoles).toEqual(file.scopedRoles);
    expect(policy.managedRoles[0]).toMatchObject({ principalIds: [verificationAccount.principalId] });
    expect(policy.contexts).toEqual([
      { principalId: verificationAccount.principalId, tenantId: verificationTenantId },
      {
        legalEntityId: verificationLegalEntityId,
        principalId: verificationAccount.principalId,
        tenantId: verificationTenantId,
      },
    ]);
    expect(file.retiredAccountEmails).toEqual([]);
    expect(file.retiredTenants).toEqual([]);
    expect(file.tenants).toHaveLength(1);
    const [tenant] = file.tenants;
    expect(tenant.tenantId).toBe(verificationTenantId);
    expect(tenant.legalEntity.legalEntityId).toBe(verificationLegalEntityId);
    expect(tenant.moduleKey).toBe(taskModule);
    expect(tenant.accounts).toHaveLength(1);
    expect(tenant.accounts[0].principalId).toBe(verificationAccount.principalId);
    expect(file.scopedRoles).toHaveLength(1);
    expect(file.scopedRoles[0].tenantId).toBe(verificationTenantId);
    expect(file.scopedRoles[0].legalEntityId).toBe(verificationLegalEntityId);
    expect(file.scopedRoles[0].principalIds).toEqual([verificationAccount.principalId]);
    expect(file.actionAuthorization.roleGrants).toEqual([
      {
        actionKey: taskAction,
        legalEntityId: verificationLegalEntityId,
        roleKey: file.scopedRoles[0].roleKey,
        tenantId: verificationTenantId,
      },
    ]);
  }),
);
