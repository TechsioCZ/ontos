import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { Cause, Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { inspect } from 'node:util';

import { safeCauseOf } from '../../src/domain/intake/safe-cause.ts';
import { storeUnavailable } from '../../src/handoff/process-intent-handoff.ts';
import { postgresCommunicationIntakePort } from '../../src/services/communication-intake.service.ts';

/**
 * A failed statement carries its bound parameters: Drizzle's query error names the SQL text and every value. For an
 * intent insert those are the recipient reference, the contact reference and the owner's mask. A typed "unavailable"
 * error must never carry them to a log, whichever way the log prints the error and its `cause`.
 */
const SECRETS = ['customer-1', 'contact-customer-1', 'p***@example.test', 'puvodni@example.test'];

const databaseFailure = () =>
  Object.assign(
    new Error(
      `Failed query: insert into "communications"."message_intents" (...) values ($1, $2, $3)\nparams: ${SECRETS.join(',')}`,
    ),
    { cause: { code: '23505', constraint: 'communications_intents_key_uk' }, name: 'DrizzleQueryError' },
  );

/** Every way a log may print an error: deep inspection (hidden properties too), the Effect cause renderer and JSON. */
const printed = (error: unknown) =>
  [inspect(error, { depth: 8, showHidden: true }), String(Cause.pretty(Cause.fail(error))), JSON.stringify(error)].join(
    '\n',
  );

const expectNoSecret = (text: string) => {
  for (const secret of SECRETS) {
    expect(text).not.toContain(secret);
  }
  expect(text).not.toContain('Failed query');
};

describe('Typed unavailable errors never carry the statement or its bound values (#1401)', () => {
  it('keeps only the failure kind and the sanitized SQLSTATE and constraint', () => {
    expect(safeCauseOf(databaseFailure())).toEqual({
      constraint: 'communications_intents_key_uk',
      kind: 'DrizzleQueryError',
      sqlState: '23505',
    });
    expect(safeCauseOf({ _tag: 'SomeOwnerFailure', recipient: 'customer-1' })).toEqual({ kind: 'SomeOwnerFailure' });
    expect(safeCauseOf('p***@example.test')).toEqual({ kind: 'string' });
  });

  it('the worker store failure is retryable and prints no recipient reference, contact reference or mask', () => {
    const error = storeUnavailable('The delivery attempt could not be recorded', databaseFailure());
    expect(error._tag).toBe('HandoffStoreUnavailable');
    expect(Reflect.get(error, 'cause')).toEqual({
      constraint: 'communications_intents_key_uk',
      kind: 'DrizzleQueryError',
      sqlState: '23505',
    });
    expectNoSecret(printed(error));
  });

  it.effect('the intake store failure is the retryable unavailable error and prints none of them either', () =>
    Effect.gen(function* intakeStoreFailure() {
      const failing = {
        select: () => ({ from: () => Effect.fail(databaseFailure()) }),
      } as unknown as ScopedTransactionExecutor;
      const port = postgresCommunicationIntakePort(failing, { tenantId: '11111111-1111-4111-8111-111111111111' });
      const error = yield* Effect.flip(port.lockIdentity('identity-key'));
      expect(error).toMatchObject({
        _tag: 'CommunicationDecisionUnavailable',
        code: 'communication_decision_unavailable',
      });
      expect(Reflect.get(error, 'cause')).toMatchObject({ kind: 'DrizzleQueryError', sqlState: '23505' });
      expectNoSecret(printed(error));
    }),
  );
});
