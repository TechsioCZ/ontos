// @rstest-environment happy-dom
// The "Trhy" tab of the product editor: a market offer decides what a live e-shop sells, so its switch changes only
// the draft. The tab's one Save button sends the changed offers, each naming the offer the draft was read from, so a
// newer change by someone else is refused instead of overwritten. The real client uses the Shell gateway issuer
// and merchandise Action contract in process; the panel uses its real i18n and router.
import { saveLabelsFor } from '@app/admin-ui';
import { acted, buttons, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Predicate, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { manageMarketsActionSchemaErrorLive } from '../../api/manage-markets-action-problems.ts';
import {
  ManageMarketsActionApi,
  ManageMarketsActionConflictProblemSchema,
} from '../../shared/apis/manage-markets-action.ts';
import type { ManageMarketsPayloadSchema } from '../../shared/apis/manage-markets-action.ts';
import { MarketIdSchema } from '../../shared/domain/market-offers.ts';
import type { ProductMarket } from '../../shared/domain/market-offers.ts';
import { ProductIdSchema } from '../../shared/domain/merchandise-model.ts';
import { MarketsPanel } from '../../src/routes/[lang]/provoz/produkty/product-markets.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const SK = Schema.decodeUnknownSync(MarketIdSchema)('6a000000-0000-4000-8000-0000000000a1');
const PL = Schema.decodeUnknownSync(MarketIdSchema)('6a000000-0000-4000-8000-0000000000a2');
const productId = Schema.decodeUnknownSync(ProductIdSchema)('product-1');
const markets: readonly ProductMarket[] = [
  { currency: 'EUR', grossPriceMinor: 1160, marketCode: 'AKROS-SK', marketId: SK, offered: true },
  { currency: 'PLN', marketCode: 'AKROS-PL', marketId: PL, offered: false },
];

const conflict = Schema.decodeSync(ManageMarketsActionConflictProblemSchema)({
  _tag: 'ManageMarketsActionConflictProblem',
  code: 'merchandise_revision_conflict',
  detail: 'Changed',
  status: 409,
  title: 'Conflict',
  type: 'urn:test:conflict',
});

/**
 * The server: the catalogue revision and each market's offer of the product. A command naming the offer it was read
 * from (`expectedOffered`) is refused when that offer changed since, as the merchandise owner refuses it.
 */
const register = { offers: new Map<string, boolean>(), revision: 4 };

const commands: (typeof ManageMarketsPayloadSchema.Encoded)[] = [];
const sent = () => commands.map(({ command, expectedRevision }) => ({ command, expectedRevision }));
const OwnerApi = ManageMarketsActionApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerApi,
    HttpApiBuilder.group(OwnerApi, 'manageMarketsAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          commands.push(payload);
          const { command } = payload;
          if (!Predicate.isTagged(command, 'SetProductMarketOffer')) {
            return Effect.die('Only offers are saved here');
          }
          if (
            command.expectedOffered !== undefined &&
            command.expectedOffered !== register.offers.get(command.marketId)
          ) {
            return Effect.fail(conflict);
          }
          register.offers.set(command.marketId, command.offered);
          return Effect.succeed({ entityIds: [], revision: register.revision });
        }),
      ),
    ).pipe(Layer.provide(manageMarketsActionSchemaErrorLive)),
  ),
);

const committed: string[] = [];
const czech = moduleText('cs');
const mount = (revision: number) =>
  mountInRoute(
    <MarketsPanel
      canManage
      markets={markets}
      onCommitted={(message) => {
        committed.push(message);
      }}
      onReload={constVoid}
      product={{ id: productId }}
      revision={revision}
    />,
    { path: 'provoz/produkty', url: '/cs/provoz/produkty' },
  );

const offerSwitch = (code: string): HTMLInputElement =>
  Option.getOrThrow(
    Option.fromNullOr(document.querySelector<HTMLInputElement>(`input[name="market-offered-${code}"]`)),
  );

const saveButton = (): HTMLButtonElement => Option.getOrThrow(Option.fromNullishOr(buttons(labels.save)[0]));
const click = (element: HTMLElement) => acted(() => element.click());

beforeEach(() => {
  commands.length = 0;
  register.revision = 4;
  register.offers = new Map(markets.map((market) => [market.marketId, market.offered]));
  committed.length = 0;
});

afterEach(unmountAll);

it.live('toggling a market offer writes nothing; Save writes the offer once', () =>
  Effect.gen(function* toggleThenSave() {
    yield* pinTestDocument;
    yield* mount(4);
    expect(saveButton().disabled).toBe(true);

    yield* click(offerSwitch('AKROS-PL'));
    expect(offerSwitch('AKROS-PL').checked).toBe(true);
    expect(sent()).toEqual([]);
    expect(saveButton().disabled).toBe(false);

    yield* click(saveButton());
    yield* waitUntil(() => committed.length === 1);
    expect(sent()).toEqual([
      {
        command: { _tag: 'SetProductMarketOffer', expectedOffered: false, marketId: PL, offered: true, productId },
        expectedRevision: 4,
      },
    ]);
    expect(committed).toEqual([czech('merchandise.pages.products.markets.saved')]);
    expect(register.offers.get(PL)).toBe(true);
  }).pipe(Effect.provide(network)),
);

it.live('one Save sends every changed market once, each naming the offer it was read from', () =>
  Effect.gen(function* twoMarkets() {
    yield* pinTestDocument;
    yield* mount(4);
    yield* click(offerSwitch('AKROS-PL'));
    yield* click(offerSwitch('AKROS-SK'));
    // Switching a market back leaves nothing to send for it.
    yield* click(offerSwitch('AKROS-PL'));
    yield* click(offerSwitch('AKROS-PL'));
    expect(sent()).toEqual([]);

    yield* click(saveButton());
    yield* waitUntil(() => committed.length === 1);
    expect(sent()).toEqual([
      {
        command: { _tag: 'SetProductMarketOffer', expectedOffered: true, marketId: SK, offered: false, productId },
        expectedRevision: 4,
      },
      {
        command: { _tag: 'SetProductMarketOffer', expectedOffered: false, marketId: PL, offered: true, productId },
        expectedRevision: 4,
      },
    ]);
  }).pipe(Effect.provide(network)),
);

it.live('a save over a newer offer change by someone else is refused and keeps the draft', () =>
  Effect.gen(function* stale() {
    yield* pinTestDocument;
    yield* mount(4);
    // Someone else withdrew the product from AKROS-SK after the tab was read (shown as offered).
    register.offers.set(SK, false);
    yield* click(offerSwitch('AKROS-SK'));
    yield* click(offerSwitch('AKROS-PL'));
    yield* click(saveButton());
    yield* waitUntil(() => text().includes(labels.conflict));
    // The first offer is refused; the rest of the save is not sent.
    expect(sent().map(({ command }) => command)).toEqual([
      { _tag: 'SetProductMarketOffer', expectedOffered: true, marketId: SK, offered: false, productId },
    ]);
    expect(register.offers.get(PL)).toBe(false);
    expect(committed).toEqual([]);
    expect(offerSwitch('AKROS-PL').checked).toBe(true);
    expect(buttons(labels.reloadLatest).length).toBe(1);
  }).pipe(Effect.provide(network)),
);
