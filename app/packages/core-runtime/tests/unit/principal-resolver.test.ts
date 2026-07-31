import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off
import test from 'node:test';
import { Effect } from 'effect';
import { classifyPrincipalResolution } from '../../src/auth/principal-resolver.ts';
import type { PrincipalResolutionRecord } from '../../src/auth/principal-resolver.ts';

const activeRecord: PrincipalResolutionRecord = {
  bindingRevokedAt: null,
  bindingStatus: 'active',
  displayName: 'Ada Lovelace',
  principalId: 'principal-1',
  principalStatus: 'active',
  tenantId: 'tenant-1',
  tenantStatus: 'active',
};

const failureTag = async (records: readonly PrincipalResolutionRecord[]) => {
  const error = await Effect.runPromise(Effect.flip(classifyPrincipalResolution(records)));
  return error._tag;
};

test('classifies one active binding as a safe identity', async () => {
  const result = await Effect.runPromise(classifyPrincipalResolution([activeRecord]));

  assert.deepEqual(result, {
    displayName: 'Ada Lovelace',
    principalId: 'principal-1',
    tenantId: 'tenant-1',
  });
});

test('fails closed for every invalid resolver state', async () => {
  assert.equal(await failureTag([]), 'PrincipalBindingMissingError');
  assert.equal(
    await failureTag([{ ...activeRecord, bindingStatus: 'revoked' }]),
    'PrincipalBindingInactiveError',
  );
  assert.equal(
    await failureTag([activeRecord, { ...activeRecord, tenantId: 'tenant-2' }]),
    'PrincipalBindingAmbiguousError',
  );
  assert.equal(
    await failureTag([{ ...activeRecord, principalStatus: 'disabled' }]),
    'PrincipalInactiveError',
  );
  assert.equal(
    await failureTag([{ ...activeRecord, tenantStatus: 'suspended' }]),
    'TenantInactiveError',
  );
});
