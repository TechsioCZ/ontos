import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '@app/core-runtime';
import { toSpiceDbActionObjectId } from '@app/core-runtime/actions/runtime-wiring';
import { expect, it } from 'effect-rstest';
import { Effect, Redacted, Schema } from 'effect';
import { StageAccountsFileSchema, parseStageAccountsFile } from '@app/core-runtime/install/stage-accounts-file';
import { stageVerificationAccounts } from '../demo/ensure-stage-verification.mts';

import {
  verificationAccount,
  verificationContext,
  verificationLegalEntityId,
  verificationTenantId,
} from '../demo/verification-context.mts';

const taskModule = 'work.tasks';

it.effect('bootstraps an isolated verification company with one principal and only work.tasks', () =>
  Effect.gen(function* verifiesContext() {
    const context = yield* verificationContext();
    expect(context.tenant.tenantId).toBe(verificationTenantId);
    expect(context.legalEntity.legalEntityId).toBe(verificationLegalEntityId);
    expect(context.accounts.map((account) => account.principalId)).toEqual([verificationAccount.principalId]);
    expect(context.modules.map((module) => module.moduleId)).toEqual([taskModule]);
    const principalGrants = context.relationships.filter((relationship) => relationship.subjectType === 'principal');
    expect(principalGrants.every((relationship) => relationship.subjectId === verificationAccount.principalId)).toBe(
      true,
    );
    expect(
      principalGrants.map(({ relation, resourceId, resourceType }) => ({ relation, resourceId, resourceType })),
    ).toEqual([
      { relation: 'member', resourceId: verificationTenantId, resourceType: 'tenant' },
      {
        relation: 'member',
        resourceId: toLegalEntityAccessObjectId(verificationTenantId, verificationLegalEntityId),
        resourceType: 'legal_entity',
      },
      ...['core.shell', taskModule].map((moduleId) => ({
        relation: 'accessor',
        resourceId: toModuleAccessObjectId(verificationTenantId, verificationLegalEntityId, moduleId),
        resourceType: 'module_access',
      })),
      ...['work.tasks.read_all', 'work.tasks.write_all'].map((permission) => ({
        relation: 'grantee',
        resourceId: toContextPermissionAccessObjectId(verificationTenantId, verificationLegalEntityId, {
          moduleId: taskModule,
          permission,
        }),
        resourceType: 'context_permission',
      })),
      { relation: 'executor', resourceId: toSpiceDbActionObjectId('work.tasks.apply-command'), resourceType: 'action' },
    ]);
  }),
);

it.effect('generates the native stage accounts file without retiring or granting access to any demo tenant', () =>
  Effect.gen(function* validatesNativeStageFile() {
    const accounts = yield* stageVerificationAccounts(Redacted.make('verification-test-password'));
    const source = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toEncoded(StageAccountsFileSchema)))(
      accounts,
    );
    const file = yield* parseStageAccountsFile({ mode: 0o600, source });
    expect(file.retiredAccountEmails).toEqual([]);
    expect(file.retiredTenants).toEqual([]);
    expect(file.tenants).toHaveLength(1);
    const [tenant] = file.tenants;
    expect(tenant.tenantId).toBe(verificationTenantId);
    expect(tenant.legalEntity.legalEntityId).toBe(verificationLegalEntityId);
    expect(tenant.moduleKey).toBe('work.tasks');
    expect(tenant.accounts).toHaveLength(1);
    expect(tenant.accounts[0].principalId).toBe(verificationAccount.principalId);
    expect(tenant.accounts[0].grants).toEqual({ explicitActions: ['work.tasks.apply-command'], tenantRelations: [] });
  }),
);
