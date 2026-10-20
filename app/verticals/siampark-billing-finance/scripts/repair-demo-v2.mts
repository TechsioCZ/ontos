// @effect-diagnostics *:off
// Scoped, optimistic demo-fixture repair. Never reseeds, deletes, rewrites payments or changes historical exports.
import { readFileSync } from 'node:fs';
import { PgClient } from '@effect/sql-pg';
import { NodeRuntime } from '@effect/platform-node';
import { Config, DateTime, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { FinanceStateSchema } from '../shared/apis/records.ts';
import { transitionFinance } from '../src/services/persistence.service.ts';
import { alignRentalTemplates } from './align-rental-templates.ts';
const tenant = '70000000-0000-4000-8000-000000000020';
const entity = '71000000-0000-4000-8000-000000000021';
const admin = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* () {
    return yield* PgClient.makeClient({ url: yield* Config.Redacted('DATABASE_ADMIN_URL') });
  }),
).pipe(Layer.provide(Reactivity.layer));
const program = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const [row] = yield* sql<{
    revision: number;
    state: unknown;
  }>`select revision,state from siampark_billing_finance.finance_states where tenant_id=${tenant} and legal_entity_id=${entity}`;
  if (row === undefined) return yield* Effect.die('Missing Siampark finance state');
  const original = yield* Schema.decodeUnknownEffect(FinanceStateSchema)(row.state);
  let state = alignRentalTemplates(original);
  const writes: { id: string; content: string }[] = [];
  state = {
    ...state,
    documents: (state.documents ?? []).map((document) => {
      const invoice = state.invoices.find((invoice) => invoice.ref.resourceId === document.invoiceResourceId);
      if (invoice?.note?.includes('demo-v2-seed') !== true || invoice.direction !== 'INCOMING') return document;
      const bytes = readFileSync(
        new URL(`./fixtures/${invoice.documentNumber.replaceAll('/', '-')}.pdf`, import.meta.url),
      );
      writes.push({ id: document.id, content: bytes.toString('base64') });
      return { ...document, sizeBytes: bytes.length };
    }),
  };
  // New version, not an in-place mutation of an accountant's historical signed/hash-verified snapshot.
  const previous = state.accountingExports?.at(-1);
  if (previous !== undefined && !previous.content.includes('http://localhost:3020/cs/siampark/finance?resourceId=')) {
    const now = yield* DateTime.now;
    const result = yield* transitionFinance(
      state,
      {
        _tag: 'CreateAccountingExport',
        actorLabel: 'Finance · oprava odkazů na doklady',
        format: 'CSV',
        invoiceResourceIds: previous.invoiceResourceIds,
      },
      { tenantId: tenant, legalEntityId: entity },
      { invoice: () => Effect.void },
      {
        now,
        resourceId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        principalId: '72000000-0000-4000-8000-000000000023',
      },
    );
    state = result.state;
  }
  const encoded = yield* Schema.encodeEffect(FinanceStateSchema)(state);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const updated =
        yield* sql`update siampark_billing_finance.finance_states set state=${JSON.stringify(encoded)}::jsonb,revision=revision+1,updated_at=now() where tenant_id=${tenant} and legal_entity_id=${entity} and revision=${row.revision} returning revision`;
      if (updated.length !== 1) return yield* Effect.die('Finance changed concurrently; retry the scoped repair');
      for (const write of writes)
        yield* sql`update siampark_billing_finance.finance_document_contents set content_base64=${write.content} where tenant_id=${tenant} and legal_entity_id=${entity} and document_id=${write.id}`;
    }),
  );
  console.log(
    `Repaired scoped finance revision ${row.revision + 1}; ${writes.length} Czech PDFs; latest handover ${state.accountingExports?.at(-1)?.batchNumber}. Historical packages/payment observations preserved.`,
  );
});
NodeRuntime.runMain(program.pipe(Effect.provide(admin)));
