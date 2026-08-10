import assert from 'node:assert/strict';
import test from 'node:test';
import { Schema } from 'effect';
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

test('identity Actions are generated, sensitive, idempotent, and owned by Core identity', () => {
  for (const registration of registrations) {
    assert.equal(registration.descriptor.actionKey.startsWith('core.identity.'), true);
    assert.equal(registration.descriptor.auditProfile, 'sensitive');
    assert.equal(registration.descriptor.idempotency, 'required');
    assert.equal(registration.descriptor.owningModuleKey, 'core.identity');
    assert.equal(registration.descriptor.accessEvidencePolicy.captureMode, 'metadata_only');
    assert.equal(Object.isFrozen(registration.descriptor), true);
  }
});

test('identity administration and support starts declare independent tenant permissions', () => {
  for (const registration of [
    bindManagedApiKeyAction,
    changePrincipalStatusAction,
    createNonHumanPrincipalAction,
    setManagedApiKeyBindingStatusAction,
  ]) {
    assert.equal(registration.descriptor.tenantPermission?.({} as never), 'manage_identity');
  }
  assert.equal(bindSelfApiKeyAction.descriptor.tenantPermission, undefined);
  assert.equal(setSelfApiKeyBindingStatusAction.descriptor.tenantPermission, undefined);
  assert.equal(
    recordSupportImpersonationAction.descriptor.tenantPermission?.({
      checkpoint: 'requested',
    } as never),
    'impersonate',
  );
  assert.equal(
    recordSupportImpersonationAction.descriptor.tenantPermission?.({
      checkpoint: 'stopped',
    } as never),
    undefined,
  );
});

test('identity status schemas require reasons for disabling, archiving, and revoking', () => {
  const principalId = '00000000-0000-4000-8000-000000000001';
  const authBindingId = '00000000-0000-4000-8000-000000000002';

  assert.throws(() =>
    Schema.decodeUnknownSync(changePrincipalStatusAction.descriptor.payloadSchema)({
      expectedStatus: 'active',
      newStatus: 'disabled',
      principalId,
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(setSelfApiKeyBindingStatusAction.descriptor.payloadSchema)({
      authBindingId,
      expectedStatus: 'active',
      newStatus: 'revoked',
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(setManagedApiKeyBindingStatusAction.descriptor.payloadSchema)({
      authBindingId,
      expectedStatus: 'active',
      newStatus: 'revoked',
      principalId,
    }),
  );
});

test('support checkpoints forbid unsafe or misplaced session references', () => {
  const originalPrincipalId = '00000000-0000-4000-8000-000000000001';
  const targetPrincipalId = '00000000-0000-4000-8000-000000000002';
  const decode = Schema.decodeUnknownSync(
    recordSupportImpersonationAction.descriptor.payloadSchema,
  );

  assert.deepEqual(
    decode({
      checkpoint: 'requested',
      originalPrincipalId,
      reason: 'Investigating a support request',
      sessionRef: 'better-auth-session:must-not-exist-yet',
      targetPrincipalId,
    }),
    {
      checkpoint: 'requested',
      originalPrincipalId,
      reason: 'Investigating a support request',
      targetPrincipalId,
    },
  );
  for (const sessionRef of ['raw-session-token', 'better-auth-session:contains whitespace']) {
    assert.throws(() =>
      decode({
        checkpoint: 'stopped',
        originalPrincipalId,
        reason: 'Investigating a support request',
        sessionRef,
        targetPrincipalId,
      }),
    );
  }
  assert.deepEqual(
    decode({
      checkpoint: 'stopped',
      originalPrincipalId,
      reason: 'Investigating a support request',
      sessionRef: 'better-auth-session:safe-session-reference',
      targetPrincipalId,
    }),
    {
      checkpoint: 'stopped',
      originalPrincipalId,
      reason: 'Investigating a support request',
      sessionRef: 'better-auth-session:safe-session-reference',
      targetPrincipalId,
    },
  );
});
