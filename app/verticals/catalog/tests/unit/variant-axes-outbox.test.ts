import type { ActionHandlerContext } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { GovernVariantAxesPayloadSchema } from '../../shared/actions/govern-variant-axes.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/commerce-catalog-variant-axes-changed-v1.ts';
import { handleGovernVariantAxes } from '../../src/actions/govern-variant-axes.action.ts';
import type { governVariantAxesAction } from '../../src/actions/govern-variant-axes.action.ts';
import { VariantAxisWriteConflict } from '../../src/persistence/variant-axis-persistence.ts';
import type { VariantAxisPersistence } from '../../src/persistence/variant-axis-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:variant-axes-outbox:run:1',
    authMethod: 'system',
    principalId: '33333333-3333-4333-8333-333333333333',
    tenantId,
  }),
  correlationId: 'variant-axes-outbox-test',
};
const payload = {
  axes: [],
  classification: {
    evidenceRefs: ['catalog-axis-review-1'],
    kind: 'AXIS_REMOVAL',
    reason: 'Update distinguishing axes',
  },
  expectedAxisRevision: 1,
  productRef,
  reason: 'Update distinguishing axes',
} as const;
const unexpected = () => Effect.die('Unexpected persistence call');

const context = (govern: VariantAxisPersistence['govern']) => {
  const events: { eventType: string; payloadJson: unknown; reference: object; subjectResourceId: string }[] = [];
  const outbox: { event: object; message: { payloadJson: unknown; producerModuleKey: string; topic: string } }[] = [];
  const services: VariantAxisPersistence = {
    govern,
    governAllowedValues: unexpected,
    readCurrent: unexpected,
    readCurrentAllowedValues: unexpected,
    readEffectiveValues: unexpected,
    readRecordedCombinations: unexpected,
    readRecordedVariants: unexpected,
  };
  const value: ActionHandlerContext<
    typeof governVariantAxesAction.descriptor.domainEvents,
    VariantAxisPersistence & { readonly assessOpenSelectionImpact: () => Effect.Effect<void> }
  > = {
    actionInvocationId: '44444444-4444-4444-8444-444444444444',
    addDomainEvent: (event) =>
      Effect.sync(() => {
        const reference = Object.create(null);
        events.push({
          eventType: event.eventType,
          payloadJson: event.payloadJson,
          reference,
          subjectResourceId: event.subjectResourceId,
        });
        return reference;
      }),
    addOutboxMessage: (event, message) =>
      Effect.sync(() => {
        outbox.push({ event, message });
      }),
    recordAuditEvidence: () => Effect.void,
    recordDataAccess: () => Effect.void,
    scope,
    services: { ...services, assessOpenSelectionImpact: () => Effect.void },
  };
  return { events, outbox, value };
};

describe('committed Variant-axis change event', () => {
  it.effect('links one Product-source event and outbox message to a changed axis revision', () =>
    Effect.gen(function* changed() {
      const state = context(() => Effect.succeed({ axisRevision: 2, changed: true }));
      yield* handleGovernVariantAxes(payload, state.value);
      expect(state.events).toHaveLength(1);
      expect(state.events[0]).toMatchObject({
        eventType: 'commerce.catalog.variant-axes-changed.v1',
        payloadJson: { axisRevision: 2, productRef, tenantId },
        subjectResourceId: productRef.resourceId,
      });
      expect(state.outbox).toHaveLength(1);
      expect(state.outbox[0]?.event).toBe(state.events[0]?.reference);
      expect(state.outbox[0]?.message).toMatchObject({
        payloadJson: { axisRevision: 2, productRef, tenantId },
        producerModuleKey: 'commerce.catalog',
        topic: 'commerce.catalog.variant-axes-changed.v1',
      });
    }),
  );

  it.effect('publishes nothing when the governance call is unchanged or rejected', () =>
    Effect.gen(function* unchanged() {
      const noOp = context(() => Effect.succeed({ axisRevision: 1, changed: false }));
      yield* handleGovernVariantAxes(payload, noOp.value);
      expect(noOp.events).toHaveLength(0);
      expect(noOp.outbox).toHaveLength(0);

      const rejected = context(() =>
        Effect.fail(
          new VariantAxisWriteConflict({
            code: 'variant_axis_write_conflict',
            conflict: 'REVISION',
            reason: 'Stale axis revision',
          }),
        ),
      );
      yield* handleGovernVariantAxes(payload, rejected.value).pipe(Effect.flip);
      expect(rejected.events).toHaveLength(0);
      expect(rejected.outbox).toHaveLength(0);
    }),
  );

  it.effect('decodes legacy axes input but fails closed before persistence without change evidence', () =>
    Effect.gen(function* legacyAxesInput() {
      const state = context(unexpected);
      const failure = yield* handleGovernVariantAxes(
        Schema.decodeUnknownSync(GovernVariantAxesPayloadSchema)({
          axes: [],
          expectedAxisRevision: 1,
          productRef,
          reason: 'Legacy axis request',
        }),
        state.value,
      ).pipe(Effect.flip);
      expect(Schema.is(VariantAxisWriteConflict)(failure)).toBe(true);
      expect(failure).toMatchObject({ conflict: 'INVALID_INPUT' });
      expect(state.events).toHaveLength(0);
      expect(state.outbox).toHaveLength(0);
    }),
  );

  it.effect('fails closed before persistence when an axis allowance revision is absent', () =>
    Effect.gen(function* missingAllowanceRevision() {
      const state = context(unexpected);
      const failure = yield* handleGovernVariantAxes(
        Schema.decodeUnknownSync(GovernVariantAxesPayloadSchema)({
          axes: [
            {
              attributeDefinitionRef: {
                moduleId: 'commerce.catalog',
                resourceId: '55555555-5555-4555-8555-555555555555',
                resourceType: 'commerce.catalog.attribute-definition',
                tenantId,
              },
              definitionRevision: 1,
            },
          ],
          classification: {
            evidenceRefs: ['axis-review'],
            kind: 'AXIS_ADDITION',
            reason: 'Add evidenced axis',
          },
          expectedAxisRevision: 1,
          productRef,
          reason: 'Add evidenced axis',
        }),
        state.value,
      ).pipe(Effect.flip);
      expect(failure).toMatchObject({ conflict: 'INVALID_INPUT' });
      expect(state.events).toHaveLength(0);
      expect(state.outbox).toHaveLength(0);
    }),
  );

  it('rejects an event whose Product subject does not belong to its Tenant', () => {
    const valid = { axisRevision: 2, productRef, tenantId };
    expect(Schema.is(OutboxPayloadSchema)(valid)).toBe(true);
    expect(Schema.is(OutboxPayloadSchema)({ ...valid, tenantId: '55555555-5555-4555-8555-555555555555' })).toBe(false);
  });
});
