// Keeps the demo Mailpit inbox presentable after test runs. Deletes ONLY Mailpit copies of
//   - e-mails about AKROS orders that were removed from the demo (soft-deleted, `demoCleanup`), and
//   - e-mails to test/audit recipients (*.invalid, *.test, or audit/critic/fixer/test markers in the address).
// The delivery ledger (demo_email.deliveries) and all domain data stay untouched. Since the dispatcher routes test
// recipients to the separate test capture (:8026), this only clears mails from before that change or from foreign senders.
//   node --env-file=.env scripts/demo/email-dispatcher/tidy-inbox.mts           dry run (lists what would go)
//   node --env-file=.env scripts/demo/email-dispatcher/tidy-inbox.mts --apply   deletes
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Config, Console, Effect, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { AKROS_LEGAL_ENTITY_ID, DEMO_TENANT_ID } from '../../../packages/email-delivery/src/dispatcher/contract.ts';
import { isTestRecipient } from '../../../packages/email-delivery/src/dispatcher/recipients.ts';

export const MailpitMessageSchema = Schema.Struct({
  Created: Schema.String,
  ID: Schema.String,
  Subject: Schema.String,
  To: Schema.Array(Schema.Struct({ Address: Schema.String })),
});
type MailpitMessage = typeof MailpitMessageSchema.Type;
const pageSchema = Schema.Struct({ messages: Schema.Array(MailpitMessageSchema), total: Schema.Number });
const deleteSchema = Schema.Struct({ IDs: Schema.Array(Schema.String) });

const DatabaseLive = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* databaseLive() {
    return yield* PgClient.makeClient({ url: yield* Config.Redacted('DATABASE_ADMIN_URL') });
  }),
).pipe(Layer.provide(Reactivity.layer));

const removedOrderNumbers = Effect.gen(function* removedOrderNumbers() {
  const sql = yield* PgClient.PgClient;
  const rows = yield* sql<{ readonly number: string }>`
    select number from demo_merchandise.orders
    where tenant_id = ${DEMO_TENANT_ID}::uuid and legal_entity_id = ${AKROS_LEGAL_ENTITY_ID}::uuid and removed`;
  return new Set(rows.map((row) => row.number));
});

export const listMessages = Effect.fn('tidyInbox.listMessages')(function* listMailpitMessages(mailpit: string) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const all: MailpitMessage[] = [];
  for (let start = 0; ; start += 500) {
    const page = yield* client
      .get(`${mailpit}/api/v1/messages?start=${start}&limit=500`)
      .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(pageSchema)), Effect.timeout('30 seconds'));
    all.push(...page.messages);
    if (page.messages.length === 0 || all.length >= page.total) {
      return all;
    }
  }
});

export const messagesToDelete = (messages: readonly MailpitMessage[], removed: ReadonlySet<string>) =>
  messages.filter((message) => {
    const order = /OBJ-\d{4}-\d{4}/u.exec(message.Subject)?.[0];
    return (order !== undefined && removed.has(order)) || message.To.some((to) => isTestRecipient(to.Address));
  });

export const deleteMessages = Effect.fn('tidyInbox.deleteMessages')(function* deleteMailpitMessages(
  mailpit: string,
  messages: readonly MailpitMessage[],
) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  for (let index = 0; index < messages.length; index += 200) {
    const request = yield* HttpClientRequest.schemaBodyJson(deleteSchema)(
      HttpClientRequest.make('DELETE')(`${mailpit}/api/v1/messages`),
      { IDs: messages.slice(index, index + 200).map((message) => message.ID) },
    );
    yield* client.execute(request).pipe(Effect.timeout('30 seconds'));
  }
});

const tidyInbox = Effect.fn('tidyInbox.run')(function* runTidyInbox(apply: boolean) {
  const mailpit = yield* Config.String('MAILPIT_URL').pipe(
    Config.withDefault('http://127.0.0.1:8025'),
    Config.map((url) => url.replace(/\/+$/u, '')),
  );
  const removed = yield* removedOrderNumbers;
  const messages = yield* listMessages(mailpit);
  const doomed = messagesToDelete(messages, removed);
  for (const message of doomed) {
    yield* Console.log(
      `${apply ? 'delete' : 'would delete'}  ${message.Created.slice(0, 16)}  ${message.To.map((to) => to.Address).join(', ')}  ${message.Subject}`,
    );
  }
  if (apply && doomed.length > 0) {
    yield* deleteMessages(mailpit, doomed);
  }
  yield* Console.log(
    `${messages.length} messages, ${doomed.length} ${apply ? 'deleted' : 'to delete (dry run, add --apply)'}, ${messages.length - doomed.length} kept`,
  );
});
const command = Command.make(
  'tidy-inbox',
  { apply: Flag.Boolean('apply').pipe(Flag.withDefault(false)) },
  ({ apply }) => tidyInbox(apply),
);
if (import.meta.main) {
  NodeRuntime.runMain(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(Layer.mergeAll(DatabaseLive, NodeServices.layer, FetchHttpClient.layer)),
      Effect.scoped,
    ),
  );
}
