import { createHash } from 'node:crypto';

import { DateTime, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { SymmyProductsBatchRequestSchema } from '../../apps/shell-super-app/api/symmy/products-batch-request-contract.ts';
import { mapSymmyProductsBatchRequest } from '../../apps/shell-super-app/api/symmy/products-batch-public-contract.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../verticals/symmy-integration/shared/domain/symmy-job-execution.ts';
import { buildSymmyProductPlan } from '../../verticals/symmy-integration/src/persistence/symmy-product-plan.ts';
import {
  makeInternalC14ProductBody,
  makeInternalC14ProductRouteTemplate,
} from '../integration/support/symmy-c14-product-plan.mts';

it.effect('admits the original category-free Product recovery fixture without Category assignment authority', () =>
  Effect.gen(function* originalProductFixture() {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const body = yield* Schema.decodeUnknownEffect(SymmyProductsBatchRequestSchema)(
      makeInternalC14ProductBody(tenantId),
    );
    const template = yield* Schema.decodeUnknownEffect(SymmyFixtureExecutionPlanSchema)(
      makeInternalC14ProductRouteTemplate({
        marketId: 'INTERNAL_C14_MARKET',
        sourceRouteId: '22222222-2222-4222-8222-222222222222',
        unitRef: {
          moduleId: 'commerce.catalog',
          resourceId: '33333333-3333-4333-8333-333333333333',
          resourceType: 'commerce.catalog.product-unit',
          tenantId,
        },
      }),
    );
    const input = {
      digest: (value) => Effect.succeed(createHash('sha256').update(value).digest('hex')),
      idempotencyKey: 'INTERNAL_C14_PRODUCT_JOB',
      legalEntityId: '44444444-4444-4444-8444-444444444444',
      priceGroups: [],
      receivedAt: DateTime.makeUnsafe('2026-11-22T12:00:00.000Z'),
      route: { mappingVersion: 'INTERNAL_C14_MAPPING_V1', routeId: '55555555-5555-4555-8555-555555555555' },
      rows: mapSymmyProductsBatchRequest(body),
      template,
      tenantId,
    } satisfies Parameters<typeof buildSymmyProductPlan>[0];
    const plan = yield* buildSymmyProductPlan(input);
    expect(Option.isSome(plan)).toBe(true);
    expect(body.products.every(({ categories }) => categories === undefined)).toBe(true);
    const effects = Option.getOrThrow(plan).items.flatMap(({ effects: itemEffects }) => itemEffects);
    expect(effects.some(({ operation }) => operation.entrypointKey === 'commerce.catalog.create-product')).toBe(true);
    expect(effects.some(({ operation }) => operation.entrypointKey === 'commerce.pricing.define-price')).toBe(true);
    expect(
      effects.some(({ operation }) => operation.entrypointKey === 'commerce.catalog.add-product-category-assignment'),
    ).toBe(false);
    const [first, ...rest] = input.rows;
    expect(first.unsupported).toEqual([
      'AttributeHint',
      'MediaHint',
      'VariantUpdateHint',
      'DescriptiveHint',
      'ClassificationHint',
    ]);
    const unassignedCategory = yield* buildSymmyProductPlan({
      ...input,
      rows: [
        {
          ...first,
          categories: [
            {
              moduleId: 'commerce.catalog',
              resourceId: '66666666-6666-4666-8666-666666666666',
              resourceType: 'commerce.catalog.product-category',
              tenantId,
            },
          ],
        },
        ...rest,
      ],
    });
    expect(Option.isNone(unassignedCategory)).toBe(true);
  }),
);
