// @rstest-environment happy-dom
// The real i18n/router and merchandise client drive the confirmation. The Shell gateway and the owner's
// Action endpoint answer in process, recording the commands the browser actually sends.
import { acted, settle, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { ManageMarketsActionApi } from '@app/merchandise/apis/manage-markets-action';
import type { ManageMarketsPayloadSchema } from '@app/merchandise/apis/manage-markets-action';
import { ApplyCommandResultSchema } from '@app/merchandise/contracts/apply-command';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { manageMarketsActionSchemaErrorLive } from '../../../merchandise/api/manage-markets-action-problems.ts';
import { MarketDefinitionSchema } from '../../shared/market-contracts.ts';
import { PriceListSetup } from '../../src/market-admin/price-list-setup.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const marketId = '30000000-0000-4000-8000-000000000001';

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
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  supportedLocales: ['cs-CZ'],
});

const czech = moduleText('cs');
const copy = {
  confirm: czech('commerce-market-catalog.detail.assortment.configureConfirm'),
  description: czech('commerce-market-catalog.detail.assortment.configureDescription', {
    code: 'CZ_B2C',
    currency: 'CZK',
  }),
  title: czech('commerce-market-catalog.detail.assortment.configureTitle', { code: 'CZ_B2C' }),
};

const commands: (typeof ManageMarketsPayloadSchema.Encoded)[] = [];
const result = Schema.decodeUnknownSync(ApplyCommandResultSchema)({ entityIds: [], marketRevision: 1, revision: 4 });
const OwnerApi = ManageMarketsActionApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerApi,
    HttpApiBuilder.group(OwnerApi, 'manageMarketsAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          commands.push(payload);
          return result;
        }),
      ),
    ).pipe(Layer.provide(manageMarketsActionSchemaErrorLive)),
  ),
);

const mount = (onDone: (message: string) => void = constVoid) =>
  mountInRoute(<PriceListSetup editable market={market} onAwaitingApproval={constVoid} onDone={onDone} revision={3} />);

const setupButton = () => document.querySelector<HTMLButtonElement>('[data-testid="market-price-list-setup"]');
const confirmButton = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (button) => button.textContent?.trim() === copy.confirm,
  );

const click = (button: HTMLButtonElement | null | undefined) =>
  acted(() => {
    expect(button).toBeDefined();
    button?.click();
  });

beforeEach(() => {
  commands.length = 0;
});

afterEach(unmountAll);

describe('setting up the price list of a market', () => {
  it.live('asks first, naming the market and the currency, and sends nothing until confirmed', () =>
    Effect.gen(function* asksFirst() {
      yield* pinTestDocument;
      yield* mount();
      yield* click(setupButton());
      yield* settle;
      expect(commands).toHaveLength(0);
      expect(document.body.textContent).toContain(copy.title);
      expect(document.body.textContent).toContain(copy.description);
      expect(confirmButton()).toBeDefined();
    }).pipe(Effect.provide(network)),
  );

  it.live('sends one ConfigureMarket after the confirmation and reports it done', () =>
    Effect.gen(function* confirmed() {
      const done: string[] = [];
      yield* pinTestDocument;
      yield* mount((message) => {
        done.push(message);
      });
      yield* click(setupButton());
      yield* settle;
      yield* click(confirmButton());
      yield* settle;
      yield* waitUntil(() => done.length === 1);
      yield* settle;
      expect(commands).toHaveLength(1);
      expect(done).toHaveLength(1);
      expect(confirmButton()).toBeUndefined();
    }).pipe(Effect.provide(network)),
  );
});
