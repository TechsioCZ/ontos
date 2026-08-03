import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off
import test from 'node:test';
import { Effect, Schema } from 'effect';
import {
  decodeActionPayload,
  decodeActionResult,
  defineAction,
} from '../../src/actions/definition.ts';
import { defineGlobalPolicy, defineMicroverticalPolicy } from '../../src/actions/policy.ts';

test('defines an immutable typed descriptor and decodes typed payloads and results', async () => {
  const registration = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.change',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      idempotency: 'required',
      owningModuleKey: 'shell.core',
      payloadSchema: Schema.Struct({ amount: Schema.Finite }),
      policies: [],
      resultSchema: Schema.Struct({ total: Schema.Finite }),
      schemaVersion: '1',
    },
    (payload) => Effect.succeed({ total: payload.amount }),
  );

  const payload = await Effect.runPromise(
    decodeActionPayload(registration.descriptor.payloadSchema, { amount: 4 }),
  );
  const result = await Effect.runPromise(
    decodeActionResult(registration.descriptor.resultSchema, { total: payload.amount }),
  );

  assert.deepEqual(payload, { amount: 4 });
  assert.deepEqual(result, { total: 4 });
  assert.equal(Object.isFrozen(registration), true);
  assert.equal(Object.isFrozen(registration.descriptor), true);
  assert.equal(Object.isFrozen(registration.descriptor.policies), true);
});

test('uses Schema.Void for a no-payload Action', async () => {
  const registration = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'cache.read.v1' },
      actionKey: 'shell.cache.refresh',
      auditProfile: 'minimal',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      idempotency: 'optional',
      owningModuleKey: 'shell.core',
      payloadSchema: Schema.Void,
      policies: [],
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () => Effect.void,
  );

  const payload = await Effect.runPromise(
    // eslint-disable-next-line unicorn/no-useless-undefined -- Explicitly proves the Schema.Void payload contract.
    decodeActionPayload(registration.descriptor.payloadSchema, undefined),
  );
  const invalid = await Effect.runPromise(
    Effect.flip(decodeActionPayload(registration.descriptor.payloadSchema, {})),
  );

  assert.equal(payload, undefined);
  assert.equal(invalid._tag, 'ActionPayloadValidationError');
});

test('keeps the private handler outside the public Action registration', () => {
  const registration = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.change',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      idempotency: 'required',
      owningModuleKey: 'shell.core',
      payloadSchema: Schema.Struct({ amount: Schema.Finite }),
      policies: [],
      resultSchema: Schema.Finite,
      schemaVersion: '1',
    },
    (payload) => Effect.succeed(payload.amount),
  );

  assert.equal('handler' in registration, false);
  assert.deepEqual(Object.keys(registration), ['descriptor']);
});

test('rejects invalid declared results through a typed error', async () => {
  const error = await Effect.runPromise(
    Effect.flip(decodeActionResult(Schema.Struct({ id: Schema.String }), { id: 1 })),
  );

  assert.equal(error._tag, 'ActionResultValidationError');
  assert.equal(error.code, 'action_result_invalid');
});

test('accepts global and same-owner Policy references and copies the collection', () => {
  const globalPolicy = defineGlobalPolicy<{ readonly amount: number }>({
    evaluate: () => Effect.void,
    policyKey: 'global.tenant-active.v1',
  });
  const modulePolicy = defineMicroverticalPolicy<{ readonly amount: number }, 'inventory.stock'>({
    evaluate: () => Effect.void,
    owningModuleKey: 'inventory.stock',
    policyKey: 'inventory.stock.available.v1',
  });
  const policies = [globalPolicy, modulePolicy];
  const registration = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'stock.read.v1' },
      actionKey: 'inventory.stock.reserve',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      idempotency: 'required',
      owningModuleKey: 'inventory.stock',
      payloadSchema: Schema.Struct({ amount: Schema.Finite }),
      policies,
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () => Effect.void,
  );

  policies.pop();
  assert.deepEqual(registration.descriptor.policies, [globalPolicy, modulePolicy]);
  assert.equal(Object.isFrozen(registration.descriptor.policies), true);
  assert.equal(registration.descriptor.policies[0], globalPolicy);
  assert.equal(registration.descriptor.policies[1], modulePolicy);
});

test('rejects cross-owner, string, copied, and missing Policy references at definition time', () => {
  const foreignPolicy = defineMicroverticalPolicy<unknown, 'billing.invoice'>({
    evaluate: () => Effect.void,
    owningModuleKey: 'billing.invoice',
    policyKey: 'billing.invoice.open.v1',
  });
  const descriptor = {
    accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'stock.read.v1' },
    actionKey: 'inventory.stock.reserve',
    auditProfile: 'standard',
    domainErrorSchema: Schema.Never,
    domainEvents: {},
    idempotency: 'required',
    owningModuleKey: 'inventory.stock',
    payloadSchema: Schema.Struct({ amount: Schema.Finite }),
    resultSchema: Schema.Void,
    schemaVersion: '1',
  } as const;
  const incompatiblePayloadPolicy = defineGlobalPolicy<{ readonly sku: string }>({
    evaluate: () => Effect.void,
    policyKey: 'global.sku-required.v1',
  });
  const compileOnlyInvalidReferences = () => {
    defineAction(
      {
        ...descriptor,
        // @ts-expect-error Policy payload input must accept the decoded Action payload.
        policies: [incompatiblePayloadPolicy],
      },
      () => Effect.void,
    );
    defineAction(
      {
        ...descriptor,
        // @ts-expect-error Raw Policy keys are not Policy object references.
        policies: ['inventory.stock.available.v1'],
      },
      () => Effect.void,
    );
  };

  assert.throws(() =>
    defineAction(
      {
        ...descriptor,
        // @ts-expect-error A foreign MicroVertical Policy is rejected by the owner contract.
        policies: [foreignPolicy],
      },
      () => Effect.void,
    ),
  );
  assert.equal(typeof compileOnlyInvalidReferences, 'function');
  assert.throws(() =>
    defineAction(
      { ...descriptor, policies: ['inventory.stock.available.v1'] } as never,
      () => Effect.void,
    ),
  );
  assert.throws(() =>
    defineAction({ ...descriptor, policies: [{ ...foreignPolicy }] } as never, () => Effect.void),
  );
  assert.throws(() => defineAction(descriptor as never, () => Effect.void));
});
