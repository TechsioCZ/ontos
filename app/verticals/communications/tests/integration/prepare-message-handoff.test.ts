import { findPostgresFailure, loadDatabaseConnectionPair } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { Effect, Exit, Layer, Match, Option, Redacted, Ref } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { HandoffStoreUnavailable, processIntentHandoff } from '../../src/handoff/process-intent-handoff.ts';
import type { HandoffProcessing, ScopedRunner } from '../../src/handoff/process-intent-handoff.ts';
import {
  communicationDecisions,
  communicationRequestConflicts,
  communicationRequests,
  deliveryAttempts,
  intentHandoffStops,
  messageIntents,
} from '../../src/database/schema.ts';
import { attemptIdOf } from '../../src/domain/intake/identity.ts';
import { workerBeginAttemptRoutine } from '../../src/persistence/communications-routines.ts';
import { DeliveryAttemptIdSchema, MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import { MessageHandoff, unavailableMessageHandoffLayer } from '../../src/domain/handoff/message-handoff.ts';
import type { PinnedHandoff } from '../../src/domain/handoff/message-handoff.ts';
import {
  deactivateRevision,
  invalidateRevisionAsUnsafe,
  resolveTemplatePin,
} from '../../src/services/template-revision-domain.service.ts';
import { setLanguageMode } from '../../src/services/language-policy-domain.service.ts';
import { fixtureType } from '../unit/support/catalog-fixtures.ts';
import { privacyAllowed, privacyIndeterminate, privacyNotAllowed } from '../unit/support/privacy-fixtures.ts';
import { ORIGINAL_ADDRESS, unusable } from '../unit/support/recipient-fixtures.ts';
import { handoffDouble } from '../support/intake-fixtures.ts';
import { decided, intakeWorld, requestFor, templateBase } from '../support/intake-world.ts';
import { actorWith, makeRuntimeDatabase, nativeServices } from '../support/persistence.fixture.ts';

/**
 * The pre-handoff step of a Message Intent on native PostgreSQL as the runtime role, through the REAL scoped routines the
 * Outbox worker uses (the worker holds no table access). The owner edges and the Messaging Adapter are labelled test
 * doubles; the double of the adapter records every call, so "no second external attempt" is a measured fact.
 */

const setup = (options: Parameters<typeof intakeWorld>[1] = {}) =>
  makeRuntimeDatabase().pipe(Effect.flatMap((database) => intakeWorld(database, options)));

type World = Effect.Success<ReturnType<typeof setup>>;

const scopedIn =
  (world: World): ScopedRunner =>
  (program) =>
    world.database
      .inTenant(world.tenantId, (transaction) => program(transaction))
      .pipe(
        Effect.mapError((failure) =>
          Match.value(failure).pipe(
            Match.tag('HandoffStoreUnavailable', (known) => known),
            Match.orElse(() => new HandoffStoreUnavailable({ reason: 'test database' })),
          ),
        ),
      );

/** A scoped runner of one delivery: the second scoped program (the evidence) can be made to fail, as a crash would. */
const runnerFailingAt = (world: World, failingProgram: number): ScopedRunner => {
  let count = 0;
  const real = scopedIn(world);
  return (program) =>
    Effect.suspend(() => {
      count += 1;
      return count === failingProgram
        ? Effect.fail(new HandoffStoreUnavailable({ reason: 'injected crash before the evidence was recorded' }))
        : real(program);
    });
};

const workerLayers = (world: World, handoff: ReturnType<typeof handoffDouble>, types = world.types) =>
  Layer.mergeAll(world.portsFor(types), handoff.layer, NodeCrypto.layer);

const step = (
  world: World,
  handoff: ReturnType<typeof handoffDouble>,
  intentId: typeof MessageIntentIdSchema.Type,
  scoped: ScopedRunner = scopedIn(world),
  types = world.types,
) =>
  processIntentHandoff({ intentId, tenantId: world.tenantId }, scoped).pipe(
    Effect.provide(workerLayers(world, handoff, types)),
  );

const decidedIntent = Effect.fn('PrepareHandoffTest.decidedIntent')(function* decideOne(world: World) {
  const run = yield* world.runner.submit(world.tenantId, requestFor(world.tenantId));
  const result = decided(run);
  const [intent] = result.decision.kind === 'MESSAGE_INTENTS' ? result.decision.intents : [];
  if (intent === undefined) {
    return yield* Effect.die('the fixture request must decide one intent');
  }
  return intent.intentId;
});

const rowsOf = <Row>(
  world: World,
  select: (
    transaction: Parameters<Parameters<World['database']['inTenant']>[1]>[0],
  ) => Effect.Effect<readonly Row[], unknown>,
) => world.database.inTenant(world.tenantId, select);

const kindOf = (processing: HandoffProcessing) =>
  processing.kind === 'SKIPPED' ? `${processing.kind}:${processing.reason}` : processing.kind;

describe('Pre-handoff step of a Message Intent (#1401)', () => {
  it.live(
    '[AC-01 AC-05] hands the pinned intent off once: ORIGINAL endpoint, pinned revision, evidence bound to the attempt',
    () =>
      Effect.gen(function* happyPath() {
        const world = yield* setup();
        const handoff = handoffDouble();
        const intentId = yield* decidedIntent(world);
        const outcome = yield* step(world, handoff, intentId);
        expect(outcome.kind).toBe('HANDED_OFF');
        expect(handoff.calls).toHaveLength(1);
        const [call] = handoff.calls;
        expect(call).toMatchObject({ intentId, language: 'cs', purpose: 'fixture.single', tenantId: world.tenantId });
        expect(call?.template).toMatchObject({ language: 'cs', revisionNumber: 1 });
        // the usable address exists only in memory, as a protected value, for this one call
        expect(Redacted.value(call?.endpoint.value ?? Redacted.make(''))).toBe(ORIGINAL_ADDRESS);
        expect(Redacted.isRedacted(call?.endpoint.value)).toBe(true);
        const [attempt] = yield* rowsOf(world, (tx) => tx.select().from(deliveryAttempts));
        expect(attempt).toMatchObject({ attemptNumber: 1, intentId, state: 'ACCEPTED' });
        expect(attempt?.attemptId).toBe(call?.attemptId);
        expect(attempt?.evidence).toMatchObject({ kind: 'ACCEPTED', providerKey: 'fixture-provider' });
        // no stored table holds the address
        const everything = JSON.stringify([
          yield* rowsOf(world, (tx) => tx.select().from(messageIntents)),
          yield* rowsOf(world, (tx) => tx.select().from(deliveryAttempts)),
        ]);
        expect(everything).not.toContain(ORIGINAL_ADDRESS);
        // the Current gates were asked about the ORIGINAL contact only
        expect(world.recipientAuthority.queries.map((query) => query.contact.contactRef.resourceId)).toEqual([
          'contact-customer-1',
          'contact-customer-1',
        ]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-02 S09] a duplicate delivery after the handoff finds the finished attempt and never calls out again',
    () =>
      Effect.gen(function* duplicateDelivery() {
        const world = yield* setup();
        const handoff = handoffDouble();
        const intentId = yield* decidedIntent(world);
        expect((yield* step(world, handoff, intentId)).kind).toBe('HANDED_OFF');
        const again = yield* step(world, handoff, intentId);
        expect(kindOf(again)).toBe('SKIPPED:ALREADY_FINISHED');
        expect(handoff.calls).toHaveLength(1);
        expect(yield* rowsOf(world, (tx) => tx.select().from(deliveryAttempts))).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('[AC-02 S10] two workers on one intent make at most one external attempt', () =>
    Effect.gen(function* parallelWorkers() {
      const world = yield* setup();
      const handoff = handoffDouble(() =>
        Effect.yieldNow.pipe(
          Effect.as({ kind: 'ACCEPTED', providerKey: 'fixture-provider', providerRef: 'r-1' } as const),
        ),
      );
      const intentId = yield* decidedIntent(world);
      const outcomes = yield* Effect.all([step(world, handoff, intentId), step(world, handoff, intentId)], {
        concurrency: 2,
      });
      expect(handoff.calls).toHaveLength(1);
      expect(outcomes.map((outcome) => outcome.kind).toSorted()).toEqual(['HANDED_OFF', 'SKIPPED']);
      expect(yield* rowsOf(world, (tx) => tx.select().from(deliveryAttempts))).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-02 S12] a crash after the provider call but before the evidence leaves the attempt unresolved: no blind resend',
    () =>
      Effect.gen(function* crashAfterCall() {
        const world = yield* setup();
        const handoff = handoffDouble();
        const intentId = yield* decidedIntent(world);
        // program 1 reads and gates, program 2 commits the attempt, the provider is called, program 3 (the evidence) dies: the worker crashed
        const crashed = yield* Effect.exit(step(world, handoff, intentId, runnerFailingAt(world, 3)));
        expect(Exit.isFailure(crashed)).toBe(true);
        expect(handoff.calls).toHaveLength(1);
        const [prepared] = yield* rowsOf(world, (tx) => tx.select().from(deliveryAttempts));
        expect(prepared).toMatchObject({ state: 'PREPARED' });
        // Core delivers the message again: the intent stays unresolved and nothing is sent a second time
        const redelivered = yield* step(world, handoff, intentId);
        expect(kindOf(redelivered)).toBe('SKIPPED:RECONCILIATION_REQUIRED');
        expect(handoff.calls).toHaveLength(1);
        expect(yield* rowsOf(world, (tx) => tx.select().from(deliveryAttempts))).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-02 S12] an unknown provider result is recorded as INDETERMINATE and a retry makes no new external attempt',
    () =>
      Effect.gen(function* unknownResult() {
        const world = yield* setup();
        const handoff = handoffDouble(() => Effect.succeed({ kind: 'INDETERMINATE', reason: 'timeout' } as const));
        const intentId = yield* decidedIntent(world);
        const first = yield* step(world, handoff, intentId);
        expect(first).toMatchObject({
          evidence: { outcome: { kind: 'INDETERMINATE', reason: 'timeout' } },
          kind: 'HANDED_OFF',
        });
        const retry = yield* step(world, handoff, intentId);
        expect(kindOf(retry)).toBe('SKIPPED:ALREADY_FINISHED');
        expect(handoff.calls).toHaveLength(1);
        const [attempt] = yield* rowsOf(world, (tx) => tx.select().from(deliveryAttempts));
        expect(attempt).toMatchObject({ state: 'INDETERMINATE' });
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-02] a provider answer bound to another attempt is never trusted: it is INDETERMINATE and reconciled, not resent',
    () =>
      Effect.gen(function* mixedUp() {
        const world = yield* setup();
        const calls: PinnedHandoff[] = [];
        const wrongAttempt = {
          calls,
          layer: Layer.succeed(MessageHandoff, {
            handoff: (message) => {
              calls.push(message);
              return Effect.succeed({
                attemptId: DeliveryAttemptIdSchema.make('00000000-0000-4000-8000-0000000000ff'),
                intentId: message.intentId,
                outcome: { kind: 'ACCEPTED', providerKey: 'fixture-provider', providerRef: 'r-x' } as const,
                tenantId: message.tenantId,
              });
            },
          }),
        };
        const intentId = yield* decidedIntent(world);
        const outcome = yield* step(world, wrongAttempt, intentId);
        expect(outcome).toMatchObject({
          evidence: { outcome: { kind: 'INDETERMINATE', reason: 'response_invalid' } },
          kind: 'HANDED_OFF',
        });
        const [attempt] = yield* rowsOf(world, (tx) => tx.select().from(deliveryAttempts));
        expect(attempt).toMatchObject({ state: 'INDETERMINATE' });
        expect(kindOf(yield* step(world, wrongAttempt, intentId))).toBe('SKIPPED:ALREADY_FINISHED');
        expect(calls).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('[AC-08 S08] an ended original endpoint stops the handoff once; no Current contact is ever substituted', () =>
    Effect.gen(function* endpointEnded() {
      const world = yield* setup();
      const handoff = handoffDouble();
      const intentId = yield* decidedIntent(world);
      world.recipientAuthority.answers.set('contact-customer-1', unusable('ORIGINAL_ENDPOINT_UNUSABLE'));
      const outcome = yield* step(world, handoff, intentId);
      expect(outcome).toMatchObject({
        kind: 'STOPPED',
        reasons: [{ category: 'CHANNEL_UNUSABLE', cause: 'ORIGINAL_ENDPOINT_UNUSABLE', proven: true }],
      });
      expect(handoff.calls).toEqual([]);
      expect(
        world.recipientAuthority.queries.every((query) => query.contact.contactRef.resourceId === 'contact-customer-1'),
      ).toBe(true);
      expect(yield* rowsOf(world, (tx) => tx.select().from(intentHandoffStops))).toHaveLength(1);
      expect(yield* rowsOf(world, (tx) => tx.select().from(deliveryAttempts))).toEqual([]);
      // a redelivery does not ask again and does not hand anything off
      expect(kindOf(yield* step(world, handoff, intentId))).toBe('SKIPPED:ALREADY_STOPPED');
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-08 I-10] Current Privacy is asked again: NOT_ALLOWED and INDETERMINATE both stop, with distinct reasons',
    () =>
      Effect.gen(function* privacyRechecked() {
        const world = yield* setup({ recipients: ['customer-1'] });
        const handoff = handoffDouble();
        const denied = yield* decidedIntent(world);
        world.privacy.answers.set('customer-1', privacyNotAllowed());
        expect(yield* step(world, handoff, denied)).toMatchObject({
          kind: 'STOPPED',
          reasons: [{ category: 'PRIVACY_NOT_ALLOWED', proven: true }],
        });
        const other = yield* setup();
        const unsure = yield* decidedIntent(other);
        other.privacy.answers.set('customer-1', privacyIndeterminate);
        expect(yield* step(other, handoff, unsure)).toMatchObject({
          kind: 'STOPPED',
          reasons: [{ category: 'PRIVACY_INDETERMINATE', proven: false }],
        });
        expect(handoff.calls).toEqual([]);
        // an earlier ALLOWED was never reused: Privacy was asked at the decision AND again at the handoff
        expect(world.privacy.queries.length).toBeGreaterThanOrEqual(2);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-05 L-13] tightening the Tenant mode from A to B stops a pinned English message without a usable Czech revision',
    () =>
      Effect.gen(function* tightening() {
        const world = yield* setup();
        const handoff = handoffDouble();
        // mode A and a trusted English recipient: the English revision is pinned (A needs no Czech one)
        yield* world.database.withPorts(world.tenantId, (_templates, policies) =>
          setLanguageMode(policies, 'A', actorWith('00000000-0000-4000-8000-0000000000a4')),
        );
        yield* Ref.set(world.language.ref, { kind: 'trusted', language: 'en' });
        const intentId = yield* decidedIntent(world);
        const [stored] = yield* rowsOf(world, (tx) => tx.select().from(messageIntents));
        expect(stored).toMatchObject({ language: 'en', tenantMode: 'A' });
        // the Czech revision is retired and the Tenant tightens the mode: English alone is no longer allowed
        const czech = yield* world.database.withPorts(world.tenantId, (templates) =>
          resolveTemplatePin(templates, { ...templateBase, language: 'cs' }),
        );
        yield* world.database.withPorts(world.tenantId, (templates) =>
          deactivateRevision(
            templates,
            { reason: 'Fictional retirement', revisionId: czech.revisionId },
            actorWith('00000000-0000-4000-8000-0000000000a6'),
          ),
        );
        yield* world.database.withPorts(world.tenantId, (_templates, policies) =>
          setLanguageMode(policies, 'B', actorWith('00000000-0000-4000-8000-0000000000a7')),
        );
        const outcome = yield* step(world, handoff, intentId);
        expect(outcome).toMatchObject({
          kind: 'STOPPED',
          reasons: [{ category: 'LANGUAGE_GATE', cause: 'czech_revision_required_by_mode_b' }],
        });
        expect(handoff.calls).toEqual([]);
        // the stored pin is untouched by the stop
        const [after] = yield* rowsOf(world, (tx) => tx.select().from(messageIntents));
        expect(after).toEqual(stored);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-05 S06] a template revision invalidated as unsafe after the decision blocks the handoff; nothing is upgraded',
    () =>
      Effect.gen(function* revisionInvalidated() {
        const world = yield* setup();
        const handoff = handoffDouble();
        const intentId = yield* decidedIntent(world);
        const [stored] = yield* rowsOf(world, (tx) => tx.select().from(messageIntents));
        yield* world.database.withPorts(world.tenantId, (templates) =>
          invalidateRevisionAsUnsafe(
            templates,
            { reason: 'Fictional unsafe wording', revisionId: stored?.templateRevisionId ?? '' },
            actorWith('00000000-0000-4000-8000-0000000000a5'),
          ),
        );
        const outcome = yield* step(world, handoff, intentId);
        expect(outcome).toMatchObject({
          kind: 'STOPPED',
          reasons: [{ category: 'TEMPLATE_PIN', cause: 'pinned_template_revision_invalidated_unsafe' }],
        });
        expect(handoff.calls).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-08] a type that is no longer approved, or approved under another revision, stops; a moved-on source is stale',
    () =>
      Effect.gen(function* catalogAndSource() {
        const world = yield* setup();
        const handoff = handoffDouble();
        const removed = yield* decidedIntent(world);
        expect(yield* step(world, handoff, removed, scopedIn(world), [])).toMatchObject({
          kind: 'STOPPED',
          reasons: [{ category: 'TYPE_UNAVAILABLE' }],
        });
        const other = yield* setup();
        const revised = yield* decidedIntent(other);
        expect(yield* step(other, handoff, revised, scopedIn(other), [fixtureType({ revision: 2 })])).toMatchObject({
          kind: 'STOPPED',
          reasons: [{ cause: 'TYPE_REVISION_CHANGED' }],
        });
        const third = yield* setup();
        const stale = yield* decidedIntent(third);
        third.source.state.latestRevision = 2;
        expect(yield* step(third, handoff, stale)).toMatchObject({
          kind: 'STOPPED',
          reasons: [{ category: 'SOURCE_STALE' }],
        });
        const fourth = yield* setup();
        const unreachable = yield* decidedIntent(fourth);
        fourth.source.state.available = false;
        expect(yield* step(fourth, handoff, unreachable)).toMatchObject({
          kind: 'STOPPED',
          reasons: [{ category: 'SOURCE_AUTHORITY_UNAVAILABLE', proven: false }],
        });
        expect(handoff.calls).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-09 ADR-0013] a suppressed or not-sent intent is never processed by the worker; only a pending one is',
    () =>
      Effect.gen(function* onlyPending() {
        const world = yield* setup();
        const handoff = handoffDouble();
        world.privacy.answers.set('customer-1', privacyNotAllowed());
        const run = yield* world.runner.submit(world.tenantId, requestFor(world.tenantId));
        const suppressed = decided(run);
        const [intent] = suppressed.decision.kind === 'MESSAGE_INTENTS' ? suppressed.decision.intents : [];
        const intentId = intent?.intentId ?? MessageIntentIdSchema.make('00000000-0000-4000-8000-000000000000');
        expect(run.outbox).toEqual([]);
        world.privacy.answers.set('customer-1', privacyAllowed);
        expect(kindOf(yield* step(world, handoff, intentId))).toBe('SKIPPED:NOT_PENDING');
        expect(handoff.calls).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[review a] worker_begin_attempt itself refuses a non-pending intent and a stale number, and never begins twice',
    () =>
      Effect.gen(function* beginGuards() {
        const world = yield* setup();
        world.privacy.answers.set('customer-1', privacyNotAllowed());
        const { decision } = decided(yield* world.runner.submit(world.tenantId, requestFor(world.tenantId)));
        const [suppressed] = decision.kind === 'MESSAGE_INTENTS' ? decision.intents : [];
        const begin = (intentId: string, attemptNumber: number) =>
          Effect.gen(function* callBegin() {
            const attemptId = yield* attemptIdOf(MessageIntentIdSchema.make(intentId), attemptNumber);
            const rows = yield* world.database.inTenant(world.tenantId, (tx) =>
              tx.invoke(workerBeginAttemptRoutine, [intentId, attemptId, attemptNumber]),
            );
            return rows[0]?.result;
          });
        // a SUPPRESSED intent is refused by the routine itself, not only by the worker
        expect(yield* begin(suppressed?.intentId ?? '', 1)).toEqual({ outcome: 'NOT_PENDING' });
        expect(yield* rowsOf(world, (tx) => tx.select().from(deliveryAttempts))).toEqual([]);
        // a pending intent: a number that is not the next one is stale and writes nothing
        const pending = yield* setup();
        const pendingId = yield* decidedIntent(pending);
        const beginPending = (attemptNumber: number) =>
          Effect.gen(function* callBegin() {
            const attemptId = yield* attemptIdOf(pendingId, attemptNumber);
            const rows = yield* pending.database.inTenant(pending.tenantId, (tx) =>
              tx.invoke(workerBeginAttemptRoutine, [pendingId, attemptId, attemptNumber]),
            );
            return rows[0]?.result;
          });
        expect(yield* beginPending(2)).toEqual({ outcome: 'STALE' });
        expect(yield* rowsOf(pending, (tx) => tx.select().from(deliveryAttempts))).toEqual([]);
        expect(yield* beginPending(1)).toEqual({ outcome: 'BEGUN' });
        // a PREPARED attempt, which may have left, blocks every further one
        expect(yield* beginPending(1)).toEqual({ outcome: 'EXISTS', state: 'PREPARED' });
        expect(yield* beginPending(2)).toEqual({ outcome: 'EXISTS', state: 'PREPARED' });
        expect(yield* rowsOf(pending, (tx) => tx.select().from(deliveryAttempts))).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[review b] NOT_ATTEMPTED (no adapter) is its own state and does not burn the intent; a real provider UNAVAILABLE does',
    () =>
      Effect.gen(function* noAdapter() {
        const world = yield* setup();
        const intentId = yield* decidedIntent(world);
        // the production composition today: owner ports enabled, no Messaging Adapter (step 22)
        const none = { calls: [] as PinnedHandoff[], layer: unavailableMessageHandoffLayer };
        expect(yield* step(world, none, intentId)).toMatchObject({
          evidence: { outcome: { kind: 'NOT_ATTEMPTED', reason: 'NO_ADAPTER_CONFIGURED' } },
          kind: 'HANDED_OFF',
        });
        const [first] = yield* rowsOf(world, (tx) => tx.select().from(deliveryAttempts));
        expect(first).toMatchObject({ attemptNumber: 1, state: 'NOT_ATTEMPTED' });
        // the adapter arrives later: the SAME intent is still sendable, as attempt 2, exactly once
        const adapter = handoffDouble();
        expect((yield* step(world, adapter, intentId)).kind).toBe('HANDED_OFF');
        expect(adapter.calls).toHaveLength(1);
        const attempts = yield* rowsOf(world, (tx) => tx.select().from(deliveryAttempts));
        expect(attempts.map(({ attemptNumber, state }) => [attemptNumber, state]).toSorted()).toEqual([
          [1, 'NOT_ATTEMPTED'],
          [2, 'ACCEPTED'],
        ]);
        expect(adapter.calls[0]?.attemptId).toBe(attempts.find(({ attemptNumber }) => attemptNumber === 2)?.attemptId);
        // an answer from a real adapter is final: no third attempt, however often Core delivers again
        expect(kindOf(yield* step(world, adapter, intentId))).toBe('SKIPPED:ALREADY_FINISHED');
        expect(adapter.calls).toHaveLength(1);

        // a real provider that could not be used does NOT prove nothing was accepted: that attempt stays final
        const other = yield* setup();
        const otherId = yield* decidedIntent(other);
        const down = handoffDouble(() =>
          Effect.succeed({ kind: 'UNAVAILABLE', reason: 'provider_unavailable' } as const),
        );
        yield* step(other, down, otherId);
        expect(yield* rowsOf(other, (tx) => tx.select().from(deliveryAttempts))).toMatchObject([
          { attemptNumber: 1, state: 'UNAVAILABLE' },
        ]);
        expect(kindOf(yield* step(other, handoffDouble(), otherId))).toBe('SKIPPED:ALREADY_FINISHED');

        // after NOT_ATTEMPTED a later Current stop is recordable (nothing ever left), unlike after an attempt that may have
        const stopped = yield* setup();
        const stoppedId = yield* decidedIntent(stopped);
        yield* step(stopped, none, stoppedId);
        stopped.privacy.answers.set('customer-1', privacyNotAllowed());
        expect(yield* step(stopped, handoffDouble(), stoppedId)).toMatchObject({ kind: 'STOPPED' });
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[review F3] a stop is recorded per evaluation, as proven or unproven, and a later Current evaluation is representable',
    () =>
      Effect.gen(function* stopEvaluations() {
        const world = yield* setup();
        const intentId = yield* decidedIntent(world);
        world.privacy.answers.set('customer-1', privacyIndeterminate);
        expect(yield* step(world, handoffDouble(), intentId)).toMatchObject({ kind: 'STOPPED' });
        const [unproven] = yield* rowsOf(world, (tx) => tx.select().from(intentHandoffStops));
        // an outage of the owner proves nothing against the message: the stop is UNPROVEN and is evaluation 1
        expect(unproven).toMatchObject({ evaluationSeq: 1, intentId, proven: false });
        // a prohibition IS a proof
        const prohibited = yield* setup();
        const prohibitedId = yield* decidedIntent(prohibited);
        prohibited.privacy.answers.set('customer-1', privacyNotAllowed());
        yield* step(prohibited, handoffDouble(), prohibitedId);
        expect(yield* rowsOf(prohibited, (tx) => tx.select().from(intentHandoffStops))).toMatchObject([
          { evaluationSeq: 1, proven: true },
        ]);
        // this lane's worker still treats the stop as final: nothing is retried or handed off
        expect(kindOf(yield* step(world, handoffDouble(), intentId))).toBe('SKIPPED:ALREADY_STOPPED');

        // d21-10 supersedes an UNPROVEN stop by APPENDING evaluation 2; the owner connection stands in for its routine. The
        // runtime role can append nothing, and no row is ever edited or removed.
        const runtimeInsert = yield* Effect.exit(
          world.database.inTenant(world.tenantId, (tx) =>
            tx.insert(intentHandoffStops).values({
              evaluationSeq: 2,
              intentId,
              reasons: [],
              recordedAt: new Date(),
              tenantId: world.tenantId,
            }),
          ),
        );
        expect(Exit.isFailure(runtimeInsert)).toBe(true);
        const admin = yield* loadDatabaseConnectionPair().pipe(
          Effect.flatMap(({ admin: connection }) =>
            PgClient.makeClient({ url: Redacted.make(connection.connectionString) }),
          ),
        );
        const append = (evaluationSeq: number, proven: boolean) =>
          admin.withTransaction(
            Effect.gen(function* appendEvaluation() {
              yield* admin.unsafe(`select set_config('ontos.tenant_id', $1, true)`, [world.tenantId]);
              yield* admin.unsafe(
                `insert into communications.intent_handoff_stops (tenant_id, intent_id, evaluation_seq, reasons, recorded_at)
                 values ($1, $2, $3, $4::jsonb, now())`,
                [
                  world.tenantId,
                  intentId,
                  evaluationSeq,
                  JSON.stringify([{ category: 'LATER_EVALUATION', cause: 'FIXTURE', proven }]),
                ],
              );
            }),
          );
        yield* append(2, true);
        const evaluations = yield* rowsOf(world, (tx) => tx.select().from(intentHandoffStops));
        expect(evaluations.map(({ evaluationSeq, proven }) => [evaluationSeq, proven]).toSorted()).toEqual([
          [1, false],
          [2, true],
        ]);
        // exactly one row per (intent, evaluation): a repeated evaluation and a non-positive one are refused
        const failureOf = (effect: ReturnType<typeof append>) =>
          Effect.flip(effect).pipe(Effect.map((failure) => findPostgresFailure(failure)));
        expect(Option.map(yield* failureOf(append(2, false)), ({ code }) => code)).toEqual(Option.some('23505'));
        expect(Option.map(yield* failureOf(append(0, false)), ({ code }) => code)).toEqual(Option.some('23514'));
        // and history stays append-only for every role
        for (const mutation of [
          `update communications.intent_handoff_stops set evaluation_seq = 3 where tenant_id = '${world.tenantId}'`,
          `delete from communications.intent_handoff_stops where tenant_id = '${world.tenantId}'`,
        ]) {
          const refused = yield* Effect.flip(admin.withTransaction(admin.unsafe(mutation)));
          expect(Option.map(findPostgresFailure(refused), ({ code }) => code)).toEqual(Option.some('55000'));
        }
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('[review f] every scoped routine refuses a Tenant other than the installed one with 42501', () =>
    Effect.gen(function* tenantGuard() {
      const world = yield* setup();
      const intentId = yield* decidedIntent(world);
      const stranger = '99999999-9999-4999-8999-999999999999';
      const attemptId = yield* attemptIdOf(intentId, 1);
      type Tx = Parameters<Parameters<World['database']['inTenant']>[1]>[0];
      // the routine's own document row, called with an explicit Tenant argument exactly as a forged caller would
      const call = (tx: Tx, routineCall: ReturnType<typeof sql>) =>
        tx.select({ result: sql<unknown>`routine.result` }).from(sql`${routineCall} as routine(result)`);
      const calls = [
        sql`communications.read_language_policy_snapshot(${stranger}::uuid)`,
        sql`communications.worker_read_intent(${stranger}::uuid, ${intentId}::uuid)`,
        sql`communications.worker_read_template_snapshot(${stranger}::uuid, 'fixture.single-message', 'email', 'tenant', null::uuid)`,
        sql`communications.worker_begin_attempt(${stranger}::uuid, ${intentId}::uuid, ${attemptId}::uuid, 1)`,
        sql`communications.worker_record_stop(${stranger}::uuid, ${intentId}::uuid, '[]'::jsonb)`,
        sql`communications.worker_finish_attempt(${stranger}::uuid, ${attemptId}::uuid, 'ACCEPTED', '{}'::jsonb)`,
      ];
      for (const routineCall of calls) {
        const failure = yield* Effect.flip(world.database.inTenant(world.tenantId, (tx) => call(tx, routineCall)));
        expect(Option.map(findPostgresFailure(failure), ({ code }) => code)).toEqual(Option.some('42501'));
      }
      // the same call naming the installed Tenant is answered: the guard refuses the Tenant, not the routine
      const own = yield* world.database.inTenant(world.tenantId, (tx) =>
        call(tx, sql`communications.worker_read_intent(${world.tenantId}::uuid, ${intentId}::uuid)`),
      );
      expect(own).toHaveLength(1);
      expect(yield* rowsOf(world, (tx) => tx.select().from(deliveryAttempts))).toEqual([]);
      expect(yield* rowsOf(world, (tx) => tx.select().from(intentHandoffStops))).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live(
    '[AC-11 persistence] after a full run no table of the owner holds an address, a secret or a raw proof, only references and a mask',
    () =>
      Effect.gen(function* noSecretsAtRest() {
        const world = yield* setup();
        const handoff = handoffDouble();
        const intentId = yield* decidedIntent(world);
        expect((yield* step(world, handoff, intentId)).kind).toBe('HANDED_OFF');
        // a stopped sibling too, so the stop reasons are on disk as well
        const stopped = yield* setup();
        const stoppedId = yield* decidedIntent(stopped);
        stopped.privacy.answers.set('customer-1', privacyNotAllowed());
        yield* step(stopped, handoffDouble(), stoppedId);
        // a conflicting duplicate, so its row exists as well
        yield* world.runner.submit(world.tenantId, requestFor(world.tenantId, ['customer-1', 'customer-2']));
        for (const run of [world, stopped]) {
          const everything = JSON.stringify([
            yield* rowsOf(run, (tx) => tx.select().from(communicationRequests)),
            yield* rowsOf(run, (tx) => tx.select().from(communicationRequestConflicts)),
            yield* rowsOf(run, (tx) => tx.select().from(communicationDecisions)),
            yield* rowsOf(run, (tx) => tx.select().from(messageIntents)),
            yield* rowsOf(run, (tx) => tx.select().from(deliveryAttempts)),
            yield* rowsOf(run, (tx) => tx.select().from(intentHandoffStops)),
          ]);
          expect(everything).not.toContain(ORIGINAL_ADDRESS);
          // no address-shaped value at all: the owner's mask is `p***@...` and never matches a usable address
          expect(everything).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/u);
          expect(everything).not.toMatch(/otp|password|secret|token|bearer/iu);
        }
        // and the schema itself has no column for one
        const admin = yield* loadDatabaseConnectionPair().pipe(
          Effect.flatMap(({ admin: connection }) =>
            PgClient.makeClient({ url: Redacted.make(connection.connectionString) }),
          ),
        );
        const columns = yield* admin.unsafe<{ readonly column_name: string }>(
          `select column_name::text from information_schema.columns where table_schema = 'communications' and table_name = any($1::text[])`,
          [
            [
              'communication_requests',
              'communication_request_conflicts',
              'communication_decisions',
              'message_intents',
              'delivery_attempts',
              'intent_handoff_stops',
            ],
          ],
        );
        expect(columns.length).toBeGreaterThan(30);
        expect(
          columns
            .map(({ column_name: name }) => name)
            .filter((name) => /address|secret|token|otp|password/u.test(name)),
        ).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
