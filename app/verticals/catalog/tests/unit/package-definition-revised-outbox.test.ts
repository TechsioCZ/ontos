import type { ActionHandlerContext } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { RevisePackageDefinitionPayloadSchema } from '../../shared/actions/revise-package-definition.ts';
import { PackageDefinitionSelectionRevisionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/commerce-catalog-package-definition-revised-v1.ts';
import { PackageDefinitionRefSchema } from '../../shared/resources/package-definition.ts';
import type { revisePackageDefinitionAction } from '../../src/actions/revise-package-definition.action.ts';
import { handleRevisePackageDefinition } from '../../src/actions/revise-package-definition.action.ts';
import type { PackagePersistence } from '../../src/persistence/package-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const definitionRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.package-definition',
  tenantId,
} as const;
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const effectiveAt = '2026-10-01T10:00:00.000Z';
const payload = Schema.decodeUnknownSync(RevisePackageDefinitionPayloadSchema)({
  changeKind: 'physical_change',
  content: { amount: '12', effectiveAt, form: { productRef, variantRef }, unitRef },
  evidenceRefs: ['supplier-package-confirmation'],
  expectedCurrent: { resourceRef: definitionRef, revision: 1 },
  reason: 'Confirmed new pack quantity',
});
const trustedRef = Schema.decodeUnknownSync(PackageDefinitionRefSchema)(definitionRef);
const revision = Schema.decodeUnknownSync(PackageDefinitionSelectionRevisionSchema)({
  resourceRef: definitionRef,
  revision: 2,
});
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:package-event:run:1',
    authMethod: 'system',
    principalId: '66666666-6666-4666-8666-666666666666',
    tenantId,
  }),
  correlationId: 'package-event-test',
};
const unexpected = () => Effect.die('Unexpected persistence call');
const context = (revise: PackagePersistence['revise']) => {
  const events: { eventType: string; payloadJson: unknown; reference: object; subjectResourceId: string }[] = [];
  const outbox: { event: object; message: { payloadJson: unknown; producerModuleKey: string; topic: string } }[] = [];
  const value: ActionHandlerContext<typeof revisePackageDefinitionAction.descriptor.domainEvents, PackagePersistence> =
    {
      actionInvocationId: '77777777-7777-4777-8777-777777777777',
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
      services: { create: unexpected, retire: unexpected, revise },
    };
  return { events, outbox, value };
};

describe('Package Definition committed revision event', () => {
  it.effect('links one message to the exact committed successor revision without claiming it is Current', () =>
    Effect.gen(function* revisedEvent() {
      const state = context(() =>
        Effect.succeed({ _tag: 'revised', contentRevision: revision, definitionRef: trustedRef }),
      );
      yield* handleRevisePackageDefinition(payload, state.value);
      expect(state.events).toHaveLength(1);
      expect(state.events[0]?.eventType).toBe('commerce.catalog.package-definition-revised.v1');
      expect(state.events[0]?.subjectResourceId).toBe(definitionRef.resourceId);
      expect(state.outbox).toHaveLength(1);
      expect(state.outbox[0]?.event).toBe(state.events[0]?.reference);
      expect(state.outbox[0]?.message).toMatchObject({
        payloadJson: {
          changeKind: 'physical_change',
          contentRevision: revision,
          definitionRef: trustedRef,
          effectiveAt,
          tenantId,
        },
        producerModuleKey: 'commerce.catalog',
        topic: 'commerce.catalog.package-definition-revised.v1',
      });
      expect(Object.keys(state.outbox[0]?.message.payloadJson ?? {})).not.toContain('currentAtCommit');
    }),
  );

  it.effect('emits no completed-change event for a rejected revision', () =>
    Effect.gen(function* rejectedRevision() {
      const state = context(() => Effect.succeed({ _tag: 'stale', actualRevision: 3 }));
      yield* handleRevisePackageDefinition(payload, state.value).pipe(Effect.flip);
      expect(state.events).toHaveLength(0);
      expect(state.outbox).toHaveLength(0);
    }),
  );

  it('requires an exact tenant and matching Package Definition revision in the published payload', () => {
    const valid = {
      changeKind: 'physical_change',
      contentRevision: revision,
      definitionRef: trustedRef,
      effectiveAt,
      tenantId,
    };
    expect(Schema.is(OutboxPayloadSchema)(valid)).toBe(true);
    expect(Schema.is(OutboxPayloadSchema)({ ...valid, tenantId: productRef.resourceId })).toBe(false);
    expect(
      Schema.is(OutboxPayloadSchema)({ ...valid, contentRevision: { ...revision, resourceRef: productRef } }),
    ).toBe(false);
  });
});
