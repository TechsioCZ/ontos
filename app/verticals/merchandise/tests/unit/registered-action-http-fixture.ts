import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { TrustedPrincipalContextSchema, GatewayAssertionRedemptionService } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { makeOwnerApplicationCompositionFixture } from '@app/core-runtime/testing/module-contract';
import type { ActionTestHarnessOptions } from '@app/core-runtime/testing/actions';
import { Clock, Effect, Layer, Schema } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { HttpApi, HttpApiBuilder } from 'effect/http-api';
import { rstest } from 'effect-rstest';

import type { MerchandiseCommand, MerchandiseCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { merchandiseRegistration } from '../../vertical.registration.ts';
import { ApplyCommandActionApi } from '../../shared/apis/apply-command-action.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { applyCommandActionApiLive } from '../../api/apply-command-action-server.ts';
import { ManageCatalogActionApi } from '../../shared/apis/manage-catalog-action.ts';
import { manageCatalogAction } from '../../src/actions/manage-catalog.action.ts';
import { manageCatalogActionApiLive } from '../../api/manage-catalog-action-server.ts';
import { ManageMarketsActionApi } from '../../shared/apis/manage-markets-action.ts';
import { manageMarketsAction } from '../../src/actions/manage-markets.action.ts';
import { manageMarketsActionApiLive } from '../../api/manage-markets-action-server.ts';
import { CleanupDemoActionApi } from '../../shared/apis/cleanup-demo-action.ts';
import { cleanupDemoAction } from '../../src/actions/cleanup-demo.action.ts';
import { cleanupDemoActionApiLive } from '../../api/cleanup-demo-action-server.ts';
import { ChangeProductImagesActionApi } from '../../shared/apis/change-product-images-action.ts';
import { changeProductImagesAction } from '../../src/actions/change-product-images.action.ts';
import { changeProductImagesActionApiLive } from '../../api/change-product-images-action-server.ts';
import { RecordStockMovementActionApi } from '../../shared/apis/record-stock-movement-action.ts';
import { recordStockMovementAction } from '../../src/actions/record-stock-movement.action.ts';
import { recordStockMovementActionApiLive } from '../../api/record-stock-movement-action-server.ts';
import { ChangeOrderStatusActionApi } from '../../shared/apis/change-order-status-action.ts';
import { changeOrderStatusAction } from '../../src/actions/change-order-status.action.ts';
import { changeOrderStatusActionApiLive } from '../../api/change-order-status-action-server.ts';
import { PlaceStorefrontOrderActionApi } from '../../shared/apis/place-storefront-order-action.ts';
import { placeStorefrontOrderAction } from '../../src/actions/place-storefront-order.action.ts';
import { placeStorefrontOrderActionApiLive } from '../../api/place-storefront-order-action-server.ts';
import { ProposeOrderChangesActionApi } from '../../shared/apis/propose-order-changes-action.ts';
import { proposeOrderChangesAction } from '../../src/actions/propose-order-changes.action.ts';
import { proposeOrderChangesActionApiLive } from '../../api/propose-order-changes-action-server.ts';
import { ReviewOrderChangesActionApi } from '../../shared/apis/review-order-changes-action.ts';
import { reviewOrderChangesAction } from '../../src/actions/review-order-changes.action.ts';
import { reviewOrderChangesActionApiLive } from '../../api/review-order-changes-action-server.ts';
// Authentication is an external port here. The real HTTP endpoint, payload decoder, owner binding,
// canonical gate, handler, invocation repository and commit evidence all remain in the test.
rstest.mock('../../api/auth/action-principal.ts', () => ({
  authenticateOperationPrincipal: () =>
    Effect.succeed(
      Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
        authBindingId: '40000000-0000-4000-8000-000000000001',
        authContextRef: 'better-auth-session:merchandise-http',
        authMethod: 'session',
        legalEntityId: '30000000-0000-4000-8000-000000000001',
        principalId: '20000000-0000-4000-8000-000000000001',
        tenantId: '10000000-0000-4000-8000-000000000001',
      }),
    ),
}));

const id = '50000000-0000-4000-8000-000000000001';
const result = { entityIds: [], revision: 2 };
const httpApi = HttpApi.make('MerchandiseApi')
  .addHttpApi(ApplyCommandActionApi)
  .addHttpApi(ManageCatalogActionApi)
  .addHttpApi(ManageMarketsActionApi)
  .addHttpApi(CleanupDemoActionApi)
  .addHttpApi(ChangeProductImagesActionApi)
  .addHttpApi(RecordStockMovementActionApi)
  .addHttpApi(ChangeOrderStatusActionApi)
  .addHttpApi(PlaceStorefrontOrderActionApi)
  .addHttpApi(ProposeOrderChangesActionApi)
  .addHttpApi(ReviewOrderChangesActionApi);
const handlers = Layer.mergeAll(
  applyCommandActionApiLive,
  manageCatalogActionApiLive,
  manageMarketsActionApiLive,
  cleanupDemoActionApiLive,
  changeProductImagesActionApiLive,
  recordStockMovementActionApiLive,
  changeOrderStatusActionApiLive,
  placeStorefrontOrderActionApiLive,
  proposeOrderChangesActionApiLive,
  reviewOrderChangesActionApiLive,
);
export const makeFixture = (options: Pick<ActionTestHarnessOptions, 'access' | 'mandateDispatch'> = {}) =>
  Effect.gen(function* fixture() {
    const writes: MerchandiseCommand[] = [];
    const services = {
      apply: (command: MerchandiseCommand) =>
        Effect.sync(() => {
          writes.push(command);
          return result;
        }),
      productImage: () => Effect.die('Image read is not part of a write'),
      records: () => Effect.die('HTTP writes must not read the records endpoint'),
    };

    const owner = yield* makeOwnerApplicationCompositionFixture({ ownerRegistration: merchandiseRegistration });
    const compositionRevision = owner.snapshot.composition.revision;
    const clock = yield* Clock.Clock;
    const harness = yield* makeActionTestHarness({
      access: 'allowed',
      applicationComposition: owner.applicationComposition,
      expectedDeployment: owner.expectedDeployment,
      ownerRegistration: merchandiseRegistration,
      services: [
        bindActionTestServices(applyCommandAction, services),
        bindActionTestServices(manageCatalogAction, services),
        bindActionTestServices(manageMarketsAction, services),
        bindActionTestServices(cleanupDemoAction, services),
        bindActionTestServices(changeProductImagesAction, services),
        bindActionTestServices(recordStockMovementAction, services),
        bindActionTestServices(changeOrderStatusAction, services),
        bindActionTestServices(placeStorefrontOrderAction, services),
        bindActionTestServices(proposeOrderChangesAction, services),
        bindActionTestServices(reviewOrderChangesAction, services),
      ],
      ...options,
    });
    const requestContext = yield* Layer.build(
      Layer.mergeAll(
        harness.layer,
        Layer.succeed(Clock.Clock, clock),
        Layer.succeed(ActiveApplicationCompositionService, owner.applicationComposition),
        Layer.mock(GatewayAssertionRedemptionService, {}),
        Layer.mock(GatewayPrincipalVerifierConfiguration, {}),
      ),
    );
    const router = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(httpApi).pipe(
            Layer.provide(handlers),
            Layer.provide(harness.layer),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (value) => Effect.promise(async () => await value.dispose()),
    );
    const request = (
      path: string,
      command: (typeof MerchandiseCommandPayloadSchema.Encoded)['command'],
      key: string,
      intent?: 'propose',
    ) => {
      const headers = new Headers({
        authorization: 'Bearer fixture',
        'content-type': 'application/json',
        'idempotency-key': key,
        'x-composition-revision': compositionRevision,
        'x-correlation-id': key,
      });
      if (intent !== undefined) {
        headers.set('x-action-intent', intent);
      }
      return Effect.promise(
        async () =>
          await router.handler(
            new Request(`https://owner.test${path}`, {
              body: JSON.stringify({ command, expectedRevision: 1 }),
              headers,
              method: 'POST',
            }),
            requestContext,
          ),
      );
    };
    return { compositionRevision, harness, request, requestContext, router, writes };
  });

export const cases = [
  {
    command: {
      _tag: 'CreateProduct',
      active: true,
      category: 'HTTP',
      lowStockThreshold: 0,
      name: 'HTTP product',
      priceMinor: 100,
      sku: 'HTTP',
      unit: 'ks',
      vatRate: 21,
    },
    slug: 'apply-command',
  },
  { command: { _tag: 'UpdateProduct', id, patch: { name: 'Updated product' } }, slug: 'manage-catalog' },
  { command: { _tag: 'SetProductMarketOffer', marketId: id, offered: true, productId: id }, slug: 'manage-markets' },
  { command: { _tag: 'ArchiveDemoProduct', id, reason: 'HTTP cleanup' }, slug: 'cleanup-demo' },
  {
    command: { _tag: 'ChangeProductImages', change: { _tag: 'Reorder', images: [] }, id },
    slug: 'change-product-images',
  },
  {
    command: { _tag: 'RecordStockMovement', delta: 1, productId: id, reason: 'RECEIPT' },
    slug: 'record-stock-movement',
  },
  { command: { _tag: 'ChangeOrderStatus', id, status: 'CONFIRMED' }, slug: 'change-order-status' },
  {
    command: {
      _tag: 'PlaceStorefrontOrder',
      clientRequestId: id,
      contact: { email: 'owner@example.test', name: 'Owner', phone: '+420123456789' },
      deliveryAddress: { city: 'Praha', country: 'CZ', postalCode: '11000', street: 'Main' },
      expectedShippingPriceMinor: 0,
      lines: [{ expectedUnitPriceMinor: 100, productId: id, quantity: 1 }],
      shippingMethod: 'OSOBNI_ODBER',
    },
    slug: 'place-storefront-order',
  },
  {
    command: {
      _tag: 'AiProposeChanges',
      changes: [{ operation: { _tag: 'ChangeOrderStatus', id, status: 'CONFIRMED' }, reason: 'HTTP fixture' }],
      instruction: 'HTTP fixture',
    },
    slug: 'propose-order-changes',
  },
  {
    command: { _tag: 'AiDecideChanges', changeIds: ['http-change'], decision: 'reject' },
    slug: 'review-order-changes',
  },
] as const;
