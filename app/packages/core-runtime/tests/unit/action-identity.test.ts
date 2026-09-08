import { expect, it } from '@app/effect-rstest';
import { Effect, Schema } from 'effect';
import {
  bindManagedApiKeyAction,
  bindSelfApiKeyAction,
  changePrincipalStatusAction,
  createNonHumanPrincipalAction,
  recordSupportImpersonationAction,
  setManagedApiKeyBindingStatusAction,
  setSelfApiKeyBindingStatusAction,
} from '../../src/index.ts';

const registrations = [
  bindManagedApiKeyAction,
  bindSelfApiKeyAction,
  changePrincipalStatusAction,
  createNonHumanPrincipalAction,
  recordSupportImpersonationAction,
  setManagedApiKeyBindingStatusAction,
  setSelfApiKeyBindingStatusAction,
] as const;

it('identity Actions are generated, sensitive, idempotent, and owned by Core identity', () => {
  for (const registration of registrations) {
    expect(registration.descriptor.actionKey.startsWith('core.identity.')).toBe(true);
    expect(registration.descriptor.auditProfile).toBe('sensitive');
    expect(registration.descriptor.idempotency).toBe('required');
    expect(registration.descriptor.owningModuleKey).toBe('core.identity');
    expect(registration.descriptor.accessEvidencePolicy.captureMode).toBe('metadata_only');
    expect(Object.isFrozen(registration.descriptor)).toBe(true);
  }
});

it.effect('identity administration and support starts declare independent tenant permissions', () =>
  Effect.gen(function* identityScenario2() {
    const principalId = '00000000-0000-4000-8000-000000000001';
    const authBindingId = '00000000-0000-4000-8000-000000000002';
    const originalPrincipalId = '00000000-0000-4000-8000-000000000003';
    const managedPermissions = [
      bindManagedApiKeyAction.descriptor.tenantPermission?.(
        yield* Schema.decodeUnknownEffect(bindManagedApiKeyAction.descriptor.payloadSchema)({
          principalId,
          providerSubjectId: 'provider-key-id',
        }),
      ),
      changePrincipalStatusAction.descriptor.tenantPermission?.(
        yield* Schema.decodeUnknownEffect(changePrincipalStatusAction.descriptor.payloadSchema)({
          expectedStatus: 'active',
          newStatus: 'disabled',
          principalId,
          reason: 'Offboarding',
        }),
      ),
      createNonHumanPrincipalAction.descriptor.tenantPermission?.(
        yield* Schema.decodeUnknownEffect(createNonHumanPrincipalAction.descriptor.payloadSchema)({
          displayName: 'Inventory service',
          kind: 'service',
        }),
      ),
      setManagedApiKeyBindingStatusAction.descriptor.tenantPermission?.(
        yield* Schema.decodeUnknownEffect(
          setManagedApiKeyBindingStatusAction.descriptor.payloadSchema,
        )({
          authBindingId,
          expectedStatus: 'active',
          newStatus: 'disabled',
          principalId,
        }),
      ),
    ];
    for (const permission of managedPermissions) {
      expect(permission).toBe('manage_identity');
    }
    expect(bindSelfApiKeyAction.descriptor.tenantPermission).toBe(undefined);
    expect(setSelfApiKeyBindingStatusAction.descriptor.tenantPermission).toBe(undefined);
    const supportPayload = {
      originalPrincipalId,
      reason: 'Investigating a support request',
      targetPrincipalId: principalId,
    };
    expect(
      recordSupportImpersonationAction.descriptor.tenantPermission?.(
        yield* Schema.decodeUnknownEffect(
          recordSupportImpersonationAction.descriptor.payloadSchema,
        )({
          ...supportPayload,
          checkpoint: 'requested',
        }),
      ),
    ).toBe('impersonate');
    expect(
      recordSupportImpersonationAction.descriptor.tenantPermission?.(
        yield* Schema.decodeUnknownEffect(
          recordSupportImpersonationAction.descriptor.payloadSchema,
        )({
          ...supportPayload,
          checkpoint: 'stopped',
          sessionRef: 'better-auth-session:safe-session-reference',
        }),
      ),
    ).toBe(undefined);
  }),
);

it('identity status schemas require reasons for disabling, archiving, and revoking', () => {
  const principalId = '00000000-0000-4000-8000-000000000001';
  const authBindingId = '00000000-0000-4000-8000-000000000002';

  expect(() =>
    Schema.decodeUnknownSync(changePrincipalStatusAction.descriptor.payloadSchema)({
      expectedStatus: 'active',
      newStatus: 'disabled',
      principalId,
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(setSelfApiKeyBindingStatusAction.descriptor.payloadSchema)({
      authBindingId,
      expectedStatus: 'active',
      newStatus: 'revoked',
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(setManagedApiKeyBindingStatusAction.descriptor.payloadSchema)({
      authBindingId,
      expectedStatus: 'active',
      newStatus: 'revoked',
      principalId,
    }),
  ).toThrow();
});

it.effect('support checkpoints forbid unsafe or misplaced session references', () =>
  Effect.gen(function* identityScenario4() {
    const originalPrincipalId = '00000000-0000-4000-8000-000000000001';
    const targetPrincipalId = '00000000-0000-4000-8000-000000000002';
    const decode = Schema.decodeUnknownEffect(
      recordSupportImpersonationAction.descriptor.payloadSchema,
    );

    expect(
      yield* decode({
        checkpoint: 'requested',
        originalPrincipalId,
        reason: 'Investigating a support request',
        sessionRef: 'better-auth-session:must-not-exist-yet',
        targetPrincipalId,
      }),
    ).toEqual({
      checkpoint: 'requested',
      originalPrincipalId,
      reason: 'Investigating a support request',
      targetPrincipalId,
    });
    for (const sessionRef of ['raw-session-token', 'better-auth-session:contains whitespace']) {
      expect(
        yield* Effect.flip(
          decode({
            checkpoint: 'stopped',
            originalPrincipalId,
            reason: 'Investigating a support request',
            sessionRef,
            targetPrincipalId,
          }),
        ),
      ).toBeDefined();
    }
    expect(
      yield* decode({
        checkpoint: 'stopped',
        originalPrincipalId,
        reason: 'Investigating a support request',
        sessionRef: 'better-auth-session:safe-session-reference',
        targetPrincipalId,
      }),
    ).toEqual({
      checkpoint: 'stopped',
      originalPrincipalId,
      reason: 'Investigating a support request',
      sessionRef: 'better-auth-session:safe-session-reference',
      targetPrincipalId,
    });
  }),
);
