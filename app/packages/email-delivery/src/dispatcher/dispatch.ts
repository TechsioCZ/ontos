// @effect-diagnostics *:off
import { PgClient } from '@effect/sql-pg';
import { Effect, Redacted } from 'effect';
import { emailEnvironment, emailTransport } from '../transport.ts';
import type { EmailEnvironment, EmailTransportRuntime } from '../transport-runtime.ts';
import { AKROS_LEGAL_ENTITY_ID, DEMO_TENANT_ID } from './contract.ts';
import type { DeliveryOutcome, PlannedEmail } from './contract.ts';
import { claim, finish, readEnabledSince, recoverInterrupted } from './ledger.ts';
import { deliveryOutcomeOf, planAgendaEmails, planAkrosOrderEmails, planRentReminderEmail } from './plan.ts';
import { isUndeliverableRecipient } from './recipients.ts';
import { agendaSenderFor, senderFor } from './senders.ts';
import { readAgendaRecipients, readAkrosOrders, readRentReminders } from './sources.ts';

type OutgoingEmail = PlannedEmail & { readonly from: string };
export const DISPATCH_BATCH_SIZE = 10;

/** Called only after a ledger claim. Fake stage recipients settle visibly without touching the binding. */
export const submitEmail = (
  planned: OutgoingEmail,
  transport: EmailTransportRuntime,
  environment: EmailEnvironment,
): Effect.Effect<DeliveryOutcome> => {
  if (
    transport.kind === 'cloudflare' &&
    isUndeliverableRecipient(planned.recipient, environment['ONTOS_EMAIL_UNDELIVERABLE_DOMAINS'])
  ) {
    return Effect.succeed({ status: 'SKIPPED', errorTag: 'undeliverable_recipient' });
  }
  return transport
    .makeDelivery(planned.from, planned.recipient)
    .send({
      html: Redacted.make(planned.html),
      idempotencyKey: planned.dedupeKey,
      subject: planned.subject,
      text: Redacted.make(planned.text),
      to: planned.recipient,
    })
    .pipe(
      Effect.map((receipt): DeliveryOutcome => ({ messageId: receipt.id, status: 'SENT' })),
      Effect.catch((error) => Effect.succeed(deliveryOutcomeOf(error))),
    );
};

/** Same dispatcher in Node and workerd. No runtime DDL, no retained DB sockets, no provider fallback. */
export const dispatchEmailBatch = Effect.gen(function* () {
  if (!emailTransport.provider.configured) return { configured: false, processed: 0 };
  const enabledSince = yield* readEnabledSince;
  // Never recover another request's live submission. A dead send remains ambiguous, never retried.
  yield* recoverInterrupted;
  const environment = emailEnvironment;
  const akrosFrom = senderFor({ legalEntityId: AKROS_LEGAL_ENTITY_ID }, 'AKROS', environment, emailTransport.kind);
  const orders = (yield* readAkrosOrders(enabledSince)).flatMap((order) =>
    planAkrosOrderEmails(order, {
      enabledSince,
      legalEntityId: AKROS_LEGAL_ENTITY_ID,
      tenantId: DEMO_TENANT_ID,
      storefrontUrl: environment['AKROS_STOREFRONT_PUBLIC_URL'] ?? 'http://localhost:3070',
    }).map((email) => ({ ...email, from: akrosFrom })),
  );
  const reminders: OutgoingEmail[] = [];
  for (const reminder of yield* readRentReminders(enabledSince)) {
    const email = planRentReminderEmail(reminder, enabledSince);
    if (email !== null)
      reminders.push({ ...email, from: senderFor(email, reminder.legalName, environment, emailTransport.kind) });
  }
  const agenda = (yield* readAgendaRecipients(enabledSince)).flatMap((person) =>
    planAgendaEmails(person, { appUrl: environment['ONTOS_PUBLIC_URL'] ?? 'http://localhost:3020', enabledSince }).map(
      (email) => ({ ...email, from: agendaSenderFor(person, environment, emailTransport.kind) }),
    ),
  );
  // Interleave sources so an order backlog cannot starve reminders or personal notifications.
  const queue: OutgoingEmail[] = [];
  for (let index = 0; index < Math.max(orders.length, reminders.length, agenda.length); index++) {
    for (const lane of [orders, reminders, agenda]) {
      const email = lane[index];
      if (email !== undefined) queue.push(email);
    }
  }
  if (queue.length === 0) return { configured: true, processed: 0 };
  const sql = yield* PgClient.PgClient;
  const due = yield* sql<{ readonly key: string }>`
    select key from unnest(${queue.map((email) => email.dedupeKey)}::text[]) as key
    where not exists (select 1 from demo_email.deliveries d where d.dedupe_key = key
      and (d.status <> 'RETRY' or d.updated_at >= now() - make_interval(secs => least(60, 10 * power(2, least(d.attempts - 1, 3))))))`;
  const dueKeys = new Set(due.map((row) => row.key));
  let processed = 0;
  for (const email of queue) {
    if (processed >= DISPATCH_BATCH_SIZE) break;
    if (!dueKeys.has(email.dedupeKey) || !(yield* claim(email))) continue;
    const outcome = yield* submitEmail(email, emailTransport, environment);
    yield* finish(email.dedupeKey, outcome);
    processed++;
  }
  return { configured: true, processed };
});
