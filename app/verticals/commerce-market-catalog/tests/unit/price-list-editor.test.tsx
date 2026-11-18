// @rstest-environment happy-dom
// The price list editor runs with its real i18n, router and merchandise Action client.
import { acted, buttons, settle, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import { MarketSettingsSchema } from '@app/merchandise/domain/market-offers';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Layer, Option, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { manageMarketsActionSchemaErrorLive } from '../../../merchandise/api/manage-markets-action-problems.ts';
import { ManageMarketsResultSchema } from '../../../merchandise/shared/actions/manage-markets.ts';
import { ManageMarketsActionApi } from '../../../merchandise/shared/apis/manage-markets-action.ts';
import type { ManageMarketsPayloadSchema } from '../../../merchandise/shared/apis/manage-markets-action.ts';
import { MarketDefinitionSchema } from '../../shared/market-contracts.ts';
import { PriceListEditor } from '../../src/market-admin/assortment-section.tsx';
import { mountInRoute } from '../support/module-ui.ts';

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
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  supportedLocales: ['cs-CZ'],
});

const saved = Schema.decodeUnknownSync(ManageMarketsResultSchema)({
  entityIds: [],
  marketRevision: 4,
  revision: 9,
});
const commands: (typeof ManageMarketsPayloadSchema.Encoded)[] = [];
let answer: Effect.Effect<typeof saved | typeof ActionProposalAcceptedSchema.Type> = Effect.succeed(saved);
const OwnerActionApi = ManageMarketsActionApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerActionApi,
    HttpApiBuilder.group(OwnerActionApi, 'manageMarketsAction', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          commands.push(payload);
          return answer;
        }),
      ),
    ).pipe(Layer.provide(manageMarketsActionSchemaErrorLive)),
  ),
);

const mount = (onAwaitingApproval: () => void = constVoid) =>
  mountInRoute(
    <PriceListEditor
      canManage
      market={market}
      onAwaitingApproval={onAwaitingApproval}
      refresh={Effect.void}
      revision={3}
      settings={settings}
    />,
  );

const saveButton = (): HTMLButtonElement => {
  const [found] = buttons('Uložit');
  expect(found).toBeDefined();
  return Option.getOrThrow(Option.fromNullOr(found));
};

const rateField = (): HTMLInputElement =>
  Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>('input[id="market-pricing-rate"]')));

/** Types like a user: React sees a native input event. */
const typeRate = (value: string) =>
  acted(() => {
    const field = rateField();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });

beforeEach(() => {
  commands.length = 0;
  answer = Effect.succeed(saved);
});

afterEach(unmountAll);

describe('price list editor', () => {
  it.live('typing changes only the draft: nothing is sent while the user types or waits', () =>
    Effect.gen(function* typingSendsNothing() {
      yield* pinTestDocument;
      yield* mount();
      expect(saveButton().disabled).toBe(true);

      yield* typeRate('24,5');
      expect(saveButton().disabled).toBe(false);
      yield* Effect.sleep('1 second');
      yield* settle;
      expect(commands).toHaveLength(0);
    }).pipe(Effect.provide(network)),
  );

  it.live('one click on Uložit sends exactly one ConfigureMarket', () =>
    Effect.gen(function* oneSave() {
      yield* pinTestDocument;
      yield* mount();
      yield* typeRate('24,5');
      yield* acted(() => saveButton().click());
      yield* waitUntil(() => commands.length > 0);
      // A second send the click started has reached the owner by the time the network is idle.
      yield* networkIdle;
      yield* settle;
      expect(commands).toHaveLength(1);
    }).pipe(Effect.provide(network)),
  );

  it.live('a change parked for approval is not sent again and asks the screen to say so', () =>
    Effect.gen(function* parked() {
      yield* pinTestDocument;
      let awaiting = 0;
      const announced = yield* Deferred.make<true>();
      const proposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
        _tag: 'ActionProposalAccepted',
        expiresAt: '2026-11-14T10:00:00.000Z',
        proposalId: '77777777-7777-4777-8777-777777777777',
      });
      answer = Effect.succeed(proposal);
      yield* mount(() => {
        awaiting += 1;
        Deferred.doneUnsafe(announced, Effect.succeed(true));
      });
      yield* typeRate('24,5');
      yield* acted(() => saveButton().click());
      yield* Deferred.await(announced);
      // A second send the click started has reached the owner by the time the network is idle.
      yield* networkIdle;
      yield* settle;
      expect(commands).toHaveLength(1);
      expect(awaiting).toBe(1);
    }).pipe(Effect.provide(network)),
  );
});
