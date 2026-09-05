/* oxlint-disable sonarjs/no-undefined-assignment, typescript/strict-boolean-expressions */
// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { defineAction } from '../../src/actions/definition.ts';
import { ActionAlreadyCommitted } from '../../src/actions/errors.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { makeActionTestHarness } from '../../src/testing/actions.ts';

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:commit-recovery-test',
  authMethod: 'session',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '30000000-0000-4000-8000-000000000001',
} as const;

test('committed retry and explicit recovery return the same invocation without rerunning or replaying the result', async () => {
  let executions = 0;
  const registration = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.recovery.read.v1' },
      actionKey: 'test.recovery.execute',
      auditProfile: 'minimal',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'test.recovery.execute',
        moduleKey: 'test.recovery',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'test.recovery',
      payloadSchema: Schema.Struct({ amount: Schema.Finite }),
      policies: [],
      resultSchema: Schema.Struct({ total: Schema.Finite }),
      schemaVersion: '1',
    },
    (payload) =>
      Effect.sync(() => {
        executions += 1;
        return { total: payload.amount * executions };
      }),
  );
  const harness = makeActionTestHarness({ actionPermission: 'allowed' });
  const request = {
    payload: { amount: 2 },
    principal,
    registration,
    transport: { correlationId: 'commit-recovery-test', idempotencyKey: 'commit-once' },
  } as const;

  assert.deepEqual(await Effect.runPromise(harness.runtime.runAction(request)), { total: 2 });
  const invocationId = harness.snapshot().invocations[0]?.actionInvocationId;
  assert.ok(invocationId);
  const replay = await Effect.runPromise(harness.runtime.runAction(request).pipe(Effect.flip));
  const recovered = await Effect.runPromise(
    harness.runtime.resolveActionCommit({ invocationId, principal }).pipe(Effect.flip),
  );

  for (const outcome of [replay, recovered]) {
    assert.equal(outcome._tag, 'ActionAlreadyCommitted');
    assert.equal('invocationId' in outcome ? outcome.invocationId : undefined, invocationId);
    assert.equal('total' in outcome, false);
    assert.equal('result' in outcome, false);
  }
  assert.equal(executions, 1);
  assert.equal(harness.snapshot().committed.length, 1);
  assert.equal(harness.snapshot().transactionCount, 1);
});

test('committed error schema requires and preserves the recovery invocation identifier', async () => {
  const encoded = {
    _tag: 'ActionAlreadyCommitted',
    code: 'action_already_committed',
    invocationId: '40000000-0000-4000-8000-000000000001',
    reason: 'This idempotency key already committed successfully',
  } as const;
  const decoded = await Effect.runPromise(
    Schema.decodeUnknownEffect(ActionAlreadyCommitted)(encoded),
  );
  assert.deepEqual(
    await Effect.runPromise(Schema.encodeEffect(ActionAlreadyCommitted)(decoded)),
    encoded,
  );
  assert.equal(
    Schema.is(ActionAlreadyCommitted)({
      _tag: 'ActionAlreadyCommitted',
      code: 'action_already_committed',
      reason: 'This idempotency key already committed successfully',
    }),
    false,
  );
  assert.equal('result' in decoded, false);
  assert.equal('status' in decoded, false);
});

test('lost commit acknowledgement recovers the committed invocation and faults only once', async () => {
  let executions = 0;
  const registration = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.recovery.read.v1' },
      actionKey: 'test.recovery.acknowledgement',
      auditProfile: 'minimal',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'test.recovery.acknowledgement',
        moduleKey: 'test.recovery',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'test.recovery',
      payloadSchema: Schema.Void,
      policies: [],
      resultSchema: Schema.Finite,
      schemaVersion: '1',
    },
    () =>
      Effect.sync(() => {
        executions += 1;
        return executions;
      }),
  );
  const harness = makeActionTestHarness({
    actionPermission: 'allowed',
    commitAcknowledgement: 'indeterminate-once',
  });
  const request = {
    payload: undefined,
    principal,
    registration,
    transport: { correlationId: 'lost-acknowledgement', idempotencyKey: 'commit-once' },
  } as const;

  const uncertain = await Effect.runPromise(harness.runtime.runAction(request).pipe(Effect.flip));
  assert.equal(uncertain._tag, 'ActionCommitIndeterminate');
  assert.ok('invocationId' in uncertain);
  assert.equal(uncertain.invocationId, harness.snapshot().invocations[0]?.actionInvocationId);
  assert.equal(harness.snapshot().invocations[0]?.status, 'succeeded');

  const recovered = await Effect.runPromise(
    harness.runtime
      .resolveActionCommit({ invocationId: uncertain.invocationId, principal })
      .pipe(Effect.flip),
  );
  const replay = await Effect.runPromise(harness.runtime.runAction(request).pipe(Effect.flip));
  for (const outcome of [recovered, replay]) {
    assert.equal(outcome._tag, 'ActionAlreadyCommitted');
    assert.ok('invocationId' in outcome);
    assert.equal(outcome.invocationId, uncertain.invocationId);
  }
  assert.equal(executions, 1);
  assert.equal(harness.snapshot().committed.length, 1);
  assert.equal(harness.snapshot().transactionCount, 1);

  assert.equal(
    await Effect.runPromise(
      harness.runtime.runAction({
        ...request,
        transport: { correlationId: 'acknowledged-next', idempotencyKey: 'next-invocation' },
      }),
    ),
    2,
  );
  assert.equal(harness.snapshot().committed.length, 2);
});
