import { Effect, Option, Predicate, Redacted } from 'effect';

import {
  attemptRetryLinks,
  communicationDecisions,
  communicationRequestConflicts,
  communicationRequests,
  deliveryAttempts,
  intentHandoffStops,
  intentRecoveryEvaluations,
  intentResendLinks,
  messageIntents,
  providerObservations,
} from '../../../verticals/communications/src/database/schema.ts';
import {
  accessReads,
  nativeRuntimeClient,
  visibilityDouble,
} from '../../../verticals/communications/tests/support/access-reads.ts';
import { MessageIntentIdSchema } from '../../../verticals/communications/shared/communication-intake.ts';
import type { AuthWorld } from './auth-communications-world.spec.mts';

/**
 * Checks shared by the three Portal Auth e-mail suites. A "secret" below is whatever Auth issued (a link, a token, a one-time
 * code, a password) and the full address: none of them may be found anywhere Communications keeps or shows anything.
 */

const SHORT_SECRET_LENGTH = 12;
const LIST = 'communications.core.message-history.list';
const LIST_MASK = 'communications.core.message-history-recipient-mask.list';
const READ = 'communications.core.message-history.read';
const READ_MASK = 'communications.core.message-history-recipient-mask.read';
export const allowedAccess = {
  [LIST]: 'allowed',
  [LIST_MASK]: 'allowed',
  [READ]: 'allowed',
  [READ_MASK]: 'allowed',
} as const;

/** Every row of every Communications table of the world's Tenant, as the runtime role sees them. */
export const everyStoredRow = (world: AuthWorld) =>
  world.database.inTenant(world.tenantId, (tx) =>
    Effect.all(
      {
        attempts: tx.select().from(deliveryAttempts),
        conflicts: tx.select().from(communicationRequestConflicts),
        decisions: tx.select().from(communicationDecisions),
        intents: tx.select().from(messageIntents),
        observations: tx.select().from(providerObservations),
        recoveries: tx.select().from(intentRecoveryEvaluations),
        requests: tx.select().from(communicationRequests),
        resends: tx.select().from(intentResendLinks),
        retries: tx.select().from(attemptRetryLinks),
        stops: tx.select().from(intentHandoffStops),
      },
      { concurrency: 1 },
    ),
  );

/** The authorized history Reads of the world's Tenant, through Core's real Read lifecycle over the real owner SQL. */
export const historyReads = Effect.fn('AuthCommunicationsChecks.reads')(function* reads(
  world: AuthWorld,
  access: Parameters<typeof accessReads>[1]['access'] = allowedAccess,
) {
  const client = yield* nativeRuntimeClient;
  const handle = yield* accessReads(client, { access, tenantId: world.tenantId });
  const visibility = visibilityDouble(() => 'VISIBLE');
  return {
    detail: (intentId: string) =>
      handle.detail({ intentId: MessageIntentIdSchema.make(intentId) }).pipe(Effect.provide(visibility.layer)),
    list: () => handle.list().pipe(Effect.provide(visibility.layer)),
  };
});

/** Console output of a run, so a secret that reached a log line is found. */
export const captureLogs = <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
  Effect.gen(function* withCapturedLogs() {
    const lines: string[] = [];
    const saved = {
      debug: console.debug,
      error: console.error,
      info: console.info,
      log: console.log,
      warn: console.warn,
    };
    const capture = (...parts: readonly unknown[]) => {
      lines.push(parts.map((part) => (Predicate.isString(part) ? part : JSON.stringify(part))).join(' '));
    };
    console.debug = capture;
    console.error = capture;
    console.info = capture;
    console.log = capture;
    console.warn = capture;
    const result = yield* effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          Object.assign(console, saved);
        }),
      ),
    );
    return { lines, result };
  });

/** A short code is looked for as a whole word, so it cannot be "found" inside an identifier or a timestamp. */
const occursIn = (needle: string, haystack: string) =>
  needle.length < SHORT_SECRET_LENGTH
    ? new RegExp(`(?<![0-9A-Za-z])${needle}(?![0-9A-Za-z])`, 'u').test(haystack)
    : haystack.includes(needle);

/**
 * Proves nothing secret was stored, shown or logged: scans every stored row, the self-outbox payloads, the requests Auth made,
 * the safe history (list and detail of every intent) and the captured log lines for each of the given needles.
 */
export const expectNoSecretAnywhere = Effect.fn('AuthCommunicationsChecks.noSecret')(function* scan(
  world: AuthWorld,
  needles: readonly string[],
  logLines: readonly string[] = [],
) {
  const stored = JSON.stringify(yield* everyStoredRow(world));
  const outbox = JSON.stringify(world.outboxes);
  const requests = JSON.stringify(world.submissions);
  const reads = yield* historyReads(world);
  const page = yield* reads.list();
  const details = yield* Effect.forEach(page.items, ({ intentId }) => reads.detail(intentId), { concurrency: 1 });
  const shown = JSON.stringify([page, details]);
  const logs = logLines.join('\n');
  const found = needles.flatMap((needle) =>
    [
      ['rows', stored],
      ['outbox', outbox],
      ['requests', requests],
      ['history', shown],
      ['logs', logs],
    ].flatMap(([where, haystack]) =>
      haystack !== undefined && occursIn(needle, haystack) ? [`${where}: ${needle.slice(0, 4)}…`] : [],
    ),
  );
  return found;
});

/** The link or code the recipient sees in a delivered mail. Only the test, playing the inbox, reads it. */
export const textOf = (mail: { readonly text: Redacted.Redacted }) => Redacted.value(mail.text);
export const tokenFromLink = (text: string) => {
  // a reset link carries its token as a path segment, a verification link as a query parameter
  const match = /(?:[?&]token=|\/reset-password\/)(?<token>[^&?\s/]+)/u.exec(text);
  return Option.fromNullishOr(match?.groups?.token);
};
