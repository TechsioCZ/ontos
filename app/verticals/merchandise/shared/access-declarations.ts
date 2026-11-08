import { Result } from 'effect';
import { decodeAccessWorkload, decodeAccessDeclarationOrThrow } from '@app/core-runtime';
import type { AccessDeclarationInput } from '@app/core-runtime';

const moduleKey = 'demo.merchandise';
export const recordsDeclaration = {
  key: 'demo.merchandise.api-records.read',
  kind: 'read',
  modes: ['run'],
  placement: { group: 'merchandise', level: 'basic' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessDeclarationInput;
export const storefrontWorkload = {
  reason: 'The registered Storefront BFF reads published catalog data and places its own guest orders',
  workloads: ['demo.storefront-client'],
} as const;
const decodedStorefrontWorkload = Result.getOrThrow(
  decodeAccessWorkload(storefrontWorkload, {
    access: 'read',
    authorization: { kind: 'protected' },
    moduleKey,
    role: 'api',
  }),
);

export const recordsCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(recordsDeclaration, {
    access: 'read',
    authorization: { kind: 'protected' },
    moduleKey,
    role: 'api',
  }),
  accessWorkload: decodedStorefrontWorkload,
};

export const applyCommandDeclaration = {
  key: 'demo.merchandise.apply-command.write',
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'merchandise', level: 'manage' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessDeclarationInput;
export const applyCommandCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(applyCommandDeclaration, {
    access: 'write',
    authorization: { kind: 'protected' },
    moduleKey,
    role: 'action',
  }),
};

export const manageCatalogDeclaration = {
  key: 'demo.merchandise.catalog.manage',
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'catalog', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessDeclarationInput;
export const manageCatalogCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(manageCatalogDeclaration, {
    access: 'write',
    authorization: { kind: 'protected' },
    moduleKey,
    role: 'action',
  }),
};

export const manageMarketsDeclaration = {
  key: 'demo.merchandise.markets.manage',
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'markets', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessDeclarationInput;
export const manageMarketsCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(manageMarketsDeclaration, {
    access: 'write',
    authorization: { kind: 'protected' },
    moduleKey,
    role: 'action',
  }),
};

export const cleanupDemoDeclaration = {
  key: 'demo.merchandise.demo.cleanup',
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'demo', level: 'extended' },
  risk: 'critical',
  selectors: [],
} as const satisfies AccessDeclarationInput;
export const cleanupDemoCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(cleanupDemoDeclaration, {
    access: 'write',
    authorization: { kind: 'protected' },
    moduleKey,
    role: 'action',
  }),
};

export const changeProductImagesDeclaration = {
  key: 'demo.merchandise.product-images.change',
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'product-images', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessDeclarationInput;
export const changeProductImagesCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(changeProductImagesDeclaration, {
    access: 'write',
    authorization: { kind: 'protected' },
    moduleKey,
    role: 'action',
  }),
};

export const recordStockMovementDeclaration = {
  key: 'demo.merchandise.stock-movement.record',
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'stock-movement', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessDeclarationInput;
export const recordStockMovementCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(recordStockMovementDeclaration, {
    access: 'write',
    authorization: { kind: 'protected' },
    moduleKey,
    role: 'action',
  }),
};

export const changeOrderStatusDeclaration = {
  key: 'demo.merchandise.order-status.change',
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'order-status', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessDeclarationInput;
export const changeOrderStatusCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(changeOrderStatusDeclaration, {
    access: 'write',
    authorization: { kind: 'protected' },
    moduleKey,
    role: 'action',
  }),
};

export const placeStorefrontOrderDeclaration = {
  key: 'demo.merchandise.storefront-order.place',
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'storefront-order', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessDeclarationInput;
export const placeStorefrontOrderCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(placeStorefrontOrderDeclaration, {
    access: 'write',
    authorization: { kind: 'protected' },
    moduleKey,
    role: 'action',
  }),
  accessWorkload: decodedStorefrontWorkload,
};

export const proposeOrderChangesDeclaration = {
  key: 'demo.merchandise.order-changes.propose',
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'order-changes', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessDeclarationInput;
export const proposeOrderChangesCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(proposeOrderChangesDeclaration, {
    access: 'write',
    authorization: { kind: 'protected' },
    moduleKey,
    role: 'action',
  }),
};

export const reviewOrderChangesDeclaration = {
  key: 'demo.merchandise.order-changes.review',
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'order-changes', level: 'extended' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessDeclarationInput;
export const reviewOrderChangesCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(reviewOrderChangesDeclaration, {
    access: 'write',
    authorization: { kind: 'protected' },
    moduleKey,
    role: 'action',
  }),
};
