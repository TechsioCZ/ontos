/// <reference lib="es2023" />
// Sales demo v2 seed for Nájempark finance (S07–S09): received invoices with a stored PDF, rent invoices with partial
// payments, recurring rent templates, budgets, an opening balance and one accountant handover package.
// It drives the owner's pure transitions (same rules as the Action) and writes the result with the admin role.
//
//   node verticals/finance-billing/scripts/seed-demo-v2.mts [--legal-entity <uuid>] [--force]
//
// Idempotent: a state already carrying the seed marker is left alone unless --force.
import { alignRentalTemplates } from './align-rental-templates.ts';
import { PgClient } from '@effect/sql-pg';
import { Config, Console, Crypto, DateTime, Effect, FileSystem, Layer, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { Reactivity } from 'effect/reactivity';
import { NodeCrypto, NodeRuntime, NodeServices } from '@effect/platform-node';
import type { FinanceCommand } from '../shared/actions/apply-command.ts';
import { FinanceCompanyIdSchema, FinanceInvoiceResourceIdSchema, FinanceStateSchema } from '../shared/apis/records.ts';
import type { FinanceState, Invoice } from '../shared/apis/records.ts';
import { nextInvoiceNumber } from '../shared/domain/invoice-totals.ts';
import { MANUAL_COUNTERPARTY_ID, transitionFinance } from '../src/services/persistence.service.ts';
import type { DocumentWrite, FinanceValidators } from '../src/services/persistence.service.ts';

class DemoSeedRejected extends Schema.TaggedError<DemoSeedRejected, { readonly brand: unique symbol }>()(
  'DemoSeedRejected',
  { reason: Schema.String },
) {}

const TENANT = '70000000-0000-4000-8000-000000000020';
const MARKER = 'demo-v2-seed';
const ACTOR = 'Finance (finance@najempark.demo)';
const OCTOBER_RENT_DUE = '2026-10-15';
const DEMO_ISSUE_DATE = '2026-10-05';
const OCTOBER_START = '2026-10-01';
const CLEANING_CATEGORY = 'Úklid a odpady';
const INSURANCE_CATEGORY = 'Pojištění';
const MAINTENANCE_CATEGORY = 'Údržba a opravy';
const ENERGY_CATEGORY = 'Energie';

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

const seed = Effect.fn('Finance.seedDemoV2')(function* seedDemoV2(LEGAL_ENTITY: string, FORCE: boolean) {
  const sql = yield* PgClient.PgClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const rows = yield* sql<{ readonly revision: number; readonly state: unknown }>`
    select revision, state from finance_billing.finance_states
    where tenant_id = ${TENANT} and legal_entity_id = ${LEGAL_ENTITY}`;
  const [existing] = rows;
  let state: FinanceState =
    existing === undefined
      ? { financialPlanEntries: [], invoices: [] }
      : yield* Schema.decodeUnknownEffect(FinanceStateSchema)(existing.state);
  if (!FORCE && state.invoices.some((invoice) => invoice.note?.includes(MARKER) === true)) {
    return yield* Console.log(`Finance demo-v2 seed already present in ${LEGAL_ENTITY}; use --force to add it again.`);
  }
  // Customers (tenants) from the party registry of this company, if the rental seed created them.
  const parties = yield* sql<{
    readonly counterparty_id: string;
    readonly display_name: string | null;
    readonly party_id: string;
  }>`
    select c.counterparty_id::text as counterparty_id, c.party_id::text as party_id, p.current_display_name as display_name
    from party.counterparties c
    left join party.parties p on p.party_id = c.party_id and p.tenant_id = c.tenant_id
    where c.tenant_id = ${TENANT} and c.legal_entity_id = ${LEGAL_ENTITY} and c.archived_at is null`.pipe(
    Effect.orElseSucceed(() => []),
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
  const apply = Effect.fn('Finance.seedDemoV2Step')(function* step(command: FinanceCommand) {
    counter += 1;
    const now = yield* DateTime.now;
    const result = yield* transitionFinance(
      state,
      command,
      { legalEntityId: LEGAL_ENTITY, tenantId: TENANT },
      validators,
      {
        attemptId: yield* crypto.randomUUIDv4(),
        now,
        principalId: '72000000-0000-4000-8000-000000000023',
        resourceId: yield* crypto.randomUUIDv4(),
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
      issued: DEMO_ISSUE_DATE,
      number: '2026-0918774',
      paid: 0,
      supplier: 'ČEZ Prodej, a.s.',
    },
    {
      amount: 1_815_000,
      category: CLEANING_CATEGORY,
      due: OCTOBER_RENT_DUE,
      ico: '06212372',
      issued: OCTOBER_START,
      number: '2026/412',
      paid: 1_815_000,
      supplier: 'Úklidová služba Lesk s.r.o.',
    },
    {
      amount: 1_270_500,
      category: MAINTENANCE_CATEGORY,
      due: '2026-10-24',
      ico: '45801126',
      issued: '2026-10-10',
      number: 'VF-26-5531',
      paid: 0,
      supplier: 'Výtahy Schindler CZ, a.s.',
    },
    {
      amount: 3_120_000,
      category: INSURANCE_CATEGORY,
      due: DEMO_ISSUE_DATE,
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
  const incomingInvoices = yield* Effect.forEach(
    incoming,
    (entry) =>
      Effect.gen(function* seedIncoming() {
        const file = yield* path.fromFileUrl(
          new URL(`fixtures/${entry.number.replaceAll('/', '-')}.pdf`, import.meta.url),
        );
        const bytes = yield* fs.readFile(file);
        const invoice = yield* invoiceOf(
          yield* apply({
            _tag: 'RecordIncomingInvoice',
            actorLabel: ACTOR,
            budgetCategory: entry.category,
            document: {
              contentBase64: Buffer.from(bytes).toString('base64'),
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
        return invoice;
      }),
    { concurrency: 1 },
  );

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
      due: OCTOBER_RENT_DUE,
      issued: OCTOBER_START,
      paid: 'NONE',
      paidOn: '',
      text: 'Nájemné R101 – říjen 2026',
      who: kavarna,
    },
    {
      amount: 2_500_000,
      due: OCTOBER_RENT_DUE,
      issued: OCTOBER_START,
      paid: 'FULL',
      paidOn: '2026-10-13',
      text: 'Nájemné R201 – říjen 2026',
      who: horak,
    },
    {
      amount: 82_645,
      due: '2026-10-19',
      issued: DEMO_ISSUE_DATE,
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
  yield* Effect.forEach(
    outgoing,
    (entry) =>
      Effect.gen(function* seedOutgoing() {
        const number = nextInvoiceNumber(state.invoices);
        const draftCommand = {
          _tag: 'CreateInvoiceDraft',
          counterpartyRef: ref(entry.who),
          currency: 'CZK',
          direction: 'OUTGOING',
          documentNumber: number,
          dueDate: entry.due,
          issueDate: entry.issued,
          lines: [{ description: entry.text, quantity: 1, unitPriceMinor: entry.amount, vatRate: 21 }],
          note: `Vydaná faktura (${MARKER})`,
        } satisfies FinanceCommand;
        const draft = yield* invoiceOf(
          yield* apply(
            entry.who.partyId === undefined ? draftCommand : { ...draftCommand, partyId: entry.who.partyId },
          ),
        );
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
      }),
    { concurrency: 1, discard: true },
  );

  // ---- S07.R3: recurring rent templates ----
  const templates = [
    { amount: 4_500_000, name: 'Nájem R101 – kavárna', unit: 'R101', who: kavarna },
    { amount: 2_500_000, name: 'Nájem R201 – ateliér', unit: 'R201', who: horak },
    { amount: 1_800_000, name: 'Nájem A101 – služební byt', unit: 'A101', who: technoservis },
  ] as const;
  yield* Effect.forEach(
    templates,
    (template) => {
      const command = {
        _tag: 'CreateRecurringTemplate',
        counterpartyName: template.who.name,
        counterpartyRef: ref(template.who),
        dueDays: 14,
        issueDay: 1,
        lines: [{ description: `Nájemné ${template.unit}`, quantity: 1, unitPriceMinor: template.amount, vatRate: 21 }],
        name: template.name,
      } satisfies FinanceCommand;
      return apply(template.who.partyId === undefined ? command : { ...command, partyId: template.who.partyId });
    },
    { concurrency: 1, discard: true },
  );

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
  const budgetPlan = [
    ['COST', ENERGY_CATEGORY, 5_500_000, undefined, 'Vyšší spotřeba plynu kvůli chladnému říjnu.'],
    ['COST', CLEANING_CATEGORY, 1_800_000, undefined, undefined],
    ['COST', MAINTENANCE_CATEGORY, 2_000_000, undefined, undefined],
    ['COST', INSURANCE_CATEGORY, 3_120_000, undefined, undefined],
    ['COST', 'Marketing', 0, 350_000, 'Neplánovaný inzerát na volné jednotky A102 a S01.'],
    ['REVENUE', 'Nájemné', 11_000_000, undefined, 'R301 začne platit až od prosince.'],
  ] as const;
  yield* Effect.forEach(
    ['2026-09', '2026-10', '2026-11', '2026-12'],
    (period) =>
      Effect.forEach(
        budgetPlan,
        ([kind, category, planned, actual, explanation]) => {
          if (period !== '2026-10' && category === 'Marketing') {
            return Effect.void;
          }
          let command: Extract<FinanceCommand, { readonly _tag: 'UpsertBudgetLine' }> = {
            _tag: 'UpsertBudgetLine',
            actorLabel: ACTOR,
            category,
            kind,
            period,
            plannedMinor: category === INSURANCE_CATEGORY && period !== '2026-10' ? 0 : planned,
          };
          if (period === '2026-10' && actual !== undefined) {
            command = { ...command, actualManualMinor: actual };
          }
          if (period === '2026-10' && explanation !== undefined) {
            command = { ...command, explanation };
          }
          return apply(command).pipe(Effect.asVoid);
        },
        { concurrency: 1, discard: true },
      ),
    { concurrency: 1, discard: true },
  );
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
      return yield* Effect.forEach(
        writes,
        (write) => sql`insert into finance_billing.finance_document_contents
          (tenant_id, legal_entity_id, document_id, content_base64, mime_type)
          values (${TENANT}, ${LEGAL_ENTITY}, ${write.id}, ${write.contentBase64}, ${write.mimeType})
          on conflict do nothing`,
        { concurrency: 1, discard: true },
      );
    }),
  );
  return yield* Console.log(
    `Finance demo-v2 seed written to ${LEGAL_ENTITY}: ${state.invoices.length} invoices, ${writes.length} PDFs, ` +
      `${state.budgets?.length ?? 0} budget lines, ${state.recurringTemplates?.length ?? 0} templates ` +
      `(registry tenants matched: ${tenants.length}).`,
  );
});

const command = Command.make(
  'seed-demo-v2',
  {
    force: Flag.Boolean('force').pipe(Flag.withDefault(false)),
    legalEntity: Flag.String('legal-entity').pipe(Flag.withDefault('71000000-0000-4000-8000-000000000021')),
  },
  ({ force, legalEntity }) => seed(legalEntity, force),
);
const runtimeLive = Layer.effectDiscard(Command.run(command, { version: '1.0.0' })).pipe(
  Layer.provide(Layer.mergeAll(AdminSql, NodeServices.layer, NodeCrypto.layer)),
);
NodeRuntime.runMain(Effect.scoped(Layer.build(runtimeLive)));
