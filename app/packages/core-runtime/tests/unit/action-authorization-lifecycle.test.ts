import { v1 } from '@authzed/authzed-node';
import { Effect, Result, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { expect, it } from 'effect-rstest';

import {
  ActionAuthorizationLifecycle,
  buildPrincipalSelfCredentialUpdates,
  buildCompanyTenantAdmissionUpdate,
  deriveActionAuthorizationInstalledScopes,
} from '../../src/permissions/action-authorization-lifecycle.ts';
import { deriveScopedActionAuthorization } from '../../src/install/action-authorization-provisioning.ts';
import { coreSystemOutboxWorkers } from '../../src/outbox/core-system-worker-entry.ts';
import { attestOutboxWorkerHandlerContext, getOutboxWorkerHandler } from '../../src/outbox/definition.ts';
import type { OutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import { OutboxPayloadSchema as PrincipalLifecyclePayloadSchema } from '../../src/outbox/core-identity-principal-lifecycle-changed-v1.ts';

it('multiplies published active tenant modules by all active companies and retains explicit empty archive scopes', () => {
  const scopes = deriveActionAuthorizationInstalledScopes({
    companies: [
      { legalEntityId: 'company-a', status: 'active' },
      { legalEntityId: 'company-b', status: 'active' },
      { legalEntityId: 'company-archived', status: 'archived' },
    ],
    coreModuleKeys: ['core.modules'],
    publishedModuleKeys: ['work.tasks', 'crm.core'],
    tenantActive: true,
    tenantId: 'tenant-a',
    tenantModules: [
      { moduleKey: 'work.tasks', state: 'active' },
      { moduleKey: 'crm.core', state: 'inactive' },
      { moduleKey: 'unpublished.module', state: 'active' },
    ],
  });
  expect(scopes).toEqual([
    { moduleKeys: ['core.modules', 'work.tasks'], tenantId: 'tenant-a' },
    { legalEntityId: 'company-a', moduleKeys: ['core.modules', 'work.tasks'], tenantId: 'tenant-a' },
    { legalEntityId: 'company-b', moduleKeys: ['core.modules', 'work.tasks'], tenantId: 'tenant-a' },
    { legalEntityId: 'company-archived', moduleKeys: [], tenantId: 'tenant-a' },
  ]);
  const actions = deriveScopedActionAuthorization(
    [
      {
        actionKey: 'work.tasks.assign',
        legalEntityScope: 'required',
        owningModuleKey: 'work.tasks',
        provisioning: 'explicit',
      },
      {
        actionKey: 'core.modules.configure',
        legalEntityScope: 'forbidden',
        owningModuleKey: 'core.modules',
        provisioning: 'explicit',
      },
    ],
    scopes,
  );
  expect(actions).toHaveLength(3);
  expect(actions).toContainEqual({ actionKey: 'work.tasks.assign', legalEntityId: 'company-a', tenantId: 'tenant-a' });
  expect(actions).toContainEqual({ actionKey: 'work.tasks.assign', legalEntityId: 'company-b', tenantId: 'tenant-a' });
  expect(actions).toContainEqual({ actionKey: 'core.modules.configure', tenantId: 'tenant-a' });
});

it('returns cleanup scopes for a disabled tenant without retaining even Core Action links', () => {
  expect(
    deriveActionAuthorizationInstalledScopes({
      companies: [{ legalEntityId: 'company-a', status: 'active' }],
      coreModuleKeys: ['core.modules'],
      publishedModuleKeys: ['work.tasks'],
      tenantActive: false,
      tenantId: 'tenant-a',
      tenantModules: [{ moduleKey: 'work.tasks', state: 'active' }],
    }),
  ).toEqual([
    { moduleKeys: [], tenantId: 'tenant-a' },
    { legalEntityId: 'company-a', moduleKeys: [], tenantId: 'tenant-a' },
  ]);
});

it('maintains only the exact active-human self edge and deletes it on deactivation without granting membership', () => {
  const input = { kind: 'human', principalId: 'human-a', status: 'active', tenantActive: true, tenantId: 'tenant-a' };
  const updates = buildPrincipalSelfCredentialUpdates(input);
  expect(updates).toHaveLength(2);
  expect(updates[1]?.operation).toBe(v1.RelationshipUpdate_Operation.TOUCH);
  expect(updates[1]?.relationship).toEqual(
    v1.Relationship.create({
      relation: 'self',
      resource: { objectId: input.principalId, objectType: 'principal' },
      subject: { object: { objectId: input.principalId, objectType: 'principal' } },
    }),
  );
  for (const change of [
    { status: 'disabled' },
    { status: 'archived' },
    { tenantActive: false },
    { kind: 'agent' },
    { kind: 'service' },
    { kind: 'integration' },
  ]) {
    const inactive = buildPrincipalSelfCredentialUpdates({ ...input, ...change });
    expect(inactive[1]?.operation).toBe(v1.RelationshipUpdate_Operation.DELETE);
    expect(inactive[1]?.relationship).toEqual(updates[1]?.relationship);
  }
  expect(updates.every((update) => update.relationship?.resource?.objectType === 'principal')).toBe(true);
  expect(updates.some((update) => update.relationship?.relation === 'member')).toBe(false);
});

const lifecycleContext: OutboxWorkerHandlerContext = {
  attemptNumber: 1,
  claimId: 'claim-a',
  compositionRevision: 'revision-a',
  consumerModuleKey: 'core.authorization',
  deliveryId: 'delivery-a',
  domainEventId: 'event-a',
  legalEntityScope: 'forbidden',
  messageId: 'message-a',
  producerModuleKey: 'core.identity',
  tenantId: 'tenant-a',
  tenantSequenceNo: 1n,
  topic: 'core.identity.principal-lifecycle-changed.v1',
  workerKey: 'core.authorization.reconcile-principal-lifecycle',
};
const principalWakeUp = Result.getOrThrow(
  Schema.decodeUnknownResult(PrincipalLifecyclePayloadSchema)({
    data: { principalId: '20000000-0000-4000-8000-000000000001' },
  }),
);

it.effect(
  'rejects unauthenticated lifecycle context and sends only exact attested identity to current-state reconciliation',
  () =>
    Effect.gen(function* workerPrincipalLifecycle() {
      const calls: string[][] = [];
      const lifecycle = {
        reconcilePrincipal: (tenantId: string, principalId: string, revision: string) =>
          Effect.sync(() => {
            calls.push([tenantId, principalId, revision]);
          }),
        reconcileScopedRoleMembership: () => Effect.void,
        reconcileTenant: () => Effect.void,
      };
      const { 2: worker } = coreSystemOutboxWorkers;
      const handler = getOutboxWorkerHandler(worker);
      const unauthorized = yield* Effect.result(
        handler(principalWakeUp, lifecycleContext).pipe(
          Effect.provideService(ActionAuthorizationLifecycle, lifecycle),
          Effect.provide(Reactivity.layer),
        ),
      );
      expect(Result.isFailure(unauthorized)).toBe(true);
      expect(calls).toEqual([]);
      yield* handler(principalWakeUp, attestOutboxWorkerHandlerContext(lifecycleContext)).pipe(
        Effect.provideService(ActionAuthorizationLifecycle, lifecycle),
        Effect.provide(Reactivity.layer),
      );
      expect(calls).toEqual([
        [lifecycleContext.tenantId, principalWakeUp.data.principalId, lifecycleContext.compositionRevision],
      ]);
    }),
);

it('projects tenant admission from any remaining eligible company without touching independently owned member edges', () => {
  const scope = { principalId: 'human-a', tenantId: 'tenant-a' };
  const active = v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.TOUCH });
  const departed = v1.RelationshipUpdate.create({ operation: v1.RelationshipUpdate_Operation.DELETE });
  for (const updates of [[], [departed], [departed, departed]]) {
    const result = buildCompanyTenantAdmissionUpdate({ ...scope, membershipUpdates: updates });
    expect(result.operation).toBe(v1.RelationshipUpdate_Operation.DELETE);
    expect(result.relationship?.relation).toBe('company_member');
  }
  const result = buildCompanyTenantAdmissionUpdate({ ...scope, membershipUpdates: [departed, active] });
  expect(result.operation).toBe(v1.RelationshipUpdate_Operation.TOUCH);
  expect(result.relationship?.relation).toBe('company_member');
});
