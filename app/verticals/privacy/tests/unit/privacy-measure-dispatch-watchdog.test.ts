import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { PrivacyMeasureHandoffSchema } from '../../shared/domain/privacy-measure-handoff.ts';
import {
  handlePrivacyMeasureDispatch,
  PrivacyMeasureDispatchRejected,
} from '../../src/workers/privacy-measure-dispatch.worker.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const context: OutboxWorkerHandlerContext = {
  attemptNumber: 1,
  claimId: 'claim-1',
  compositionRevision: 'test-composition',
  consumerModuleKey: 'privacy.core',
  deliveryId: 'delivery-1',
  domainEventId: 'event-1',
  messageId: '40000000-0000-4000-8000-000000000004',
  producerModuleKey: 'privacy.core',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'privacy.measure.dispatched',
  workerKey: 'privacy.core.privacy-measure-dispatch',
};
/** TEST-only references; no real measure, subject or decision. */
const communicationsHandoff = Schema.decodeUnknownSync(PrivacyMeasureHandoffSchema)({
  contentScopeRefs: ['communications.core.history'],
  controllerObligationRef: 'TEST:obligation',
  dispositionDecision: 'DELETE',
  expectedEvidenceRefs: ['TEST:receipt'],
  idempotencyKey: 'TEST:handoff:1',
  kind: 'DELETE',
  measureId: 'TEST:measure:1',
  ownerScope: {
    controllerRef: 'TEST:controller',
    requestedScopePartRefs: ['communications.core.history'],
    requestedScopeRef: 'TEST:scope',
    trustedLookups: [
      {
        _tag: 'SUBJECT_REFERENCE',
        lookupRef: 'TEST:lookup',
        moduleId: 'party.registry',
        resourceId: 'party-1',
        resourceType: 'party',
      },
    ],
  },
  owningCapability: 'communications.core',
  preconditionRefs: ['TEST:decision'],
  requestedAt: '2026-10-23T09:00:00.000Z',
  requestedResult: 'ERASED',
  resourceRefs: ['communications.core.intent:i1'],
  right: 'ERASURE',
  sourceDecisionRef: 'TEST:decision',
  sourceDecisionRevision: 1,
  subjectRef: 'TEST:subject',
  taskId: 'TEST:task',
  tenantId,
});

it.effect('routes a Communications measure: the watchdog records no unsupported owner and claims no execution', () =>
  Effect.gen(function* communicationsRoutable() {
    const exit = yield* Effect.exit(handlePrivacyMeasureDispatch({ handoff: communicationsHandoff }, context));
    expect(Exit.isSuccess(exit)).toBe(true);
  }),
);

it.effect('still rejects an owner no consumer is registered for, and a delivery of another Tenant', () =>
  Effect.gen(function* stillRejects() {
    const unknownOwner = yield* Effect.flip(
      handlePrivacyMeasureDispatch(
        { handoff: { ...communicationsHandoff, owningCapability: 'fixture.unregistered-owner' } },
        context,
      ),
    );
    expect(Schema.is(PrivacyMeasureDispatchRejected)(unknownOwner)).toBe(true);
    expect(unknownOwner.code).toBe('LAUNCH_OWNER_UNSUPPORTED');
    const foreignTenant = yield* Effect.flip(
      handlePrivacyMeasureDispatch(
        { handoff: communicationsHandoff },
        { ...context, tenantId: '90000000-0000-4000-8000-000000000009' },
      ),
    );
    expect(foreignTenant.code).toBe('DISPATCH_CONTEXT_INVALID');
  }),
);
