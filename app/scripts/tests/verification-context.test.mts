import { createHash } from 'node:crypto';
import { NodeServices } from '@effect/platform-node';
import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '@app/core-runtime';
import { StageAccountsFileSchema, parseStageAccountsFile } from '@app/core-runtime/install/stage-accounts-file';
import {
  buildStageContextRelationships,
  stageContextsFromAccountsFile,
} from '@app/core-runtime/install/stage-context-bootstrap';
import { expect, it } from 'effect-rstest';
import { Effect, FileSystem, Redacted, Result, Schema } from 'effect';
import { toScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import {
  toSpiceDbActionObjectId,
  toSpiceDbActionGrantObjectId,
} from '../../packages/core-runtime/src/permissions/service.ts';
import { stageVerificationAccounts } from '../demo/ensure-stage-verification.mts';
import { readReviewedAgentProfiles, ReviewedAgentProfilesSchema } from '../demo/agent-profile-setup.mts';
import { stageAccountsAuthorization } from '../provision-current-action-authorization.mts';
import { peopleModelTransitionFixtureRelationships } from '../demo/people-model-transition-fixture.mts';
import { ownTaskRelationships } from '../demo/accounts-admin-grants.mts';
import {
  verificationAccount,
  verificationContext,
  verificationLegalEntityId,
  verificationTenantId,
  verificationTaskWriterRoleKey,
} from '../demo/verification-context.mts';

const taskModule = 'work.tasks';
const taskAction = 'work.tasks.apply-command';
const roleId = toScopedRoleObjectId({
  legalEntityId: verificationLegalEntityId,
  roleKey: verificationTaskWriterRoleKey,
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
            relationship.subjectId === verificationAccount.principalId &&
            relationship.relation === (relationship.resourceType === 'tenant' ? 'company_member' : 'member'),
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
    expect(tenant.accounts[0].affiliation).toBe('external');
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

it.effect(
  'preserves the reviewed CI company role in the canonical transition without creating absent memberships',
  () =>
    Effect.gen(function* verifiesTransitionFixture() {
      const actions = [
        ...[
          'crm.activities',
          'demo.workforce',
          'demo.merchandise',
          'demo.sales-insights',
          'finance.billing',
          'property.portfolio',
          'property.leasing',
        ].map((owningModuleKey) => ({
          actionKey: `${owningModuleKey}.apply-command`,
          legalEntityScope: 'required' as const,
          owningModuleKey,
          provisioning: 'explicit' as const,
        })),
        { actionKey: taskAction, legalEntityScope: 'required', owningModuleKey: taskModule, provisioning: 'explicit' },
        {
          actionKey: 'work.tasks.unreviewed-command',
          legalEntityScope: 'required',
          owningModuleKey: taskModule,
          provisioning: 'explicit',
        },
      ] as const;
      const membership = {
        legalEntityId: verificationLegalEntityId,
        principalId: verificationAccount.principalId,
        tenantId: verificationTenantId,
      };
      const installation = {
        companies: [{ legalEntityId: membership.legalEntityId, status: 'active', tenantId: membership.tenantId }],
        moduleStates: [{ moduleKey: taskModule, state: 'active', tenantId: membership.tenantId }],
        publishedModuleKeys: [taskModule],
      };
      const target = yield* peopleModelTransitionFixtureRelationships(actions, [membership], installation);
      const context = yield* verificationContext(actions);
      for (const row of [...context.relationships, ...ownTaskRelationships()]) {
        expect(target).toContainEqual(row);
      }
      // Reviewed executor add-ons remain policy, not evidence that their modules are installed.
      expect(
        target
          .filter((row) => row.resourceType === 'action')
          .every((row) =>
            [taskAction, 'work.tasks.unreviewed-command'].some(
              (actionKey) => row.resourceId === toSpiceDbActionObjectId({ ...membership, actionKey }),
            ),
          ),
      ).toBe(true);
      expect(target).toContainEqual({
        relation: 'role',
        resourceId: toSpiceDbActionGrantObjectId({ ...membership, actionKey: taskAction }),
        resourceType: 'action_grant',
        subjectId: roleId,
        subjectRelation: 'member',
        subjectType: 'scoped_role',
      });
      expect(context.relationships.filter((row) => row.resourceType === 'action_grant')).toHaveLength(1);
      expect(target).toContainEqual({
        relation: 'member',
        resourceId: roleId,
        resourceType: 'scoped_role',
        subjectId: membership.principalId,
        subjectType: 'principal',
      });
      expect(target).toContainEqual({
        relation: 'company_member',
        resourceId: membership.tenantId,
        resourceType: 'tenant',
        subjectId: membership.principalId,
        subjectType: 'principal',
      });
      for (const unavailable of [
        { ...installation, publishedModuleKeys: [] },
        { ...installation, moduleStates: installation.moduleStates.map((row) => ({ ...row, state: 'inactive' })) },
        { ...installation, companies: installation.companies.map((row) => ({ ...row, status: 'inactive' })) },
      ]) {
        const unavailableTarget = yield* peopleModelTransitionFixtureRelationships(actions, [membership], unavailable);
        expect(unavailableTarget.filter((row) => row.resourceType === 'action')).toEqual([]);
        expect(unavailableTarget.filter((row) => row.resourceType === 'action_grant')).toEqual(
          target.filter((row) => row.resourceType === 'action_grant'),
        );
      }
      for (const rows of [[], [{ ...membership, tenantId: '70000000-0000-4000-8000-000000000020' }]]) {
        const absent = yield* peopleModelTransitionFixtureRelationships(actions, rows, installation);
        expect(absent.some((row) => row.subjectId === membership.principalId || row.resourceId === roleId)).toBe(false);
      }
    }),
);

it.effect('gives the verification account module access only through its task-writer role, never a direct grant', () =>
  Effect.gen(function* rolesOnlyVerificationAccess() {
    const accounts = yield* stageVerificationAccounts(Redacted.make('verification-test-password'));
    const source = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toEncoded(StageAccountsFileSchema)))(
      accounts,
    );
    const [context] = stageContextsFromAccountsFile(yield* parseStageAccountsFile({ mode: 0o600, source }));
    const bootstrap = yield* buildStageContextRelationships(context);
    const taskAccess = toModuleAccessObjectId(verificationTenantId, verificationLegalEntityId, taskModule);
    expect(bootstrap.some((row) => row.resourceType === 'module_access' && row.relation === 'accessor')).toBe(false);
    expect(bootstrap).toContainEqual({
      relation: 'member',
      resourceId: roleId,
      resourceType: 'scoped_role',
      subjectId: verificationAccount.principalId,
      subjectType: 'principal',
    });
    const policy = yield* verificationContext();
    expect(
      policy.relationships.some(
        (row) =>
          row.resourceId === taskAccess &&
          row.relation === 'accessor_role' &&
          row.subjectId === roleId &&
          row.subjectRelation === 'member',
      ),
    ).toBe(true);
  }),
);

it.effect('pins each environment replay artifact by its own exact reviewed hash, never the old LOCAL identities', () =>
  Effect.gen(function* verifiesProfileArtifact() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'reviewed-stage-profiles-' });
    const path = `${directory}/profiles.json`;
    const profile = {
      description: null,
      legalEntityId: verificationLegalEntityId,
      modules: [{ access: 'read' as const, moduleId: taskModule }],
      ownerPrincipalId: null,
      principalId: '72000000-0000-4000-8000-000000000091',
      tenantId: verificationTenantId,
      writePolicy: 'read_only' as const,
    };
    const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.toEncoded(ReviewedAgentProfilesSchema)));
    const source = yield* encode({ profiles: [profile], schemaVersion: 2 });
    yield* fs.writeFileString(path, source, { mode: 0o600 });
    const hash = createHash('sha256').update(source).digest('hex');
    expect((yield* readReviewedAgentProfiles(path, hash)).profiles).toEqual([profile]);
    expect(Result.isFailure(yield* Effect.result(readReviewedAgentProfiles(path, '0'.repeat(64))))).toBe(true);
    expect(Result.isFailure(yield* Effect.result(readReviewedAgentProfiles(path, 'not-a-sha256')))).toBe(true);
    const duplicate = yield* encode({ profiles: [profile, profile], schemaVersion: 2 });
    yield* fs.writeFileString(path, duplicate);
    expect(
      Result.isFailure(
        yield* Effect.result(readReviewedAgentProfiles(path, createHash('sha256').update(duplicate).digest('hex'))),
      ),
    ).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
