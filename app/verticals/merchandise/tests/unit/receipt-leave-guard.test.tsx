// @rstest-environment happy-dom
// Receipt leave guards and product selection run through the real router, translations, controls and clients.
// The owner's HTTP contracts hold full-record responses until each case releases them.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, settle, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkQuietExcept,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { recordStockMovementActionSchemaErrorLive } from '../../api/record-stock-movement-action-problems.ts';
import { RecordStockMovementResultSchema } from '../../shared/actions/record-stock-movement.ts';
import { RecordStockMovementActionApi } from '../../shared/apis/record-stock-movement-action.ts';
import type { RecordStockMovementPayloadSchema } from '../../shared/apis/record-stock-movement-action.ts';
import { RecordsApi, RecordsResponseSchema, RecordsForbiddenProblemSchema } from '../../shared/apis/records.ts';
import type { ProductRecord, RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import { ReceiptDialog } from '../../src/routes/[lang]/provoz/produkty/product-forms.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const czech = moduleText('cs');
const copy = {
  cancel: czech('merchandise.pages.products.common.cancel'),
  // This retired key has no catalog entry; the baseline guards its absence.
  oldKeep: 'merchandise.pages.products.detail.discardKeep',
  retry: czech('merchandise.pages.products.common.retry'),
  submit: czech('merchandise.pages.products.receipt.submit'),
  typed: 'typed-note',
} as const;

const receiptProduct = Schema.decodeSync(ProductRecordSchema)({
  active: true,
  category: 'Stock',
  createdAt: '2026-11-14T10:00:00Z',
  currentPriceMinor: 1000,
  id: 'receipt-product',
  lowStock: false,
  lowStockThreshold: 0,
  name: 'Receipt product',
  priceHistory: [],
  sku: 'RECEIPT',
  stockOnHand: 0,
  stockValueMinor: 0,
  taxClassificationCode: 'cz.vat.standard',
  unit: 'm',
  updatedAt: '2026-11-14T10:00:00Z',
  variantRecords: [
    {
      active: true,
      attributes: '',
      availability: 'OUT_OF_STOCK',
      id: 'receipt-v1',
      name: 'Small',
      priceHistory: [],
      priceMinor: 1000,
      sku: 'RECEIPT-SMALL',
      stockOnHand: 0,
    },
  ],
});

const plain = Schema.decodeSync(ProductRecordSchema)({
  ...Schema.encodeSync(ProductRecordSchema)(receiptProduct),
  id: 'plain-receipt-product',
  variantRecords: [],
});
const recordsWith = (products: readonly ProductRecord[]): RecordsResponse =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '20000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    canWrite: true,
    indicators: {
      lowStockCount: 0,
      openOrderValueMinor: 0,
      orderCount: 0,
      productCount: products.length,
      stockValueMinor: 0,
    },
    movements: [],
    orders: [],
    products: products.map((product) => Schema.encodeSync(ProductRecordSchema)(product)),
    revision: 4,
  });
const summary = recordsWith([receiptProduct, plain].map((product) => ({ ...product, variantRecords: [] })));
const refused = Schema.decodeSync(RecordsForbiddenProblemSchema)({
  _tag: 'RecordsForbiddenProblem',
  detail: 'refused',
  status: 403,
  title: 'Forbidden',
  type: 'urn:ontos:test:records-forbidden',
});
const created = Schema.decodeSync(RecordStockMovementResultSchema)({ entityIds: [], revision: 5 });
const commands: (typeof RecordStockMovementPayloadSchema.Encoded)[] = [];
const reads: {
  readonly gate: Deferred.Deferred<RecordsResponse, typeof RecordsForbiddenProblemSchema.Type>;
  readonly request: RecordsRequest;
  readonly returned: Deferred.Deferred<true>;
}[] = [];
const openChanges: boolean[] = [];
const OwnerRecords = RecordsApi.prefix('/merchandise-api');
const OwnerAction = RecordStockMovementActionApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerRecords,
    HttpApiBuilder.group(OwnerRecords, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.gen(function* read() {
          if (payload.view?.summary === true) {
            return summary;
          }
          const gate = yield* Deferred.make<RecordsResponse, typeof RecordsForbiddenProblemSchema.Type>();
          const returned = yield* Deferred.make<true>();
          reads.push({ gate, request: payload, returned });
          return yield* Deferred.await(gate).pipe(Effect.ensuring(Deferred.succeed(returned, true)));
        }),
      ),
    ),
  ),
  serveApi(
    OwnerAction,
    HttpApiBuilder.group(OwnerAction, 'recordStockMovementAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload);
          return created;
        }),
      ),
    ).pipe(Layer.provide(recordStockMovementActionSchemaErrorLive)),
  ),
);
const mount = Effect.gen(function* mountReceipt() {
  yield* pinTestDocument;
  yield* mountInRoute(
    <ReceiptDialog
      onCommitted={constVoid}
      onOpenChange={(open) => {
        openChanges.push(open);
      }}
      onReload={constVoid}
      open
      revision={4}
    />,
    { path: 'provoz/produkty', url: '/cs/provoz/produkty' },
  );
});
const button = (label: string): HTMLButtonElement => Option.getOrThrow(Option.fromNullishOr(buttons(label)[0]));
const field = (id: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`input[id="${id}"]`)));
const typeInto = (id: string, value: string) =>
  acted(() => {
    const input = field(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const typeNote = (value: string) => typeInto('receipt-note', value);
const click = (element: HTMLElement) => acted(() => element.click());
const variantTrigger = () => document.querySelector<HTMLButtonElement>('[data-scope="select"][data-part="trigger"]');
const pickProduct = (product: ProductRecord) =>
  Effect.gen(function* pickProductOption() {
    yield* click(field('receipt-product-input'));
    yield* waitUntil(() => document.querySelector(`[role="option"][data-value="${product.id}"]`) !== null, 2000);
    yield* acted(() =>
      Option.getOrThrow(
        Option.fromNullOr(document.querySelector<HTMLElement>(`[role="option"][data-value="${product.id}"]`)),
      ).click(),
    );
  });
const pickVariant = Effect.gen(function* pickVariantOption() {
  yield* click(Option.getOrThrow(Option.fromNullOr(variantTrigger())));
  yield* waitUntil(() => document.querySelector('[role="option"][data-value="receipt-v1"]') !== null);
  yield* acted(() =>
    Option.getOrThrow(
      Option.fromNullOr(document.querySelector<HTMLElement>('[role="option"][data-value="receipt-v1"]')),
    ).click(),
  );
});
const pendingRead = (index: number) =>
  Effect.gen(function* pendingProductRead() {
    yield* waitUntil(() => reads.length > index);
    return Option.getOrThrow(Option.fromUndefinedOr(reads[index]));
  });
const answerRead = (index: number, product: ProductRecord) =>
  Effect.gen(function* answerProductRead() {
    const read = yield* pendingRead(index);
    yield* Deferred.succeed(read.gate, recordsWith([product]));
    yield* Deferred.await(read.returned);
    // The answer reaches the dialog while the reads still held stay open.
    yield* networkQuietExcept(reads.filter((held) => !Deferred.isDoneUnsafe(held.returned)).length);
    yield* settle;
  });

beforeEach(() => {
  openChanges.length = 0;
  reads.length = 0;
  commands.length = 0;
});
afterEach(unmountAll);

it.live('closing with typed input asks the shared leave question; Zůstat keeps it, Zahodit změny closes', () =>
  Effect.gen(function* leave() {
    yield* mount;
    yield* typeNote(copy.typed);
    yield* click(button(copy.cancel));
    expect(buttons(copy.oldKeep)).toHaveLength(0);
    expect(buttons(labels.stay)).toHaveLength(1);
    expect(buttons(labels.discard)).toHaveLength(1);
    // The question never sends the receipt: only the command's own button does.
    expect(button(labels.save).disabled).toBe(true);
    expect(openChanges).toEqual([]);
    yield* click(button(labels.stay));
    expect(buttons(labels.stay)).toHaveLength(0);
    expect(document.querySelector<HTMLInputElement>('#receipt-note')?.value).toBe(copy.typed);
    yield* click(button(copy.cancel));
    yield* click(button(labels.discard));
    expect(openChanges).toEqual([false]);
  }).pipe(Effect.provide(network)),
);
it.live('an untouched receipt closes at once', () =>
  Effect.gen(function* untouched() {
    yield* mount;
    yield* click(button(copy.cancel));
    expect(buttons(labels.stay)).toHaveLength(0);
    expect(openChanges).toEqual([false]);
  }).pipe(Effect.provide(network)),
);
it.live('the receipt button stays disabled until a product is picked', () =>
  Effect.gen(function* disabledSubmit() {
    yield* mount;
    expect(button(copy.submit).disabled).toBe(true);
    yield* typeNote(copy.typed);
    expect(button(copy.submit).disabled).toBe(true);
  }).pipe(Effect.provide(network)),
);
it.live('waits for the full product and an explicit variant, then submits that identity and fractional amount', () =>
  Effect.gen(function* receiptVariantIdentity() {
    yield* mount;
    yield* pickProduct(receiptProduct);
    expect(button(copy.submit).disabled).toBe(true);
    yield* answerRead(0, receiptProduct);
    yield* waitUntil(() => variantTrigger() !== null);
    expect(button(copy.submit).disabled).toBe(true);
    yield* pickVariant;
    yield* typeInto('receipt-quantity', '0,125');
    expect(button(copy.submit).disabled).toBe(false);
    yield* click(button(copy.submit));
    yield* waitUntil(() => commands.length > 0);
    const sent = commands[0]?.command;
    expect(Predicate.isTagged(sent, 'RecordStockMovement')).toBe(true);
    expect(sent).toMatchObject({
      delta: 0.125,
      productId: receiptProduct.id,
      reason: 'RECEIPT',
      variantId: 'receipt-v1',
    });
  }).pipe(Effect.provide(network)),
);
it.live('does not permit a receipt when the selected product record cannot be loaded', () =>
  Effect.gen(function* receiptReadFailure() {
    yield* mount;
    yield* pickProduct(receiptProduct);
    const first = yield* pendingRead(0);
    yield* Deferred.fail(first.gate, refused);
    yield* waitUntil(() => buttons(copy.retry).length > 0);
    expect(button(copy.submit).disabled).toBe(true);
    expect(commands).toHaveLength(0);
    // The retry reads the same product again; its record then lets the receipt choose a variant.
    yield* click(button(copy.retry));
    yield* pendingRead(1);
    yield* networkQuietExcept(1);
    expect(reads).toHaveLength(2);
    expect(reads[1]?.request).toEqual(reads[0]?.request);
    yield* answerRead(1, receiptProduct);
    yield* waitUntil(() => variantTrigger() !== null);
    expect(buttons(copy.retry)).toHaveLength(0);
    expect(document.querySelectorAll('[data-scope="select"][data-part="trigger"]')).toHaveLength(1);
  }).pipe(Effect.provide(network)),
);
it.live('ignores a stale product response and permits a variant-free receipt only after its own read', () =>
  Effect.gen(function* staleReceiptSelection() {
    yield* mount;
    yield* pickProduct(receiptProduct);
    yield* pendingRead(0);
    yield* pickProduct(plain);
    yield* pendingRead(1);
    yield* answerRead(0, receiptProduct);
    expect(button(copy.submit).disabled).toBe(true);
    yield* answerRead(1, plain);
    yield* waitUntil(() => !button(copy.submit).disabled);
    expect(button(copy.submit).disabled).toBe(false);
    expect(document.querySelectorAll('[data-scope="select"][data-part="trigger"]')).toHaveLength(0);
    yield* click(button(copy.submit));
    yield* waitUntil(() => commands.length > 0);
    const sent = commands[0]?.command;
    expect(Predicate.isTagged(sent, 'RecordStockMovement')).toBe(true);
    expect(sent).toMatchObject({ delta: 1, productId: plain.id, reason: 'RECEIPT' });
    expect(sent).not.toHaveProperty('variantId');
    return yield* Effect.void;
  }).pipe(Effect.provide(network)),
);
