import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { it } from 'effect-rstest';
import { extractVerticalRuntimeSafeDescriptors } from '@app/core-runtime';

import { catalogRegistration } from '../../verticals/catalog/vertical.registration.ts';
import { catalogRuntimeDeclaration } from '../../verticals/catalog/vertical.runtime-declaration.ts';

it('the actual Catalog registration imports and extracts every distinct runtime operation once', () => {
  const safe = extractVerticalRuntimeSafeDescriptors(catalogRegistration);
  equal(safe.moduleId, 'commerce.catalog');
  const entrypoints = safe.operationContracts.map(({ entrypoint }) => entrypoint.entrypointKey);
  equal(new Set(entrypoints).size, entrypoints.length);
  for (const entrypoint of [
    'commerce.catalog.set-product-localized-facts',
    'commerce.catalog.api.set-product-localized-facts-recovery',
    'commerce.catalog.set-variant-localized-facts',
    'commerce.catalog.api.set-variant-localized-facts-recovery',
  ]) {
    equal(entrypoints.filter((key) => key === entrypoint).length, 1);
  }
  deepStrictEqual(
    safe.actions.map(({ actionKey }) => actionKey).toSorted(),
    catalogRuntimeDeclaration.actions.map(({ descriptor }) => descriptor.actionKey).toSorted(),
  );
  const localizedFacts = safe.actions.find(({ actionKey }) =>
    actionKey === 'commerce.catalog.set-product-localized-facts');
  ok(localizedFacts);
  ok(localizedFacts.accessWorkload?.workloads.includes('commerce.catalog.symmy-product-import'));
});
