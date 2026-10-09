import { describe, expect, it } from 'effect-rstest';
import { Effect, Exit, Option, Schema } from 'effect';

import { SkuLookupRequestSchema, SkuLookupResponseSchema } from '../../shared/apis/sku-lookup.ts';
import {
  skuLookupEntrypoint,
  skuLookupResult,
  skuLookupResultPermissionTargets,
} from '../../src/api/sku-lookup.read.ts';

const tenantId = '6ae451be-2478-4f99-a3bd-3e5e5ec07720';
const variantId = 'd31d75df-3e52-4a47-83b9-c7fa2f442816';
const packageDefinitionId = '36fb5844-7f9f-4bc7-8418-c4c1398fdb67';
const variant = { kind: 'VARIANT' as const, tenantId, variantId };
const packageOption = { kind: 'PACKAGE_OPTION' as const, packageDefinitionId, tenantId };

describe('governed SKU lookup contract', () => {
  it('accepts a code-only request for a post-result resource-authorized read', () => {
    expect(Option.isSome(Schema.decodeUnknownOption(SkuLookupRequestSchema)({ code: 'OLD-10' }))).toBe(true);
  });

  it('derives exactly one exact resource check for either target kind', () => {
    const variantResult = {
      _tag: 'found' as const,
      displayCode: 'OLD-10',
      revision: 2,
      state: 'HISTORICAL' as const,
      target: variant,
    };
    const packageResult = { ...variantResult, target: packageOption };
    expect(skuLookupResultPermissionTargets(variantResult)).toEqual([
      { moduleId: 'commerce.catalog', resourceId: variantId, resourceType: 'commerce.catalog.variant', tenantId },
    ]);
    expect(skuLookupResultPermissionTargets(packageResult)).toEqual([
      {
        moduleId: 'commerce.catalog',
        resourceId: packageDefinitionId,
        resourceType: 'commerce.catalog.package-definition',
        tenantId,
      },
    ]);
    expect(skuLookupResultPermissionTargets({ _tag: 'not_found' })).toEqual([]);
  });

  it('exposes historical state without claiming current selection eligibility', () => {
    const historical = {
      _tag: 'found' as const,
      displayCode: 'OLD-10',
      revision: 2,
      state: 'HISTORICAL' as const,
      target: variant,
    };
    expect(Option.isSome(Schema.decodeUnknownOption(SkuLookupResponseSchema)(historical))).toBe(true);
    expect(skuLookupEntrypoint.access).toBe('historical_read');
  });

  it.effect('fails closed for ambiguous code with no candidate disclosure', () =>
    Effect.gen(function* ambiguousSkuRead() {
      const exit = yield* Effect.exit(skuLookupResult({ _tag: 'ambiguous' }));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});
