// Scoped, optimistic demo-fixture repair. Never reseeds, deletes, rewrites payments or changes historical exports.
import { PgClient } from '@effect/sql-pg';
import { NodeCrypto, NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Crypto, DateTime, Effect, FileSystem, Layer, Path, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { Hex } from 'effect/encoding';
import { FinanceStateSchema } from '../shared/apis/records.ts';
import { transitionFinance } from '../src/services/persistence.service.ts';
import { alignRentalTemplates } from './align-rental-templates.ts';

const tenant = '70000000-0000-4000-8000-000000000020';
const entity = '71000000-0000-4000-8000-000000000021';
const admin = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* admin() {
    return yield* PgClient.makeClient({ url: yield* Config.Redacted('DATABASE_ADMIN_URL') });
  }),
).pipe(Layer.provide(Reactivity.layer));
const program = Effect.gen(function* repair() {
  const sql = yield* PgClient.PgClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const [row] = yield* sql<{
    revision: number;
    state: unknown;
  }>`select revision,state from finance_billing.finance_states where tenant_id=${tenant} and legal_entity_id=${entity}`;
  if (row === undefined) {
    return yield* Effect.die('Missing Siampark finance state');
  }
  const original = yield* Schema.decodeUnknownEffect(FinanceStateSchema)(row.state);
  let state = alignRentalTemplates(original);
  const writes: { content: string; id: string }[] = [];
  const repairedAt = yield* DateTime.now;
  state = {
    ...state,
    documents: yield* Effect.forEach(
      state.documents ?? [],
      (document) =>
        Effect.gen(function* repairDocument() {
          const invoice = state.invoices.find((entry) => entry.ref.resourceId === document.invoiceResourceId);
          if (invoice?.note?.includes('demo-v2-seed') !== true || invoice.direction !== 'INCOMING') {
            return document;
          }
          const file = yield* path.fromFileUrl(
            new URL(`fixtures/${invoice.documentNumber.replaceAll('/', '-')}.pdf`, import.meta.url),
          );
          const bytes = yield* fs.readFile(file);
          writes.push({ content: Buffer.from(bytes).toString('base64'), id: document.id });
          return {
            ...document,
            actorLabel: 'Finance · oprava DEMO dokladu',
            sha256: Hex.encode(yield* crypto.digest('SHA-256', bytes)),
            sizeBytes: bytes.length,
            uploadedAt: repairedAt,
          };
        }),
      { concurrency: 1 },
    ),
  };
  // New version, not an in-place mutation of an accountant's historical signed/hash-verified snapshot.
  const previous = state.accountingExports?.at(-1);
  if (previous !== undefined && !previous.content.includes('http://localhost:3020/cs/finance?resourceId=')) {
    const now = yield* DateTime.now;
    const result = yield* transitionFinance(
      state,
      {
        _tag: 'CreateAccountingExport',
        actorLabel: 'Finance · oprava odkazů na doklady',
        format: 'CSV',
        invoiceResourceIds: previous.invoiceResourceIds,
      },
      { legalEntityId: entity, tenantId: tenant },
      { invoice: () => Effect.void },
      {
        attemptId: yield* crypto.randomUUIDv4(),
        now,
        principalId: '72000000-0000-4000-8000-000000000023',
        resourceId: yield* crypto.randomUUIDv4(),
      },
    );
    ({ state } = result);
  }
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(FinanceStateSchema))(state);
  yield* sql.withTransaction(
    Effect.gen(function* transaction() {
      const updated =
        yield* sql`update finance_billing.finance_states set state=${encoded}::jsonb,revision=revision+1,updated_at=now() where tenant_id=${tenant} and legal_entity_id=${entity} and revision=${row.revision} returning revision`;
      if (updated.length !== 1) {
        return yield* Effect.die('Finance changed concurrently; retry the scoped repair');
      }
      return yield* Effect.forEach(
        writes,
        (write) =>
          sql`update finance_billing.finance_document_contents set content_base64=${write.content} where tenant_id=${tenant} and legal_entity_id=${entity} and document_id=${write.id}`,
        { concurrency: 1, discard: true },
      );
    }),
  );
  return yield* Console.log(
    `Repaired scoped finance revision ${row.revision + 1}; ${writes.length} Czech PDFs; latest handover ${state.accountingExports?.at(-1)?.batchNumber}. Historical packages/payment observations preserved.`,
  );
});
const runtimeLive = Layer.effectDiscard(program).pipe(
  Layer.provide(Layer.mergeAll(admin, NodeServices.layer, NodeCrypto.layer)),
);
NodeRuntime.runMain(Effect.scoped(Layer.build(runtimeLive)));
