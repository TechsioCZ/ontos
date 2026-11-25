import { expect, it } from 'effect-rstest';
import { extractVerticalRuntimeSafeDescriptors } from '@app/core-runtime';

import { catalogRegistration } from '../../verticals/catalog/vertical.registration.ts';
import { catalogRuntimeDeclaration } from '../../verticals/catalog/vertical.runtime-declaration.ts';

it('the actual Catalog registration imports and extracts every distinct runtime operation once', () => {
  const safe = extractVerticalRuntimeSafeDescriptors(catalogRegistration);
  expect(safe.moduleId).toBe('commerce.catalog');
  const entrypoints = safe.operationContracts.map(({ entrypoint }) => entrypoint.entrypointKey);
  expect(new Set(entrypoints).size).toBe(entrypoints.length);
  for (const entrypoint of [
    'commerce.catalog.set-product-localized-facts',
    'commerce.catalog.api.set-product-localized-facts-recovery',
    'commerce.catalog.set-variant-localized-facts',
    'commerce.catalog.api.set-variant-localized-facts-recovery',
  ]) {
    expect(entrypoints.filter((key) => key === entrypoint)).toHaveLength(1);
  }
  expect(safe.actions.map(({ actionKey }) => actionKey).toSorted()).toStrictEqual(
    catalogRuntimeDeclaration.actions.map(({ descriptor }) => descriptor.actionKey).toSorted(),
  );
  const localizedFacts = safe.actions.find(
    ({ actionKey }) => actionKey === 'commerce.catalog.set-product-localized-facts',
  );
  expect(
    localizedFacts?.accessWorkload?.workloads.some((workload) => workload === 'commerce.catalog.symmy-product-import'),
  ).toBe(true);
});
