// @rstest-environment happy-dom
// The market screens' writes to Merchandise: narrow Market/Catalog payloads under one fresh correlation that is also
// the idempotency key, a committed answer or a 202 proposal receipt passed back as Merchandise sent it, and malformed
// input refused before anything is sent. The generated Merchandise client runs for real; the Shell's gateway issuer
// and Merchandise's Action endpoints answer in process through their HttpApi contracts.
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import {
  ManageCatalogActionApi,
  ManageCatalogActionInvalidProblemSchema,
  ManageCatalogActionSchemaErrorMiddleware,
  ManageCatalogPayloadSchema,
} from '@app/merchandise/apis/manage-catalog-action';
import { ManageMarketsActionApi, ManageMarketsPayloadSchema } from '@app/merchandise/apis/manage-markets-action';
import { ApplyCommandResultSchema } from '@app/merchandise/contracts/apply-command';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder, HttpApiMiddleware, HttpServerRequest } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Schema } from 'effect';
import { beforeEach, expect, it } from 'effect-rstest';

import { manageMarketsActionSchemaErrorLive } from '../../../merchandise/api/manage-markets-action-problems.ts';
import { merchandiseCommand, saveStorefrontCatalog } from '../../src/market-admin/page-data.ts';
import type { MarketCommandInput } from '../../src/market-admin/page-data.ts';

const command: MarketCommandInput = {
  _tag: 'ConfigureMarket',
  currency: 'CZK',
  exchangeRate: '1',
  expectedRevision: 3,
  marketCode: 'CZ_MAIN',
  marketId: '11111111-1111-4111-8111-111111111111',
  offerMode: 'WHOLE_CATALOGUE',
  roundingMinor: 100,
};
/** A committed ManageMarkets answer (the client's non-proposal success). */
const committed = Schema.decodeUnknownSync(ApplyCommandResultSchema)({
  entityIds: [],
  marketRevision: 4,
  revision: 17,
});
const proposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2030-01-01T00:00:00.000Z',
  proposalId: '22222222-2222-4222-8222-222222222222',
});

/** One ManageMarkets request as Merchandise received it. */
interface Received {
  readonly correlation: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly payload: typeof ManageMarketsPayloadSchema.Encoded;
}
const received: Received[] = [];
interface CatalogReceived {
  readonly correlation: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly payload: typeof ManageCatalogPayloadSchema.Encoded;
}
const catalogReceived: CatalogReceived[] = [];
/** What Merchandise answers the next Action request with; each test scripts it. */
let answer: typeof committed | typeof proposal = committed;

const OwnerApi = ManageMarketsActionApi.prefix('/merchandise-api');
const CatalogApi = ManageCatalogActionApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(
    OwnerApi,
    HttpApiBuilder.group(OwnerApi, 'manageMarketsAction', (group) =>
      group.handle('execute', ({ payload }) =>
        HttpServerRequest.HttpServerRequest.pipe(
          Effect.map(({ headers }) => {
            received.push({
              correlation: headers['x-correlation-id'],
              idempotencyKey: headers['idempotency-key'],
              payload,
            });
            return answer;
          }),
        ),
      ),
    ).pipe(Layer.provide(manageMarketsActionSchemaErrorLive)),
  ),
  serveApi(
    CatalogApi,
    HttpApiBuilder.group(CatalogApi, 'manageCatalogAction', (group) =>
      group.handle('execute', ({ payload }) =>
        HttpServerRequest.HttpServerRequest.pipe(
          Effect.map(({ headers }) => {
            catalogReceived.push({
              correlation: headers['x-correlation-id'],
              idempotencyKey: headers['idempotency-key'],
              payload,
            });
            return answer;
          }),
        ),
      ),
    ).pipe(
      Layer.provide(
        HttpApiMiddleware.layerSchemaErrorTransform(ManageCatalogActionSchemaErrorMiddleware, () =>
          Effect.fail(
            ManageCatalogActionInvalidProblemSchema.make({
              detail: 'The test endpoint received an invalid request.',
              status: 400,
              title: 'Invalid request',
              type: 'https://ontos.dev/problems/action-invalid',
            }),
          ),
        ),
      ),
    ),
  ),
);

beforeEach(() => {
  received.length = 0;
  catalogReceived.length = 0;
  answer = committed;
});

it.live('saves one e-shop preference with catalogue authority, revision and idempotency', () =>
  Effect.gen(function* storefrontCatalogSetting() {
    yield* pinTestDocument;
    expect(yield* saveStorefrontCatalog('akros-storefront', false, 17)).toEqual({ ok: true, value: committed });
    expect(catalogReceived).toHaveLength(1);
    const [request] = catalogReceived;
    expect(Schema.decodeUnknownSync(ManageCatalogPayloadSchema)(request?.payload)).toEqual(
      Schema.decodeUnknownSync(ManageCatalogPayloadSchema)({
        command: {
          _tag: 'ConfigureStorefrontCatalog',
          mainSourceProductsOnly: false,
          storefrontAppId: 'akros-storefront',
        },
        expectedRevision: 17,
      }),
    );
    expect(request?.correlation).toMatch(/^commerce-market-catalog:/u);
    expect(request?.idempotencyKey).toBe(request?.correlation);
    expect(received).toEqual([]);
  }).pipe(Effect.provide(network)),
);

it.live('retains proposal receipts and rejects malformed storefront ids without a write', () =>
  Effect.gen(function* storefrontCatalogProposal() {
    yield* pinTestDocument;
    answer = proposal;
    expect(yield* saveStorefrontCatalog('akros-storefront', true, 17)).toEqual({ ok: true, value: proposal });
    expect(catalogReceived).toHaveLength(1);
    catalogReceived.length = 0;
    expect(yield* saveStorefrontCatalog('../invalid', true, 17)).toEqual({ ok: false, reason: 'invalid' });
    expect(catalogReceived).toEqual([]);
  }).pipe(Effect.provide(network)),
);

it.live('uses the narrow ManageMarkets payload and one fresh correlation/idempotency identity', () =>
  Effect.gen(function* currentMarketCommand() {
    yield* pinTestDocument;
    expect(yield* merchandiseCommand(command, 17)).toEqual(committed);
    const [request] = received;
    expect(received).toHaveLength(1);
    expect(Schema.decodeUnknownSync(ManageMarketsPayloadSchema)(request?.payload)).toEqual(
      Schema.decodeUnknownSync(ManageMarketsPayloadSchema)({ command, expectedRevision: 17 }),
    );
    expect(request?.correlation).toMatch(/^commerce-market-catalog:/u);
    expect(request?.idempotencyKey).toBe(request?.correlation);
  }).pipe(Effect.provide(network)),
);

it.live('preserves the original successful 202 proposal receipt without inventing a committed revision', () =>
  Effect.gen(function* acceptedMarketProposal() {
    yield* pinTestDocument;
    answer = proposal;
    const result = yield* merchandiseCommand(command, 17);
    expect(result).toEqual(proposal);
    expect(Schema.is(ActionProposalAcceptedSchema)(result)).toBe(true);
    expect(result).not.toHaveProperty('entityIds');
    expect(result).not.toHaveProperty('marketRevision');
    expect(result).not.toHaveProperty('revision');
    expect(received).toHaveLength(1);
  }).pipe(Effect.provide(network)),
);

it.live('rejects malformed market input before calling Merchandise', () =>
  Effect.gen(function* invalidMarketCommand() {
    yield* pinTestDocument;
    // The command settles here, so a request it had sent would already have been received.
    expect(yield* merchandiseCommand({ ...command, marketId: '' }, 17).pipe(Effect.flip)).toBe('invalid');
    expect(received).toEqual([]);
  }).pipe(Effect.provide(network)),
);
