// @effect-diagnostics *:off
// Demo e-mail dispatcher: after-commit worker that sends AKROS order e-mails and Siampark payment reminders over
// real SMTP exactly once (ledger demo_email.deliveries), plus a read-only receipts API on 127.0.0.1.
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { PgClient } from '@effect/sql-pg';
import { Config, Effect, Layer, ManagedRuntime, Redacted } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { makeSmtpEmailDelivery, smtpConfigurationFromEnvironment } from '../../../packages/email-delivery/src/smtp.ts';
import { AKROS_LEGAL_ENTITY_ID, DEMO_TENANT_ID, EMAIL_DISPATCHER_DEFAULT_PORT, emailDeliverySources } from './contract.ts';
import type { DeliveryOutcome, EmailDeliverySource, PlannedEmail } from './contract.ts';
import { claim, ensureLedger, finish, listDeliveries, listSettledKeys, readEnabledSince, recoverInterrupted } from './ledger.ts';
import { deliveryOutcomeOf, planAkrosOrderEmails, planSiamparkReminderEmail } from './plan.ts';
import { readAkrosOrders, readSiamparkReminders } from './sources.ts';

const env = process.env;
const port = Number(env['EMAIL_DISPATCHER_PORT'] ?? EMAIL_DISPATCHER_DEFAULT_PORT);
const intervalMs = Number(env['EMAIL_DISPATCHER_INTERVAL_MS'] ?? 2000);
const storefrontUrl = env['AKROS_STOREFRONT_PUBLIC_URL'] ?? 'http://localhost:3070';
const allowedOrigins = new Set((env['EMAIL_DISPATCHER_ALLOWED_ORIGINS'] ?? 'http://localhost:3020,http://127.0.0.1:3020').split(',').map((value) => value.trim()).filter((value) => value.length > 0));
const smtp = smtpConfigurationFromEnvironment(env);
const transports = {
  'akros-order': makeSmtpEmailDelivery({ ...smtp, from: env['AKROS_EMAIL_FROM'] ?? 'AKROS e-shop <eshop@akros.demo>' }),
  'siampark-reminder': makeSmtpEmailDelivery({ ...smtp, from: env['SIAMPARK_EMAIL_FROM'] ?? 'Siampark – finanční oddělení <finance@siampark.demo>' }),
} as const;
const AdminDatabaseLive = Layer.effect(PgClient.PgClient, Effect.gen(function* adminClient() {
  return yield* PgClient.makeClient({ url: yield* Config.Redacted('DATABASE_ADMIN_URL') });
})).pipe(Layer.provide(Reactivity.layer));
const runtime = ManagedRuntime.make(AdminDatabaseLive);
const settled = new Set<string>();

const deliver = async (planned: PlannedEmail): Promise<void> => {
  if (settled.has(planned.dedupeKey)) return;
  if (!(await runtime.runPromise(claim(planned)))) return;
  const outcome: DeliveryOutcome = await Effect.runPromise(
    transports[planned.source]
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
  const planned: PlannedEmail[] = [];
  for (const order of await runtime.runPromise(readAkrosOrders(enabledSince))) {
    planned.push(...planAkrosOrderEmails(order, { enabledSince, legalEntityId: AKROS_LEGAL_ENTITY_ID, storefrontUrl, tenantId: DEMO_TENANT_ID }));
  }
  for (const reminder of await runtime.runPromise(readSiamparkReminders(enabledSince))) {
    const email = planSiamparkReminderEmail(reminder, enabledSince);
    if (email !== null) planned.push(email);
  }
  for (const email of planned) {
    try { await deliver(email); } catch (error) { console.error(`[email] ${email.dedupeKey} failed`, error); }
  }
};

const reply = (response: ServerResponse, status: number, body: unknown, origin: string | undefined): void => {
  const headers: Record<string, string> = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' };
  if (origin !== undefined && allowedOrigins.has(origin)) { headers['access-control-allow-origin'] = origin; headers['vary'] = 'Origin'; }
  response.writeHead(status, headers);
  response.end(body === null ? undefined : JSON.stringify(body));
};

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
  runtime.runPromise(listDeliveries({ source: source as EmailDeliverySource, subjectIds, subjectNumbers })).then(
    (deliveries) => { reply(response, 200, { deliveries }, origin); },
    (error: unknown) => { console.error('[email] receipts read failed', error); reply(response, 503, { error: 'ledger_unavailable' }, origin); },
  );
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
