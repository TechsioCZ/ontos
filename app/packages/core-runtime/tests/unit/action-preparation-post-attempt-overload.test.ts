import { Clock, Context, Crypto, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  defineAction,
  getActionDecodedSuccessHook,
  getActionPostAttemptHook,
  getActionServiceFactory,
  getActionServicePreflight,
} from '../../src/actions/definition.ts';
import type {
  ActionDecodedSuccessHook,
  ActionPostAttemptHook,
  ActionPostAttemptResult,
  ActionServiceFactory,
  ActionServicePreflight,
} from '../../src/actions/definition.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { TenantIdSchema } from '../../src/access/ids.ts';

class HandlerSettings extends Context.Service<
  HandlerSettings,
  {
    readonly multiplier: number;
  }
>()('@app/core-runtime/tests/unit/action-preparation-post-attempt-overload.test/HandlerSettings') {}

const CounterRejectedSchema = Schema.TaggedStruct('CounterRejected', {
  code: Schema.Literal('counter_rejected'),
});
type CounterRejected = typeof CounterRejectedSchema.Type;

const payloadSchema = Schema.Struct({ amount: Schema.Finite });
const resultSchema = Schema.Struct({ tenantId: TenantIdSchema, total: Schema.Finite });
type Payload = typeof payloadSchema.Type;
type Result = typeof resultSchema.Type;
interface CounterServices {
  readonly increment: number;
  readonly tenantId: typeof TenantIdSchema.Type;
}

/** These factories retain the genuine transaction's tenant. No principal, scope or admission is fabricated. */
const serviceFactory: ActionServiceFactory<CounterServices> = (transaction) =>
  Effect.succeed({ increment: 0, tenantId: TenantIdSchema.make(transaction.scope.tenantId) });

const prepareServices: ActionServicePreflight<Payload, CounterServices, CounterRejected, Clock.Clock> = (payload) =>
  Effect.gen(function* prepareCounterServices() {
    const clock = yield* Clock.Clock;
    const preparedAt = yield* clock.currentTimeMillis;
    const preparedFactory: ActionServiceFactory<CounterServices> = (transaction) =>
      Effect.succeed({
        increment: payload.amount + preparedAt,
        tenantId: TenantIdSchema.make(transaction.scope.tenantId),
      });
    return preparedFactory;
  });

const onDecodedSuccess: ActionDecodedSuccessHook<Result, CounterServices, CounterRejected, Clock.Clock> = (context) =>
  Effect.gen(function* observeDecodedResult() {
    const clock = yield* Clock.Clock;
    const observedAt = yield* clock.currentTimeMillis;
    expect(context.result.tenantId).toBe(context.services.tenantId);
    expect(observedAt).toBeGreaterThanOrEqual(0);
  });

const onPostAttempt: ActionPostAttemptHook<Payload, Result, CounterRejected, Crypto.Crypto> = (context) =>
  Effect.gen(function* recordSettledAttempt() {
    const crypto = yield* Crypto.Crypto;
    const observationId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    expect(observationId).not.toBe(context.actionInvocationId);
    return yield* Effect.succeed<ActionPostAttemptResult<Result>>({ _tag: 'Settled' });
  });

/**
 * This is the public five-argument call that an owner needs to retain both remote preparation and
 * its post-attempt reconciliation. No explicit defineAction generics or registration casts hide
 * inference errors. Private accessors below verify the definition implementation stores both.
 */
const registration = defineAction(
  {
    accessDeclaration: {
      key: 'test.action-hooks.counter.change',
      kind: 'action',
      modes: ['run'],
      placement: { group: 'counter', level: 'basic' },
      risk: 'routine',
      selectors: [],
    },
    accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.action-hooks.counter.access.v1' },
    actionKey: 'test.action-hooks.change-counter',
    auditProfile: 'standard',
    domainErrorSchema: CounterRejectedSchema,
    domainEvents: {},
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'protected' },
      entrypointKey: 'test.action-hooks.change-counter',
      moduleKey: 'test.action-hooks',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'optional',
    owningModuleKey: 'test.action-hooks',
    payloadSchema,
    policies: [],
    resultSchema,
    schemaVersion: '1',
  },
  (payload, context) =>
    Effect.gen(function* changeCounter() {
      const settings = yield* HandlerSettings;
      if (payload.amount < 0) {
        return yield* Effect.fail(CounterRejectedSchema.make({ _tag: 'CounterRejected', code: 'counter_rejected' }));
      }
      return {
        tenantId: context.services.tenantId,
        total: payload.amount * settings.multiplier + context.services.increment,
      };
    }),
  serviceFactory,
  { onDecodedSuccess, prepareServices },
  onPostAttempt,
);

type Equivalent<Actual, Expected> = [Actual] extends [Expected] ? ([Expected] extends [Actual] ? true : false) : false;

// These are compile-time proofs as well as runtime assertions: dropping any requirement or
// widening the service/payload/result types makes the literal `true` assignment fail.
const exactRequirements: Equivalent<
  NonNullable<typeof registration._handlerRequirements>,
  HandlerSettings | Clock.Clock | Crypto.Crypto
> = true;
const exactServices: Equivalent<NonNullable<typeof registration._services>, CounterServices> = true;
const exactPayload: Equivalent<typeof registration.descriptor.payloadSchema.Type, Payload> = true;
const exactResult: Equivalent<typeof registration.descriptor.resultSchema.Type, Result> = true;
const exactDomainError: Equivalent<typeof registration.descriptor.domainErrorSchema.Type, CounterRejected> = true;

it('retains the real factory, preparation, decoded-success and post-attempt hooks in one opaque registration', () => {
  expect(getActionServiceFactory(registration)).toBe(serviceFactory);
  expect(getActionServicePreflight(registration)).toBe(prepareServices);
  expect(getActionDecodedSuccessHook(registration)).toBe(onDecodedSuccess);
  expect(getActionPostAttemptHook(registration)).toBe(onPostAttempt);
  expect(Object.isFrozen(registration)).toBe(true);
  expect(Object.isFrozen(registration.descriptor)).toBe(true);
  for (const key of ['prepareServices', 'onDecodedSuccess', 'onPostAttempt']) {
    expect(Object.hasOwn(registration, key)).toBe(false);
    expect(Object.hasOwn(registration.descriptor, key)).toBe(false);
  }
});

it('infers the exact services, contracts and all three independent effect requirements without a cast', () => {
  expect(exactRequirements).toBe(true);
  expect(exactServices).toBe(true);
  expect(exactPayload).toBe(true);
  expect(exactResult).toBe(true);
  expect(exactDomainError).toBe(true);
});
