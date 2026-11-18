// @rstest-environment happy-dom
// Purchase and sales forms send once through the real owner Action clients on Uložit.
// Their real i18n, router, VAT read and Finance records run against in-process HttpApi handlers.
import { Effect, Layer, Option, Schema } from 'effect';
import { CZ_VAT_STANDARD } from '@app/shared-contracts/cz-vat-classifications';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import { PurchaseOrderSchema, SalesOrderSchema, SupplierSchema } from '../../shared/domain/purchasing.ts';
import { salesRemainder } from '../../shared/commands/sales.ts';
import { InvoiceDraftForm } from '../../src/routes/[lang]/provoz/nakupy/invoice-draft-form.tsx';
import { InvoiceForm, ReceiveForm } from '../../src/routes/[lang]/provoz/nakupy/orders-tab.tsx';
import { SalesCloseForm, SalesDeliverForm } from '../../src/routes/[lang]/provoz/nakupy/sales-order-forms.tsx';
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, settle, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { HttpApi } from 'effect/http-api';
import { financeBillingApi } from '@app/finance-billing/api';
import { RecordsResponseSchema as FinanceRecordsResponseSchema } from '@app/finance-billing/contracts/records';
import { ApplyCommandPayloadSchema as FinancePayloadSchema } from '@app/finance-billing/contracts/apply-command';
import type { FinanceCommand } from '@app/finance-billing/contracts/apply-command';
import { ApplyCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { applyCommandActionSchemaErrorLive as financeSchemaErrorLive } from '../../../finance-billing/api/apply-command-action-problems.ts';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import type { OpsCommand } from '../../shared/agendas.ts';
import type { CommandOutcome } from '../../src/ui/use-agenda.ts';
import { executeApplyCommand } from '../../src/api/apply-command-action-client.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const czech = moduleText('cs');
const copy = {
  cancel: czech('facility-operations.common.cancel'),
  close: czech('facility-operations.purchasing.sales.actions.close'),
};
const financeCommands: FinanceCommand[] = [];
const commands: OpsCommand[] = [];
const calls: string[] = [];
const taxRevisionId = '70000000-0000-4000-8000-000000000022';

const click = (name: string) => acted(() => Option.getOrThrow(Option.fromUndefinedOr(buttons(name)[0])).click());
const saveButton = () => Option.getOrThrow(Option.fromUndefinedOr(buttons(labels.save)[0]));
const leaveQuestionOpen = () => buttons(labels.discard).length > 0;
const typeInto = (selector: string, value: string) =>
  acted(() => {
    const field = Option.getOrThrow(
      Option.fromNullOr(document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)),
    );
    Reflect.set(Object.getPrototypeOf(field), 'value', value, field);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
const pick = (name: string, value: string) =>
  acted(() => {
    const select = Option.getOrThrow(
      Option.fromNullOr(document.querySelector<HTMLSelectElement>(`select[name="${name}"]`)),
    );
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
const mountPanel: typeof mountInRoute = (element) => mountInRoute(element, { url: '/cs/provoz/nakupy' });
const recordingRunner = () => ({
  run: (command: OpsCommand): Effect.Effect<CommandOutcome> =>
    executeApplyCommand({ command, expectedRevision: 7 }, 'order-forms-save', {
      idempotencyKey: `order-forms-save:${command._tag}`,
    }).pipe(
      Effect.orDie,
      Effect.map((result): CommandOutcome =>
        'revision' in result ? { ok: true, result } : { ok: false, reason: 'approval_required' },
      ),
    ),
  sent: commands,
});
const saveSent = (runner: ReturnType<typeof recordingRunner>, count: number) =>
  click(labels.save).pipe(
    Effect.andThen(waitUntil(() => runner.sent.length >= count)),
    Effect.andThen(waitUntil(() => calls.length > 0)),
    Effect.andThen(settle),
  );
const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const audit = {
  createdAt: '2026-10-20T08:00:00Z',
  createdBy: actor,
  updatedAt: '2026-10-20T08:00:00Z',
  updatedBy: actor,
};
const supplier = Schema.decodeUnknownSync(SupplierSchema)({ ...audit, id: 'supplier-1', name: 'Filtry s.r.o.' });
const order = Schema.decodeUnknownSync(PurchaseOrderSchema)({
  ...audit,
  currency: 'CZK',
  deliveries: [],
  history: [],
  id: 'order-1',
  invoices: [],
  lines: [{ description: 'Filtr G4', id: 'line-1', quantity: 10, receivedQuantity: 0, unitPriceMinor: 12_000 }],
  number: 'OBJ-2026-004',
  status: 'ordered',
  supplierId: supplier.id,
  warehouseId: 'warehouse-1',
});
const salesOrder = Schema.decodeUnknownSync(SalesOrderSchema)({
  ...audit,
  currency: 'CZK',
  customer: { counterpartyId: 'customer-1', name: 'Kavárna Dolce', tenantId },
  deliveries: [],
  history: [],
  id: 'sales-order-1',
  invoices: [],
  lines: [
    { deliveredQuantity: 0, description: 'Servis', id: 'line-1', quantity: 2, unitPriceMinor: 150_000, vatRate: 21 },
  ],
  number: 'PRO-2026-002',
  status: 'partially_delivered',
});
const lookupState = { items: [] };

const page = (name: string) => () => {
  calls.push(name);
};

const FinanceApi = HttpApi.make('OrderFormsFinanceApi')
  .add(financeBillingApi.groups.records)
  .add(financeBillingApi.groups.vatChoices)
  .add(financeBillingApi.groups.applyCommandAction)
  .prefix('/finance-billing-api');
const FacilityApi = ApplyCommandActionApi.prefix('/facility-operations-api');
const financeRecords = Schema.decodeUnknownSync(FinanceRecordsResponseSchema)({
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
  revision: 7,
  state: { financialPlanEntries: [], invoices: [] },
});
const network = browserNetwork(
  shellGatewayIssuer({ 'facility-operations': '/facility-operations-api', 'finance-billing': '/finance-billing-api' })
    .application,
  serveApi(
    FacilityApi,
    HttpApiBuilder.group(FacilityApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(Schema.decodeUnknownSync(ApplyCommandPayloadSchema)(payload).command);
          return { entityIds: [], revision: 8 };
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    FinanceApi,
    Layer.mergeAll(
      HttpApiBuilder.group(FinanceApi, 'records', (group) =>
        group.handle('execute', () => Effect.succeed(financeRecords)),
      ),
      HttpApiBuilder.group(FinanceApi, 'vatChoices', (group) =>
        group.handle('execute', ({ payload }) =>
          Effect.succeed({
            on: payload.on,
            rates: [
              {
                code: CZ_VAT_STANDARD,
                effectiveFrom: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)('2026-01-01T00:00:00Z'),
                ratePercent: 21,
                taxRuleRevisionRef: {
                  moduleId: 'commerce.tax',
                  resourceId: taxRevisionId,
                  resourceType: 'commerce.tax.tax-rule-revision',
                  tenantId,
                },
              },
            ],
            regime: 'VAT_PAYER' as const,
          }),
        ),
      ),
      HttpApiBuilder.group(FinanceApi, 'applyCommandAction', (group) =>
        group.handle('execute', ({ payload }) =>
          Effect.sync(() => {
            financeCommands.push(Schema.decodeUnknownSync(FinancePayloadSchema)(payload).command);
            return { changed: true, revision: 8 };
          }),
        ),
      ).pipe(Layer.provide(financeSchemaErrorLive)),
    ),
  ),
);
beforeEach(() => {
  calls.length = 0;
  commands.length = 0;
  financeCommands.length = 0;
});
afterEach(unmountAll);

describe('purchase order forms', () => {
  it.live('a receipt opens with the remaining quantities and records them once', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const runner = recordingRunner();
      yield* mountPanel(
        createElement(ReceiveForm, {
          onDone: page('done'),
          order,
          run: runner.run,
          state: {
            ...lookupState,
            movements: [],
            orders: [order],
            plannedIssues: [],
            quotes: [],
            suppliers: [supplier],
            warehouses: [],
          },
        }),
      );
      yield* typeInto('#receive-note', 'DL-55');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        expect.objectContaining({
          _tag: 'PurchaseOrderReceive',
          deliveryNote: 'DL-55',
          lines: [{ lineId: 'line-1', quantity: 10 }],
          orderId: order.id,
        }),
      ]);
      expect(calls).toEqual(['done']);
    }).pipe(Effect.provide(network)),
  );

  it.live('an invoice is linked once with the typed number; leaving with it asks', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const runner = recordingRunner();
      yield* mountPanel(createElement(InvoiceForm, { onDone: page('done'), order, run: runner.run }));
      yield* typeInto('#invoice-number', 'FV-2026-118');
      yield* click(copy.cancel);
      expect(leaveQuestionOpen()).toBe(true);
      yield* click(labels.stay);
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([{ _tag: 'PurchaseOrderLinkInvoice', number: 'FV-2026-118', orderId: order.id }]);
      expect(calls).toEqual(['done']);
    }).pipe(Effect.provide(network)),
  );

  it.live('the incoming invoice requires the actual document number and a published VAT choice', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mountPanel(
        createElement(InvoiceDraftForm, { onCancel: page('cancel'), onCreated: page('created'), order, supplier }),
      );
      expect(saveButton().disabled).toBe(true);
      yield* waitUntil(
        () => document.querySelector(`select[name="invoice-vat-rate"] option[value="${CZ_VAT_STANDARD}"]`) !== null,
      );
      yield* pick('invoice-vat-rate', CZ_VAT_STANDARD);
      expect(saveButton().disabled).toBe(true);
      yield* typeInto('#draft-invoice-number', 'SUP-2026-118');
      yield* click(labels.save);
      yield* waitUntil(() => calls.includes('created'));
      expect(financeCommands).toEqual([
        expect.objectContaining({
          _tag: 'RecordIncomingInvoice',
          documentNumber: 'SUP-2026-118',
          lines: [
            expect.objectContaining({
              taxRuleRevisionRef: expect.objectContaining({ resourceId: taxRevisionId }),
              vatClassification: CZ_VAT_STANDARD,
              vatRate: 21,
            }),
          ],
          sourceOrder: { id: order.id, number: order.number },
        }),
      ]);
      expect(calls).toEqual(['created']);
    }).pipe(Effect.provide(network)),
  );
});

describe('sales order forms', () => {
  it.live('a delivery is recorded once with the typed quantity', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const runner = recordingRunner();
      yield* mountPanel(
        createElement(SalesDeliverForm, {
          onDone: page('done'),
          order: salesOrder,
          remainder: salesRemainder(salesOrder),
          run: runner.run,
        }),
      );
      yield* typeInto('#sales-deliver-line-1', '1');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        expect.objectContaining({
          _tag: 'SalesOrderDeliver',
          lines: [{ lineId: 'line-1', quantity: 1 }],
          orderId: salesOrder.id,
        }),
      ]);
      expect(calls).toEqual(['done']);
    }).pipe(Effect.provide(network)),
  );

  it.live('closing with a remainder needs a reason, then closes once', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      const runner = recordingRunner();
      yield* mountPanel(
        createElement(SalesCloseForm, {
          closeLabel: copy.close,
          onDone: page('done'),
          order: salesOrder,
          run: runner.run,
        }),
      );
      expect(saveButton().disabled).toBe(true);
      yield* typeInto('#sales-close-reason', 'Zákazník zbytek nechce');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        {
          _tag: 'SalesOrderTransition',
          note: 'Zákazník zbytek nechce',
          orderId: salesOrder.id,
          to: 'completed',
        },
      ]);
      expect(calls).toEqual(['done']);
    }).pipe(Effect.provide(network)),
  );
});
