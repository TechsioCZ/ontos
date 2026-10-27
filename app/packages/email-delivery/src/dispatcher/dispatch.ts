import { Context, Effect, Layer, Redacted } from 'effect';
import { EmailDeliveryService } from '../server.ts';
import { emailEnvironment, emailTransport } from '../transport.ts';
import type { EmailEnvironment, EmailTransportRuntime } from '../transport-runtime.ts';
import type { DeliveryOutcome, EmailDeliverySource, PlannedEmail } from './contract.ts';
import { claim, finish, readEnabledSince, recoverInterrupted } from './ledger.ts';
import {
  deliveryOutcomeOf,
  planAgendaEmails,
  planAkrosOrderEmails,
  planRentReminderEmail,
  planStorefrontInquiryEmail,
} from './plan.ts';
import { isUndeliverableRecipient, undeliverableDomainsFor } from './recipients.ts';
import { inDeliveryScope } from './scope.ts';
import type { DeliveryScope } from './scope.ts';
import { agendaSenderFor, senderFor } from './senders.ts';
import { planPersonInvitationEmail, readPersonInvitations } from './person-invitation.ts';
import type { PendingDelivery } from './sources.ts';
import {
  parseDeliveryId,
  readAgendaRecipients,
  readAkrosOrders,
  readPendingDeliveries,
  readRentReminders,
  readStorefrontInquiryTasks,
} from './sources.ts';

type OutgoingEmail = PlannedEmail & { readonly from: string };
export const DISPATCH_BATCH_SIZE = 10;

/** Called only after a ledger claim. Seeded fake recipients settle visibly as SKIPPED without touching the transport. */
export const submitEmail = Effect.fn('EmailDispatch.submitEmail')(function* submitPlannedEmail(
  planned: OutgoingEmail,
  transport: EmailTransportRuntime,
  environment: EmailEnvironment,
) {
  if (isUndeliverableRecipient(planned.recipient, undeliverableDomainsFor(transport.kind, environment))) {
    const skipped: DeliveryOutcome = { errorTag: 'undeliverable_recipient', status: 'SKIPPED' };
    return skipped;
  }
  const context = yield* Layer.build(transport.deliveryLayer(planned.from, planned.recipient));
  const service = Context.get(context, EmailDeliveryService);
  return yield* service
    .send({
      html: Redacted.make(planned.html),
      idempotencyKey: planned.dedupeKey,
      subject: planned.subject,
      text: Redacted.make(planned.text),
      to: planned.recipient,
    })
    .pipe(
      Effect.match({
        onFailure: deliveryOutcomeOf,
        onSuccess: (receipt): DeliveryOutcome => ({ messageId: receipt.id, status: 'SENT' }),
      }),
    );
}, Effect.scoped);

/** Work of one tenant + legal entity this tick: due delivery ids grouped by source subject. */
export interface ScopeWork {
  readonly keys: ReadonlySet<string>;
  readonly scope: DeliveryScope;
  readonly subjects: Readonly<Record<EmailDeliverySource, readonly string[]>>;
}

/**
 * Round-robin over sources (an order backlog cannot starve reminders or personal notifications), at most `limit`
 * deliveries, grouped by scope. An interrupted SENDING row arrives under its own key: its scope's transaction settles
 * it as UNKNOWN before planning, and the claim then refuses it.
 */
export const scheduleScopes = (pending: readonly PendingDelivery[], limit: number): readonly ScopeWork[] => {
  const lanes = new Map<EmailDeliverySource, { readonly item: PendingDelivery; readonly subjectId: string }[]>();
  for (const item of pending) {
    const parsed = parseDeliveryId(item.deliveryId);
    if (parsed === null) {
      continue;
    }
    lanes.set(parsed.source, [...(lanes.get(parsed.source) ?? []), { item, subjectId: parsed.subjectId }]);
  }
  const scopes = new Map<
    string,
    { keys: Set<string>; scope: DeliveryScope; subjects: Record<EmailDeliverySource, string[]> }
  >();
  let taken = 0;
  const rounds = Math.max(0, ...[...lanes.values()].map((lane) => lane.length));
  for (let index = 0; index < rounds; index += 1) {
    const round = [...lanes.entries()].flatMap(([source, lane]) => {
      const entry = lane[index];
      return entry === undefined ? [] : [{ ...entry, source }];
    });
    for (const { item, source, subjectId } of round) {
      if (taken >= limit) {
        return [...scopes.values()];
      }
      const id = `${item.tenantId}/${item.legalEntityId}`;
      const work = scopes.get(id) ?? {
        keys: new Set<string>(),
        scope: { legalEntityId: item.legalEntityId, tenantId: item.tenantId },
        subjects: {
          'akros-order': [],
          'facility-agenda': [],
          'person-invitation': [],
          'rent-reminder': [],
          'storefront-inquiry': [],
        },
      };
      scopes.set(id, work);
      if (work.keys.has(item.deliveryId)) {
        continue;
      }
      work.keys.add(item.deliveryId);
      taken += 1;
      if (!work.subjects[source].includes(subjectId)) {
        work.subjects[source].push(subjectId);
      }
    }
  }
  return [...scopes.values()];
};

/** Plans exactly the due e-mails of one scope. Must run inside inDeliveryScope(work.scope). */
const planScope = Effect.fn('EmailDispatch.planScope')(function* planScopeEmails(
  work: ScopeWork,
  enabledSince: string,
  transport: EmailTransportRuntime,
  environment: EmailEnvironment,
) {
  const { scope } = work;
  const appUrl = environment.ONTOS_PUBLIC_URL ?? 'http://localhost:3020';
  const orders = yield* readAkrosOrders(scope, work.subjects['akros-order']);
  const orderEmails = yield* Effect.forEach(
    orders,
    (order) =>
      senderFor(scope, 'AKROS', environment, transport.kind).pipe(
        Effect.map((from) =>
          planAkrosOrderEmails(order, {
            enabledSince,
            legalEntityId: scope.legalEntityId,
            storefrontUrl: environment.AKROS_STOREFRONT_PUBLIC_URL ?? 'http://localhost:3070',
            tenantId: scope.tenantId,
          }).map((email) => ({ ...email, from })),
        ),
      ),
    { concurrency: 1 },
  );
  const reminders = yield* readRentReminders(scope, work.subjects['rent-reminder']);
  const reminderEmails = yield* Effect.forEach(
    reminders,
    (reminder) => {
      const email = planRentReminderEmail(reminder, enabledSince);
      return email === null
        ? Effect.succeed([])
        : senderFor(email, reminder.legalName, environment, transport.kind).pipe(
            Effect.map((from) => [{ ...email, from }]),
          );
    },
    { concurrency: 1 },
  );
  const people = yield* readAgendaRecipients(scope, work.subjects['facility-agenda']);
  const agendaEmails = yield* Effect.forEach(
    people,
    (person) =>
      agendaSenderFor(person, environment, transport.kind).pipe(
        Effect.map((from) => planAgendaEmails(person, { appUrl, enabledSince }).map((email) => ({ ...email, from }))),
      ),
    { concurrency: 1 },
  );
  const tasks = yield* readStorefrontInquiryTasks(scope, work.subjects['storefront-inquiry']);
  const inquiryEmails = yield* Effect.forEach(
    tasks,
    (task) => {
      const email = planStorefrontInquiryEmail(task, {
        ...scope,
        appUrl,
        enabledSince,
        recipient: environment.AKROS_INQUIRY_EMAIL_TO ?? '',
      });
      return email === null
        ? Effect.succeed([])
        : senderFor(scope, 'AKROS', environment, transport.kind).pipe(Effect.map((from) => [{ ...email, from }]));
    },
    { concurrency: 1 },
  );
  const invitations = yield* readPersonInvitations(scope, work.subjects['person-invitation']);
  const invitationEmails = yield* Effect.forEach(
    invitations,
    (invitation) =>
      agendaSenderFor(invitation, environment, transport.kind).pipe(
        Effect.map((from) => ({ ...planPersonInvitationEmail(invitation, appUrl), from })),
      ),
    { concurrency: 1 },
  );
  return [
    ...orderEmails.flat(),
    ...reminderEmails.flat(),
    ...agendaEmails.flat(),
    ...inquiryEmails.flat(),
    ...invitationEmails,
  ].filter((email) => work.keys.has(email.dedupeKey));
});

export interface DispatchResult {
  readonly configured: boolean;
  readonly processed: number;
  readonly skipped: number;
}

/**
 * Same dispatcher in Node and workerd, as the runtime role under RLS. One cross-tenant read lists due delivery ids;
 * each scope then reads, claims (committed before its send, so a dead send is never repeated), sends and settles in
 * transactions bound to its tenant + legal entity. No runtime DDL, no retained DB sockets, no provider fallback.
 */
interface DispatchCounts {
  readonly processed: number;
  readonly skipped: number;
}
const sumCounts = (counts: readonly DispatchCounts[]): DispatchCounts => {
  let processed = 0;
  let skipped = 0;
  for (const count of counts) {
    processed += count.processed;
    skipped += count.skipped;
  }
  return { processed, skipped };
};

const dispatchClaimedEmail = Effect.fn('EmailDispatch.dispatchClaimedEmail')(function* sendClaimedEmail(
  scope: DeliveryScope,
  email: OutgoingEmail,
  transport: EmailTransportRuntime,
  environment: EmailEnvironment,
) {
  // Each claim commits before submission. An interrupted attempt leaves at most one ambiguous SENDING row.
  if (!(yield* inDeliveryScope(scope, claim(email)))) {
    return { processed: 0, skipped: 0 };
  }
  const outcome = yield* submitEmail(email, transport, environment);
  yield* inDeliveryScope(scope, finish(email.dedupeKey, outcome));
  return { processed: 1, skipped: outcome.status === 'SKIPPED' ? 1 : 0 };
});

const dispatchScope = Effect.fn('EmailDispatch.dispatchScope')(function* processScope(
  work: ScopeWork,
  enabledSince: string,
  transport: EmailTransportRuntime,
  environment: EmailEnvironment,
) {
  const planned = yield* inDeliveryScope(
    work.scope,
    recoverInterrupted.pipe(Effect.andThen(planScope(work, enabledSince, transport, environment))),
  );
  const counts = yield* Effect.forEach(
    planned,
    (email) => dispatchClaimedEmail(work.scope, email, transport, environment),
    { concurrency: 1 },
  );
  return sumCounts(counts);
});

export const dispatchEmailBatchWith = Effect.fn('EmailDispatch.dispatchEmailBatchWith')(function* dispatchBatch(
  transport: EmailTransportRuntime,
  environment: EmailEnvironment,
): Effect.fn.Return<
  DispatchResult,
  Effect.Error<ReturnType<typeof dispatchScope>>,
  Effect.Services<ReturnType<typeof dispatchScope>>
> {
  if (!transport.provider.configured) {
    return { configured: false, processed: 0, skipped: 0 };
  }
  const enabledSince = yield* readEnabledSince;
  const work = scheduleScopes(yield* readPendingDeliveries, DISPATCH_BATCH_SIZE);
  const counts = yield* Effect.forEach(work, (item) => dispatchScope(item, enabledSince, transport, environment), {
    concurrency: 1,
  });
  return { configured: true, ...sumCounts(counts) };
});

export const dispatchEmailBatch = Effect.gen(function* dispatchConfiguredEmailBatch() {
  const environment = yield* emailEnvironment;
  const transport = yield* emailTransport;
  return yield* dispatchEmailBatchWith(transport, environment);
});
