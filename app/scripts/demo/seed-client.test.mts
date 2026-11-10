import { Effect, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { ChangeOrderStatusPayloadSchema } from '../../verticals/merchandise/shared/actions/change-order-status.ts';
import { ApplyCommandPayloadSchema as MerchandiseApplyCommandPayloadSchema } from '../../verticals/merchandise/shared/actions/apply-command.ts';
import { ChangeProductImagesPayloadSchema } from '../../verticals/merchandise/shared/actions/change-product-images.ts';
import { ManageCatalogPayloadSchema } from '../../verticals/merchandise/shared/actions/manage-catalog.ts';
import { ManageMarketsPayloadSchema } from '../../verticals/merchandise/shared/actions/manage-markets.ts';
import { DeleteTagPayloadSchema } from '../../verticals/tagging/shared/actions/delete-tag.ts';
import { connectSeedClient, ownerAction } from './seed-client.mts';
import type { SeedClient } from './seed-client.mts';

const tenantId = '71000000-0000-4000-8000-000000000001';
const legalEntityId = '71000000-0000-4000-8000-000000000002';
const entityId = '71000000-0000-4000-8000-000000000003';
const compositionRevision = 'composition-fixture';
const target = { legalEntityId, shellUrl: 'http://localhost:3020', tenantId };

/** Login, session, composition and gateway answers; every owner write is accepted with revision 1. */
const answerFor = (path: string, isOwnerWrite: boolean) => {
  if (path === '/shell-super-app-api/auth/gateway-context') {
    return { apiBaseUrl: '/owner-api', compositionRevision, token: 'assertion' };
  }
  if (path === '/shell-super-app-api/auth/session') {
    return { identity: { legalEntityId, tenantId }, state: 'authenticated' };
  }
  if (path === '/shell-super-app-api/shell/composition') {
    return { compositionRevision, state: 'available' };
  }
  return isOwnerWrite ? { revision: 1 } : {};
};

/** Records every owner Action path the client posts to. */
const fakeShell = (ownerPaths: string[]) =>
  HttpClient.make((request, url) => {
    const isOwnerWrite = url.pathname.startsWith('/owner-api/');
    if (isOwnerWrite) {
      ownerPaths.push(url.pathname);
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(answerFor(url.pathname, isOwnerWrite))));
  });

// Compile-time guard: `apply-command` accepts only CreateProduct, so an UpdateProduct sent to it must not type-check.
const misroutedUpdate = (client: SeedClient) =>
  client.apply(
    'merchandise',
    ownerAction('apply-command', Schema.toEncoded(MerchandiseApplyCommandPayloadSchema)),
    // @ts-expect-error UpdateProduct belongs to manage-catalog, not apply-command.
    { _tag: 'UpdateProduct', id: entityId, patch: { lowStockThreshold: 5 } },
    1,
  );

it('keeps the compile-time guard in place', () => {
  expect(misroutedUpdate.length).toBe(1);
});

it.effect('sends each command to the owner Action that accepts its tag', () => {
  const ownerPaths: string[] = [];
  return Effect.gen(function* routesEachTag() {
    const client = yield* connectSeedClient(target, 'seed@example.invalid', Redacted.make('fixture'));
    yield* client.apply(
      'merchandise',
      ownerAction('manage-catalog', Schema.toEncoded(ManageCatalogPayloadSchema)),
      { _tag: 'UpdateProduct', id: entityId, patch: { lowStockThreshold: 5 } },
      1,
    );
    yield* client.apply(
      'merchandise',
      ownerAction('change-order-status', Schema.toEncoded(ChangeOrderStatusPayloadSchema)),
      { _tag: 'ChangeOrderStatus', id: entityId, status: 'CANCELLED' },
      1,
    );
    yield* client.apply(
      'merchandise',
      ownerAction('manage-markets', Schema.toEncoded(ManageMarketsPayloadSchema)),
      { _tag: 'SetMarketProductOffers', marketId: entityId, offered: true, productIds: [entityId] },
      1,
    );
    yield* client.apply(
      'merchandise',
      ownerAction('change-product-images', Schema.toEncoded(ChangeProductImagesPayloadSchema)),
      { _tag: 'ChangeProductImages', change: { _tag: 'Reorder', images: [] }, id: entityId },
      0,
    );
    yield* client.apply(
      'tagging',
      ownerAction('delete-tag', Schema.toEncoded(DeleteTagPayloadSchema)),
      {
        _tag: 'DeleteTag',
        id: entityId,
      },
      1,
    );
    expect(ownerPaths).toEqual([
      '/owner-api/merchandise/actions/manage-catalog',
      '/owner-api/merchandise/actions/change-order-status',
      '/owner-api/merchandise/actions/manage-markets',
      '/owner-api/merchandise/actions/change-product-images',
      '/owner-api/tagging/actions/delete-tag',
    ]);
  }).pipe(Effect.provideService(HttpClient.HttpClient, fakeShell(ownerPaths)));
});
