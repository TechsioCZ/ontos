// @effect-diagnostics *:off
// Demo e-mail dispatcher: after-commit worker that sends AKROS order e-mails and payment reminders (Siampark,
// Obchodní firma, …; always in the name of the issuing company) over real SMTP exactly once (ledger
// demo_email.deliveries), plus a read-only receipts API on 127.0.0.1 that checks who is asking.
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { PgClient } from '@effect/sql-pg';
import { Config, Effect, Layer, ManagedRuntime, Redacted } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { makeSmtpEmailDelivery, smtpConfigurationFromEnvironment } from '../../../packages/email-delivery/src/smtp.ts';
import { AKROS_LEGAL_ENTITY_ID, DEMO_TENANT_ID, EMAIL_DISPATCHER_DEFAULT_PORT, emailDeliverySources } from './contract.ts';
import type { DeliveryOutcome, EmailDeliverySource, PlannedEmail } from './contract.ts';
import type { DeliveryReadScope } from './ledger.ts';
import { claim, ensureLedger, finish, listDeliveries, listSettledKeys, readEnabledSince, recoverInterrupted } from './ledger.ts';
import { senderFor } from './senders.ts';
import { deliveryOutcomeOf, planAkrosOrderEmails, planSiamparkReminderEmail } from './plan.ts';
import { readAkrosOrders, readSiamparkReminders } from './sources.ts';

const env = process.env;
const port = Number(env['EMAIL_DISPATCHER_PORT'] ?? EMAIL_DISPATCHER_DEFAULT_PORT);
const intervalMs = Number(env['EMAIL_DISPATCHER_INTERVAL_MS'] ?? 2000);
const storefrontUrl = env['AKROS_STOREFRONT_PUBLIC_URL'] ?? 'http://localhost:3070';
const allowedOrigins = new Set((env['EMAIL_DISPATCHER_ALLOWED_ORIGINS'] ?? 'http://localhost:3020,http://127.0.0.1:3020').split(',').map((value) => value.trim()).filter((value) => value.length > 0));
const sessionUrl = env['EMAIL_DISPATCHER_SESSION_URL'] ?? 'http://127.0.0.1:3020/shell-super-app-api/auth/session';
const smtp = smtpConfigurationFromEnvironment(env);
/** One SMTP transport per sender (From), created on first use. */
const transports = new Map<string, ReturnType<typeof makeSmtpEmailDelivery>>();
const transportFor = (from: string) => {
  let transport = transports.get(from);
  if (transport === undefined) {
    transport = makeSmtpEmailDelivery({ ...smtp, from });
    transports.set(from, transport);
  }
  return transport;
};
type OutgoingEmail = PlannedEmail & { readonly from: string };
const AdminDatabaseLive = Layer.effect(PgClient.PgClient, Effect.gen(function* adminClient() {
  return yield* PgClient.makeClient({ url: yield* Config.Redacted('DATABASE_ADMIN_URL') });
})).pipe(Layer.provide(Reactivity.layer));
const runtime = ManagedRuntime.make(AdminDatabaseLive);
const settled = new Set<string>();

const deliver = async (planned: OutgoingEmail): Promise<void> => {
  if (settled.has(planned.dedupeKey)) return;
  if (!(await runtime.runPromise(claim(planned)))) return;
  const outcome: DeliveryOutcome = await Effect.runPromise(
    transportFor(planned.from)
      .send({ html: Redacted.make(planned.html), idempotencyKey: planned.dedupeKey, subject: planned.subject, text: Redacted.make(planned.text), to: planned.recipient })
      .pipe(
        Effect.map((receipt): DeliveryOutcome => ({ messageId: receipt.id, status: 'SENT' })),
        Effect.catch((error) => Effect.succeed(deliveryOutcomeOf(error))),
      ),
  );
  await runtime.runPromise(finish(planned.dedupeKey, outcome));
  if (outcome.status !== 'RETRY') settled.add(planned.dedupeKey);
  console.log(`[email] ${planned.dedupeKey} -> ${outcome.status}${outcome.status === 'SENT' ? '' : ` (${outcome.errorTag})`}`);
};

const cycle = async (enabledSince: string): Promise<void> => {
  const planned: OutgoingEmail[] = [];
  const akrosFrom = senderFor({ legalEntityId: AKROS_LEGAL_ENTITY_ID }, 'AKROS', env);
  for (const order of await runtime.runPromise(readAkrosOrders(enabledSince))) {
    for (const email of planAkrosOrderEmails(order, { enabledSince, legalEntityId: AKROS_LEGAL_ENTITY_ID, storefrontUrl, tenantId: DEMO_TENANT_ID })) {
      planned.push({ ...email, from: akrosFrom });
    }
  }
  for (const reminder of await runtime.runPromise(readSiamparkReminders(enabledSince))) {
    const email = planSiamparkReminderEmail(reminder, enabledSince);
    if (email !== null) planned.push({ ...email, from: senderFor(email, reminder.legalName, env) });
  }
  for (const email of planned) {
    try { await deliver(email); } catch (error) { console.error(`[email] ${email.dedupeKey} failed`, error); }
  }
};

const reply = (response: ServerResponse, status: number, body: unknown, origin: string | undefined): void => {
  const headers: Record<string, string> = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' };
  if (origin !== undefined && allowedOrigins.has(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-credentials'] = 'true';
    headers['vary'] = 'Origin';
  }
  response.writeHead(status, headers);
  response.end(body === null ? undefined : JSON.stringify(body));
};

type SessionCheck = { readonly at: number; readonly scope: DeliveryReadScope | null };
const sessionCache = new Map<string, SessionCheck>();
const SESSION_TTL_MS = 15_000;

/** Verifies the OntOS session cookie with the shell; returns the caller's company scope or null (not signed in). */
const companyScopeOf = async (cookie: string): Promise<DeliveryReadScope | null> => {
  const cached = sessionCache.get(cookie);
  if (cached !== undefined && Date.now() - cached.at < SESSION_TTL_MS) return cached.scope;
  const upstream = await fetch(sessionUrl, { headers: { accept: 'application/json', cookie }, signal: AbortSignal.timeout(5000) });
  if (!upstream.ok) throw new Error(`session HTTP ${upstream.status}`);
  const body = (await upstream.json()) as { readonly identity?: { readonly legalEntityId?: unknown; readonly tenantId?: unknown }; readonly state?: unknown };
  const identity = body.identity;
  const scope: DeliveryReadScope | null =
    body.state === 'authenticated' && typeof identity?.tenantId === 'string' && typeof identity.legalEntityId === 'string'
      ? { kind: 'company', legalEntityId: identity.legalEntityId, tenantId: identity.tenantId }
      : null;
  if (sessionCache.size > 500) sessionCache.clear();
  sessionCache.set(cookie, { at: Date.now(), scope });
  return scope;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const server = createServer((request, response) => {
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'OPTIONS') {
    if (origin !== undefined && allowedOrigins.has(origin)) { response.setHeader('access-control-allow-methods', 'GET'); response.setHeader('access-control-max-age', '600'); }
    reply(response, 204, null, origin);
    return;
  }
  if (request.method !== 'GET') { reply(response, 405, { error: 'method_not_allowed' }, origin); return; }
  if (url.pathname === '/healthz') { reply(response, 200, { ok: true, smtp: { host: smtp.host, port: smtp.port } }, origin); return; }
  if (url.pathname !== '/v1/deliveries') { reply(response, 404, { error: 'not_found' }, origin); return; }
  const source = url.searchParams.get('source') ?? '';
  const subjectIds = url.searchParams.getAll('subjectId');
  const subjectNumbers = url.searchParams.getAll('subjectNumber');
  const all = [...subjectIds, ...subjectNumbers];
  if (!emailDeliverySources.includes(source as EmailDeliverySource) || all.length === 0 || all.length > 200 || all.some((value) => value.length === 0 || value.length > 120)) {
    reply(response, 400, { error: 'invalid_query' }, origin);
    return;
  }
  const recipient = url.searchParams.get('recipient');
  const cookie = typeof request.headers.cookie === 'string' ? request.headers.cookie : '';
  const resolveScope = async (): Promise<DeliveryReadScope | 'forbidden'> => {
    // Buyer: exactly one order number plus the e-mail address the order was placed with (AKROS storefront BFF).
    if (recipient !== null) {
      return source === 'akros-order' && subjectIds.length === 0 && subjectNumbers.length === 1 && recipient.length <= 254 && EMAIL_PATTERN.test(recipient.trim())
        ? { kind: 'buyer', recipient }
        : 'forbidden';
    }
    // Staff: signed-in OntOS session; only rows of the session's tenant and selected company.
    if (cookie === '') return 'forbidden';
    return (await companyScopeOf(cookie)) ?? 'forbidden';
  };
  resolveScope().then(
    async (scope) => {
      if (scope === 'forbidden') { reply(response, 401, { error: 'authentication_required' }, origin); return; }
      const deliveries = await runtime.runPromise(listDeliveries({ scope, source: source as EmailDeliverySource, subjectIds, subjectNumbers }));
      reply(response, 200, { deliveries }, origin);
    },
  ).catch((error: unknown) => { console.error('[email] receipts read failed', error); reply(response, 503, { error: 'receipts_unavailable' }, origin); });
});

const main = async (): Promise<void> => {
  await runtime.runPromise(ensureLedger);
  const recovered = await runtime.runPromise(recoverInterrupted);
  if (recovered > 0) console.warn(`[email] ${recovered} interrupted deliveries marked UNKNOWN (never resent)`);
  const enabledSince = await runtime.runPromise(readEnabledSince);
  for (const key of await runtime.runPromise(listSettledKeys)) settled.add(key);
  await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', () => resolve()); });
  console.log(`[email] dispatcher on http://127.0.0.1:${port}; SMTP ${smtp.host}:${smtp.port}; e-mails for events since ${enabledSince}`);
  let stopping = false;
  const stop = (): void => { stopping = true; server.close(); setTimeout(() => process.exit(0), 8000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  while (!stopping) {
    try { await cycle(enabledSince); } catch (error) { console.error('[email] cycle failed', error); }
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
  await runtime.dispose();
  process.exit(0);
};

main().catch((error: unknown) => {
  console.error('[email] dispatcher failed to start', error);
  process.exit(1);
});
