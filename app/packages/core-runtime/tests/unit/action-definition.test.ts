import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off
import test from 'node:test';
import { Effect, Schema } from 'effect';
import type { ActionHandlerContext } from '../../src/actions/context.ts';
import {
  decodeActionPayload,
  decodeActionResult,
  defineAction,
} from '../../src/actions/definition.ts';

const trustedContext = {
  authMethod: 'session',
  principalId: '00000000-0000-4000-8000-000000000002',
  tenantId: '00000000-0000-4000-8000-000000000001',
} as const;

const handlerContext = {
  principal: trustedContext,
} as ActionHandlerContext<Record<never, never>>;

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

test('keeps trusted principal context separate from and authoritative over payload data', async () => {
  let observedTenant = '';
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
      resultSchema: Schema.Finite,
      schemaVersion: '1',
    },
    (payload, context) => {
      observedTenant = context.principal.tenantId;
      return Effect.succeed(payload.amount);
    },
  );

  const payload = await Effect.runPromise(
    decodeActionPayload(registration.descriptor.payloadSchema, {
      amount: 2,
      tenantId: '00000000-0000-4000-8000-000000000099',
    }),
  );
  const result = await Effect.runPromise(registration.handler(payload, handlerContext));

  assert.deepEqual(payload, { amount: 2 });
  assert.equal(result, 2);
  assert.equal(observedTenant, trustedContext.tenantId);
});

test('rejects invalid declared results through a typed error', async () => {
  const error = await Effect.runPromise(
    Effect.flip(decodeActionResult(Schema.Struct({ id: Schema.String }), { id: 1 })),
  );

  assert.equal(error._tag, 'ActionResultValidationError');
  assert.equal(error.code, 'action_result_invalid');
});
