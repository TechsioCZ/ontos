import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  bindManagedApiKeyAction,
  getActionReducesAuthorityResolver,
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

it.effect('identity administration declares its own admin capability, and only a support stop reduces authority', () =>
  Effect.gen(function* identityScenario2() {
    const principalId = '00000000-0000-4000-8000-000000000001';
    const originalPrincipalId = '00000000-0000-4000-8000-000000000003';
    const declarations = [
      [bindManagedApiKeyAction, 'core.identity.managed-api-key.bind'],
      [bindSelfApiKeyAction, 'core.identity.self-api-key.bind'],
      [changePrincipalStatusAction, 'core.identity.principal.change-status'],
      [createNonHumanPrincipalAction, 'core.identity.principal.create-non-human'],
      [recordSupportImpersonationAction, 'core.identity.support.impersonate'],
      [setManagedApiKeyBindingStatusAction, 'core.identity.managed-api-key.change-status'],
      [setSelfApiKeyBindingStatusAction, 'core.identity.self-api-key.change-status'],
    ] as const;
    for (const [registration, key] of declarations) {
      // The tenant-role gate is gone (O37): each identity Action carries its own admin capability and
      // the one gate decides it, so no legacy tenant permission may remain on the descriptor.
      expect('tenantPermission' in registration.descriptor).toBe(false);
      expect(registration.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
      expect(registration.descriptor.accessDeclaration).toMatchObject({
        key,
        kind: 'admin',
        modes: ['run'],
        risk: 'critical',
        selectors: [],
      });
    }
    const reducesAuthority = getActionReducesAuthorityResolver(recordSupportImpersonationAction);
    const decode = Schema.decodeEffect(recordSupportImpersonationAction.descriptor.payloadSchema);
    const supportPayload = {
      originalPrincipalId,
      reason: 'Investigating a support request',
      targetPrincipalId: principalId,
    };
    // A stop only takes the impersonation away from the person, so no grant may block it (O35, O71).
    expect(
      reducesAuthority?.(
        yield* decode({
          ...supportPayload,
          checkpoint: 'stopped',
          sessionRef: 'better-auth-session:safe-session-reference',
        }),
      ),
    ).toBe(true);
    expect(reducesAuthority?.(yield* decode({ ...supportPayload, checkpoint: 'requested' }))).toBe(false);
    expect(
      reducesAuthority?.(
        yield* decode({
          ...supportPayload,
          checkpoint: 'started',
          sessionRef: 'better-auth-session:safe-session-reference',
        }),
      ),
    ).toBe(false);
    // No other identity Action claims a reduction: an administration or a start still needs its grant.
    for (const [registration] of declarations) {
      if (registration !== recordSupportImpersonationAction) {
        expect(registration.descriptor.accessReducesAuthority).toBeUndefined();
      }
    }
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
    const decode = Schema.decodeUnknownEffect(recordSupportImpersonationAction.descriptor.payloadSchema);

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
