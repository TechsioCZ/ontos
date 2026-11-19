// @rstest-environment happy-dom
// Purchasing forms preserve suggested orders, supplier fields, stock quantities and quote conversion.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  RecordsApi as PropertyRecordsApi,
  RecordsResponseSchema as PropertyRecordsResponseSchema,
} from '@app/property-portfolio/contracts/records';
import {
  RecordsApi as WorkRecordsApi,
  RecordsResponseSchema as WorkRecordsResponseSchema,
} from '@app/work-tasks/contracts/records';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Predicate, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import { PurchasingStateSchema, emptyPurchasingState } from '../../shared/domain/purchasing.ts';
import type { PurchasingState } from '../../shared/domain/purchasing.ts';
import { MovementForm } from '../../src/routes/[lang]/provoz/nakupy/movement-form.tsx';
import {
  ItemCreatePanel,
  PurchaseDocumentPanel,
  SupplierPanel,
  draftLine,
} from '../../src/routes/[lang]/provoz/nakupy/order-forms.tsx';
import { QuoteToOrderForm } from '../../src/routes/[lang]/provoz/nakupy/other-tabs.tsx';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { ApplyCommandResultSchema } from '../../shared/actions/apply-command.ts';
import { OpsCommandSchema } from '../../shared/agendas.ts';
import type { OpsCommand } from '../../shared/agendas.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { runCommand } from '../../src/ui/use-agenda.ts';
import { mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const created = Schema.decodeUnknownSync(ApplyCommandResultSchema)({ entityIds: ['created-1'], revision: 2 });
const propertyRecords = Schema.decodeUnknownSync(PropertyRecordsResponseSchema)({
  assets: [],
  properties: [],
  revision: 0,
  units: [],
});
const workRecords = Schema.decodeUnknownSync(WorkRecordsResponseSchema)({
  actorPrincipalRef: actor,
  assignablePrincipals: [],
  canWrite: false,
  collection: {
    properties: {
      dueDate: { locked: true, type: 'DATE' },
      ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
      status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
      title: { locked: true, type: 'TEXT' },
    },
    ref: { moduleId: 'work.tasks', resourceId: 'tasks', resourceType: 'work.tasks.task-collection', tenantId },
    title: 'Úkoly',
  },
  indicators: { open: 0, openByAssignee: [], overdue: 0 },
  items: [],
  principalNames: [],
  referenceDate: '2026-10-20',
  revision: 0,
});
const sent: OpsCommand[] = [];
const OwnerActionApi = ApplyCommandActionApi.prefix('/facility-operations-api');
const PropertyApi = PropertyRecordsApi.prefix('/property-portfolio-api');
const WorkApi = WorkRecordsApi.prefix('/work-tasks-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'facility-operations': '/facility-operations-api',
    'property-portfolio': '/property-portfolio-api',
    'work-tasks': '/work-tasks-api',
  }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'applyCommandAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          sent.push(Schema.decodeUnknownSync(OpsCommandSchema)(payload.command));
          return Effect.succeed(created);
        }),
      ),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
  serveApi(
    PropertyApi,
    HttpApiBuilder.group(PropertyApi, 'records', (group) =>
      group.handle('execute', () => Effect.succeed(propertyRecords)),
    ),
  ),
  serveApi(
    WorkApi,
    HttpApiBuilder.group(WorkApi, 'records', (group) => group.handle('execute', () => Effect.succeed(workRecords))),
  ),
);
const run = (command: OpsCommand) => runCommand(command, 0);
const mountPanel = (element: ReturnType<typeof createElement>) =>
  mountInRoute(element, { path: 'provoz/nakupy', url: '/cs/provoz/nakupy' });
const saveButton = (): HTMLButtonElement => Option.getOrThrow(Option.fromUndefinedOr(buttons(labels.save)[0]));
const click = (name: string) =>
  acted(() => {
    Option.getOrThrow(Option.fromUndefinedOr(buttons(name)[0])).click();
  });
const typeInto = (selector: string, value: string) =>
  acted(() => {
    const field = Option.getOrThrow(
      Option.fromNullOr(document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)),
    );
    Reflect.set(Object.getPrototypeOf(field), 'value', value, field);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
const saveSent = (count: number) =>
  click(labels.save).pipe(
    Effect.andThen(waitUntil(() => sent.length >= count)),
    Effect.andThen(waitUntil(() => saveButton().textContent.trim() === labels.save)),
    Effect.andThen(networkIdle),
  );

const audit = {
  createdAt: '2026-10-20T08:00:00Z',
  createdBy: actor,
  updatedAt: '2026-10-20T08:00:00Z',
  updatedBy: actor,
};
const state: PurchasingState = Schema.decodeUnknownSync(PurchasingStateSchema)({
  ...emptyPurchasingState,
  items: [
    {
      ...audit,
      category: 'consumable',
      id: 'item-1',
      lastPriceMinor: 12_000,
      leadTimeDays: 7,
      maximum: 50,
      minimum: 10,
      name: 'Filtr G4',
      sku: 'FLT-G4',
      tracking: 'none',
      unit: 'ks',
      warehouseId: 'warehouse-1',
    },
  ],
  quotes: [
    {
      ...audit,
      currency: 'CZK',
      date: '2026-10-20',
      id: 'quote-1',
      lines: [{ description: 'Filtr G4', id: 'line-1', itemId: 'item-1', quantity: 20, unitPriceMinor: 12_000 }],
      number: 'NAB-17',
      status: 'received',
      supplierId: 'supplier-1',
    },
  ],
  suppliers: [{ ...audit, id: 'supplier-1', name: 'Filtry s.r.o.' }],
  warehouses: [{ ...audit, code: 'HS', id: 'warehouse-1', name: 'Hlavní sklad' }],
});
const [item] = state.items;
const [quote] = state.quotes;

const calls: string[] = [];
const page = (name: string) => () => {
  calls.push(name);
};

beforeEach(() => {
  sent.length = 0;
  calls.length = 0;
});

afterEach(() => {
  unmountAll();
});

describe('purchase order, supplier and stock item', () => {
  it.live('an order handed over with its lines can be sent at once; Uložit creates it once', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mountPanel(
        createElement(PurchaseDocumentPanel, {
          initialLines: item === undefined ? [] : [draftLine('suggested', item, 5)],
          initialSupplierId: 'supplier-1',
          kind: 'order',
          onClose: page('close'),
          onCreated: page('created'),
          run,
          state,
        }),
      );
      expect(saveButton().disabled).toBe(false);
      yield* saveSent(1);
      expect(sent).toEqual([
        expect.objectContaining({
          _tag: 'PurchaseOrderCreate',
          lines: [expect.objectContaining({ itemId: 'item-1', quantity: 5 })],
          supplierId: 'supplier-1',
          warehouseId: 'warehouse-1',
        }),
      ]);
      expect(calls).toEqual(['created']);
    }).pipe(Effect.provide(network)),
  );

  it.live('maps the typed supplier name to the create command', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mountPanel(createElement(SupplierPanel, { onClose: page('close'), run }));
      yield* typeInto('#supplier-name', 'Čistota a.s.');
      yield* saveSent(1);
      expect(sent).toEqual([{ _tag: 'PurchaseSupplierCreate', name: 'Čistota a.s.' }]);
      expect(calls).toEqual(['close']);
    }).pipe(Effect.provide(network)),
  );

  it.live('maps stock limits and SKU to the create command', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      yield* mountPanel(
        createElement(ItemCreatePanel, { onClose: page('close'), onCreated: page('created'), run, state }),
      );
      yield* typeInto('#item-sku', 'FLT-G5');
      yield* typeInto('#item-name', 'Filtr G5');
      yield* typeInto('#item-minimum', '5');
      yield* typeInto('#item-maximum', '20');
      yield* saveSent(1);
      expect(Predicate.isTagged(sent[0], 'StockItemCreate')).toBe(true);
      expect(sent[0]).toMatchObject({ maximum: 20, minimum: 5, sku: 'FLT-G5' });
      expect(calls).toEqual(['created']);
    }).pipe(Effect.provide(network)),
  );
});

describe('stock movement and order from a quote', () => {
  it.live('a receipt is recorded once with the typed quantity and reason', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      if (item === undefined) {
        return;
      }
      yield* mountPanel(createElement(MovementForm, { item, kind: 'receipt', onDone: page('done'), run, state }));
      yield* typeInto('#movement-quantity', '12');
      yield* typeInto('#movement-reason', 'Dodávka');
      yield* saveSent(1);
      expect(sent).toEqual([
        expect.objectContaining({ _tag: 'StockReceipt', itemId: item.id, quantity: 12, reason: 'Dodávka' }),
      ]);
      expect(calls).toEqual(['done']);
    }).pipe(Effect.provide(network)),
  );

  it.live('a quote becomes an order on Uložit, with the warehouse it opened with', () =>
    Effect.gen(function* scenario() {
      yield* pinTestDocument;
      if (quote === undefined) {
        return;
      }
      yield* mountPanel(
        createElement(QuoteToOrderForm, {
          onOpenOrder: page('order'),
          quote,
          run,
          setError: constVoid,
          state,
        }),
      );
      yield* saveSent(1);
      expect(sent).toEqual([{ _tag: 'PurchaseOrderCreateFromQuote', quoteId: quote.id, warehouseId: 'warehouse-1' }]);
      expect(calls).toEqual(['order']);
    }).pipe(Effect.provide(network)),
  );
});
