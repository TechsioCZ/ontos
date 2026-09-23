import type { ActionHandlerContext } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ReviseProductUnitPayloadSchema } from '../../shared/actions/revise-product-unit.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/commerce-catalog-product-unit-revised-v1.ts';
import type { reviseProductUnitAction } from '../../src/actions/revise-product-unit.action.ts';
import { handleReviseProductUnit } from '../../src/actions/revise-product-unit.action.ts';
import type { ProductUnitPersistence } from '../../src/persistence/product-unit-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const unit = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const payload = Schema.decodeUnknownSync(ReviseProductUnitPayloadSchema)({
  evidenceRefs: ['unit-revision-evidence'],
  expectedCurrent: { revision: 2, unit },
  reason: 'Correct conversion step',
  rule: { rounding: 'HALF_UP', step: '0.01' },
});
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:unit-revised-outbox:run:1',
    authMethod: 'system',
    principalId: '33333333-3333-4333-8333-333333333333',
    tenantId,
  }),
  correlationId: 'unit-revised-outbox-test',
};

const unexpected = () => Effect.die('Unexpected Product Unit operation');

const makeContext = (revise: ProductUnitPersistence['revise']) => {
  const events: { readonly eventType: string; readonly payloadJson: unknown; readonly reference: object }[] = [];
  const outbox: {
    readonly event: object;
    readonly message: { readonly payloadJson: unknown; readonly topic: string };
  }[] = [];
  const context: ActionHandlerContext<typeof reviseProductUnitAction.descriptor.domainEvents, ProductUnitPersistence> =
    {
      actionInvocationId: '44444444-4444-4444-8444-444444444444',
      addDomainEvent: (event) =>
        Effect.sync(() => {
          const reference = Object.create(null);
          events.push({ eventType: event.eventType, payloadJson: event.payloadJson, reference });
          return reference;
        }),
      addOutboxMessage: (event, message) =>
        Effect.sync(() => {
          outbox.push({ event, message });
        }),
      recordAuditEvidence: () => Effect.void,
      recordDataAccess: () => Effect.void,
      scope,
      services: { create: unexpected, retire: unexpected, revise, setTargetDivisibility: unexpected },
    };
  return { context, events, outbox };
};

describe('Product Unit committed revision event', () => {
  it.effect('links the message to the exact revised Unit source and resulting revision', () =>
    Effect.gen(function* revised() {
      const state = makeContext(() =>
        Effect.succeed({ _tag: 'revised', ruleRevision: { ...payload.rule, revision: 3, unit }, unit }),
      );
      const result = yield* handleReviseProductUnit(payload, state.context);
      expect(result.ruleRevision.revision).toBe(3);
      expect(state.events).toHaveLength(1);
      expect(state.events[0]).toMatchObject({
        eventType: 'commerce.catalog.product-unit-revised.v1',
        payloadJson: { revision: 3, tenantId, unit },
      });
      expect(state.outbox).toHaveLength(1);
      expect(state.outbox[0]?.event).toBe(state.events[0]?.reference);
      expect(state.outbox[0]?.message).toMatchObject({
        payloadJson: { revision: 3, tenantId, unit },
        topic: 'commerce.catalog.product-unit-revised.v1',
      });
    }),
  );

  it.effect('emits no committed fact for a rejected or inconsistent revision', () =>
    Effect.gen(function* rejected() {
      const stale = makeContext(() => Effect.succeed({ _tag: 'stale', actualRevision: 4 }));
      yield* handleReviseProductUnit(payload, stale.context).pipe(Effect.flip);
      expect(stale.events).toHaveLength(0);
      expect(stale.outbox).toHaveLength(0);

      const inconsistent = makeContext(() =>
        Effect.succeed({ _tag: 'revised', ruleRevision: { ...payload.rule, revision: 2, unit }, unit }),
      );
      yield* handleReviseProductUnit(payload, inconsistent.context).pipe(Effect.flip);
      expect(inconsistent.events).toHaveLength(0);
      expect(inconsistent.outbox).toHaveLength(0);
    }),
  );

  it('rejects a payload for the wrong Tenant or an invalid revision', () => {
    const valid = { revision: 3, tenantId, unit };
    expect(Schema.is(OutboxPayloadSchema)(valid)).toBe(true);
    expect(Schema.is(OutboxPayloadSchema)({ ...valid, tenantId: '55555555-5555-4555-8555-555555555555' })).toBe(false);
    expect(Schema.is(OutboxPayloadSchema)({ ...valid, revision: 0 })).toBe(false);
  });
});
