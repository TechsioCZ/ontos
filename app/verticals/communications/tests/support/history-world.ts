import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Layer, Match, Option } from 'effect';

import { CommunicationRequestIdSchema, DeliveryAttemptIdSchema } from '../../shared/communication-intake.ts';
import type { MessageIntentIdSchema, MessageIntentSummary } from '../../shared/communication-intake.ts';
import type { ProviderObservationInput } from '../../src/domain/history/provider-observation.ts';
import { ingestProviderObservation } from '../../src/history/provider-observations.ts';
import { HandoffStoreUnavailable, processIntentHandoff } from '../../src/handoff/process-intent-handoff.ts';
import type { ScopedRunner } from '../../src/handoff/process-intent-handoff.ts';
import { loadRequestHistory } from '../../src/services/message-history.service.ts';
import type { IntentHistoryRecord, RequestHistoryRecord } from '../../src/services/message-history.service.ts';
import type { handoffDouble } from './intake-fixtures.ts';
import { decided, requestFor } from './intake-world.ts';
import type { intakeWorld } from './intake-world.ts';
import type { ObservationTarget } from './step22-observation-double.ts';

/**
 * TEST-ONLY wiring of the message history lane on native PostgreSQL, as the runtime role and through the REAL scoped routines.
 * The Messaging Adapter (`handoffDouble`) and the step 22 evidence (`step22Double`) are labelled doubles: they prove how
 * Communications READS an answer, never that a real provider answers so.
 */

export type World = Effect.Success<ReturnType<typeof intakeWorld>>;
type Handoff = ReturnType<typeof handoffDouble>;

/** One scoped transaction of the world's Tenant, exactly as Core's worker scope runs one. */
export const scopedIn =
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

/** One delivery of the pre-handoff step for an intent, with the given Messaging Adapter double. */
export const step = (world: World, handoff: Handoff, intentId: typeof MessageIntentIdSchema.Type) =>
  processIntentHandoff({ intentId, tenantId: world.tenantId }, scopedIn(world)).pipe(
    Effect.provide(Layer.mergeAll(world.portsFor(world.types), handoff.layer, NodeCrypto.layer)),
  );

/** The id of the intent at `index` of a decision, or a defect of the test: a decision that decided none. */
export const intentIdAt = (intents: readonly MessageIntentSummary[], index = 0) =>
  Option.match(Option.fromNullishOr(intents[index]), {
    onNone: () => Effect.die(`the decision has no intent at ${String(index)}`),
    onSome: ({ intentId }) => Effect.succeed(intentId),
  });

/** Decides one request for the given recipients through the public Action handler. */
export const decide = Effect.fn('HistoryTest.decide')(function* decideRequest(
  world: World,
  recipients: readonly string[] = ['customer-1'],
  occurrenceId = 'fixture-occurrence-1',
) {
  const run = yield* world.runner.submit(world.tenantId, requestFor(world.tenantId, recipients, occurrenceId));
  const result = decided(run);
  const intents = result.decision.kind === 'MESSAGE_INTENTS' ? result.decision.intents : [];
  return { intents, requestId: CommunicationRequestIdSchema.make(result.requestId) };
});

/** A request that decided exactly one intent: its identities. */
export const decideOne = Effect.fn('HistoryTest.decideOne')(function* decideSingle(
  world: World,
  recipient = 'customer-1',
  occurrenceId = 'fixture-occurrence-1',
) {
  const { intents, requestId } = yield* decide(world, [recipient], occurrenceId);
  return { intentId: yield* intentIdAt(intents), requestId };
});

/** The one provider observation of an input, in the Tenant scope the world installs (never the one the input claims). */
export const ingest = (world: World, input: ProviderObservationInput) =>
  world.database
    .inTenant(world.tenantId, (transaction) => ingestProviderObservation(transaction, input))
    .pipe(Effect.provide(NodeCrypto.layer));

/** The safe history record of a request, as an owner-internal read. Never a public Read. */
export const historyOf = (world: World, requestId: typeof CommunicationRequestIdSchema.Type) =>
  world.database
    .inTenant(world.tenantId, (transaction) => loadRequestHistory(transaction, world.tenantId, requestId))
    .pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die('the request has no history in this Tenant'),
          onSome: (record: RequestHistoryRecord) => Effect.succeed(record),
        }),
      ),
    );

/** The history record of the intent at `index` of a request, or a defect of the test when the request decided none. */
export const intentHistoryOf = Effect.fn('HistoryTest.intentHistoryOf')(function* intentHistory(
  world: World,
  requestId: typeof CommunicationRequestIdSchema.Type,
  index = 0,
) {
  const history = yield* historyOf(world, requestId);
  const record: IntentHistoryRecord | undefined = history.intents[index];
  return yield* Option.match(Option.fromNullishOr(record), {
    onNone: () => Effect.die(`the request has no intent history at ${String(index)}`),
    onSome: (found) => Effect.succeed(found),
  });
});

export const targetOf = (
  world: World,
  intentId: typeof MessageIntentIdSchema.Type,
  attemptId: string,
): ObservationTarget => ({
  attemptId: DeliveryAttemptIdSchema.make(attemptId),
  intentId,
  tenantId: world.tenantId,
});

export const minutesFromNow = (minutes: number) =>
  DateTime.now.pipe(Effect.map((now) => DateTime.add(now, { minutes })));
