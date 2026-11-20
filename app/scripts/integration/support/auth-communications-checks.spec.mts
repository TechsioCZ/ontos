import { Effect, Option, Predicate, Redacted } from 'effect';

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

/**
 * Every row of EVERY table of the `communications` schema (enumerated from the database catalog, so no table is left out
 * by a hand list) and of Core's real outbox tables (`core.outbox_messages`, `core.outbox_deliveries`), as the runtime role
 * sees them for the world's Tenant. The in-process messages the Action collector held are scanned separately as `outboxes`.
 */
export const everyStoredRow = (world: AuthWorld) =>
  world.database.everyRowOf(world.tenantId, {
    schemas: ['communications'],
    tables: ['core.outbox_messages', 'core.outbox_deliveries'],
  });

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
 * Proves nothing secret was stored, shown or logged: scans every row of every table of the communications schema, the
 * real Core outbox rows of the Tenant, the outbox payloads the Action collected in process, the requests Auth made,
 * the safe history (list and detail of every intent) and the captured log lines for each of the given needles.
 */
export const expectNoSecretAnywhere = Effect.fn('AuthCommunicationsChecks.noSecret')(function* scan(
  world: AuthWorld,
  needles: readonly string[],
  logLines: readonly string[] = [],
) {
  const tables = yield* everyStoredRow(world);
  const stored = JSON.stringify(tables);
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
  // A scan over no communications table at all proves nothing, so it is itself a finding.
  return tables.some(({ table }) => table.startsWith('communications.')) ? found : [...found, 'rows: no table scanned'];
});

/** The link or code the recipient sees in a delivered mail. Only the test, playing the inbox, reads it. */
export const textOf = (mail: { readonly text: Redacted.Redacted }) => Redacted.value(mail.text);
export const tokenFromLink = (text: string) => {
  // a reset link carries its token as a path segment, a verification link as a query parameter
  const match = /(?:[?&]token=|\/reset-password\/)(?<token>[^&?\s/]+)/u.exec(text);
  return Option.fromNullishOr(match?.groups?.token);
};
