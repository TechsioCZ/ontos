import { Cause, DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { inspect } from 'node:util';

import { CommunicationDecisionUnavailable } from '../../shared/communication-intake-errors.ts';
import { CommunicationRequestIdSchema } from '../../shared/communication-intake.ts';
import { messageIntents } from '../../src/database/schema.ts';
import { storeUnavailable } from '../../src/handoff/process-intent-handoff.ts';
import { postgresCommunicationIntakePort } from '../../src/services/communication-intake.service.ts';
import { makeRuntimeDatabase, nativeServices, nextId } from '../support/persistence.fixture.ts';

/**
 * A failed statement carries its bound parameters: Drizzle's query error holds the SQL text and every value. For an intent
 * those are the recipient reference, the contact reference and the owner's mask. These tests provoke REAL failures on
 * native PostgreSQL and prove that the typed unavailable errors print none of that, whichever way a log renders them.
 */
const RECIPIENT = 'recipient-redaction-probe';
const MASK = 'r***@redaction.example.test';
const FINGERPRINT = 'fingerprint-redaction-probe';

/** Every way a log may print an error: deep inspection (hidden properties too), the Effect cause renderer and JSON. */
const printed = (error: Error) =>
  [inspect(error, { depth: 10, showHidden: true }), Cause.pretty(Cause.fail(error)), JSON.stringify(error)].join('\n');

describe('Typed unavailable errors never carry the failed statement or its bound values (#1401)', () => {
  it.live('the worker store failure of a real failed intent insert prints no reference and no mask', () =>
    Effect.gen(function* workerStoreFailure() {
      const database = yield* makeRuntimeDatabase();
      const tenantId = yield* nextId;
      const [intentId, requestId, decisionId] = [yield* nextId, yield* nextId, yield* nextId];
      // a PENDING intent without its pins violates a CHECK constraint, so PostgreSQL refuses the very statement
      const failure = yield* Effect.flip(
        database.inTenant(tenantId, (tx) =>
          Effect.gen(function* insertInvalidIntent() {
            return yield* tx.insert(messageIntents).values({
              createdAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-19T12:00:00.000Z')),
              decisionId,
              endpointPin: { channel: 'email', mask: MASK },
              handoffPin: {},
              intentId,
              intentKey: 'redaction-probe',
              originalBinding: {},
              purpose: 'fixture.single',
              recipientId: RECIPIENT,
              recipientModule: 'fixture.party',
              recipientRole: 'original-recipient',
              recipientType: 'fixture.recipient',
              requestId,
              slotKey: 'primary',
              status: 'PENDING_HANDOFF',
              tenantId,
              typeId: 'fixture.single-message',
              typeRevision: 1,
            });
          }),
        ),
      );
      // the premise: the raw failure DOES carry the bound values, which is exactly why it must not be kept
      expect(inspect(failure, { depth: 10 })).toContain(RECIPIENT);
      const wrapped = storeUnavailable('The delivery attempt could not be recorded', failure);
      const text = printed(wrapped);
      for (const secret of [RECIPIENT, MASK, 'redaction-probe', 'insert into']) {
        expect(text).not.toContain(secret);
      }
      // what remains is the safe kind and the sanitized SQLSTATE of the check violation
      expect(inspect(wrapped.cause, { depth: 4 })).toContain('23514');
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );

  it.live('the intake port maps a real failed statement to the retryable error without its bound values', () =>
    Effect.gen(function* intakeStoreFailure() {
      const database = yield* makeRuntimeDatabase();
      const tenantId = yield* nextId;
      const requestId = CommunicationRequestIdSchema.make(yield* nextId);
      const actionInvocationId = yield* nextId;
      // a conflict row for a request that does not exist violates its foreign key
      const error = yield* Effect.flip(
        database.inTenant(tenantId, (tx) =>
          postgresCommunicationIntakePort(tx, { tenantId }).recordConflict({
            actionInvocationId,
            fingerprint: FINGERPRINT,
            requestId,
          }),
        ),
      );
      expect(Schema.is(CommunicationDecisionUnavailable)(error)).toBe(true);
      const text = printed(error);
      for (const secret of [FINGERPRINT, requestId, 'insert into']) {
        expect(text).not.toContain(secret);
      }
      expect(inspect(error.cause, { depth: 4 })).toContain('23503');
    }).pipe(Effect.scoped, Effect.provide(nativeServices)),
  );
});
