import {
  extractVerticalRuntimeSafeDescriptors,
  getVerticalRuntimeActions,
  getVerticalRuntimeEntrypoints,
} from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';

import { catalogRegistration } from '../../vertical.registration.ts';
import { bindInitialVariantSourceAction } from '../../src/actions/bind-initial-variant-source.action.ts';
import { correctProductAction } from '../../src/actions/correct-product.action.ts';
import { createProductAction } from '../../src/actions/create-product.action.ts';
import { createVariantAction } from '../../src/actions/create-variant.action.ts';
import { updateProductAction } from '../../src/actions/update-product.action.ts';

const actionPublications = [
  {
    action: bindInitialVariantSourceAction,
    apiKey: 'bind-initial-variant-source-action',
    recoveryKey: 'bind-initial-variant-source-recovery',
  },
  { action: correctProductAction, apiKey: 'correct-product-action', recoveryKey: 'correct-product-recovery' },
  { action: createProductAction, apiKey: 'create-product-action', recoveryKey: 'create-product-recovery' },
  { action: createVariantAction, apiKey: 'create-variant-action', recoveryKey: 'create-variant-recovery' },
  { action: updateProductAction, apiKey: 'update-product-action', recoveryKey: 'update-product-recovery' },
];

describe('Catalog Action HTTP publication', () => {
  it('keeps native Actions and their exact recovery Reads without publishing Action clients as lazy module Reads', () => {
    const published = extractVerticalRuntimeSafeDescriptors(catalogRegistration);
    const lazyApiKeys = Object.keys(getVerticalRuntimeEntrypoints(catalogRegistration).api ?? {});
    for (const { action, apiKey, recoveryKey } of actionPublications) {
      expect(getVerticalRuntimeActions(catalogRegistration)).toContain(action);
      expect(
        published.actions.some(
          ({ actionKey, schemaVersion }) =>
            actionKey === action.descriptor.actionKey && schemaVersion === action.descriptor.schemaVersion,
        ),
      ).toBe(true);
      expect(lazyApiKeys).not.toContain(apiKey);
      expect(lazyApiKeys).toContain(recoveryKey);
      expect(
        published.operationContracts.some(
          ({ apiKey: publicApiKey, entrypoint }) =>
            publicApiKey === `commerce.catalog.${apiKey}` &&
            entrypoint.entrypointKey === action.descriptor.entrypoint.entrypointKey,
        ),
      ).toBe(true);
      expect(
        published.operationContracts.some(
          ({ apiKey: publicApiKey, entrypoint }) =>
            publicApiKey === `commerce.catalog.${recoveryKey}` &&
            entrypoint.entrypointKey === `commerce.catalog.api.${recoveryKey}`,
        ),
      ).toBe(true);
    }
  });
});
