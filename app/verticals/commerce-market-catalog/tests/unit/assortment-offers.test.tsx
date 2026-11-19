// @rstest-environment happy-dom
// The e-shop switches of the price list: a switch changes only the section's draft, the one Save sends each changed
// offer once, and leaving with unsaved offers asks first. The real clients use in-process owner HTTP endpoints,
// and the editor runs under its real i18n and router.
import type {
  ManageMarketsActionForbiddenProblemSchema as forbiddenSchema,
  ManageMarketsActionConflictProblemSchema as conflictSchema,
} from '@app/merchandise/apis/manage-markets-action';
import type { executeManageMarkets } from '@app/merchandise/apis/manage-markets-action/client';
import { ManageMarketsActionApi, ManageMarketsPayloadSchema } from '@app/merchandise/apis/manage-markets-action';
import { RecordsApi, RecordsResponseSchema } from '@app/merchandise/apis/records';
import type { RecordsRequest } from '@app/merchandise/apis/records';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { acted, buttons, settle, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { MarketSettingsSchema } from '@app/merchandise/domain/market-offers';
import { saveLabelsFor } from '@app/admin-ui';
import { Effect, Layer, Option, Predicate, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { act } from 'react';
import { manageMarketsActionSchemaErrorLive } from '../../../merchandise/api/manage-markets-action-problems.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

import { MarketDefinitionSchema } from '../../shared/market-contracts.ts';
import { PriceListEditor } from '../../src/market-admin/assortment-section.tsx';
import type { ExceptionsSpec } from '../../src/market-admin/assortment-section.tsx';
import { marketExceptionsData } from '../../src/market-admin/page-data.ts';

const labels = saveLabelsFor('cs');
const czech = moduleText('cs');
const legalEntityId = '33333333-3333-4333-8333-333333333333';
const tenantId = '11111111-1111-4111-8111-111111111111';
const marketId = '30000000-0000-4000-8000-000000000001';

const settings = Schema.decodeUnknownSync(MarketSettingsSchema)({
  currency: 'CZK',
  exceptionCounts: { notOffered: 0, offered: 0 },
  exchangeRate: '1',
  marketCode: 'CZ-B2C',
  marketId,
  offerMode: 'WHOLE_CATALOGUE',
  revision: 3,
  roundingMinor: 1,
  updatedAt: '2026-11-01T10:00:00.000Z',
});

const market = Schema.decodeUnknownSync(MarketDefinitionSchema)({
  channels: ['B2C'],
  definitionRevisionRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'commerce.market-catalog.market-definition-revision',
    tenantId,
  },
  effectivePeriod: { startsAt: '2026-01-01T00:00:00.000Z' },
  jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
  lifecycle: 'ACTIVE',
  marketCode: 'CZ_B2C',
  marketRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: marketId,
    resourceType: 'commerce.market-catalog.market',
    tenantId,
  },
  purpose: 'Czech retail commerce',
  revision: 1,
  sellingLegalEntityRef: {
    moduleId: 'core.identity',
    resourceId: legalEntityId,
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  supportedLocales: ['cs-CZ'],
});

/** Two products that are exceptions of a whole-catalogue market, both offered as the page shows them. */
const exceptionItems = [
  { name: 'Šroub A', offered: true, productId: 'p-1', sku: 'SKU-1' },
  { name: 'Šroub B', offered: true, productId: 'p-2', sku: 'SKU-2' },
];

const exceptions: ExceptionsSpec = {
  input: { legalEntityId, marketId, offset: 0, tenantId },
  offeredByDefault: true,
  onOffset: constVoid,
};

type ManageMarketsFailure = typeof forbiddenSchema.Type | typeof conflictSchema.Type;
/** The action's refusal for a user without the permission. */
const forbidden: Extract<ManageMarketsFailure, { readonly _tag: 'ManageMarketsActionForbiddenProblem' }> = {
  _tag: 'ManageMarketsActionForbiddenProblem',
  code: 'action_permission_denied',
  detail: 'The actor may not manage markets',
  status: 403,
  title: 'Forbidden',
  type: 'https://ontos.dev/problems/forbidden',
};

/** The owner's refusal of an offer saved over a newer change by someone else. */
const staleOffer: Extract<ManageMarketsFailure, { readonly _tag: 'ManageMarketsActionConflictProblem' }> = {
  _tag: 'ManageMarketsActionConflictProblem',
  code: 'merchandise_revision_conflict',
  detail: 'The product offer in this market changed; refresh before another change',
  status: 409,
  title: 'Conflict',
  type: 'https://ontos.dev/problems/conflict',
};

type ActionPayload = typeof ManageMarketsPayloadSchema.Encoded;
type ActionResult = Effect.Success<ReturnType<typeof executeManageMarkets>>;
const received: ActionPayload[] = [];
let manage: (payload: ActionPayload) => Effect.Effect<ActionResult, ManageMarketsFailure>;
let read: (payload: RecordsRequest) => ReturnType<typeof recordsOf>;

const OwnerActionApi = ManageMarketsActionApi.prefix('/merchandise-api');
const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'manageMarketsAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          received.push(payload);
          return manage(payload);
        }),
      ),
    ).pipe(Layer.provide(manageMarketsActionSchemaErrorLive)),
  ),
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) => Effect.suspend(() => read(payload))),
    ),
  ),
);

const commands = () => received.length;
const commandTags = () => received.map((payload) => payload.command._tag);

const mount = Effect.gen(function* mountEditor() {
  yield* pinTestDocument;
  marketExceptionsData.invalidate();
  const mounted = yield* mountInRoute(
    <PriceListEditor
      canManage
      exceptions={exceptions}
      market={market}
      onAwaitingApproval={constVoid}
      refresh={Effect.void}
      revision={3}
      settings={settings}
    />,
    { url: '/cs/eshopy/test' },
  );
  yield* waitUntil(() => document.querySelector('input[name="market-offer-SKU-1"]') !== null);
  // The page's own reads have been answered before a case acts on it.
  yield* networkIdle;
  yield* settle;
  return mounted;
});

const saveButton = (): HTMLButtonElement => {
  const [found] = buttons('Uložit');
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};

/** The hidden checkbox of one product's switch: a click on it is a click on the switch. */
const switchFor = (sku: string): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>(`input[name="market-offer-${sku}"]`)));

const toggle = (sku: string) => acted(() => switchFor(sku).click());
const clickSave = () => acted(() => saveButton().click());

/** A catalogue product as the product search returns it: the search knows nothing of its offer in a market. */
const searchHit = (productId: string, sku: string, name: string) => ({
  active: true,
  category: 'Šrouby',
  createdAt: '2026-11-01T10:00:00.000Z',
  currentPriceMinor: 100,
  id: productId,
  lowStock: false,
  lowStockThreshold: 0,
  name,
  priceHistory: [],
  sku,
  stockOnHand: 0,
  stockValueMinor: 0,
  unit: 'ks',
  updatedAt: '2026-11-01T10:00:00.000Z',
  vatRate: 21,
});

/** The records the page reads: the exceptions as `items`, and `products` for a search. */
const recordsOf = (items: readonly (typeof exceptionItems)[number][], products: readonly unknown[] = []) =>
  Effect.succeed(
    Schema.decodeUnknownSync(RecordsResponseSchema)({
      actorPrincipalRef: { principalId: '20000000-0000-4000-8000-000000000002', tenantId },
      canWrite: true,
      indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: 0, stockValueMinor: 0 },
      marketExceptions: { items, marketId, total: items.length },
      movements: [],
      orders: [],
      products,
      revision: 3,
    }),
  );

const sentCommands = () => received.map((payload) => payload.command);

beforeEach(() => {
  received.length = 0;
  manage = () => Effect.succeed({ entityIds: [], revision: 9 });
  read = () => recordsOf(exceptionItems);
});

afterEach(unmountAll);

describe('e-shop offer switches of the price list', () => {
  it.live('toggling writes nothing; Save sends the changed offer once', () =>
    Effect.gen(function* toggleSendsNothing() {
      yield* mount;
      yield* toggle('SKU-1');
      // Longer than any delay the switch ever saved after; a write it started has reached the owner by idle.
      yield* Effect.sleep('1 second');
      yield* networkIdle;
      yield* settle;
      expect(commands()).toBe(0);
      expect(saveButton().disabled).toBe(false);

      yield* clickSave();
      yield* waitUntil(() => commands() >= 1);
      yield* networkIdle;
      yield* settle;
      expect(commands()).toBe(1);
      expect(commandTags()).toEqual(['SetProductMarketOffer']);
    }).pipe(Effect.provide(network)),
  );

  it.live('Save sends each of two changed offers exactly once', () =>
    Effect.gen(function* twoOffers() {
      yield* mount;
      yield* toggle('SKU-1');
      yield* toggle('SKU-2');
      yield* networkIdle;
      expect(commands()).toBe(0);

      yield* clickSave();
      yield* waitUntil(() => commands() >= 2);
      yield* networkIdle;
      yield* settle;
      expect(commands()).toBe(2);
      expect(commandTags()).toEqual(['SetProductMarketOffer', 'SetProductMarketOffer']);
    }).pipe(Effect.provide(network)),
  );

  it.live('a refused offer names the reason on the save bar', () =>
    Effect.gen(function* refusedOffer() {
      manage = () => Effect.fail(forbidden);
      yield* mount;
      yield* toggle('SKU-1');
      yield* clickSave();
      const refusal = czech('commerce-market-catalog.failures.forbidden');
      yield* waitUntil(() => document.body.textContent.includes(refusal));
      yield* networkIdle;
      yield* settle;
      expect(commands()).toBe(1);
      expect(document.body.textContent).toContain(refusal);
      expect(document.body.textContent).not.toContain('Uložení se nezdařilo');
    }).pipe(Effect.provide(network)),
  );

  it.live('an offer read before someone else changed it is refused on Save and offers the latest version', () =>
    Effect.gen(function* staleRead() {
      // The server: someone withdrew SKU-1 after the page showed it as offered.
      const server = new Map(Object.entries({ 'p-1': false, 'p-2': true }));
      manage = ({ command }) => {
        if (
          Predicate.isTagged(command, 'SetProductMarketOffer') &&
          command.expectedOffered !== undefined &&
          command.expectedOffered !== server.get(command.productId)
        ) {
          return Effect.fail(staleOffer);
        }
        return Effect.succeed({ entityIds: [], revision: 9 });
      };
      yield* mount;
      yield* toggle('SKU-1');
      yield* clickSave();
      yield* waitUntil(() => document.body.textContent.includes(labels.conflict));
      yield* networkIdle;
      yield* settle;
      expect(sentCommands()).toEqual([
        { _tag: 'SetProductMarketOffer', expectedOffered: true, marketId, offered: false, productId: 'p-1' },
      ]);
      expect(document.body.textContent).toContain(labels.conflict);
      expect(buttons(labels.reloadLatest)).toHaveLength(1);
      // The draft is kept: the switch still shows the unsaved change.
      expect(switchFor('SKU-1').checked).toBe(false);
    }).pipe(Effect.provide(network)),
  );

  it.live('after a conflict, Načíst aktuální verzi shows the other change and the next switch saves over it', () =>
    Effect.gen(function* reloadAfterConflict() {
      // The server: someone withdrew SKU-1 after the page showed it as offered.
      const server = new Map(Object.entries({ 'p-1': false, 'p-2': true }));
      manage = ({ command }) => {
        if (!Predicate.isTagged(command, 'SetProductMarketOffer')) {
          return Effect.succeed({ entityIds: [], revision: 9 });
        }
        if (command.expectedOffered !== undefined && command.expectedOffered !== server.get(command.productId)) {
          return Effect.fail(staleOffer);
        }
        server.set(command.productId, command.offered);
        return Effect.succeed({ entityIds: [], revision: 9 });
      };
      yield* mount;
      // From now on a read shows the server as it is.
      read = () =>
        recordsOf(exceptionItems.map((item) => ({ ...item, offered: server.get(item.productId) ?? item.offered })));
      yield* toggle('SKU-1');
      yield* clickSave();
      yield* waitUntil(() => document.body.textContent.includes(labels.conflict));
      expect(document.body.textContent).toContain(labels.conflict);

      yield* Effect.promise(async () => {
        await act(async () => {
          buttons(labels.reloadLatest)[0]?.click();
        });
      });
      yield* waitUntil(() => !document.body.textContent.includes(labels.conflict));
      yield* networkIdle;
      yield* settle;
      // The other person's withdrawal shows; nothing is unsaved.
      expect(switchFor('SKU-1').checked).toBe(false);
      expect(document.body.textContent).not.toContain(labels.conflict);

      // Offering it again is checked against what was just read, and goes through.
      const before = commands();
      yield* toggle('SKU-1');
      yield* clickSave();
      yield* waitUntil(() => commands() > before);
      yield* networkIdle;
      yield* settle;
      expect(sentCommands().at(-1)).toEqual(
        Schema.decodeUnknownSync(ManageMarketsPayloadSchema.fields.command)({
          _tag: 'SetProductMarketOffer',
          expectedOffered: false,
          marketId,
          offered: true,
          productId: 'p-1',
        }),
      );
      expect(server.get('p-1')).toBe(true);
      expect(document.body.textContent).not.toContain(labels.conflict);
    }).pipe(Effect.provide(network)),
  );

  it.live('withdrawing a search hit that is already withdrawn saves, and claims no offer it did not read', () =>
    Effect.gen(function* searchHitAlreadyException() {
      // The server: SKU-3 is already withdrawn from this whole-catalogue market, and it is not on the shown page.
      const server = new Map(Object.entries({ 'p-3': false }));
      manage = ({ command }) => {
        if (
          Predicate.isTagged(command, 'SetProductMarketOffer') &&
          command.expectedOffered !== undefined &&
          command.expectedOffered !== server.get(command.productId)
        ) {
          return Effect.fail(staleOffer);
        }
        return Effect.succeed({ entityIds: [], revision: 9 });
      };
      read = ({ view }) =>
        recordsOf(exceptionItems, view?.search === undefined ? [] : [searchHit('p-3', 'SKU-3', 'Šroub C')]);
      yield* mount;
      yield* Effect.promise(async () => {
        await act(async () => {
          const input = Option.getOrThrow(
            Option.fromNullOr(document.querySelector<HTMLInputElement>('input[id="market-product-search"]')),
          );
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Šroub');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      });
      // The search runs after the field's pause in typing; wait for its hit to show.
      const withdrawLabel = czech('commerce-market-catalog.detail.assortment.exceptions.withdraw');
      yield* waitUntil(() => buttons(withdrawLabel).length > 0, 2000);
      const [withdraw] = buttons(withdrawLabel);
      expect(withdraw).toBeDefined();
      yield* Effect.promise(async () => {
        await act(async () => {
          withdraw?.click();
        });
      });
      yield* networkIdle;
      yield* settle;
      expect(commands()).toBe(0);

      yield* clickSave();
      yield* waitUntil(() => commands() >= 1);
      yield* networkIdle;
      yield* settle;
      expect(sentCommands()).toEqual([{ _tag: 'SetProductMarketOffer', marketId, offered: false, productId: 'p-3' }]);
      expect(document.body.textContent).not.toContain(labels.conflict);
    }).pipe(Effect.provide(network)),
  );

  it.live('leaving with unsaved offers asks first', () =>
    Effect.gen(function* offersLeaveAsks() {
      const { router } = yield* mount;
      yield* toggle('SKU-1');
      yield* settle;
      yield* acted(() => {
        void router.navigate({ to: '/cs/eshopy/other' });
      });
      yield* waitUntil(() => buttons('Zůstat').length > 0);
      expect(buttons('Zůstat').length).toBeGreaterThan(0);
      expect(buttons('Zahodit změny').length).toBeGreaterThan(0);
      yield* networkIdle;
      expect(commands()).toBe(0);
    }).pipe(Effect.provide(network)),
  );
});
