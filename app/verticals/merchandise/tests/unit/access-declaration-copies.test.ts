// The descriptors carry closed inline access literals because the catalog accepts only literal custody;
// the owner asks the gate with its own decoded copies. These copies must never drift from the descriptors.
import { expect, it } from 'effect-rstest';

import {
  applyCommandCarrier,
  changeOrderStatusCarrier,
  changeProductImagesCarrier,
  cleanupDemoCarrier,
  manageCatalogCarrier,
  manageMarketsCarrier,
  placeStorefrontOrderCarrier,
  proposeOrderChangesCarrier,
  recordStockMovementCarrier,
  recordsCarrier,
  reviewOrderChangesCarrier,
} from '../../shared/access-declarations.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { changeOrderStatusAction } from '../../src/actions/change-order-status.action.ts';
import { changeProductImagesAction } from '../../src/actions/change-product-images.action.ts';
import { cleanupDemoAction } from '../../src/actions/cleanup-demo.action.ts';
import { manageCatalogAction } from '../../src/actions/manage-catalog.action.ts';
import { manageMarketsAction } from '../../src/actions/manage-markets.action.ts';
import { placeStorefrontOrderAction } from '../../src/actions/place-storefront-order.action.ts';
import { proposeOrderChangesAction } from '../../src/actions/propose-order-changes.action.ts';
import { recordStockMovementAction } from '../../src/actions/record-stock-movement.action.ts';
import { reviewOrderChangesAction } from '../../src/actions/review-order-changes.action.ts';
import { recordsRead } from '../../src/api/records.read.ts';

it('asks the gate exactly what the registered descriptors declare', () => {
  for (const [carrier, descriptor] of [
    [recordsCarrier, recordsRead.descriptor],
    [applyCommandCarrier, applyCommandAction.descriptor],
    [manageCatalogCarrier, manageCatalogAction.descriptor],
    [manageMarketsCarrier, manageMarketsAction.descriptor],
    [cleanupDemoCarrier, cleanupDemoAction.descriptor],
    [changeProductImagesCarrier, changeProductImagesAction.descriptor],
    [recordStockMovementCarrier, recordStockMovementAction.descriptor],
    [changeOrderStatusCarrier, changeOrderStatusAction.descriptor],
    [placeStorefrontOrderCarrier, placeStorefrontOrderAction.descriptor],
    [proposeOrderChangesCarrier, proposeOrderChangesAction.descriptor],
    [reviewOrderChangesCarrier, reviewOrderChangesAction.descriptor],
  ] as const) {
    expect(carrier.accessDeclaration).toEqual(descriptor.accessDeclaration);
  }
  expect(recordsCarrier.accessWorkload).toEqual(recordsRead.descriptor.accessWorkload);
  expect(placeStorefrontOrderCarrier.accessWorkload).toEqual(placeStorefrontOrderAction.descriptor.accessWorkload);
});
