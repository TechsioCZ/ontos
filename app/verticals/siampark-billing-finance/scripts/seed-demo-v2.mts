/// <reference lib="es2023" />
// Sales demo v2 seed for Siampark finance (S07–S09): received invoices with a stored PDF, rent invoices with partial
// payments, recurring rent templates, budgets, an opening balance and one accountant handover package.
// It drives the owner's pure transitions (same rules as the Action) and writes the result with the admin role.
//
//   node verticals/siampark-billing-finance/scripts/seed-demo-v2.mts [--legal-entity <uuid>] [--force]
//
// Idempotent: a state already carrying the seed marker is left alone unless --force.
import { PgClient } from '@effect/sql-pg';
import { Config, DateTime, Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { NodeRuntime } from '@effect/platform-node';
import type { FinanceCommand } from '../shared/actions/apply-command.ts';
import { FinanceStateSchema } from '../shared/apis/records.ts';
import type { FinanceState, Invoice } from '../shared/apis/records.ts';
import { nextInvoiceNumber } from '../shared/domain/invoice-totals.ts';
import { MANUAL_COUNTERPARTY_ID, transitionFinance } from '../src/services/persistence.service.ts';
import type { DocumentWrite, FinanceValidators } from '../src/services/persistence.service.ts';

const TENANT = '70000000-0000-4000-8000-000000000020';
const argValue = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};
const LEGAL_ENTITY = argValue('--legal-entity') ?? '71000000-0000-4000-8000-000000000021';
const FORCE = process.argv.includes('--force');
const MARKER = 'demo-v2-seed';
const ACTOR = 'Jana Dvořáková (finance)';

/** A tiny valid one-page PDF with readable invoice text, generated so the stored document opens in any viewer. */
const pdfFor = (lines: readonly string[]) => {
  const ascii = (text: string) =>
    text
      .normalize('NFD')
      .replaceAll(/[̀-ͯ]/gu, '')
      .replaceAll(/[()\\]/gu, ' ');
  const body = lines
    .map((line, index) => `BT /F1 ${index === 0 ? 18 : 11} Tf 60 ${770 - index * 22} Td (${ascii(line)}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1').toString('base64');
};

const AdminSql = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* adminClient() {
    const url = yield* Config.Redacted('DATABASE_ADMIN_URL');
    return yield* PgClient.makeClient({ url });
  }),
).pipe(Layer.provide(Reactivity.layer));

const validators: FinanceValidators = { invoice: () => Effect.void };

interface Counterparty {
  readonly id: string;
  readonly name: string;
}

const program = Effect.gen(function* seed() {
  const sql = yield* PgClient.PgClient;
  const rows = yield* sql<{ readonly revision: number; readonly state: unknown }>`
    select revision, state from siampark_billing_finance.finance_states
    where tenant_id = ${TENANT} and legal_entity_id = ${LEGAL_ENTITY}`;
  const existing = rows[0];
  let state: FinanceState =
    existing === undefined
      ? { accountingObservations: [], financialPlanEntries: [], invoices: [], paymentObservations: [] }
      : yield* Schema.decodeUnknownEffect(FinanceStateSchema)(existing.state);
  if (!FORCE && state.invoices.some((invoice) => invoice.note?.includes(MARKER) === true)) {
    console.log(`Finance demo-v2 seed already present in ${LEGAL_ENTITY}; use --force to add it again.`);
    return;
  }
  // Customers (tenants) from the party registry of this company, if the rental seed created them.
  const parties = yield* sql<{ readonly counterparty_id: string; readonly display_name: string | null }>`
    select c.counterparty_id::text as counterparty_id, p.current_display_name as display_name
    from party.counterparties c
    left join party.parties p on p.party_id = c.party_id and p.tenant_id = c.tenant_id
    where c.tenant_id = ${TENANT} and c.legal_entity_id = ${LEGAL_ENTITY} and c.archived_at is null`.pipe(
    Effect.orElseSucceed(
      () => [] as readonly { readonly counterparty_id: string; readonly display_name: string | null }[],
    ),
  );
  const tenants: readonly Counterparty[] = parties.map((row) => ({
    id: row.counterparty_id,
    name: row.display_name ?? '',
  }));
  const tenantNamed = (fragment: string, fallback: string): Counterparty =>
    tenants.find((entry) => entry.name.toLocaleLowerCase('cs').includes(fragment.toLocaleLowerCase('cs'))) ?? {
      id: MANUAL_COUNTERPARTY_ID,
      name: fallback,
    };
  const ref = (counterparty: Counterparty) => ({
    moduleId: 'party.registry' as const,
    resourceId: counterparty.id,
    resourceType: 'party.registry.counterparty' as const,
    tenantId: TENANT,
  });
  const writes: DocumentWrite[] = [];
  let counter = 0;
  const apply = (command: FinanceCommand) =>
    Effect.gen(function* step() {
      counter += 1;
      const now = yield* DateTime.now;
      const result = yield* transitionFinance(
        state,
        command,
        { legalEntityId: LEGAL_ENTITY, tenantId: TENANT },
        validators,
        {
          attemptId: crypto.randomUUID(),
          now,
          principalId: '72000000-0000-4000-8000-000000000023',
          resourceId: crypto.randomUUID(),
        },
      );
      state = result.state;
      writes.push(...(result.documentWrites ?? []));
      return result.invoice;
    });
  const invoiceOf = (value: Invoice | undefined) =>
    value === undefined ? Effect.die(new Error(`seed step ${counter} returned no invoice`)) : Effect.succeed(value);

  // ---- S07: received invoices (manual suppliers), one due yesterday and unpaid → overdue ----
  const incoming = [
    {
      amount: 4_862_000,
      category: 'Energie',
      due: '2026-10-19',
      ico: '27232433',
      issued: '2026-10-05',
      number: '2026-0918774',
      paid: 0,
      supplier: 'ČEZ Prodej, a.s.',
    },
    {
      amount: 1_815_000,
      category: 'Úklid a odpady',
      due: '2026-10-15',
      ico: '06212372',
      issued: '2026-10-01',
      number: '2026/412',
      paid: 1_815_000,
      supplier: 'Úklidová služba Lesk s.r.o.',
    },
    {
      amount: 1_270_500,
      category: 'Údržba a opravy',
      due: '2026-10-24',
      ico: '45801126',
      issued: '2026-10-10',
      number: 'VF-26-5531',
      paid: 0,
      supplier: 'Výtahy Schindler CZ, a.s.',
    },
    {
      amount: 3_120_000,
      category: 'Pojištění',
      due: '2026-10-05',
      ico: '47116617',
      issued: '2026-09-20',
      number: '7720115',
      paid: 1_560_000,
      supplier: 'Kooperativa pojišťovna, a.s.',
    },
    {
      amount: 986_000,
      category: 'Energie',
      due: '2026-11-02',
      ico: '25656635',
      issued: '2026-10-12',
      number: '2026-77412',
      paid: 0,
      supplier: 'Pražské vodovody a kanalizace, a.s.',
    },
  ] as const;
  const incomingInvoices: Invoice[] = [];
  for (const entry of incoming) {
    const invoice = yield* invoiceOf(
      yield* apply({
        _tag: 'RecordIncomingInvoice',
        actorLabel: ACTOR,
        budgetCategory: entry.category,
        document: {
          contentBase64: pdfFor([
            `${entry.supplier} - FAKTURA ${entry.number}`,
            `ICO dodavatele: ${entry.ico}`,
            'Odberatel: Siampark s.r.o.',
            `Datum vystaveni: ${entry.issued}`,
            `Datum splatnosti: ${entry.due}`,
            `Celkem k uhrade: ${(entry.amount / 100).toFixed(2)} CZK`,
            '(ukazkovy doklad pro demo OntOS)',
          ]),
          fileName: `faktura-${entry.number.replaceAll('/', '-')}.pdf`,
          mimeType: 'application/pdf',
        },
        documentNumber: entry.number,
        dueDate: entry.due,
        issueDate: entry.issued,
        note: `Přijatá faktura (${MARKER})`,
        supplierCompanyId: entry.ico,
        supplierName: entry.supplier,
        totalMinor: entry.amount,
      }),
    );
    incomingInvoices.push(invoice);
    if (entry.paid > 0) {
      yield* apply({
        _tag: 'RecordManualPayment',
        actorLabel: ACTOR,
        amountMinor: entry.paid,
        invoiceRef: invoice.ref,
        note: 'Bankovní výpis č. 41',
        paidOn: entry.due < '2026-10-14' ? entry.due : '2026-10-14',
      });
    }
  }

  // ---- S07: issued rent invoices (confirmed), one partially paid 400 of 1 000 Kč ----
  const kavarna = tenantNamed('Kavárna', 'Kavárna U Parku s.r.o.');
  const horak = tenantNamed('Horák', 'Ateliér Horák');
  const technoservis = tenantNamed('Technoservis', 'Technoservis Praha s.r.o.');
  const lekarna = tenantNamed('Lékárna', 'Lékárna Na Nábřeží s.r.o.');
  const outgoing = [
    {
      amount: 2_500_000,
      issued: '2026-09-01',
      due: '2026-09-15',
      paid: 'FULL',
      paidOn: '2026-09-12',
      text: 'Nájemné R201 – září 2026',
      who: horak,
    },
    {
      amount: 4_500_000,
      issued: '2026-10-01',
      due: '2026-10-15',
      paid: 'NONE',
      paidOn: '',
      text: 'Nájemné R101 – říjen 2026',
      who: technoservis,
    },
    {
      amount: 2_500_000,
      issued: '2026-10-01',
      due: '2026-10-15',
      paid: 'FULL',
      paidOn: '2026-10-13',
      text: 'Nájemné R201 – říjen 2026',
      who: horak,
    },
    {
      amount: 82_645,
      issued: '2026-10-05',
      due: '2026-10-19',
      paid: 'PART',
      paidOn: '2026-10-16',
      text: 'Parkovací karta – říjen 2026',
      who: kavarna,
    },
    {
      amount: 1_800_000,
      issued: '2026-10-01',
      due: '2026-10-31',
      paid: 'NONE',
      paidOn: '',
      text: 'Nájemné A101 – říjen 2026',
      who: lekarna,
    },
  ] as const;
  for (const entry of outgoing) {
    const number = nextInvoiceNumber(state.invoices);
    const draft = yield* invoiceOf(
      yield* apply({
        _tag: 'CreateInvoiceDraft',
        counterpartyRef: ref(entry.who),
        currency: 'CZK',
        direction: 'OUTGOING',
        documentNumber: number,
        dueDate: entry.due,
        issueDate: entry.issued,
        lines: [{ description: entry.text, quantity: 1, unitPriceMinor: entry.amount, vatRate: 21 }],
        note: `Vydaná faktura (${MARKER})`,
      }),
    );
    state = {
      ...state,
      invoices: state.invoices.map((invoice) =>
        invoice.ref.resourceId === draft.ref.resourceId
          ? { ...invoice, budgetCategory: 'Nájemné', counterpartyName: entry.who.name }
          : invoice,
      ),
    };
    const confirmed = yield* invoiceOf(yield* apply({ _tag: 'ConfirmInvoice', invoiceRef: draft.ref }));
    if (entry.paid !== 'NONE') {
      yield* apply({
        _tag: 'RecordManualPayment',
        actorLabel: ACTOR,
        amountMinor: entry.paid === 'FULL' ? confirmed.totalMinor : 40_000,
        invoiceRef: confirmed.ref,
        note: entry.paid === 'FULL' ? 'Platba převodem' : 'Částečná úhrada v hotovosti',
        paidOn: entry.paidOn,
      });
    }
  }

  // ---- S07.R3: recurring rent templates ----
  const templates = [
    { amount: 4_500_000, name: 'Nájem R101 – kancelář', unit: 'R101', who: technoservis },
    { amount: 2_500_000, name: 'Nájem R201 – ateliér', unit: 'R201', who: horak },
    { amount: 1_800_000, name: 'Nájem A101 – lékárna', unit: 'A101', who: lekarna },
  ] as const;
  for (const template of templates) {
    yield* apply({
      _tag: 'CreateRecurringTemplate',
      counterpartyName: template.who.name,
      counterpartyRef: ref(template.who),
      dueDays: 14,
      issueDay: 1,
      lines: [{ description: `Nájemné ${template.unit}`, quantity: 1, unitPriceMinor: template.amount, vatRate: 21 }],
      name: template.name,
    });
  }

  // ---- S09: budgets, opening balance ----
  const budgetPlan = [
    ['COST', 'Energie', 5_500_000, undefined, 'Vyšší spotřeba plynu kvůli chladnému říjnu.'],
    ['COST', 'Úklid a odpady', 1_800_000, undefined, undefined],
    ['COST', 'Údržba a opravy', 2_000_000, undefined, undefined],
    ['COST', 'Pojištění', 3_120_000, undefined, undefined],
    ['COST', 'Marketing', 0, 350_000, 'Neplánovaný inzerát na volné jednotky A102 a S01.'],
    ['REVENUE', 'Nájemné', 11_000_000, undefined, 'R301 začne platit až od prosince.'],
  ] as const;
  for (const period of ['2026-09', '2026-10', '2026-11', '2026-12']) {
    for (const [kind, category, planned, actual, explanation] of budgetPlan) {
      if (period !== '2026-10' && category === 'Marketing') {
        continue;
      }
      yield* apply({
        _tag: 'UpsertBudgetLine',
        actorLabel: ACTOR,
        ...(period === '2026-10' && actual !== undefined ? { actualManualMinor: actual } : {}),
        category,
        ...(period === '2026-10' && explanation !== undefined ? { explanation } : {}),
        kind,
        period,
        plannedMinor: category === 'Pojištění' && period !== '2026-10' ? 0 : planned,
      });
    }
  }
  yield* apply({
    _tag: 'SetOpeningBalance',
    actorLabel: ACTOR,
    openingBalanceMinor: 125_000_000,
    openingDate: '2026-10-01',
  });

  // ---- S08: accounting registry (partly waiting for input) and one handover package ----
  yield* apply({ _tag: 'UpdateAccountingSetup', actorLabel: ACTOR, product: 'Pohoda (Stormware)' });
  yield* apply({
    _tag: 'CreateAccountingExport',
    actorLabel: ACTOR,
    format: 'CSV',
    invoiceResourceIds: incomingInvoices.slice(1, 4).map((invoice) => invoice.ref.resourceId),
  });

  const encoded = yield* Schema.encodeEffect(FinanceStateSchema)(state);
  yield* sql.withTransaction(
    Effect.gen(function* save() {
      if (existing === undefined) {
        yield* sql`insert into siampark_billing_finance.finance_states (tenant_id, legal_entity_id, revision, state)
          values (${TENANT}, ${LEGAL_ENTITY}, 1, ${JSON.stringify(encoded)}::jsonb)`;
      } else {
        yield* sql`update siampark_billing_finance.finance_states
          set state = ${JSON.stringify(encoded)}::jsonb, revision = revision + 1, updated_at = now()
          where tenant_id = ${TENANT} and legal_entity_id = ${LEGAL_ENTITY} and revision = ${existing.revision}`;
      }
      for (const write of writes) {
        yield* sql`insert into siampark_billing_finance.finance_document_contents
          (tenant_id, legal_entity_id, document_id, content_base64, mime_type)
          values (${TENANT}, ${LEGAL_ENTITY}, ${write.id}, ${write.contentBase64}, ${write.mimeType})
          on conflict do nothing`;
      }
    }),
  );
  console.log(
    `Finance demo-v2 seed written to ${LEGAL_ENTITY}: ${state.invoices.length} invoices, ${writes.length} PDFs, ` +
      `${state.budgets?.length ?? 0} budget lines, ${state.recurringTemplates?.length ?? 0} templates ` +
      `(registry tenants matched: ${tenants.length}).`,
  );
});

NodeRuntime.runMain(program.pipe(Effect.provide(AdminSql)));
