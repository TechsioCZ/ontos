import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { OutboxWorkerTenantScope } from '@app/core-runtime/outbox/worker';
import type { OutboxWorkerTenantScopeView } from '@app/core-runtime/outbox/worker';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Layer, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { OutboxPayloadSchema as ProviderObservationRecordedPayloadSchema } from '../../shared/outbox/communications-core-provider-observation-recorded-v1.ts';
import { IngestProviderObservationPayloadSchema } from '../../shared/provider-observation-ingest.ts';
import { ingestProviderObservationAction } from '../../src/actions/ingest-provider-observation.action.ts';
import type { ProviderObservationInput } from '../../src/domain/history/provider-observation.ts';
import {
  ProviderObservationIngest,
  ingestProviderObservationService,
} from '../../src/services/ingest-provider-observation.service.ts';
import { handleReconcileProviderEvidence } from '../../src/workers/reconcile-provider-evidence.worker.ts';
import { communicationsRegistration } from '../../vertical.registration.ts';
import { privacyNotAllowed } from '../unit/support/privacy-fixtures.ts';
import { decideOne, intentHistoryOf, targetOf } from '../support/history-world.ts';
import type { World } from '../support/history-world.ts';
import { handoffDouble } from '../support/intake-fixtures.ts';
import { intakeWorld } from '../support/intake-world.ts';
import { makeRuntimeDatabase, nativeServices, nextId } from '../support/persistence.fixture.ts';
import {
  answers,
  attemptsOf,
  conflictsOf,
  intentRowOf,
  kindOf,
  observationsOf,
  recoverableType,
  retryLinksOf,
  stepWith,
  recoveriesOf,
} from '../support/recovery-world.ts';
import { step22Double } from '../support/step22-observation-double.ts';

/**
 * [#1402 AC-03/04/05, #1403 D1/D5/AC-02, T2-09] The provider observation ingest THROUGH the public boundary of the Action
 * runtime, as the registered Messaging Adapter calls it, and the production entry of reconciliation: the self-outbox message the
 * Action queues, delivered to the owner's own worker. The evidence is the labelled step 22 double (no real provider, callback or
 * transport exists); the store is native PostgreSQL through the real scoped routines. Nothing here claims real delivery.
 */
const encode = Schema.encodeSync(IngestProviderObservationPayloadSchema);
const RECORDED_TOPIC = 'communications.core.provider-observation-recorded.v1';
/** The adapter is an integration principal that calls with its managed API key; its workload binding is the gate's concern. */
const adapterOf = (tenantId: string, principalId: string) => ({
  authBindingId: '99999999-9999-4999-8999-999999999999',
  authContextRef: 'api-key:fixture-messaging-adapter',
  authMethod: 'api_key' as const,
  principalId,
  tenantId,
});

const setup = (options: Parameters<typeof intakeWorld>[1] = {}) =>
  makeRuntimeDatabase().pipe(Effect.flatMap((database) => intakeWorld(database, options)));

/** The Messaging Adapter calling the PUBLIC Action; the Action's own service is the real one, over the world's native store. */
const boundary = Effect.fn('ObservationIngestTest.boundary')(function* adapterBoundary(world: World) {
  const principalId = yield* nextId;
  const observations = ProviderObservationIngest.of({
    ingest: (observation) =>
      world.database
        .inTenant(world.tenantId, (transaction) =>
          ingestProviderObservationService(transaction).pipe(
            Effect.flatMap((services) => services.observations.ingest(observation)),
          ),
        )
        .pipe(Effect.orDie),
  });
  const harness = yield* makeActionTestHarness({
    access: 'allowed',
    ownerRegistration: communicationsRegistration,
    services: [bindActionTestServices(ingestProviderObservationAction, { observations })],
  });
  let sequence = 0;
  const issue = (observation: ProviderObservationInput) => {
    sequence += 1;
    const key = `adapter-call-${String(sequence)}`;
    return harness.runtime
      .runAction({
        payload: encode(observation),
        principal: adapterOf(world.tenantId, principalId),
        registration: ingestProviderObservationAction,
        transport: { correlationId: key, idempotencyKey: key },
      })
      .pipe(Effect.provide(NodeCrypto.layer));
  };
  const queued = () =>
    harness
      .snapshot()
      .committed.flatMap(({ evidence }) => evidence.outboxMessages.map(({ message }) => message))
      .filter(({ topic }) => topic === RECORDED_TOPIC);
  return { issue, queued };
});

const submitted = Effect.fn('ObservationIngestTest.submitted')(function* submittedWith(
  answer: () =>
    | ReturnType<typeof answers.accepted>
    | ReturnType<typeof answers.timeout>
    | ReturnType<typeof answers.rateLimited>,
  options?: Parameters<typeof intakeWorld>[1],
) {
  const world = yield* setup(options ?? { types: [recoverableType()] });
  const handoff = handoffDouble(answer);
  const { intentId, requestId } = yield* decideOne(world);
  yield* stepWith(world, handoff, intentId);
  const [attempt] = yield* attemptsOf(world, intentId);
  const attemptId = attempt?.attemptId ?? '';
  return { attemptId, handoff, intentId, requestId, target: targetOf(world, intentId, attemptId), world };
});

const contextOf = (tenantId: string): OutboxWorkerHandlerContext =>
  attestOutboxWorkerHandlerContext({
    attemptNumber: 1,
    claimId: 'claim-1',
    compositionRevision: 'a'.repeat(64),
    consumerModuleKey: 'communications.core',
    deliveryId: 'delivery-1',
    domainEventId: 'event-1',
    legalEntityScope: 'forbidden',
    messageId: 'message-1',
    producerModuleKey: 'communications.core',
    tenantId,
    tenantSequenceNo: 1n,
    topic: RECORDED_TOPIC,
    workerKey: 'communications.core.reconcile-provider-evidence',
  });
const decodePayload = Schema.decodeUnknownSync(ProviderObservationRecordedPayloadSchema);
const at = (minutes: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 25, 10, minutes));

describe('the Messaging Adapter hands a provider observation to the public Action (#1402, T2-09)', () => {
  it.live('records an acceptance idempotently: the same event again is a duplicate and queues nothing more', () =>
    Effect.gen(function* acceptance() {
      const { intentId, requestId, target, world } = yield* submitted(answers.timeout);
      const adapter = yield* boundary(world);
      const observation = step22Double.acceptanceProven(
        target,
        { key: 'evt-accepted-1', observedAt: at(1) },
        'RECONCILIATION',
      );
      expect(yield* adapter.issue(observation)).toEqual({ outcome: 'RECORDED' });
      // a new key of the same event is no new evidence: the provider's own event identity makes it a duplicate
      expect(yield* adapter.issue(observation)).toEqual({ outcome: 'DUPLICATE' });
      expect((yield* observationsOf(world, intentId)).map(({ kind }) => kind)).toEqual(['ACCEPTANCE_PROVEN']);
      // ONE self-outbox message, carrying identities only, queued in the Action's own transaction for the reconciliation worker
      expect(adapter.queued()).toHaveLength(1);
      expect(adapter.queued()[0]?.payloadJson).toEqual({ attemptId: target.attemptId, intentId });
      const record = yield* intentHistoryOf(world, requestId);
      expect(record.history.summary).toMatchObject({ deliveryProven: false, providerAccepted: true });
      expect(record.history.summary.status).not.toBe('DELIVERED');
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('says DELIVERED only for a provider event the adapter proved, and keeps the acceptance beside it', () =>
    Effect.gen(function* delivered() {
      const { intentId, requestId, target, world } = yield* submitted(answers.accepted);
      const adapter = yield* boundary(world);
      expect((yield* intentHistoryOf(world, requestId)).history.summary).toMatchObject({
        deliveryProven: false,
        status: 'PROVIDER_ACCEPTED',
      });
      expect(
        yield* adapter.issue(step22Double.delivered(target, { key: 'evt-delivered-1', observedAt: at(5) })),
      ).toEqual({ outcome: 'RECORDED' });
      expect((yield* intentHistoryOf(world, requestId)).history.summary).toMatchObject({
        deliveryProven: true,
        providerAccepted: true,
        status: 'DELIVERED',
      });
      expect((yield* attemptsOf(world, intentId)).map(({ state }) => state)).toEqual(['ACCEPTED']);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('appends a late bounce after the acceptance: the acceptance stays and the history says FAILED', () =>
    Effect.gen(function* lateBounce() {
      const { intentId, requestId, target, world } = yield* submitted(answers.accepted);
      const adapter = yield* boundary(world);
      expect(yield* adapter.issue(step22Double.bounced(target, { key: 'evt-bounce-1', observedAt: at(30) }))).toEqual({
        outcome: 'RECORDED',
      });
      const record = yield* intentHistoryOf(world, requestId);
      expect(record.history.summary).toMatchObject({ providerAccepted: true, status: 'FAILED' });
      expect((yield* observationsOf(world, intentId)).map(({ kind }) => kind)).toEqual(['DELIVERY_FAILED']);
      // the attempt itself was never edited: the acceptance is the history of what the provider said then
      expect((yield* attemptsOf(world, intentId)).map(({ state }) => state)).toEqual(['ACCEPTED']);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'keeps contradictory evidence INDETERMINATE and never prefers a side; the same event with another content is a conflict',
    () =>
      Effect.gen(function* contradiction() {
        const { handoff, intentId, requestId, target, world } = yield* submitted(answers.accepted);
        const adapter = yield* boundary(world);
        expect(
          yield* adapter.issue(step22Double.nonAcceptanceProven(target, { key: 'recon-1', observedAt: at(10) })),
        ).toEqual({ outcome: 'RECORDED' });
        expect((yield* intentHistoryOf(world, requestId)).history.summary).toMatchObject({
          contradictory: true,
          status: 'INDETERMINATE',
        });
        // the same identity with another claimed content: the first stays untouched, the disagreement is a trace
        expect(
          yield* adapter.issue(step22Double.nonAcceptanceProven(target, { key: 'recon-1', observedAt: at(11) })),
        ).toEqual({ outcome: 'CONFLICT' });
        expect(yield* conflictsOf(world, intentId)).toHaveLength(1);
        expect(adapter.queued()).toHaveLength(1);
        // nothing is ever sent again because of evidence
        expect(kindOf(yield* stepWith(world, handoff, intentId))).toMatch(/^SKIPPED:/u);
        expect(handoff.calls).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('answers UNBOUND for a Tenant it does not belong to and records nothing', () =>
    Effect.gen(function* foreignTenant() {
      const { intentId, target, world } = yield* submitted(answers.accepted);
      const adapter = yield* boundary(world);
      const claimed = step22Double.delivered(
        { ...target, tenantId: yield* nextId },
        { key: 'evt-foreign', observedAt: at(2) },
      );
      expect(yield* adapter.issue(claimed)).toEqual({ outcome: 'UNBOUND' });
      expect(yield* observationsOf(world, intentId)).toEqual([]);
      expect(adapter.queued()).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});

/** One delivery of the queued message to the worker, with the adapter double that would answer a continuation. */
const deliver = (
  world: World,
  payload: { attemptId: string; intentId: string },
  next: ReturnType<typeof handoffDouble>,
) => {
  const tenantScope = {
    run: <Failure, Requirements>(
      context: OutboxWorkerHandlerContext,
      observe: (scope: OutboxWorkerTenantScopeView) => Effect.Effect<void, Failure, Requirements>,
    ) =>
      world.database
        .inTenant(context.tenantId, (transaction) =>
          observe({
            completionPublisher: { publish: () => Effect.die('Completion belongs to Core delivery') },
            readOriginalActionInvocation: () => Effect.succeed(Option.none()),
            readWorkloadPrincipalEligibility: () => Effect.die('Not used by this worker'),
            routineInvoker: transaction,
            tenantId: context.tenantId,
          }),
        )
        .pipe(Effect.orDie),
  };
  return Effect.suspend(() => handleReconcileProviderEvidence(decodePayload(payload), contextOf(world.tenantId))).pipe(
    Effect.provideService(OutboxWorkerTenantScope, tenantScope),
    Effect.provide(Layer.mergeAll(world.portsFor(world.types), next.layer, NodeCrypto.layer)),
  );
};

describe('the recorded observation reaches reconciliation through the owner worker (#1403, T2-09)', () => {
  it.live(
    'an INDETERMINATE attempt is reconciled and the SAME intent continues only after a proven non-acceptance and a fresh gate pass',
    () =>
      Effect.gen(function* unblocks() {
        const { attemptId, handoff, intentId, target, world } = yield* submitted(answers.timeout);
        const adapter = yield* boundary(world);
        const next = handoffDouble(answers.accepted);
        const payload = { attemptId, intentId };
        const before = yield* intentRowOf(world, intentId);
        // an unknown effect blocks: a delivery of the worker before any proof sends nothing and burns no attempt
        yield* deliver(world, payload, next);
        expect(next.calls).toEqual([]);
        expect((yield* attemptsOf(world, intentId)).map(({ state }) => state)).toEqual(['INDETERMINATE']);
        // the adapter proves the provider did NOT accept it: that is recorded and queues the reconciliation
        expect(
          yield* adapter.issue(step22Double.nonAcceptanceProven(target, { key: 'recon-1', observedAt: at(3) })),
        ).toEqual({ outcome: 'RECORDED' });
        const gatesBefore = world.privacy.queries.length;
        yield* deliver(world, payload, next);
        // the SAME intent continued: attempt 2, linked to the proof, after Privacy was asked AGAIN
        expect(next.calls).toHaveLength(1);
        expect(
          (yield* attemptsOf(world, intentId)).map(({ attemptNumber, state }) => `${String(attemptNumber)}:${state}`),
        ).toEqual(['1:INDETERMINATE', '2:ACCEPTED']);
        expect(yield* retryLinksOf(world, intentId)).toMatchObject([{ basisKind: 'RECONCILED_NON_ACCEPTANCE' }]);
        expect(world.privacy.queries.length).toBeGreaterThan(gatesBefore);
        expect(yield* intentRowOf(world, intentId)).toEqual(before);
        // the first provider call was never repeated blindly, and an accepted retry is never sent again
        expect(handoff.calls).toHaveLength(1);
        yield* deliver(world, payload, next);
        expect(next.calls).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    'a proven non-acceptance does not override a Current gate: Privacy NOT_ALLOWED after the proof sends nothing',
    () =>
      Effect.gen(function* stoppedByGate() {
        const { attemptId, intentId, target, world } = yield* submitted(answers.timeout);
        const adapter = yield* boundary(world);
        const next = handoffDouble(answers.accepted);
        yield* adapter.issue(step22Double.nonAcceptanceProven(target, { key: 'recon-1', observedAt: at(3) }));
        world.privacy.answers.set('customer-1', privacyNotAllowed());
        yield* deliver(world, { attemptId, intentId }, next);
        expect(next.calls).toEqual([]);
        expect((yield* attemptsOf(world, intentId)).map(({ state }) => state)).toEqual(['INDETERMINATE']);
        expect(yield* recoveriesOf(world, intentId)).toMatchObject([
          { outcome: 'STOPPED', proven: true, reasons: [{ category: 'PRIVACY_NOT_ALLOWED' }] },
        ]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('a proven acceptance sends nothing, however often the message is delivered', () =>
    Effect.gen(function* acceptedStaysAccepted() {
      const { attemptId, intentId, target, world } = yield* submitted(answers.timeout);
      const adapter = yield* boundary(world);
      const next = handoffDouble(answers.accepted);
      yield* adapter.issue(
        step22Double.acceptanceProven(target, { key: 'recon-2', observedAt: at(4) }, 'RECONCILIATION'),
      );
      for (let delivery = 0; delivery < 3; delivery += 1) {
        yield* deliver(world, { attemptId, intentId }, next);
      }
      expect(next.calls).toEqual([]);
      expect(yield* attemptsOf(world, intentId)).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
