// @rstest-environment happy-dom
// The create and bulk product forms send their command only from the shared Save button ("Uložit"), last in the
// footer: typing and Enter change only the draft. Real clients reach the owner contracts through in-process HTTP.
// The forms run under the module i18n and router with their real controls and leave protection.
import { requiredLabelFor, saveLabelsFor } from '@app/admin-ui';
import { acted, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
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
import type { ReactElement } from 'react';
import { manageCatalogActionSchemaErrorLive } from '../../api/manage-catalog-action-problems.ts';
import { ManageCatalogResultSchema } from '../../shared/actions/manage-catalog.ts';
import type { ManageCatalogPayloadSchema } from '../../shared/actions/manage-catalog.ts';
import { ManageCatalogActionApi } from '../../shared/apis/manage-catalog-action.ts';
import type { ManageCatalogActionProblem } from '../../shared/apis/manage-catalog-action.ts';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { CatalogCategoryIdSchema, ProductIdSchema } from '../../shared/domain/merchandise-model.ts';
import { CategoryDialog, PriceChangeDialog } from '../../src/routes/[lang]/provoz/produkty/product-forms.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const productId = Schema.decodeUnknownSync(ProductIdSchema)('product-1');
const ids = [productId];
const category = { id: Schema.decodeSync(CatalogCategoryIdSchema)('category-tools'), trail: 'Nářadí' };

const commands: (typeof ManageCatalogPayloadSchema.Encoded)[] = [];
const sent = () => commands.map((payload) => payload.command);
const saved = Schema.decodeUnknownSync(ManageCatalogResultSchema)({ entityIds: [], revision: 5 });
let answer: Effect.Effect<typeof saved, ManageCatalogActionProblem> = Effect.succeed(saved);
const records = Schema.decodeUnknownSync(RecordsResponseSchema)({
  actorPrincipalRef: {
    principalId: '20000000-0000-4000-8000-000000000002',
    tenantId: '20000000-0000-4000-8000-000000000001',
  },
  canWrite: true,
  categoryMatches: [category],
  categoryMatchTotal: 1,
  indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: 0, stockValueMinor: 0 },
  movements: [],
  orders: [],
  products: [],
  revision: 4,
});
const OwnerActionApi = ManageCatalogActionApi.prefix('/merchandise-api');
const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'manageCatalogAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          commands.push(payload);
          return answer;
        }),
      ),
    ).pipe(Layer.provide(manageCatalogActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) => group.handle('execute', () => Effect.succeed(records))),
  ),
);
const copy = moduleText('cs');

const committed: string[] = [];
const openChanges: boolean[] = [];

const dialogProps = {
  ids,
  onCommitted: (message: string) => {
    committed.push(message);
  },
  onOpenChange: (open: boolean) => {
    openChanges.push(open);
  },
  onReload: constVoid,
  open: true,
  revision: 4,
};
const categoryProps = { ...dialogProps, hasTree: true };
const priceProps = { ...dialogProps, variantProducts: [] };

/** Mounts the form under the module's real i18n and router. */
const mount = (element: ReactElement) => mountInRoute(element, { path: 'provoz/produkty', url: '/cs/provoz/produkty' });

const footerButtons = (): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.closest('form') === null);

const saveButton = (): HTMLButtonElement =>
  Option.getOrThrow(Option.fromNullishOr(footerButtons().find((button) => button.textContent?.trim() === labels.save)));

const field = (id: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`#${id}`)));

const typeInto = (id: string, value: string) =>
  acted(() => {
    const input = field(id);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

const pressEnter = (id: string) =>
  acted(() => {
    const input = field(id);
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    input.form?.requestSubmit();
  });

const click = (element: HTMLElement) => acted(() => element.click());

beforeEach(() => {
  commands.length = 0;
  committed.length = 0;
  openChanges.length = 0;
  answer = Effect.succeed(saved);
});

afterEach(unmountAll);

it.live('the category change is sent once, from Uložit only, never on Enter', () =>
  Effect.gen(function* categorySave() {
    yield* pinTestDocument;
    yield* mount(<CategoryDialog {...categoryProps} />);
    expect(saveButton().disabled).toBe(true);
    expect(footerButtons().at(-1)).toBe(saveButton());

    yield* click(field('bulk-category-input'));
    yield* typeInto('bulk-category-input', 'Nářadí');
    expect(saveButton().disabled).toBe(true);
    yield* waitUntil(() => document.querySelector('[role="option"]') !== null);
    const option = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLElement>('[role="option"]')));
    yield* click(option);
    yield* pressEnter('bulk-category-input');
    yield* networkIdle;
    expect(sent()).toEqual([]);
    expect(saveButton().disabled).toBe(false);

    yield* click(saveButton());
    yield* waitUntil(() => committed.length === 1);
    yield* networkIdle;
    expect(sent()).toEqual([{ _tag: 'BulkUpdateProducts', ids, patch: { categoryId: category.id } }]);
    expect(openChanges).toEqual([false]);
  }).pipe(Effect.provide(network)),
);

it.live('the price change it opens with is sent by the first Uložit', () =>
  Effect.gen(function* priceSave() {
    yield* pinTestDocument;
    yield* mount(<PriceChangeDialog {...priceProps} />);
    expect(saveButton().disabled).toBe(false);
    yield* networkIdle;
    expect(sent()).toEqual([]);

    yield* click(saveButton());
    yield* waitUntil(() => committed.length === 1);
    yield* networkIdle;
    expect(sent()).toEqual([{ _tag: 'BulkUpdateProducts', ids, patch: { priceChangePercent: 5 } }]);
  }).pipe(Effect.provide(network)),
);

type ManageCatalogFailure = ManageCatalogActionProblem;

/** Whether closing or reloading the tab would ask now. */
const unloadAsks = (): boolean => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

it.live('the price change becomes savable when rows are selected after the page mounted it', () =>
  Effect.gen(function* lateSelection() {
    yield* pinTestDocument;
    // The products page mounts the dialog before anything is selected.
    const { rerender } = yield* mount(<PriceChangeDialog {...priceProps} ids={[]} open={false} />);
    yield* rerender(<PriceChangeDialog {...priceProps} open />);
    expect(saveButton().disabled).toBe(false);

    yield* click(saveButton());
    yield* waitUntil(() => committed.length === 1);
    yield* networkIdle;
    expect(sent()).toEqual([{ _tag: 'BulkUpdateProducts', ids, patch: { priceChangePercent: 5 } }]);
  }).pipe(Effect.provide(network)),
);

it.live('the price change asks before leaving only for a percent the user typed in the open panel', () =>
  Effect.gen(function* untouchedPrice() {
    yield* pinTestDocument;
    const { rerender } = yield* mount(<PriceChangeDialog {...priceProps} ids={[]} open={false} />);
    expect(unloadAsks()).toBe(false);
    yield* rerender(<PriceChangeDialog {...priceProps} open />);
    // The 5 % it opens with is not typed input.
    expect(unloadAsks()).toBe(false);
    yield* typeInto('price-percent', '7');
    expect(unloadAsks()).toBe(true);
  }).pipe(Effect.provide(network)),
);

it.live('reads the required text of a required field in Czech', () =>
  Effect.gen(function* requiredText() {
    yield* pinTestDocument;
    yield* mount(<CategoryDialog {...categoryProps} />);
    yield* networkIdle;
    const label = document.querySelector<HTMLLabelElement>('label[for="bulk-category-input"]');
    expect(label?.textContent ?? '').toContain(requiredLabelFor('cs'));
    expect(document.body.textContent).not.toContain('(required)');
  }).pipe(Effect.provide(network)),
);

it.live('a refused variant bulk price edit shows its actionable message instead of a revision conflict', () =>
  Effect.gen(function* actionableBulkRefusal() {
    yield* pinTestDocument;
    const refused: Extract<ManageCatalogFailure, { readonly _tag: 'ManageCatalogActionConflictProblem' }> = {
      _tag: 'ManageCatalogActionConflictProblem',
      code: 'merchandise_variant_bulk_price_unsupported',
      detail: 'The Action conflicts with current state.',
      status: 409,
      title: 'Action conflict',
      type: 'https://ontos.dev/problems/action-conflict',
    };
    answer = Effect.fail(refused);
    yield* mount(<PriceChangeDialog {...priceProps} />);
    yield* click(saveButton());
    const message = copy('merchandise.pages.products.messages.variantBulkPriceUnsupported');
    yield* waitUntil(() => (document.body.textContent ?? '').includes(message));
    yield* networkIdle;
    expect(document.body.textContent).not.toContain(copy('merchandise.pages.products.messages.conflict'));
    expect(committed).toEqual([]);
    return yield* Effect.void;
  }).pipe(Effect.provide(network)),
);

it.live('names the selected products priced by variants before anything is typed and keeps Uložit disabled', () =>
  Effect.gen(function* variantProductsNamed() {
    yield* pinTestDocument;
    yield* mount(<PriceChangeDialog {...priceProps} variantProducts={[{ id: productId, name: 'Šroub M8' }]} />);
    expect(document.body.textContent).toContain(
      copy('merchandise.pages.products.priceDialog.variantProducts', { names: 'Šroub M8' }),
    );
    expect(saveButton().disabled).toBe(true);
    yield* networkIdle;
    expect(sent()).toEqual([]);
  }).pipe(Effect.provide(network)),
);

it.live('a company without a storefront tree types the category label as before', () =>
  Effect.gen(function* labelCategory() {
    yield* pinTestDocument;
    yield* mount(<CategoryDialog {...dialogProps} hasTree={false} />);
    expect(document.querySelector('[id="bulk-category-input"]')).toBeNull();
    yield* typeInto('bulk-category', '  Nářadí  ');
    yield* click(saveButton());
    yield* waitUntil(() => committed.length === 1);
    yield* networkIdle;
    expect(sent()).toEqual([{ _tag: 'BulkUpdateProducts', ids, patch: { category: 'Nářadí' } }]);
  }).pipe(Effect.provide(network)),
);

it.live('a tree category deleted meanwhile says so instead of a stock refusal', () =>
  Effect.gen(function* deletedCategory() {
    yield* pinTestDocument;
    const refused: Extract<ManageCatalogFailure, { readonly _tag: 'ManageCatalogActionConflictProblem' }> = {
      _tag: 'ManageCatalogActionConflictProblem',
      code: 'merchandise_lifecycle_conflict',
      detail: 'The Action conflicts with current state.',
      status: 409,
      title: 'Action conflict',
      type: 'https://ontos.dev/problems/action-conflict',
    };
    answer = Effect.fail(refused);
    yield* mount(<CategoryDialog {...categoryProps} />);
    yield* click(field('bulk-category-input'));
    yield* waitUntil(() => document.querySelector('[role="option"]') !== null);
    const option = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLElement>('[role="option"]')));
    yield* click(option);
    yield* click(saveButton());
    const message = copy('merchandise.pages.products.category.missing');
    yield* waitUntil(() => (document.body.textContent ?? '').includes(message));
    yield* networkIdle;
    expect(committed).toEqual([]);
  }).pipe(Effect.provide(network)),
);
