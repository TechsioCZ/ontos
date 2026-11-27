// @rstest-environment happy-dom
// One-click commands that change what the public e-shop shows ask first, naming what changes: bulk Aktivovat /
// Deaktivovat names how many products, archiving a product names the product. Zrušit runs nothing. The
// real i18n, router and catalog Action client run against the owner’s in-process HTTP contract.
import { acted, buttons, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { manageCatalogActionSchemaErrorLive } from '../../api/manage-catalog-action-problems.ts';
import { ManageCatalogResultSchema } from '../../shared/actions/manage-catalog.ts';
import type { ManageCatalogPayloadSchema } from '../../shared/actions/manage-catalog.ts';
import { ManageCatalogActionApi } from '../../shared/apis/manage-catalog-action.ts';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import { ProductBulkBar } from '../../src/routes/[lang]/provoz/produkty/product-bulk-bar.tsx';
import { ArchiveSection } from '../../src/routes/[lang]/provoz/produkty/product-eshop-sections.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const czech = moduleText('cs');
const copy = {
  activate: czech('merchandise.pages.products.bulk.activate'),
  activateTitle: czech('merchandise.pages.products.bulk.activateTitle', { total: 3 }),
  archiveTitle: czech('merchandise.pages.products.eshop.archiveTitle', { name: 'Etiopie' }),
  cancel: czech('merchandise.pages.products.common.cancel'),
  deactivate: czech('merchandise.pages.products.bulk.deactivate'),
  deactivateDescription: czech('merchandise.pages.products.bulk.deactivateDescription', { total: 3 }),
};

const commands: (typeof ManageCatalogPayloadSchema.Encoded)[] = [];
const cleaned = Schema.decodeUnknownSync(ManageCatalogResultSchema)({ entityIds: [], revision: 2 });
const OwnerActionApi = ManageCatalogActionApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'manageCatalogAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload);
          return cleaned;
        }),
      ),
    ).pipe(Layer.provide(manageCatalogActionSchemaErrorLive)),
  ),
);

const product = Schema.decodeSync(ProductRecordSchema)({
  active: false,
  category: 'Zrnková káva',
  createdAt: '2026-10-20T09:00:00.000Z',
  currentPriceMinor: 25_804,
  id: 'product-1',
  lowStock: false,
  lowStockThreshold: 3,
  name: 'Etiopie',
  priceHistory: [],
  published: false,
  sku: 'ETI-250',
  stockOnHand: 12,
  stockValueMinor: 309_648,
  unit: 'ks',
  updatedAt: '2026-10-20T09:00:00.000Z',
  variants: [],
  vatRate: 12,
});

const button = (name: string) => Option.getOrThrow(Option.fromNullishOr(buttons(name)[0]));
const byTestId = (id: string) =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)));

const click = (element: HTMLElement) => acted(() => element.click());

const type = (id: string, value: string) =>
  acted(() => {
    const field = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`input[id="${id}"]`)));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });

beforeEach(() => {
  commands.length = 0;
});

afterEach(unmountAll);

const bulkBar = (onSetActive: (active: boolean) => void) => (
  <ProductBulkBar
    busy={false}
    canWrite
    count={3}
    onChangeCategory={constVoid}
    onChangePrice={constVoid}
    onClear={constVoid}
    onSetActive={onSetActive}
    onTags={constVoid}
  />
);

it.live('bulk Aktivovat asks first, naming how many products go on the e-shop', () =>
  Effect.gen(function* activate() {
    yield* pinTestDocument;
    const calls: boolean[] = [];
    yield* mountInRoute(
      bulkBar((active) => {
        calls.push(active);
      }),
    );
    yield* click(button(copy.activate));
    expect(calls).toEqual([]);
    expect(text()).toContain(copy.activateTitle);
    yield* click(byTestId('live-shop-confirm'));
    expect(calls).toEqual([true]);
  }).pipe(Effect.provide(network)),
);

it.live('bulk Deaktivovat names the products leaving the e-shop; Zrušit changes nothing', () =>
  Effect.gen(function* deactivate() {
    yield* pinTestDocument;
    const calls: boolean[] = [];
    yield* mountInRoute(
      bulkBar((active) => {
        calls.push(active);
      }),
    );
    yield* click(button(copy.deactivate));
    expect(text()).toContain(copy.deactivateDescription);
    yield* click(button(copy.cancel));
    expect(calls).toEqual([]);
    yield* click(button(copy.deactivate));
    yield* click(byTestId('live-shop-confirm'));
    expect(calls).toEqual([false]);
  }).pipe(Effect.provide(network)),
);

it.live('archiving a product asks first, naming the product, and runs once after the confirmation', () =>
  Effect.gen(function* archive() {
    yield* pinTestDocument;
    const archived: string[] = [];
    yield* mountInRoute(
      <ArchiveSection
        onArchived={() => {
          archived.push('archived');
        }}
        onCommitted={constVoid}
        onReload={constVoid}
        product={product}
        revision={4}
      />,
    );
    yield* type('product-archive-reason', 'Testovací produkt');
    yield* click(byTestId('product-archive'));
    yield* networkIdle;
    expect(commands).toEqual([]);
    expect(text()).toContain(copy.archiveTitle);
    yield* click(byTestId('live-shop-confirm'));
    yield* waitUntil(() => archived.length > 0);
    yield* networkIdle;
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      command: { _tag: 'ArchiveProduct', reason: 'Testovací produkt' },
      expectedRevision: 4,
    });
    expect(archived).toEqual(['archived']);
  }).pipe(Effect.provide(network)),
);
