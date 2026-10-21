// @effect-diagnostics *:off
// Keeps the demo Mailpit inbox presentable after test runs. Deletes ONLY Mailpit copies of
//   - e-mails about AKROS orders that were removed from the demo (soft-deleted, `demoCleanup`), and
//   - e-mails to test/audit recipients (*.invalid, *.test, or audit/critic/fixer/test markers in the address).
// The delivery ledger (demo_email.deliveries) and all domain data stay untouched.
//   node --env-file=.env scripts/demo/email-dispatcher/tidy-inbox.mts           dry run (lists what would go)
//   node --env-file=.env scripts/demo/email-dispatcher/tidy-inbox.mts --apply   deletes
import { PgClient } from '@effect/sql-pg';
import { Config, Effect, Layer, ManagedRuntime } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { AKROS_LEGAL_ENTITY_ID, DEMO_TENANT_ID } from './contract.ts';

const mailpit = (process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:8025').replace(/\/+$/u, '');
const apply = process.argv.includes('--apply');

interface MailpitMessage {
  readonly Created: string;
  readonly ID: string;
  readonly Subject: string;
  readonly To: readonly { readonly Address: string }[];
}

/** Reserved test domains and the markers QA personas use in their addresses. */
export const isTestRecipient = (address: string): boolean => {
  const value = address.trim().toLowerCase();
  const domain = value.slice(value.lastIndexOf('@') + 1);
  return (
    domain.endsWith('.invalid') ||
    domain.endsWith('.test') ||
    domain === 'audit.example' ||
    /(audit|critic|kritik|fixer|reqsol|reqx|test)/u.test(value.slice(0, value.lastIndexOf('@')))
  );
};

const Database = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* () {
    return yield* PgClient.makeClient({ url: yield* Config.Redacted('DATABASE_ADMIN_URL') });
  }),
).pipe(Layer.provide(Reactivity.layer));

const removedOrderNumbers = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const rows = yield* sql<{ readonly number: string }>`
    select o->>'number' as "number"
    from demo_merchandise.merchandise_states s, jsonb_array_elements(coalesce(s.state->'orders', '[]'::jsonb)) o
    where s.tenant_id = ${DEMO_TENANT_ID}::uuid and s.legal_entity_id = ${AKROS_LEGAL_ENTITY_ID}::uuid
      and o ? 'demoCleanup'`;
  return new Set(rows.map((row) => row.number));
});

const listMessages = async (): Promise<readonly MailpitMessage[]> => {
  const all: MailpitMessage[] = [];
  for (let start = 0; ; start += 500) {
    const response = await fetch(`${mailpit}/api/v1/messages?start=${start}&limit=500`);
    if (!response.ok) throw new Error(`Mailpit HTTP ${response.status}`);
    const page = (await response.json()) as { readonly messages: readonly MailpitMessage[]; readonly total: number };
    all.push(...page.messages);
    if (page.messages.length === 0 || all.length >= page.total) return all;
  }
};

const main = async () => {
  const runtime = ManagedRuntime.make(Database);
  const removed = await runtime.runPromise(removedOrderNumbers);
  await runtime.dispose();
  const messages = await listMessages();
  const doomed = messages.filter((message) => {
    const order = /OBJ-\d{4}-\d{4}/u.exec(message.Subject)?.[0];
    return (order !== undefined && removed.has(order)) || message.To.some((to) => isTestRecipient(to.Address));
  });
  for (const message of doomed) {
    console.log(`${apply ? 'delete' : 'would delete'}  ${message.Created.slice(0, 16)}  ${message.To.map((to) => to.Address).join(', ')}  ${message.Subject}`);
  }
  if (apply && doomed.length > 0) {
    for (let index = 0; index < doomed.length; index += 200) {
      const response = await fetch(`${mailpit}/api/v1/messages`, {
        body: JSON.stringify({ IDs: doomed.slice(index, index + 200).map((message) => message.ID) }),
        headers: { 'content-type': 'application/json' },
        method: 'DELETE',
      });
      if (!response.ok) throw new Error(`Mailpit delete HTTP ${response.status}`);
    }
  }
  console.log(`${messages.length} messages, ${doomed.length} ${apply ? 'deleted' : 'to delete (dry run, add --apply)'}, ${messages.length - doomed.length} kept`);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
