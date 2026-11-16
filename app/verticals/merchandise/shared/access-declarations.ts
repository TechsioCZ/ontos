import { Result } from 'effect';
import { decodeAccessWorkload, decodeAccessDeclarationOrThrow } from '@app/core-runtime';

const moduleKey = 'demo.merchandise';
const decodedStorefrontWorkload = Result.getOrThrow(
  decodeAccessWorkload(
    {
      reason: 'The registered Storefront BFF reads published catalog data and places its own guest orders',
      workloads: ['demo.storefront-client'],
    },
    {
      access: 'read',
      authorization: { kind: 'protected' },
      moduleKey,
      role: 'api',
    },
  ),
);

export const recordsCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'demo.merchandise.api-records.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'merchandise', level: 'basic' },
      risk: 'sensitive',
      selectors: [],
    },
    {
      access: 'read',
      authorization: { kind: 'protected' },
      moduleKey,
      role: 'api',
    },
  ),
  accessWorkload: decodedStorefrontWorkload,
};

export const applyCommandCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'demo.merchandise.apply-command.write',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'merchandise', level: 'manage' },
      risk: 'sensitive',
      selectors: [],
    },
    {
      access: 'write',
      authorization: { kind: 'protected' },
      moduleKey,
      role: 'action',
    },
  ),
};

export const manageCatalogCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'demo.merchandise.catalog.manage',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'catalog', level: 'extended' },
      risk: 'sensitive',
      selectors: [],
    },
    {
      access: 'write',
      authorization: { kind: 'protected' },
      moduleKey,
      role: 'action',
    },
  ),
};

export const manageMarketsCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'demo.merchandise.markets.manage',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'markets', level: 'extended' },
      risk: 'sensitive',
      selectors: [],
    },
    {
      access: 'write',
      authorization: { kind: 'protected' },
      moduleKey,
      role: 'action',
    },
  ),
};

export const cleanupDemoCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'demo.merchandise.demo.cleanup',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'demo', level: 'extended' },
      risk: 'critical',
      selectors: [],
    },
    {
      access: 'write',
      authorization: { kind: 'protected' },
      moduleKey,
      role: 'action',
    },
  ),
};

export const changeProductImagesCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'demo.merchandise.product-images.change',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'product-images', level: 'extended' },
      risk: 'sensitive',
      selectors: [],
    },
    {
      access: 'write',
      authorization: { kind: 'protected' },
      moduleKey,
      role: 'action',
    },
  ),
};

export const recordStockMovementCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'demo.merchandise.stock-movement.record',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'stock-movement', level: 'extended' },
      risk: 'sensitive',
      selectors: [],
    },
    {
      access: 'write',
      authorization: { kind: 'protected' },
      moduleKey,
      role: 'action',
    },
  ),
};

export const changeOrderStatusCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'demo.merchandise.order-status.change',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'order-status', level: 'extended' },
      risk: 'sensitive',
      selectors: [],
    },
    {
      access: 'write',
      authorization: { kind: 'protected' },
      moduleKey,
      role: 'action',
    },
  ),
};

export const placeStorefrontOrderCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'demo.merchandise.storefront-order.place',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'storefront-order', level: 'extended' },
      risk: 'sensitive',
      selectors: [],
    },
    {
      access: 'write',
      authorization: { kind: 'protected' },
      moduleKey,
      role: 'action',
    },
  ),
  accessWorkload: decodedStorefrontWorkload,
};

export const proposeOrderChangesCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'demo.merchandise.order-changes.propose',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'order-changes', level: 'extended' },
      risk: 'sensitive',
      selectors: [],
    },
    {
      access: 'write',
      authorization: { kind: 'protected' },
      moduleKey,
      role: 'action',
    },
  ),
};

export const reviewOrderChangesCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: 'demo.merchandise.order-changes.review',
      kind: 'action',
      modes: ['run', 'propose', 'approve'],
      placement: { group: 'order-changes', level: 'extended' },
      risk: 'sensitive',
      selectors: [],
    },
    {
      access: 'write',
      authorization: { kind: 'protected' },
      moduleKey,
      role: 'action',
    },
  ),
};
