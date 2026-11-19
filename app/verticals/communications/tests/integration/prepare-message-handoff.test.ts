import { NodeCrypto } from '@effect/platform-node';
import { Effect, Exit, Layer, Match, Redacted, Ref } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { HandoffStoreUnavailable, processIntentHandoff } from '../../src/handoff/process-intent-handoff.ts';
import type { HandoffProcessing, ScopedRunner } from '../../src/handoff/process-intent-handoff.ts';
import { deliveryAttempts, intentHandoffStops, messageIntents } from '../../src/database/schema.ts';
import { DeliveryAttemptIdSchema, MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import { MessageHandoff } from '../../src/domain/handoff/message-handoff.ts';
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
        // program 1 commits the attempt, the provider is called, program 2 (the evidence) dies: the worker crashed
        const crashed = yield* Effect.exit(step(world, handoff, intentId, runnerFailingAt(world, 2)));
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
});
