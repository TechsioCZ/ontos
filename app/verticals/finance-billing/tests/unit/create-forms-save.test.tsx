// @rstest-environment happy-dom
// The real forms, router, translations, VAT read and finance clients: edits stay local until the footer's Uložit.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { pinDocumentNavigationModules } from '@app/shared-contracts';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder, HttpRouter, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { ToastProvider } from '@techsio/ui-kit/molecules/toast';
import { Effect, Layer, Option, Predicate, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import type { ReactElement } from 'react';
import { CustomerListApi } from '../../../party-registry/shared/apis/customer-list.ts';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import type { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { InvoiceSchema, RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { VatChoicesApi } from '../../shared/apis/vat-choices.ts';
import { CreateInvoiceDialog } from '../../src/routes/[lang]/finance/create-invoice-dialog.tsx';
import type { FinanceViewModel } from '../../src/routes/[lang]/finance/finance-ui.tsx';
import { IncomingInvoiceDialog } from '../../src/routes/[lang]/finance/incoming-invoice-dialog.tsx';
import { RecurringTemplateEditor } from '../../src/routes/[lang]/finance/recurring-template-form.tsx';
import { useFinanceRecords } from '../../src/routes/[lang]/finance/use-finance-records.ts';
import type { DraftInvoiceInput } from '../../src/routes/[lang]/finance/use-finance-records.ts';
import { baselineVatChoices } from '../support/finance-tax-rates.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

type Command = (typeof ApplyCommandPayloadSchema.Encoded)['command'];
const sent: Command[] = [];
const tenantId = 'c0000000-0000-4000-8000-000000000001';
const invoice = Schema.decodeUnknownSync(InvoiceSchema)({
  accountingCorrelation: 'acc-invoice-1',
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'CONFIRMED',
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: 'c0000000-0000-4000-8000-000000000012',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  createdAt: '2026-10-20T08:00:00Z',
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: 'FV-2026-001',
  dueDate: '2026-10-30',
  issueDate: '2026-10-01',
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: {
    moduleId: 'finance.billing',
    resourceId: 'c0000000-0000-4000-8000-000000000021',
    resourceType: 'finance.billing.invoice',
    tenantId,
  },
  totalMinor: 100_000,
  updatedAt: '2026-10-20T08:00:00Z',
});
const customer: FinanceViewModel['references']['customers'][number] = {
  city: null,
  companyId: '12345678',
  counterpartyId: 'c0000000-0000-4000-8000-000000000012',
  counterpartyRef: invoice.counterpartyRef,
  createdAt: '2026-10-01T08:00:00.000Z',
  displayName: 'Kavárna Dolce',
  email: null,
  partyId: 'c0000000-0000-4000-8000-000000000013',
  partyRef: {
    moduleId: 'party.registry',
    resourceId: 'c0000000-0000-4000-8000-000000000013',
    resourceType: 'party.registry.party',
    tenantId,
  },
  partyRevision: 1,
  phone: null,
  status: 'ACTIVE',
  vatId: null,
};
const records = Schema.decodeUnknownSync(RecordsResponseSchema)({
  businessDate: '2026-10-20',
  canWrite: true,
  indicators: {
    costMinor: 0,
    costVarianceMinor: 0,
    draftCount: 0,
    grossOutstandingMinor: 0,
    openIncomingInvoices: 0,
    openInvoices: 0,
    openOutgoingInvoices: 0,
    overdueInvoices: 0,
    payablesOutstandingMinor: 0,
    plannedCostMinor: 0,
    plannedRevenueMinor: 0,
    receivablesOutstandingMinor: 0,
    revenueMinor: 0,
    revenueVarianceMinor: 0,
  },
  referenceDate: '2026-10-05',
  revision: 1,
  state: { financialPlanEntries: [], invoices: [] },
});
const OwnerActions = ApplyCommandActionApi.prefix('/finance-billing-api');
const OwnerRecords = RecordsApi.prefix('/finance-billing-api');
const OwnerVat = VatChoicesApi.prefix('/finance-billing-api');
const Party = CustomerListApi.prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'finance-billing': '/finance-billing-api', 'party-registry': '/party-registry-api' })
    .application,
  serveApi(
    OwnerActions,
    HttpApiBuilder.group(OwnerActions, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          sent.push(payload.command);
          return { changed: true, invoice, revision: 2 };
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerRecords,
    HttpApiBuilder.group(OwnerRecords, 'records', (group) => group.handle('execute', () => Effect.succeed(records))),
  ),
  serveApi(
    OwnerVat,
    HttpApiBuilder.group(OwnerVat, 'vatChoices', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.succeed(baselineVatChoices('00000000-0000-4000-8000-0000000000aa', payload.on)),
      ),
    ),
  ),
  serveApi(
    Party,
    HttpApiBuilder.group(Party, 'customerList', (group) =>
      group.handle('execute', () => Effect.succeed({ items: [customer] })),
    ),
  ),
  HttpRouter.add(
    'GET',
    '/shell-super-app-api/auth/session',
    Effect.succeed(HttpServerResponse.jsonUnsafe({ identity: { displayName: 'Jana Nováková' } })),
  ),
);

let scopeSequence = 0;
const Form = ({
  drafts,
  render,
}: {
  readonly drafts: DraftInvoiceInput[];
  readonly render: (vm: FinanceViewModel) => ReactElement;
}) => {
  const vm = useFinanceRecords({ scope: `create-forms-save-${scopeSequence}` });
  if (vm.snapshot === undefined || vm.references.customersLoading) {
    return null;
  }
  return render({
    ...vm,
    createDraft: (input) => {
      drafts.push(input);
      return vm.createDraft(input);
    },
  });
};
const mount = (render: (vm: FinanceViewModel) => ReactElement, drafts: DraftInvoiceInput[] = []) =>
  Effect.gen(function* mountForm() {
    yield* mountInRoute(
      <ToastProvider>
        <Form drafts={drafts} render={render} />
      </ToastProvider>,
      { path: 'finance', url: '/cs/finance' },
    );
    yield* waitUntil(() => document.querySelector('form') !== null);
  });
const labels = saveLabelsFor('cs');
const t = moduleText('cs');
const CREATED = 'finance-billing.faktury.form.created';
const closes: boolean[] = [];
const onOpenChange = (open: boolean) => {
  closes.push(open);
};
const saveButton = () =>
  Option.getOrThrow(
    Option.fromUndefinedOr(buttons(labels.save).find((button) => button.closest('[role="alertdialog"]') === null)),
  );
const clickSave = acted(() => saveButton().click());
const field = (id: string) =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`[id="${id}"]`)));
const typeInto = (id: string, value: string) =>
  acted(() => {
    const input = field(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const pickTenant = acted(() => {
  const select = Option.getOrThrow(
    Option.fromUndefinedOr(
      [...document.querySelectorAll<HTMLSelectElement>('select')].find(
        (candidate) =>
          document
            .querySelector(`[id="${candidate.getAttribute('aria-labelledby') ?? ''}"]`)
            ?.textContent?.includes(t('finance-billing.financeUi.recurring.tenant')) === true,
      ),
    ),
  );
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, customer.partyId);
  select.dispatchEvent(new Event('change', { bubbles: true }));
});
const fillInvoice = (price: string) =>
  Effect.gen(function* fill() {
    yield* acted(() =>
      Option.getOrThrow(
        Option.fromNullOr(document.querySelector<HTMLInputElement>('input[data-scope="combobox"][data-part="input"]')),
      ).click(),
    );
    yield* waitUntil(() => document.querySelector('[role="option"]') !== null);
    yield* acted(() =>
      Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLElement>('[role="option"]'))).click(),
    );
    yield* typeInto('invoice-line-description-line-1', 'Pronájem kavárny');
    yield* typeInto('invoice-line-price-line-1', price);
  });
const toastTitles = () =>
  [...document.querySelectorAll('[data-scope="toast"][data-part="title"]')].map((toast) => toast.textContent);

beforeEach(() => {
  scopeSequence += 1;
  pinDocumentNavigationModules(['finance.billing', 'party.registry'], document);
  closes.length = 0;
  sent.length = 0;
});
afterEach(unmountAll);

it.layer(network, { excludeTestServices: true })('create forms save from Uložit only', (suite) => {
  suite.effect('a recurring template maps the selected tenant and entered terms to its command', () =>
    Effect.gen(function* step1() {
      yield* pinTestDocument;
      const left: string[] = [];
      const onClose = () => {
        left.push('closed');
      };
      yield* mount((vm) => <RecurringTemplateEditor onClose={onClose} vm={vm} />);
      yield* pickTenant;
      yield* typeInto('template-name', 'Nájem kavárna');
      yield* typeInto('template-amount', '18 000');
      yield* clickSave;
      yield* waitUntil(() => left.length === 1);
      expect(sent).toHaveLength(1);
      expect(Predicate.isTagged(sent[0], 'CreateRecurringTemplate')).toBe(true);
      expect(sent[0]).toMatchObject({ dueDays: 14, issueDay: 1, name: 'Nájem kavárna', partyId: customer.partyId });
    }),
  );

  suite.effect('an incoming invoice maps supplier, document number and VAT-inclusive total', () =>
    Effect.gen(function* step2() {
      yield* pinTestDocument;
      yield* mount((vm) => <IncomingInvoiceDialog onOpenChange={onOpenChange} open vm={vm} />);
      expect(saveButton().disabled).toBe(true);
      yield* typeInto('incoming-supplier', 'ČEZ Prodej');
      yield* typeInto('incoming-number', 'ZF-2026-77');
      yield* typeInto('invoice-line-description-incoming-line-1', 'Elektřina říjen');
      yield* typeInto('invoice-line-price-incoming-line-1', '1000');
      yield* clickSave;
      yield* waitUntil(() => closes.length === 1);
      expect(sent).toHaveLength(1);
      expect(Predicate.isTagged(sent[0], 'RecordIncomingInvoice')).toBe(true);
      expect(sent[0]).toMatchObject({ documentNumber: 'ZF-2026-77', supplierName: 'ČEZ Prodej', totalMinor: 121_000 });
    }),
  );

  suite.effect('a new invoice draft carries its selected customer and document kind', () =>
    Effect.gen(function* step3() {
      yield* pinTestDocument;
      const drafts: DraftInvoiceInput[] = [];
      yield* mount((vm) => <CreateInvoiceDialog onOpenChange={onOpenChange} open vm={vm} />, drafts);
      yield* fillInvoice('1000');
      yield* clickSave;
      yield* waitUntil(() => closes.length === 1);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({ customer: { partyId: customer.partyId }, documentKind: 'STANDARD' });
      expect(toastTitles()).toEqual([t(CREATED)]);
    }),
  );
});
