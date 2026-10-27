/// <reference lib="es2023" />
// Sales demo v2 seed for Siampark finance (S07–S09): received invoices with a stored PDF, rent invoices with partial
// payments, recurring rent templates, budgets, an opening balance and one accountant handover package.
// It drives the owner's pure transitions (same rules as the Action) and writes the result with the admin role.
//
//   node verticals/finance-billing/scripts/seed-demo-v2.mts [--legal-entity <uuid>] [--force]
//
// Idempotent: a state already carrying the seed marker is left alone unless --force.
import { alignRentalTemplates } from './align-rental-templates.ts';
import { PgClient } from '@effect/sql-pg';
import { Config, Console, Crypto, DateTime, Effect, Encoding, FileSystem, Layer, Path, Schema } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Command, Flag } from 'effect/unstable/cli';
import type { FinanceCommand } from '../shared/actions/apply-command.ts';
import { FinanceCompanyIdSchema, FinanceInvoiceResourceIdSchema, FinanceStateSchema } from '../shared/apis/records.ts';
import type { FinanceState, Invoice } from '../shared/apis/records.ts';
import { nextInvoiceNumber } from '../shared/domain/invoice-totals.ts';
import { MANUAL_COUNTERPARTY_ID, transitionFinance } from '../src/services/persistence.service.ts';
import type { DocumentWrite, FinanceValidators } from '../src/services/persistence.service.ts';

const TENANT = '70000000-0000-4000-8000-000000000020';
const MARKER = 'demo-v2-seed';
const ACTOR = 'Finance (finance@siampark.demo)';
const ENERGY_CATEGORY = 'Energie';
const OCTOBER_MID_MONTH = '2026-10-15';
const OCTOBER_START = '2026-10-01';
const OCTOBER_FIFTH = '2026-10-05';

class DemoSeedRejected extends Schema.TaggedError<DemoSeedRejected>()('DemoSeedRejected', { reason: Schema.String }) {}

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };
interface CounterpartyRow {
  readonly counterparty_id: string;
  readonly display_name: string | null;
  readonly party_id: string;
}

const budgetPlan = [
  ['COST', ENERGY_CATEGORY, 5_500_000, undefined, 'Vyšší spotřeba plynu kvůli chladnému říjnu.'],
  ['COST', 'Úklid a odpady', 1_800_000, undefined, undefined],
  ['COST', 'Údržba a opravy', 2_000_000, undefined, undefined],
  ['COST', 'Pojištění', 3_120_000, undefined, undefined],
  ['COST', 'Marketing', 0, 350_000, 'Neplánovaný inzerát na volné jednotky A102 a S01.'],
  ['REVENUE', 'Nájemné', 11_000_000, undefined, 'R301 začne platit až od prosince.'],
] as const;

const budgetCommand = (period: string, [kind, category, planned, actual, explanation]: (typeof budgetPlan)[number]) => {
  const command: Mutable<Extract<FinanceCommand, { readonly _tag: 'UpsertBudgetLine' }>> = {
    _tag: 'UpsertBudgetLine',
    actorLabel: ACTOR,
    category,
    kind,
    period,
    plannedMinor: category === 'Pojištění' && period !== '2026-10' ? 0 : planned,
  };
  if (period === '2026-10' && actual !== undefined) {
    command.actualManualMinor = actual;
  }
  if (period === '2026-10' && explanation !== undefined) {
    command.explanation = explanation;
  }
  return command;
};

const seedSummary = (
  legalEntity: string,
  state: FinanceState,
  writes: readonly DocumentWrite[],
  tenants: readonly Counterparty[],
) =>
  `Finance demo-v2 seed written to ${legalEntity}: ${state.invoices.length} invoices, ${writes.length} PDFs, ` +
  `${state.budgets?.length ?? 0} budget lines, ${state.recurringTemplates?.length ?? 0} templates ` +
  `(registry tenants matched: ${tenants.length}).`;

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
  readonly partyId?: string;
}

const program = Effect.fn('Finance.seedDemoV2')(function* seed(LEGAL_ENTITY: string, FORCE: boolean) {
  const sql = yield* PgClient.PgClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const [existing] = yield* sql<{ readonly revision: number; readonly state: unknown }>`
    select revision, state from finance_billing.finance_states
    where tenant_id = ${TENANT} and legal_entity_id = ${LEGAL_ENTITY}`;
  let state: FinanceState =
    existing === undefined
      ? { financialPlanEntries: [], invoices: [] }
      : yield* Schema.decodeUnknownEffect(FinanceStateSchema)(existing.state);
  if (!FORCE && state.invoices.some((invoice) => invoice.note?.includes(MARKER) === true)) {
    yield* Console.log(`Finance demo-v2 seed already present in ${LEGAL_ENTITY}; use --force to add it again.`);
    return;
  }
  // Customers (tenants) from the party registry of this company, if the rental seed created them.
  const parties = yield* sql<CounterpartyRow>`
    select c.counterparty_id::text as counterparty_id, c.party_id::text as party_id, p.current_display_name as display_name
    from party.counterparties c
    left join party.parties p on p.party_id = c.party_id and p.tenant_id = c.tenant_id
    where c.tenant_id = ${TENANT} and c.legal_entity_id = ${LEGAL_ENTITY} and c.archived_at is null`.pipe(
    Effect.orElseSucceed((): readonly CounterpartyRow[] => []),
  );
  const tenants: readonly Counterparty[] = parties.map((row) => ({
    id: row.counterparty_id,
    name: row.display_name ?? '',
    partyId: row.party_id,
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
  const apply = Effect.fn('Finance.seedDemoV2.apply')(function* step(command: FinanceCommand) {
    counter += 1;
    const now = yield* DateTime.now;
    const result = yield* transitionFinance(
      state,
      command,
      { legalEntityId: LEGAL_ENTITY, tenantId: TENANT },
      validators,
      {
        attemptId: yield* crypto.randomUUIDv4,
        now,
        principalId: '72000000-0000-4000-8000-000000000023',
        resourceId: yield* crypto.randomUUIDv4,
      },
    );
    ({ state } = result);
    writes.push(...(result.documentWrites ?? []));
    return result.invoice;
  });
  const invoiceOf = (value: Invoice | undefined) =>
    value === undefined
      ? Effect.fail(new DemoSeedRejected({ reason: `seed step ${counter} returned no invoice` }))
      : Effect.succeed(value);

  // ---- S07: received invoices (manual suppliers), one due yesterday and unpaid → overdue ----
  const incoming = [
    {
      amount: 4_862_000,
      category: ENERGY_CATEGORY,
      due: '2026-10-19',
      ico: '27232433',
      issued: OCTOBER_FIFTH,
      number: '2026-0918774',
      paid: 0,
      supplier: 'ČEZ Prodej, a.s.',
    },
    {
      amount: 1_815_000,
      category: 'Úklid a odpady',
      due: OCTOBER_MID_MONTH,
      ico: '06212372',
      issued: OCTOBER_START,
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
      due: OCTOBER_FIFTH,
      ico: '47116617',
      issued: '2026-09-20',
      number: '7720115',
      paid: 1_560_000,
      supplier: 'Kooperativa pojišťovna, a.s.',
    },
    {
      amount: 986_000,
      category: ENERGY_CATEGORY,
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
    const filePath = yield* path.fromFileUrl(
      new URL(`fixtures/${entry.number.replaceAll('/', '-')}.pdf`, import.meta.url),
    );
    const bytes = yield* fileSystem.readFile(filePath);
    const invoice = yield* invoiceOf(
      yield* apply({
        _tag: 'RecordIncomingInvoice',
        actorLabel: ACTOR,
        budgetCategory: entry.category,
        document: {
          contentBase64: Encoding.encodeBase64(bytes),
          fileName: `faktura-${entry.number.replaceAll('/', '-')}.pdf`,
          mimeType: 'application/pdf',
        },
        documentNumber: entry.number,
        dueDate: entry.due,
        issueDate: entry.issued,
        note: `Přijatá faktura (${MARKER})`,
        supplierCompanyId: yield* Schema.decodeEffect(FinanceCompanyIdSchema)(entry.ico),
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
  const outgoing = [
    {
      amount: 2_500_000,
      due: '2026-09-15',
      issued: '2026-09-01',
      paid: 'FULL',
      paidOn: '2026-09-12',
      text: 'Nájemné R201 – září 2026',
      who: horak,
    },
    {
      amount: 4_500_000,
      due: OCTOBER_MID_MONTH,
      issued: OCTOBER_START,
      paid: 'NONE',
      paidOn: '',
      text: 'Nájemné R101 – říjen 2026',
      who: kavarna,
    },
    {
      amount: 2_500_000,
      due: OCTOBER_MID_MONTH,
      issued: OCTOBER_START,
      paid: 'FULL',
      paidOn: '2026-10-13',
      text: 'Nájemné R201 – říjen 2026',
      who: horak,
    },
    {
      amount: 82_645,
      due: '2026-10-19',
      issued: OCTOBER_FIFTH,
      paid: 'PART',
      paidOn: '2026-10-16',
      text: 'Parkovací karta – říjen 2026',
      who: kavarna,
    },
    {
      amount: 1_800_000,
      due: '2026-10-31',
      issued: OCTOBER_START,
      paid: 'NONE',
      paidOn: '',
      text: 'Nájemné A101 – říjen 2026',
      who: technoservis,
    },
  ] as const;
  for (const entry of outgoing) {
    const number = nextInvoiceNumber(state.invoices);
    const draftCommand: Mutable<Extract<FinanceCommand, { readonly _tag: 'CreateInvoiceDraft' }>> = {
      _tag: 'CreateInvoiceDraft',
      counterpartyRef: ref(entry.who),
      currency: 'CZK',
      direction: 'OUTGOING',
      documentNumber: number,
      dueDate: entry.due,
      issueDate: entry.issued,
      lines: [{ description: entry.text, quantity: 1, unitPriceMinor: entry.amount, vatRate: 21 }],
      note: `Vydaná faktura (${MARKER})`,
    };
    if (entry.who.partyId !== undefined) {
      draftCommand.partyId = entry.who.partyId;
    }
    const draft = yield* invoiceOf(yield* apply(draftCommand));
    state = {
      ...state,
      invoices: state.invoices.map((invoice) =>
        invoice.ref.resourceId === draft.ref.resourceId
          ? { ...invoice, budgetCategory: 'Nájemné', counterpartyName: entry.who.name }
          : invoice,
      ),
    };
    yield* apply({ _tag: 'MarkInvoicesPrepared', actorLabel: ACTOR, invoiceRefs: [draft.ref] });
    const confirmed = yield* invoiceOf(
      yield* apply({ _tag: 'ConfirmInvoice', actorLabel: ACTOR, invoiceRef: draft.ref }),
    );
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
    { amount: 4_500_000, name: 'Nájem R101 – kavárna', unit: 'R101', who: kavarna },
    { amount: 2_500_000, name: 'Nájem R201 – ateliér', unit: 'R201', who: horak },
    { amount: 1_800_000, name: 'Nájem A101 – služební byt', unit: 'A101', who: technoservis },
  ] as const;
  for (const template of templates) {
    const templateCommand: Mutable<Extract<FinanceCommand, { readonly _tag: 'CreateRecurringTemplate' }>> = {
      _tag: 'CreateRecurringTemplate',
      counterpartyName: template.who.name,
      counterpartyRef: ref(template.who),
      dueDays: 14,
      issueDay: 1,
      lines: [{ description: `Nájemné ${template.unit}`, quantity: 1, unitPriceMinor: template.amount, vatRate: 21 }],
      name: template.name,
    };
    if (template.who.partyId !== undefined) {
      templateCommand.partyId = template.who.partyId;
    }
    yield* apply(templateCommand);
  }

  // Rent invoices issued from a template carry its id and period, so the duplicate protection applies to them.
  state = {
    ...state,
    invoices: state.invoices.map((invoice) => {
      const description = invoice.lines?.[0]?.description ?? '';
      const template = (state.recurringTemplates ?? []).find(
        (entry) =>
          entry.counterpartyRef.resourceId === invoice.counterpartyRef.resourceId &&
          description.startsWith(`${entry.lines[0]?.description ?? '¤'} `),
      );
      return invoice.direction === 'OUTGOING' && invoice.note?.includes(MARKER) === true && template !== undefined
        ? {
            ...invoice,
            documentKind: 'RECURRING' as const,
            recurringPeriod: invoice.issueDate.slice(0, 7),
            recurringTemplateId: template.id,
          }
        : invoice;
    }),
  };

  state = alignRentalTemplates(state);

  // ---- S09: budgets, opening balance ----
  for (const period of ['2026-09', '2026-10', '2026-11', '2026-12']) {
    for (const entry of budgetPlan) {
      const [, category] = entry;
      if (period !== '2026-10' && category === 'Marketing') {
        continue;
      }
      yield* apply(budgetCommand(period, entry));
    }
  }
  yield* apply({
    _tag: 'SetOpeningBalance',
    actorLabel: ACTOR,
    openingBalanceMinor: 125_000_000,
    openingDate: OCTOBER_START,
  });

  // ---- S08: accounting registry (partly waiting for input) and one handover package ----
  yield* apply({ _tag: 'UpdateAccountingSetup', actorLabel: ACTOR, product: 'Pohoda (Stormware)' });
  yield* apply({
    _tag: 'CreateAccountingExport',
    actorLabel: ACTOR,
    format: 'CSV',
    invoiceResourceIds: yield* Schema.decodeEffect(Schema.Array(FinanceInvoiceResourceIdSchema))(
      incomingInvoices.slice(1, 4).map((invoice) => invoice.ref.resourceId),
    ),
  });

  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(FinanceStateSchema))(state);
  yield* sql.withTransaction(
    Effect.gen(function* save() {
      if (existing === undefined) {
        yield* sql`insert into finance_billing.finance_states (tenant_id, legal_entity_id, revision, state)
          values (${TENANT}, ${LEGAL_ENTITY}, 1, ${encoded}::jsonb)`;
      } else {
        const updated = yield* sql`update finance_billing.finance_states
          set state = ${encoded}::jsonb, revision = revision + 1, updated_at = now()
          where tenant_id = ${TENANT} and legal_entity_id = ${LEGAL_ENTITY} and revision = ${existing.revision}
          returning revision`;
        if (updated.length === 0) {
          return yield* new DemoSeedRejected({ reason: 'finance state changed concurrently; run the seed again' });
        }
      }
      for (const write of writes) {
        yield* sql`insert into finance_billing.finance_document_contents
          (tenant_id, legal_entity_id, document_id, content_base64, mime_type)
          values (${TENANT}, ${LEGAL_ENTITY}, ${write.id}, ${write.contentBase64}, ${write.mimeType})
          on conflict do nothing`;
      }
      return yield* Effect.void;
    }),
  );
  yield* Console.log(seedSummary(LEGAL_ENTITY, state, writes, tenants));
});

const cli = Command.make(
  'seed-demo-v2',
  {
    force: Flag.Boolean('force').pipe(Flag.withDefault(false)),
    legalEntity: Flag.String('legal-entity').pipe(Flag.withDefault('71000000-0000-4000-8000-000000000021')),
  },
  ({ force, legalEntity }) => program(legalEntity, force),
);

const mainLive = Layer.effectDiscard(Command.run(cli, { version: '1.0.0' })).pipe(
  Layer.provide(Layer.merge(AdminSql, NodeServices.layer)),
);

if (import.meta.main) {
  NodeRuntime.runMain(Layer.build(mainLive).pipe(Effect.scoped));
}
