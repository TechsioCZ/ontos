// Scoped, optimistic demo-fixture repair. Never reseeds, deletes, rewrites payments or changes historical exports.
import { PgClient } from '@effect/sql-pg';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Crypto, DateTime, Effect, Encoding, FileSystem, Layer, Path, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { FinanceStateSchema } from '../shared/apis/records.ts';
import type { FinanceDocument } from '../shared/apis/records.ts';
import { transitionFinance } from '../src/services/persistence.service.ts';
import { alignRentalTemplates } from './align-rental-templates.ts';

const tenant = '70000000-0000-4000-8000-000000000020';
const entity = '71000000-0000-4000-8000-000000000021';
class DemoRepairRejected extends Schema.TaggedError<DemoRepairRejected>()('DemoRepairRejected', {
  reason: Schema.String,
}) {}
const admin = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* adminClient() {
    return yield* PgClient.makeClient({ url: yield* Config.Redacted('DATABASE_ADMIN_URL') });
  }),
).pipe(Layer.provide(Reactivity.layer));
const program = Effect.gen(function* repairDemo() {
  const sql = yield* PgClient.PgClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const [row] = yield* sql<{
    revision: number;
    state: unknown;
  }>`select revision,state from finance_billing.finance_states where tenant_id=${tenant} and legal_entity_id=${entity}`;
  if (row === undefined) {
    return yield* new DemoRepairRejected({ reason: 'Missing Siampark finance state' });
  }
  const original = yield* Schema.decodeUnknownEffect(FinanceStateSchema)(row.state);
  let state = alignRentalTemplates(original);
  const writes: { content: string; id: string }[] = [];
  const repairedAt = yield* DateTime.now;
  state = {
    ...state,
    documents: yield* Effect.forEach(
      state.documents ?? [],
      Effect.fn(function* repairDocument(document: FinanceDocument) {
        const invoice = state.invoices.find((entry) => entry.ref.resourceId === document.invoiceResourceId);
        if (invoice?.note?.includes('demo-v2-seed') !== true || invoice.direction !== 'INCOMING') {
          return document;
        }
        const filePath = yield* path.fromFileUrl(
          new URL(`fixtures/${invoice.documentNumber.replaceAll('/', '-')}.pdf`, import.meta.url),
        );
        const bytes = yield* fileSystem.readFile(filePath);
        writes.push({ content: Encoding.encodeBase64(bytes), id: document.id });
        return {
          ...document,
          actorLabel: 'Finance · oprava DEMO dokladu',
          sha256: Encoding.encodeHex(yield* crypto.digest('SHA-256', bytes)),
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
    const resourceId = yield* crypto.randomUUIDv4;
    const attemptId = yield* crypto.randomUUIDv4;
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
        attemptId,
        now,
        principalId: '72000000-0000-4000-8000-000000000023',
        resourceId,
      },
    );
    ({ state } = result);
  }
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(FinanceStateSchema))(state);
  yield* sql.withTransaction(
    Effect.gen(function* persistRepair() {
      const updated =
        yield* sql`update finance_billing.finance_states set state=${encoded}::jsonb,revision=revision+1,updated_at=now() where tenant_id=${tenant} and legal_entity_id=${entity} and revision=${row.revision} returning revision`;
      if (updated.length !== 1) {
        return yield* new DemoRepairRejected({ reason: 'Finance changed concurrently; retry the scoped repair' });
      }
      for (const write of writes) {
        yield* sql`update finance_billing.finance_document_contents set content_base64=${write.content} where tenant_id=${tenant} and legal_entity_id=${entity} and document_id=${write.id}`;
      }
      return yield* Effect.void;
    }),
  );
  yield* Console.log(
    `Repaired scoped finance revision ${row.revision + 1}; ${writes.length} Czech PDFs; latest handover ${state.accountingExports?.at(-1)?.batchNumber}. Historical packages/payment observations preserved.`,
  );
  return yield* Effect.void;
});
const mainLive = Layer.effectDiscard(program).pipe(Layer.provide(Layer.merge(admin, NodeServices.layer)));

if (import.meta.main) {
  NodeRuntime.runMain(Layer.build(mainLive).pipe(Effect.scoped));
}
