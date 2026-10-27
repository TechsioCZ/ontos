// Keeps the demo Mailpit inbox presentable after test runs. Deletes ONLY Mailpit copies of
//   - e-mails about AKROS orders that were removed from the demo (soft-deleted, `demoCleanup`), and
//   - e-mails to test/audit recipients (*.invalid, *.test, or audit/critic/fixer/test markers in the address).
// The delivery ledger (demo_email.deliveries) and all domain data stay untouched. Since the dispatcher routes test
// recipients to the separate test capture (:8026), this only clears mails from before that change or from foreign senders.
//   node --env-file=.env scripts/demo/email-dispatcher/tidy-inbox.mts           dry run (lists what would go)
//   node --env-file=.env scripts/demo/email-dispatcher/tidy-inbox.mts --apply   deletes
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { AKROS_LEGAL_ENTITY_ID, DEMO_TENANT_ID, isTestRecipient } from '@app/email-delivery/contract';
import { Config, Console, Effect, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http';
import { Reactivity } from 'effect/unstable/reactivity';

class MailpitFailure extends Schema.TaggedError<MailpitFailure>()('MailpitFailure', { message: Schema.String }) {}
const MailpitMessageSchema = Schema.Struct({
  Created: Schema.String,
  ID: Schema.String.pipe(Schema.brand('MailpitMessageId')),
  Subject: Schema.String,
  To: Schema.Array(Schema.Struct({ Address: Schema.String })),
});
const MailpitPageSchema = Schema.Struct({ messages: Schema.Array(MailpitMessageSchema), total: Schema.Int });
const DeleteSchema = Schema.Struct({ IDs: Schema.Array(MailpitMessageSchema.fields.ID) });
type MailpitMessage = typeof MailpitMessageSchema.Type;
const Database = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* databaseConnection() {
    return yield* PgClient.makeClient({ url: yield* Config.Redacted('DATABASE_ADMIN_URL') });
  }),
).pipe(Layer.provide(Reactivity.layer));
const removedOrderNumbers = Effect.gen(function* readRemovedOrders() {
  const sql = yield* PgClient.PgClient;
  const rows = yield* sql<{ readonly number: string }>`
    select number from demo_merchandise.orders
    where tenant_id = ${DEMO_TENANT_ID}::uuid and legal_entity_id = ${AKROS_LEGAL_ENTITY_ID}::uuid and removed`;
  return new Set(rows.map((row) => row.number));
});
const listMessages = (mailpit: string) =>
  Effect.gen(function* listInbox() {
    const http = yield* HttpClient.HttpClient;
    const all: MailpitMessage[] = [];
    for (let start = 0; ; start += 500) {
      const response = yield* http.get(`${mailpit}/api/v1/messages?start=${start}&limit=500`);
      if (response.status < 200 || response.status >= 300) {
        return yield* new MailpitFailure({ message: `Mailpit HTTP ${response.status}` });
      }
      const page = yield* HttpClientResponse.schemaBodyJson(MailpitPageSchema)(response);
      all.push(...page.messages);
      if (page.messages.length === 0 || all.length >= page.total) {
        return all;
      }
    }
  });
const main = (apply: boolean) =>
  Effect.gen(function* tidyInbox() {
    const mailpit = (yield* Config.String('MAILPIT_URL').pipe(Config.withDefault('http://127.0.0.1:8025'))).replace(
      /\/+$/u,
      '',
    );
    // The database scope ends before listing or deleting Mailpit messages.
    const removed = yield* Effect.scoped(
      Effect.gen(function* queryRemovedOrders() {
        const database = yield* Layer.build(Database);
        return yield* removedOrderNumbers.pipe(Effect.provideContext(database));
      }),
    );
    const messages = yield* listMessages(mailpit);
    const doomed = messages.filter((message) => {
      const order = /OBJ-\d{4}-\d{4}/u.exec(message.Subject)?.[0];
      return (order !== undefined && removed.has(order)) || message.To.some((to) => isTestRecipient(to.Address));
    });
    for (const message of doomed) {
      yield* Console.log(
        `${apply ? 'delete' : 'would delete'}  ${message.Created.slice(0, 16)}  ${message.To.map((to) => to.Address).join(', ')}  ${message.Subject}`,
      );
    }
    if (apply && doomed.length > 0) {
      const http = yield* HttpClient.HttpClient;
      for (let index = 0; index < doomed.length; index += 200) {
        const request = yield* HttpClientRequest.schemaBodyJson(DeleteSchema)(
          HttpClientRequest.delete(`${mailpit}/api/v1/messages`),
          {
            IDs: doomed.slice(index, index + 200).map((message) => message.ID),
          },
        );
        const response = yield* http.execute(request);
        if (response.status < 200 || response.status >= 300) {
          return yield* new MailpitFailure({ message: `Mailpit delete HTTP ${response.status}` });
        }
      }
    }
    yield* Console.log(
      `${messages.length} messages, ${doomed.length} ${apply ? 'deleted' : 'to delete (dry run, add --apply)'}, ${messages.length - doomed.length} kept`,
    );
    return yield* Effect.void;
  });
const command = Command.make('tidy-inbox', { apply: Flag.Boolean('apply') }, ({ apply }) => main(apply));
NodeRuntime.runMain(
  Command.run(command, { version: '1.0.0' }).pipe(
    Effect.scoped,
    Effect.provide(FetchHttpClient.layer),
    Effect.provide(NodeServices.layer),
  ),
);
