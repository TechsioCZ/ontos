// @effect-diagnostics *:off
import { Effect, Redacted } from 'effect';
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
export const submitEmail = (
  planned: OutgoingEmail,
  transport: EmailTransportRuntime,
  environment: EmailEnvironment,
): Effect.Effect<DeliveryOutcome> => {
  if (isUndeliverableRecipient(planned.recipient, undeliverableDomainsFor(transport.kind, environment))) {
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
    if (parsed === null) continue;
    lanes.set(parsed.source, [...(lanes.get(parsed.source) ?? []), { item, subjectId: parsed.subjectId }]);
  }
  const scopes = new Map<
    string,
    { keys: Set<string>; scope: DeliveryScope; subjects: Record<EmailDeliverySource, string[]> }
  >();
  let taken = 0;
  for (let index = 0; taken < limit; index++) {
    const round = [...lanes.entries()].flatMap(([source, lane]) => {
      const entry = lane[index];
      return entry === undefined ? [] : [{ ...entry, source }];
    });
    if (round.length === 0) break;
    for (const { item, source, subjectId } of round) {
      if (taken >= limit) break;
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
      if (work.keys.has(item.deliveryId)) continue;
      work.keys.add(item.deliveryId);
      taken++;
      if (!work.subjects[source].includes(subjectId)) work.subjects[source].push(subjectId);
    }
  }
  return [...scopes.values()];
};

/** Plans exactly the due e-mails of one scope. Must run inside inDeliveryScope(work.scope). */
const planScope = (
  work: ScopeWork,
  enabledSince: string,
  transport: EmailTransportRuntime,
  environment: EmailEnvironment,
) =>
  Effect.gen(function* () {
    const { scope } = work;
    const appUrl = environment['ONTOS_PUBLIC_URL'] ?? 'http://localhost:3020';
    const planned: OutgoingEmail[] = [];
    const orders = yield* readAkrosOrders(scope, work.subjects['akros-order']);
    for (const order of orders) {
      const from = senderFor(scope, 'AKROS', environment, transport.kind);
      for (const email of planAkrosOrderEmails(order, {
        enabledSince,
        legalEntityId: scope.legalEntityId,
        storefrontUrl: environment['AKROS_STOREFRONT_PUBLIC_URL'] ?? 'http://localhost:3070',
        tenantId: scope.tenantId,
      }))
        planned.push({ ...email, from });
    }
    for (const reminder of yield* readRentReminders(scope, work.subjects['rent-reminder'])) {
      const email = planRentReminderEmail(reminder, enabledSince);
      if (email !== null)
        planned.push({ ...email, from: senderFor(email, reminder.legalName, environment, transport.kind) });
    }
    for (const person of yield* readAgendaRecipients(scope, work.subjects['facility-agenda'])) {
      const from = agendaSenderFor(person, environment, transport.kind);
      for (const email of planAgendaEmails(person, {
        appUrl,
        enabledSince,
      }))
        planned.push({ ...email, from });
    }
    for (const task of yield* readStorefrontInquiryTasks(scope, work.subjects['storefront-inquiry'])) {
      const email = planStorefrontInquiryEmail(task, {
        ...scope,
        appUrl,
        enabledSince,
        recipient: environment.AKROS_INQUIRY_EMAIL_TO ?? '',
      });
      if (email !== null) {
        planned.push({ ...email, from: senderFor(scope, 'AKROS', environment, transport.kind) });
      }
    }
    const invitations = yield* readPersonInvitations(scope, work.subjects['person-invitation']);
    planned.push(...invitations.map((invitation) => ({
      ...planPersonInvitationEmail(invitation, appUrl),
      from: agendaSenderFor(invitation, environment, transport.kind),
    })));
    return planned.filter((email) => work.keys.has(email.dedupeKey));
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
export const dispatchEmailBatchWith = (transport: EmailTransportRuntime, environment: EmailEnvironment) =>
  Effect.gen(function* () {
    if (!transport.provider.configured) return { configured: false, processed: 0, skipped: 0 } as DispatchResult;
    const enabledSince = yield* readEnabledSince;
    const work = scheduleScopes(yield* readPendingDeliveries, DISPATCH_BATCH_SIZE);
    let processed = 0;
    let skipped = 0;
    for (const scopeWork of work) {
      const planned = yield* inDeliveryScope(
        scopeWork.scope,
        Effect.gen(function* () {
          // Never recover another request's live submission. A dead send remains ambiguous, never retried.
          yield* recoverInterrupted;
          return yield* planScope(scopeWork, enabledSince, transport, environment);
        }),
      );
      for (const email of planned) {
        // Claim, send, settle one at a time: an interrupted request leaves at most one row ambiguous.
        if (!(yield* inDeliveryScope(scopeWork.scope, claim(email)))) continue;
        const outcome = yield* submitEmail(email, transport, environment);
        yield* inDeliveryScope(scopeWork.scope, finish(email.dedupeKey, outcome));
        processed++;
        if (outcome.status === 'SKIPPED') skipped++;
      }
    }
    return { configured: true, processed, skipped } as DispatchResult;
  });

export const dispatchEmailBatch = dispatchEmailBatchWith(emailTransport, emailEnvironment);
